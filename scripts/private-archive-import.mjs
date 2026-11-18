#!/usr/bin/env node
// 私聊归档：把「只属于人和家人的私聊」搬进独立库，和肥鱼的常规记忆物理隔离。
//
// 设计约束（主人 2026-11-16 定）：
//   1. 只收：抖音私信（家人）、微信私聊（家长/家人）、QQ 私聊（家长/家人）
//   2. 来源识别：scope = <platform>:dm:<convId>，永远带时间戳，不跨库合并
//   3. 物理隔离：写到 .qqbot/private/private-chat.db（独立文件），不写 memory.db
//   4. 读取要人同意：本脚本不提供「自动读取」入口；要读只能由人当场点头后手动跑 --dump
//
// 用法：
//   node scripts/private-archive-import.mjs --all
//   node scripts/private-archive-import.mjs --douyin / --wechat / --qq
//   node scripts/private-archive-import.mjs --stats
//   node scripts/private-archive-import.mjs --dump <scope> --limit 20   # 需人点头后手动跑
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

// ★ 2026-11-18：仓库根不再写死；名单也从本地数据文件读（发布包不带任何人的 openid）
const ROOT = process.env.QQBOT_ROOT || dirname(dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Za-z]:)/, '$1')
const PRIVATE_DB = join(ROOT, 'dshqqbot', '.qqbot', 'private', 'private-chat.db')
const CHAT_DB = join(ROOT, 'dshqqbot', '.qqbot', 'memory.db')
const WECHAT_JSONL = join(ROOT, 'wechat-bridge', 'messages.jsonl')
const DY_DIR = join(ROOT, 'data', 'douyin-exports')

// 「只属于人」的会话名单：从 {ROOT}/dshqqbot/.qqbot/private-people.json 读（不存在就只跑抖音那部分）
function loadPeers() {
  const f = process.env.QQBOT_PRIVATE_PEOPLE || join(ROOT, 'dshqqbot', '.qqbot', 'private-people.json')
  try {
    if (!existsSync(f)) return []
    const arr = JSON.parse(readFileSync(f, 'utf8'))
    if (!Array.isArray(arr)) return []
    return arr.filter((x) => x && (x.qq || x.id)).map((x) => ({
      name: String(x.name || '私聊对象'),
      qq: x.qq ? String(x.qq) : (x.id ? String(x.id) : null),
      wx: x.wx ? String(x.wx) : null,
    }))
  } catch { return [] }
}
const PEERS = loadPeers()

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const arg = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }

if (!existsSync(dirname(PRIVATE_DB))) mkdirSync(dirname(PRIVATE_DB), { recursive: true })
const db = new DatabaseSync(PRIVATE_DB)
db.exec(`
  create table if not exists msg (
    fp text primary key,
    platform text not null,
    conv_id text not null,
    conv_name text,
    scope text not null,
    ts integer not null,
    dir text,
    sender text,
    text text,
    media text,
    src text,
    tag text not null default 'private',
    imported_at integer
  );
  create index if not exists idx_msg_scope_ts on msg(scope, ts);
  create table if not exists consent (id text primary key, note text, at integer);
`)
const now = Date.now()
const ins = db.prepare(`insert or ignore into msg (fp,platform,conv_id,conv_name,scope,ts,dir,sender,text,media,src,tag,imported_at)
  values (?,?,?,?,?,?,?,?,?,?,?,'private',?)`)
const fpOf = (...p) => createHash('sha1').update(p.join('|')).digest('hex')

function insert(platform, convId, convName, ts, dir, sender, text, media, src) {
  if (!convId || !Number(ts)) return 0
  const scope = `${platform}:dm:${convId}`
  return Number(ins.run(fpOf(scope, ts, dir, String(text || '')), platform, convId, convName || '', scope, Number(ts), dir || '', sender || '', String(text || ''), media || '', src || '', now).changes) || 0
}

function importDouyin() {
  if (!existsSync(DY_DIR)) return { n: 0, files: 0 }
  let n = 0, files = 0
  for (const f of readdirSync(DY_DIR).filter((x) => x.startsWith('dm-') && x.endsWith('.ndjson'))) {
    files++
    const peer = f.slice(3).replace(/-\d{4}-\d{2}-\d{2}\.ndjson$/, '')
    for (const line of readFileSync(join(DY_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      const conv = String(j.scope || '').split(':').pop() || peer
      n += insert('douyin', conv, j.peer || peer, j.ts, j.dir, j.dir === 'out' ? '小蓝' : (j.peer || peer), j.text, '', 'douyin-dm')
    }
  }
  return { n, files }
}

function importWechat() {
  if (!existsSync(WECHAT_JSONL)) return { n: 0 }
  let n = 0
  for (const line of readFileSync(WECHAT_JSONL, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    const name = PEERS.find((p) => p.wx && p.wx === j.convId)?.name || ''
    if (!name) continue
    n += insert('wechat', j.convId, name, j.t, j.dir, j.sender, j.text, j.media || '', 'wechat-bridge')
  }
  return { n }
}

function importQq() {
  if (!existsSync(CHAT_DB)) return { n: 0 }
  const src = new DatabaseSync(CHAT_DB, { readOnly: true })
  let n = 0
  try {
    for (const p of PEERS) {
      const rows = src.prepare(`select ts,dir,coalesce(sender,'') sender,coalesce(text,'') text,coalesce(media,'') media,coalesce(src,'') src
        from chat where scope = ? order by ts asc`).all(`c2c:${p.qq}`)
      for (const r of rows) n += insert('qq', p.qq, p.name, r.ts, r.dir, r.sender, r.text, r.media, r.src)
    }
  } finally { src.close() }
  return { n }
}

function stats() {
  const rows = db.prepare(`select scope, conv_name, count(*) n, min(ts) a, max(ts) b from msg group by scope order by n desc`).all()
  return rows.map((r) => ({ ...r }))
}

if (flag('stats')) {
  console.log(JSON.stringify({ ok: true, db: PRIVATE_DB, scopes: stats() }, null, 2))
} else if (flag('dump')) {
  // 只有人在场同意后才该跑这个
  const scope = arg('scope', '')
  const limit = Number(arg('limit', '20')) || 20
  const rows = db.prepare(`select ts,dir,sender,text from msg where scope = ? order by ts desc limit ?`).all(scope, limit)
  console.log(JSON.stringify({ ok: true, scope, rows: rows.reverse() }, null, 2))
} else if (flag('consent')) {
  db.prepare('insert or replace into consent (id, note, at) values (?,?,?)').run(String(arg('consent', 'manual')), String(arg('note', '')), now)
  console.log(JSON.stringify({ ok: true, consent: arg('consent', 'manual') }))
} else {
  const out = {}
  if (flag('all') || flag('douyin')) out.douyin = importDouyin()
  if (flag('all') || flag('wechat')) out.wechat = importWechat()
  if (flag('all') || flag('qq')) out.qq = importQq()
  console.log(JSON.stringify({ ok: true, db: PRIVATE_DB, ...out, scopes: stats() }, null, 2))
}
db.close()
