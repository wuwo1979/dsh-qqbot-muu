#!/usr/bin/env node
/**
 * 平板微信全量快照 → 私有归档库
 *
 * 现实（2026-11-16 实测）：
 *  - 平板上的微信是「小蓝自己的号」(wxid_x9oo19tcn4gm12 / MuUAstra)，2026-11-05 才建。
 *  - WCX 只给 /api/conversations/<id>/history（page-index 分页，最新在前），
 *    单条只有 {sender, content, type}：没有时间戳、没有 msgId、没有媒体地址。
 *  - 能翻到的总量就是这台设备上的全部：家长 146 / 家人 31 / 家庭群 75 / filehelper 4。
 *
 * 所以这里做的是「能拉到的一条不漏」：全部分页拉完 → 私有库 private-chat.db，
 * scope 用会话 id 区分（wechat:dm:<wxid> / wechat:group:<chatroom>），
 * ts 记 0 表示「接口没给时间」、seq 记时间顺序（越大越新），等以后解出
 * 本地 EnMicroMsg.db 再用真实 createTime 回填。
 *
 * 用法：
 *   node scripts/wechat-full-pull.mjs [--dry] [--convs wxid_a,wxid_b]
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = 'F:/qqbot'
const PRIVATE_DB = join(ROOT, 'dshqqbot/.qqbot/private/private-chat.db')
const BASE = 'http://127.0.0.1:3001'
const dry = process.argv.includes('--dry')
const convArg = (() => {
  const i = process.argv.indexOf('--convs')
  return i > 0 ? String(process.argv[i + 1] || '').split(',').filter(Boolean) : null
})()

const token = readFileSync(join(ROOT, 'secrets/wcx-token.txt'), 'utf8').trim()
const auth = { Authorization: `Bearer ${token}` }

async function api(path) {
  const r = await fetch(BASE + path, { headers: auth })
  const buf = Buffer.from(await r.arrayBuffer())
  let json = null
  try { json = JSON.parse(buf.toString('utf8')) } catch { /* 非 JSON */ }
  return { ok: r.ok, status: r.status, json }
}

function fpOf(scope, seq, dir, text) {
  return createHash('sha1').update(`${scope}|${seq}|${dir}|${text}`).digest('hex')
}

async function pullConv(convId) {
  const all = []
  for (let page = 1; page <= 200; page += 1) {
    const r = await api(`/api/conversations/${convId}/history?page-index=${page}&page-size=50`)
    if (!Array.isArray(r.json) || r.json.length === 0) break
    for (const m of r.json) all.push(m)
    if (r.json.length < 50) break
  }
  return all
}

const friends = (await api('/api/contacts?type=friends')).json || []
const groups = (await api('/api/contacts?type=groups')).json || []
const self = (await api('/api/self/info')).json || {}
const byId = new Map()
for (const c of [...friends, ...groups]) byId.set(c.wxId, c)
byId.set('filehelper', { wxId: 'filehelper', remarkName: '文件传输助手', nickname: '文件传输助手' })

const targets = convArg || [...byId.keys()]
mkdirSync(dirname(PRIVATE_DB), { recursive: true })
const db = dry ? null : new DatabaseSync(PRIVATE_DB)
if (db) {
  db.exec(`
    create table if not exists msg(
      fp text primary key, platform text, conv_id text, conv_name text, scope text,
      ts integer, seq integer, dir text, sender text, text text, media text, kind text,
      src text, tag text default 'private', ts_quality text, imported_at integer
    );
  `)
  // private-archive-import.mjs 建的表没有 seq/kind/ts_quality，先补列再建索引（幂等）
  for (const ddl of [
    'alter table msg add column seq integer',
    'alter table msg add column kind text',
    'alter table msg add column ts_quality text',
  ]) {
    try { db.exec(ddl) } catch { /* 已存在 */ }
  }
  db.exec('create index if not exists idx_msg_scope on msg(scope, seq)')
}

const ins = db?.prepare(`insert or ignore into msg(fp,platform,conv_id,conv_name,scope,ts,seq,dir,sender,text,media,kind,src,tag,ts_quality,imported_at)
  values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)

let grand = 0
for (const convId of targets) {
  const c = byId.get(convId) || { wxId: convId }
  const isGroup = /@chatroom$/.test(convId)
  const scope = `${isGroup ? 'wechat:group' : 'wechat:dm'}:${convId}`
  const name = c.remarkName || c.nickname || convId
  const msgs = await pullConv(convId)
  const total = msgs.length
  // 接口是最新在前 → 反过来让 seq 越大越新
  msgs.reverse()
  let n = 0
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i]
    const raw = String(m.content ?? '')
    const senderRaw = String(m.sender ?? '')
    const isSelf = senderRaw === '<myself>' || senderRaw === self.customWxId
    const dir = isSelf ? 'out' : 'in'
    const kind = String(m.type || 'text')
    let media = null
    if (kind === 'image') media = raw.includes('<type:image>') ? raw : '<image>'
    else if (kind === 'voice' || raw.startsWith('<type:voice')) media = raw
    else if (raw.startsWith('<?xml')) media = 'appmsg' // 转发卡片/链接/文件，原文保留在 text
    const seq = i + 1
    const fp = fpOf(scope, seq, dir, raw)
    grand += 1
    n += 1
    if (ins) ins.run(fp, 'wechat', convId, name, scope, 0, seq, dir, senderRaw, raw, media, kind, 'tablet-api', 'private', 'unknown', Date.now())
  }
  console.log(`${scope}  ${name}  msgs=${total}${dry ? ' (dry)' : ''}`)
}
if (db) {
  const r = db.prepare(`select scope, count(*) n from msg where platform='wechat' group by scope order by n desc`).all()
  console.log('--- private-chat.db wechat ---')
  for (const row of r) console.log(`${row.scope}  ${row.n}`)
  db.close()
}
console.log('pulled', grand)
