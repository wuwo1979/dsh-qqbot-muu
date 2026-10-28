/**
 * persona-fresh.mjs —— 印象「保鲜」：判断哪些卡/状态已经旧了，并按需重建。
 *
 * 背景（主人 2026-10-27）：
 *   面板里的「当前状态」和印象卡长期不更新，看起来永远停在同一天；
 *   卡片是该更新的（新的切片已经进来了），但没人触发。
 *
 * 这一层只做三件事：
 *   1) freshness()：算每张卡的年龄、有没有"新切片但卡没更新"、心情是否过期；
 *   2) staleTargets()：挑出该重建的人（按"有多旧"排序，限量）；
 *   3) refresh()：调 profile-digest.digestPerson 重建；自我卡用 character.json 重写。
 *
 * 所有写操作都走既有的 setPersona / digestPerson，不新增数据结构。
 */
import { openDb } from './memory-db.mjs'
import { setPersona, getPersonaValue } from './memory.mjs'
import { loadConfig } from './memory-db.mjs'
import { GLOBAL_SCOPE, MOOD_KEY } from './profile-core.mjs'
import { loadCharacter, buildSelfCard, resolveCardIdentity, splitRelationName } from './memory-panel-core.mjs'

export const FRESH_DEFAULTS = {
  cardTtlMs: 36 * 3600 * 1000, // 卡超过 36h 视为该更新
  moodTtlMs: 30 * 60 * 1000, // 与 memory-config.json 的 mood.ttlMs 对齐
  sliceLookbackMs: 3 * 24 * 3600 * 1000, // 只看近 3 天的切片
  budget: 2, // 一次自动刷新最多重建几个人
}

function num(v, d = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

function openRw(root) {
  const o = openDb(root)
  return o && o.db ? o.db : null
}

/** 读所有印象卡（ckey 以 card: 开头），顺手算切片数。 */
export function readCards(root) {
  const db = openRw(root)
  if (!db) return []
  let rows = []
  try {
    rows = db.prepare("SELECT scope, ckey, cvalue, ts FROM persona WHERE ckey LIKE 'card:%'").all()
  } catch {
    return []
  }
  const now = Date.now()
  return rows.map((r) => {
    const key = String(r.ckey || '')
    const raw = String(r.cvalue || '')
    const i = raw.indexOf('：')
    return {
      scope: String(r.scope || ''),
      key,
      person: key.slice('card:'.length),
      name: i > 0 ? raw.slice(0, i) : '',
      text: i > 0 ? raw.slice(i + 1) : raw,
      ts: num(r.ts),
      ageMs: num(r.ts) ? now - num(r.ts) : -1,
    }
  })
}

/** 某个人的切片概况：条数 + 最近一条的时间。 */
export function sliceStats(root, person = '') {
  const db = openRw(root)
  if (!db) return { n: 0, lastTs: 0 }
  const p = String(person || '').trim()
  try {
    const row = p
      ? db.prepare('SELECT COUNT(*) AS n, MAX(ts) AS t FROM persona WHERE ckey LIKE ?').get('slice:' + p + ':%')
      : db.prepare("SELECT COUNT(*) AS n, MAX(ts) AS t FROM persona WHERE ckey LIKE 'slice:%'").get()
    return { n: num(row && row.n), lastTs: num(row && row.t) }
  } catch {
    return { n: 0, lastTs: 0 }
  }
}

/** 当前心情（按 scope 取最新一条）+ 是否过期。 */
export function moodInfo(root, scope = '', cfg = {}) {
  const ttl = num((cfg && cfg.mood && cfg.mood.ttlMs) || FRESH_DEFAULTS.moodTtlMs, FRESH_DEFAULTS.moodTtlMs)
  const db = openRw(root)
  if (!db) return { text: '', ts: 0, ageMs: -1, expired: true, scope: '' }
  const sc = String(scope || '').trim()
  let row = null
  try {
    row = sc
      ? db.prepare("SELECT scope, cvalue, ts FROM persona WHERE ckey = ? AND scope = ? ORDER BY ts DESC LIMIT 1").get(MOOD_KEY, sc)
      : null
    if (!row) {
      row = db.prepare('SELECT scope, cvalue, ts FROM persona WHERE ckey = ? ORDER BY ts DESC LIMIT 1').get(MOOD_KEY)
    }
  } catch {
    row = null
  }
  if (!row) return { text: '', ts: 0, ageMs: -1, expired: true, scope: '' }
  const ts = num(row.ts)
  const ageMs = ts ? Date.now() - ts : -1
  return {
    text: String(row.cvalue || '').trim(),
    ts,
    ageMs,
    expired: ageMs < 0 || ageMs > ttl,
    ttlMs: ttl,
    scope: String(row.scope || ''),
  }
}

/**
 * 整体保鲜状态：每张卡的年龄 / 是否"有新切片但没更新" / 心情过期与否。
 * 纯读，不花 token，面板每次刷新都能算。
 */
export function freshness(root, cfg = {}) {
  const f = { ...FRESH_DEFAULTS, ...((cfg && cfg.personaFresh) || {}) }
  const cards = readCards(root)
  const now = Date.now()
  const selfNames = new Set()
  let char = null
  try {
    char = loadCharacter(root)
    for (const n of [char && char.name, ...((char && char.aliases) || [])]) {
      if (n && String(n).trim()) selfNames.add(String(n).trim())
    }
  } catch { /* 没档案就只按名字算 */ }

  const rows = cards.map((c) => {
    const isSelf = selfNames.has(String(c.name || '').trim()) || selfNames.has(String(c.person || '').trim())
    const st = sliceStats(root, c.person)
    const newSlices = st.lastTs > c.ts + 60 * 1000
    const tooOld = c.ageMs > f.cardTtlMs
    return {
      ...c,
      self: isSelf,
      slices: st.n,
      lastSliceTs: st.lastTs,
      newSlices,
      tooOld,
      stale: isSelf ? tooOld : tooOld || newSlices,
      why: newSlices ? '有新切片没消化' : (tooOld ? '卡太旧' : ''),
    }
  })

  // 心情：取最"新鲜"的那条，并明确是否过期（面板不该再拿过期状态当"当前"）
  const db = openRw(root)
  let moods = []
  try {
    moods = (db ? db.prepare('SELECT scope, cvalue, ts FROM persona WHERE ckey = ? ORDER BY ts DESC').all(MOOD_KEY) : [])
      .map((r) => {
        const ts = num(r.ts)
        const ageMs = ts ? now - ts : -1
        return {
          scope: String(r.scope || ''),
          text: String(r.cvalue || '').trim(),
          ts,
          ageMs,
          expired: ageMs < 0 || ageMs > num((cfg && cfg.mood && cfg.mood.ttlMs) || f.moodTtlMs),
        }
      })
  } catch { moods = [] }

  const stale = rows.filter((r) => r.stale)
  return {
    ok: true,
    checkedAt: now,
    cardTtlMs: f.cardTtlMs,
    cards: rows,
    staleCount: stale.length,
    stale: stale
      .sort((a, b) => (b.newSlices - a.newSlices) || (b.ageMs - a.ageMs))
      .map((r) => ({ person: r.person, name: r.name, self: r.self, ageMs: r.ageMs, slices: r.slices, why: r.why })),
    mood: moods[0] || { text: '', ts: 0, ageMs: -1, expired: true, scope: '' },
    moods,
    cardCount: rows.length,
  }
}

/** 该刷新的目标（跳过自我：自我卡走 writeSelfCard，不花摘要 token）。 */
export function staleTargets(root, cfg = {}) {
  const f = freshness(root, cfg)
  return (f.stale || []).filter((x) => !x.self && x.person)
}

/**
 * 用 character.json 重写"我自己"这张卡，并把 ts 刷新。
 * 参数 extra 可以塞一段"最近的自我反思"，让卡不只有静态人设。
 */
export function writeSelfCard(root, { extra = '', cfg = {} } = {}) {
  let char = null
  try { char = loadCharacter(root) } catch { char = null }
  if (!char || !char.name) return { ok: false, reason: 'no-character' }
  const bits = []
  let self = ''
  try {
    const sc0 = buildSelfCard(char)
    self = sc0 && sc0.text ? String(sc0.text) : ''
  } catch { self = '' }
  if (self) bits.push(self)
  const ex = String(extra || '').trim()
  if (ex) bits.push(ex)
  const alias = (char.aliases || []).filter(Boolean).join('、')
  const text = (char.name || '我') + '：' + (alias ? '（' + alias + '）' : '') + bits.join('　')
  const sc = (cfg && cfg.selfCardScope) || GLOBAL_SCOPE
  const r = setPersona(root, sc, { ckey: 'card:' + char.name, cvalue: String(text).slice(0, 300), weight: 2 })
  return r && r.ok ? { ok: true, text: text.slice(0, 120), scope: sc } : { ok: false, reason: (r && r.reason) || 'write-fail' }
}

/**
 * 按需重建：先自我卡（便宜），再重建最多 budget 个过期的人（花 token，节流由 digestPerson 自己管）。
 * mode:
 *   'stale'  → 自我卡 + budget 个最旧的人
 *   'self'   → 只重写自我卡
 *   'person' → 指定 senderId（args.senderId / args.name 反查卡）
 */
export async function refresh(root, { mode = 'stale', senderId = '', name = '', budget, force = false, cfg = {}, llmCfg = null, chatImpl = null } = {}) {
  const f = { ...FRESH_DEFAULTS, ...((cfg && cfg.personaFresh) || {}) }
  const cfgAll = cfg && cfg.digest ? cfg : { ...(cfg || {}), digest: { ...((cfg && cfg.digest) || {}) } }
  // 先收敛重复卡（角色词/别名 → 真人），这一步不花 token，但能避免面板/提示里出现两份
  let dedupe = null
  try { dedupe = dedupeCards(root, { dryRun: false }) } catch { dedupe = null }
  if (mode === 'self') {
    const r = writeSelfCard(root, { cfg })
    return { ok: !!r.ok, mode, self: r, did: [] }
  }
  // 找到目标
  let targets = []
  if (mode === 'person') {
    const want = String(senderId || '').trim()
    if (want) targets = [{ person: want, name: String(name || ''), self: false }]
    else if (name) {
      const hit = readCards(root).find((c) => String(c.name || '').trim() === String(name).trim())
      if (hit) targets = [{ person: hit.person, name: hit.name, self: false }]
    }
  } else {
    targets = staleTargets(root, cfg)
  }
  const cap = Math.max(1, Math.min(6, num(budget, f.budget)))
  const picked = targets.slice(0, force ? cap : cap)

  let digestPerson = null
  try { digestPerson = (await import('./profile-digest.mjs')).digestPerson } catch { digestPerson = null }

  const did = []
  for (const t of picked) {
    if (!t.person || !digestPerson) { did.push({ ...t, ok: false, reason: 'no-digester' }); continue }
    try {
      const r = await digestPerson({ dataRoot: root, senderId: t.person, cfg: cfgAll, llmCfg, chatImpl, force: !!force })
      did.push({ person: t.person, name: t.name, ok: !!(r && r.ok), reason: (r && r.reason) || '', ms: (r && r.ms) || 0 })
    } catch (e) {
      did.push({ person: t.person, name: t.name, ok: false, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  const self = mode === 'stale' ? writeSelfCard(root, { cfg }) : null
  return { ok: true, mode, self, did, remaining: Math.max(0, targets.length - picked.length) }
}

/**
 * 把库里重复的卡真正合并掉（不只是面板显示时合并）。
 *
 * 现状（2026-10-27）：persona 表里同时存在
 *   card:5F38…（内容 "对方：妈妈是小蓝的妈妈…"）、card:妈妈妈妈、card:妈妈
 * 三张说的是同一个人，面板每轮都要在显示层做一次归并，而且"妈妈"这张还会被
 * 模型反复写回来。这里做一次性收敛：
 *   · 用 character.json 的 roleOwner/relationOf 把角色词映射到真人；
 *   · 合并文字（信息不丢），写到真人那张卡上（ts 用最新）；
 *   · 删掉角色词那几条。返回 {ok, merged:[], removed:[]}
 */
export function dedupeCards(root, { dryRun = false } = {}) {
  let char = null
  try { char = loadCharacter(root) } catch { char = null }
  if (!char || !char.name) return { ok: false, reason: 'no-character', merged: [], removed: [] }
  const selfNames = new Set([String(char.name || '').trim(), ...((char.aliases || []).map((x) => String(x || '').trim()))].filter(Boolean))
  const ctx = { roleOwner: char.roleOwner || {}, relationOf: char.relationOf || {}, selfNames, display: char.display || char.name }
  const cards = readCards(root)
  const groups = new Map()
  for (const c of cards) {
    if (selfNames.has(String(c.name || '').trim()) || selfNames.has(String(c.person || '').trim())) continue
    let nm = String(c.name || '').trim()
    // "对方/某人/ta" 这种泛称：从正文里认出真人（模型常写 "对方：妈妈是小蓝的妈妈…"）
    if (!nm || /^(对方|某人|他|她|ta|TA|用户|对方是)/.test(nm)) {
      const body = String(c.text || '')
      const hitName = Object.keys(ctx.relationOf || {}).find((k) => k && body.includes(k))
      if (hitName) nm = hitName
    }
    const id = resolveCardIdentity(nm, ctx)
    const canon = String(id && id.name ? id.name : nm || '').trim()
    if (!canon) continue
    const k = canon
    if (!groups.has(k)) groups.set(k, { canon, items: [] })
    groups.get(k).items.push(c)
  }
  const merged = []
  const removed = []
  for (const g of groups.values()) {
    if (g.items.length < 2) continue
    // 文字去重拼接（先长者优先，避免"妈妈"这种短句盖掉长卡）
    const seen = new Set()
    const parts = []
    for (const it of g.items.slice().sort((a, b) => String(b.text || '').length - String(a.text || '').length)) {
      const t = String(it.text || '').trim()
      if (!t) continue
      const key = t.replace(/\s+/g, '').slice(0, 40)
      if (seen.has(key)) continue
      seen.add(key)
      parts.push(t)
    }
    const text = parts.join('　').slice(0, 300)
    const newest = Math.max(...g.items.map((x) => x.ts))
    // 目标行优先选"按 id 记的"那条（card:<openid>）：模型以后还会往 id 上写，
    // 保住它才不会每次合并都丢 sid 关联；没有 id 行才退回 card:<真名>。
    const idLike = (p) => /^[0-9A-Za-z_-]{16,}$/.test(String(p || ''))
    const target = g.items.find((x) => idLike(x.person)) || g.items.find((x) => x.key === 'card:' + g.canon) || g.items[0]
    const scope = (target && target.scope) || GLOBAL_SCOPE
    if (!dryRun) {
      setPersona(root, scope, { ckey: target.key, cvalue: g.canon + '：' + text, weight: 2 })
      const db = openRw(root)
      for (const it of g.items) {
        if (it.key === target.key && it.scope === target.scope) continue
        try { db.prepare('DELETE FROM persona WHERE ckey = ? AND scope = ?').run(it.key, it.scope) } catch { /* ignore */ }
        removed.push(it.key)
      }
    }
    merged.push({ canon: g.canon, into: target.key, from: g.items.map((x) => x.key), chars: text.length, ts: newest })
  }
  return { ok: true, merged, removed }
}

function splitRelationNameSafe(s) {
  try { return splitRelationName(s) } catch { return s }
}

/** 一次性把状态+卡都算出来，给面板/工具用。 */
export function status(root, scope = '', cfg = {}) {
  const fr = freshness(root, cfg)
  const m = moodInfo(root, scope, cfg)
  return { ok: true, freshness: fr, mood: m }
}
