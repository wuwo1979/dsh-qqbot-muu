import { existsSync as __existsSync } from 'node:fs'
const __repoRoot = (() => {
  let cached = ''
  const norm = (p) => String(p || '').split(String.fromCharCode(92)).join('/')
  return () => {
    if (cached) return cached
    const cands = []
    const env = String(process.env.QQBOT_ROOT || process.env.QQBOT_REPO_ROOT || '').trim()
    if (env) cands.push(norm(env))
    try {
      let here = decodeURIComponent(new URL('.', import.meta.url).pathname)
      if (here[0] === '/' && here[2] === ':') here = here.slice(1)
      here = norm(here).replace(/\/+$/, '')
      let d = here
      for (let i = 0; i < 6; i += 1) {
        if (!d) break
        cands.push(d)
        const k = d.lastIndexOf('/')
        d = k > 0 ? d.slice(0, k) : ''
      }
    } catch { /* noop */ }
    try { cands.push(norm(process.cwd())) } catch { /* noop */ }
    for (const c of cands) {
      try {
        if (c && (__existsSync(c + '/qqbot-mod/muu-shared.mjs') || __existsSync(c + '/dshqqbot'))) { cached = c; return cached }
      } catch { /* noop */ }
    }
    cached = norm(cands.find(Boolean) || '.')
    return cached
  }
})()
/**
 * person-link.mjs — 跨渠道「同一个人」归并（读侧并集 + 写侧规范 scope）
 *
 * 与 person-registry.mjs 的区别：那个管 QQ 群昵称 → personId（防改名串号），
 * 这个管「微信 wxid / QQ openid / 小天才腕表 id 其实是同一个人」。
 *
 * 为什么不在 chat 表里 UPDATE scope：
 *   chat 的主键 fp 含 scope（id:<scope>:<msgId> / h:sha1(scope|...)），
 *   批量改 scope 会让不同来源的同一条消息撞主键、丢掉历史。所以：
 *     · 新写入用规范 scope `c2c:<personId>`；
 *     · 老数据不动，读侧 aliasesFor(scope) 取全部历史 scope 做并集。
 *
 * 合并来源（按优先级）：
 *   1. <repo>/wechat-bridge/people.json      wxid ↔ qqId ↔ 名字
 *   2. <repo>/xtc-bridge/people.json         xtcId（常是占位）
 *   3. <dataRoot>/.qqbot/xtc-peers.json      真实腕表 id → 名字
 *   4. <dataRoot>/.qqbot/persons.json        人工覆盖层（可选）
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CACHE_MS = 10_000
const cache = new Map() // dataRoot -> { at, stamp, reg }

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function mtime(p) {
  try { return statSync(p).mtimeMs } catch { return 0 }
}

/** 看起来像「平台 id」而不是昵称 */
function looksLikeId(a) {
  const s = String(a || '')
  return /^\d{5,}$/.test(s) || /^[0-9A-Fa-f]{16,}$/.test(s) || /^wxid_/.test(s) || /^xtc_/.test(s)
}

/** 找仓库根：dataRoot 的上一级（<仓库根>），或环境变量，或已知路径 */
export function repoRootOf(dataRoot) {
  const cands = []
  if (process.env.QQBOT_REPO_ROOT) cands.push(String(process.env.QQBOT_REPO_ROOT))
  cands.push(dirname(String(dataRoot || '')))
  cands.push(__repoRoot() + "")
  for (const c of cands) {
    try { if (c && existsSync(join(c, 'wechat-bridge', 'people.json'))) return c } catch { /* ignore */ }
  }
  return dirname(String(dataRoot || '.'))
}

export function isGroupConv(id) {
  const s = String(id || '')
  return s.endsWith('@chatroom') || s.startsWith('group:') || s.startsWith('g:') || /@gid$/.test(s)
}

function uniq(a) { return [...new Set(a.filter(Boolean).map(String))] }

function emptyPerson(id) {
  return { id: String(id), name: '', relation: '', self: false, aliases: { qq: [], wechat: [], xtc: [] } }
}

function aliasAdd(p, kind, v) {
  const s = String(v || '').trim()
  if (!s || isGroupConv(s)) return
  const arr = p.aliases[kind] || (p.aliases[kind] = [])
  if (!arr.includes(s)) arr.push(s)
}

function buildReg(dataRoot) {
  const repo = repoRootOf(dataRoot)
  const wxPath = join(repo, 'wechat-bridge', 'people.json')
  const xtcPath = join(repo, 'xtc-bridge', 'people.json')
  const peersPath = join(String(dataRoot || '.'), '.qqbot', 'xtc-peers.json')
  const overlayPath = join(String(dataRoot || '.'), '.qqbot', 'persons.json')

  const persons = new Map() // id -> person
  const byName = new Map()  // 名字 -> [person]

  const ensure = (id) => {
    const k = String(id)
    if (!persons.has(k)) persons.set(k, emptyPerson(k))
    return persons.get(k)
  }
  const rememberName = (p) => {
    if (!p.name) return
    if (!byName.has(p.name)) byName.set(p.name, [p])
    else if (!byName.get(p.name).includes(p)) byName.get(p.name).push(p)
  }

  // 1) 微信人物库
  const wx = readJson(wxPath)
  const wxPeople = Array.isArray(wx) ? wx : (wx?.people || [])
  for (const it of wxPeople) {
    const wxid = String(it?.wxid || it?.id || '').trim()
    if (!wxid || isGroupConv(wxid)) continue
    if (/小蓝自己的微信账号/.test(String(it?.relation || ''))) continue
    const qqId = String(it?.qqId || '').trim()
    const p = ensure(qqId || wxid)
    if (!p.name) p.name = String(it?.name || it?.nick || '') || p.id
    if (!p.relation) p.relation = String(it?.relation || '')
    aliasAdd(p, 'wechat', wxid)
    if (qqId) aliasAdd(p, 'qq', qqId)
    rememberName(p)
  }

  // 2) 小天才人物库（xtcId 多为占位）
  const xtc = readJson(xtcPath)
  const xtcPeople = Array.isArray(xtc) ? xtc : (xtc?.people || [])
  for (const it of xtcPeople) {
    const xid = String(it?.xtcId || it?.id || '').trim()
    const name = String(it?.name || it?.nick || '').trim()
    if (!xid && !name) continue
    const p = ensure(xid || `xtc:${name}`)
    if (!p.name) p.name = name || p.id
    if (!p.relation) p.relation = String(it?.relation || '')
    for (const a of (it?.aliases || [])) aliasAdd(p, 'xtc', a)
    // 腕表 id（watchId）也归到同一个人：小天才的消息有时带的是 watchId 而不是 imAccountId
    for (const w of (it?.watchIds || [])) aliasAdd(p, 'xtc', String(w))
    if (xid) aliasAdd(p, 'xtc', xid)
    rememberName(p)
  }

  // 3) 腕表真实 id → 昵称（把占位 xtcId 与真实 id 并成一个人）
  const peers = readJson(peersPath)
  if (peers && typeof peers === 'object' && !Array.isArray(peers)) {
    for (const [id, name] of Object.entries(peers)) {
      const nm = String(name || '').trim()
      if (!/^\d{4,}$/.test(String(id)) || !nm) continue
      const p = byName.get(nm)?.[0] || ensure(String(id))
      if (!p.name) p.name = nm
      aliasAdd(p, 'xtc', id)
      rememberName(p)
    }
  }

  // 4) 人工覆盖层 {persons:[{id,name,aliases:{qq,wechat,xtc}}]}
  const ov = readJson(overlayPath)
  for (const it of (Array.isArray(ov) ? ov : (ov?.persons || []))) {
    const ids = [it?.id, ...(it?.aliases?.qq || []), ...(it?.aliases?.wechat || []), ...(it?.aliases?.xtc || [])].filter(Boolean)
    let p = ids.map((x) => persons.get(String(x))).find(Boolean)
    if (!p && it?.name) p = byName.get(String(it.name))?.[0]
    if (!p) p = ensure(String(it?.id || it?.name || `p_${Date.now().toString(36)}`))
    if (it?.name && !p.name) p.name = String(it.name)
    if (it?.relation && !p.relation) p.relation = String(it.relation)
    for (const k of ['qq', 'wechat', 'xtc']) for (const a of (it?.aliases?.[k] || [])) aliasAdd(p, k, a)
  }

  // 群会话不参与「人」的归并
  for (const p of [...persons.values()]) if (isGroupConv(p.id)) persons.delete(p.id)

  const mergeInto = (keep, drop) => {
    for (const k of ['qq', 'wechat', 'xtc']) for (const a of drop.aliases[k]) aliasAdd(keep, k, a)
    if (!keep.relation) keep.relation = drop.relation
    if (!keep.name) keep.name = drop.name
  }

  // 同名多份（占位 xtcId + 真实腕表 id）合并
  for (const [, group] of byName) {
    if (group.length < 2) continue
    const score = (p) => (p.aliases.qq.length ? 8 : 0) + (p.aliases.wechat.length ? 4 : 0) +
      p.aliases.xtc.filter((a) => /^\d{5,}$/.test(a)).length * 2 + (p.relation ? 1 : 0)
    const keep = group.slice().sort((a, b) => score(b) - score(a))[0]
    for (const p of group) {
      if (p === keep || !persons.has(p.id)) continue
      mergeInto(keep, p)
      persons.delete(p.id)
    }
  }

  // 定规范 id：QQ 16+ hex > wxid > 数字腕表 id > 其余
  const pickId = (p) => {
    const qq = p.aliases.qq.find((a) => /^[0-9A-Fa-f]{16,}$/.test(a))
    if (qq) return qq
    const wx = p.aliases.wechat.find((a) => a.startsWith('wxid_'))
    if (wx) return wx
    const xtcNum = p.aliases.xtc.find((a) => /^\d{5,}$/.test(a))
    if (xtcNum) return xtcNum
    return p.aliases.xtc[0] || p.aliases.qq[0] || p.aliases.wechat[0] || p.id
  }

  const finalMap = new Map()
  for (const p of persons.values()) {
    const id = pickId(p)
    const hit = finalMap.get(id)
    if (hit) { mergeInto(hit, p); continue }
    p.id = id
    p.scope = `c2c:${id}`
    finalMap.set(id, p)
  }

  const out = []
  const byAlias = new Map()
  for (const p of finalMap.values()) {
    p.aliases.qq = uniq(p.aliases.qq)
    p.aliases.wechat = uniq(p.aliases.wechat)
    p.aliases.xtc = uniq(p.aliases.xtc)
    p.scope = `c2c:${p.id}`
    out.push(p)
    byAlias.set(p.scope, p)
    byAlias.set(p.id, p)
    for (const k of ['qq', 'wechat', 'xtc']) {
      for (const a of p.aliases[k]) {
        byAlias.set(`${k}:${a}`, p)
        if (k !== 'wechat') byAlias.set(`c2c:${a}`, p)
      }
    }
  }
  return { persons: out, byAlias, files: [wxPath, xtcPath, peersPath, overlayPath] }
}

export function loadPeople(dataRoot) {
  const root = String(dataRoot || '.')
  const repo = repoRootOf(root)
  const stamp = [join(repo, 'wechat-bridge', 'people.json'), join(repo, 'xtc-bridge', 'people.json'),
    join(root, '.qqbot', 'xtc-peers.json'), join(root, '.qqbot', 'persons.json')].map(mtime).join('|')
  const hit = cache.get(root)
  if (hit && hit.stamp === stamp && Date.now() - hit.at < CACHE_MS) return hit.reg
  const reg = buildReg(root)
  cache.set(root, { at: Date.now(), stamp, reg })
  return reg
}

/** 按平台 id 找人，找不到 null */
export function personFor(dataRoot, platform, id) {
  const reg = loadPeople(dataRoot)
  const s = String(id || '').trim()
  if (!s) return null
  return reg.byAlias.get(`${platform}:${s}`) || reg.byAlias.get(`c2c:${s}`) || null
}

/**
 * 写侧规范 scope。
 *   私聊、能对上人 → c2c:<personId>
 *   私聊、对不上   → 保持渠道原生形状（wechat:<id> / c2c:<id>）
 *   群             → group:<id>（微信沿用 wechat:<id>，历史如此）
 */
export function scopeFor(dataRoot, platform, convId, opts = {}) {
  const s = String(convId || '').trim()
  if (!s) return ''
  if (opts.isGroup || isGroupConv(s)) return platform === 'wechat' ? `wechat:${s}` : `group:${s}`
  const p = personFor(dataRoot, platform, s)
  if (p) return p.scope
  if (platform === 'wechat') return `wechat:${s}`
  return `c2c:${s}`
}

/** 读侧并集：这个 scope 背后的人还有哪些历史 scope（只收 id 形状，不收昵称） */
export function aliasesFor(dataRoot, scope) {
  const s = String(scope || '').trim()
  if (!s) return []
  const reg = loadPeople(dataRoot)
  const p = reg.byAlias.get(s) || reg.byAlias.get(`c2c:${s}`) || reg.byAlias.get(`wechat:${s}`) || reg.byAlias.get(s.replace(/^[a-z]+:/, ''))
  if (!p) return [s]
  const out = new Set([s, p.scope])
  for (const a of [...p.aliases.qq, ...p.aliases.wechat, ...p.aliases.xtc]) {
    if (!looksLikeId(a)) continue
    out.add(`c2c:${a}`)
    out.add(a)
    if (a.startsWith('wxid_')) out.add(`wechat:${a}`)
  }
  return [...out]
}

/** 给日志/提示用的名字 */
export function nameForScope(dataRoot, scope) {
  const reg = loadPeople(dataRoot)
  const p = reg.byAlias.get(String(scope || ''))
  return p?.name || String(scope || '').replace(/^(c2c|wechat|group):/, '')
}

export function listPersons(dataRoot) {
  return loadPeople(dataRoot).persons.slice()
}

export default { repoRootOf, isGroupConv, loadPeople, personFor, scopeFor, aliasesFor, nameForScope, listPersons }
