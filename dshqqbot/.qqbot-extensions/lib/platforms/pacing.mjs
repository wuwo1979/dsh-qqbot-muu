// 平台动作节奏器 —— 给"平台上的一切写操作"统一排队、随机间隔、日配额、风控退避。
// 设计目标：让机器人的行为看起来像人，而不是定时任务或压测脚本。
// 所有平台（B 站 / 抖音 / 以后别的）都走这里，别再各自写 sleep。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { writeJsonAtomic } from '../atomic-write.mjs'
import { join, dirname } from 'node:path'

export const PACING_DEFAULTS = {
  // 两次"写操作"之间至少隔多久（毫秒）。人不会卡点，所以给随机区间。
  minGapMs: 45_000,
  maxGapMs: 240_000,
  // 同一天同一个平台上，各类写操作的硬上限。
  dailyCaps: { publish: 3, comment: 3, dynamic: 2, follow: 0, like: 0, message: 20 },
  // 命中风控（429 / 412 / -412 / 4031 / 频繁）之后，整个平台停多久。
  riskCooldownMs: 30 * 60_000,
}

const FILE = (root) => join(root, '.qqbot-extensions', 'data', 'pacing.json')

function loadRaw(root) {
  const f = FILE(root)
  try {
    if (!existsSync(f)) return { platforms: {} }
    const j = JSON.parse(readFileSync(f, 'utf8'))
    if (!j || typeof j !== 'object' || !j.platforms) return { platforms: {} }
    return j
  } catch {
    return { platforms: {} }
  }
}

function saveRaw(root, data) {
  const f = FILE(root)
  try {
    mkdirSync(dirname(f), { recursive: true })
    // [qqbot-mod] atomic-write 2026-10-27：冷却/配额状态原子写（降档状态丢失= fail-safe 反转，02 号文档纪律）
    writeJsonAtomic(f, data, 1)
    return true
  } catch {
    return false
  }
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

/** 一个平台当前的节流状态（纯读，不改盘）。 */
export function platformState(root, platform, cfg = PACING_DEFAULTS) {
  const raw = loadRaw(root)
  const p = raw.platforms[platform] || {}
  const day = today()
  const counts = p.day === day ? (p.counts || {}) : {}
  const now = Date.now()
  return {
    platform,
    lastActionAt: Number(p.lastActionAt || 0),
    nextAllowedAt: Math.max(Number(p.lastActionAt || 0) + cfg.minGapMs, Number(p.backoffUntil || 0)),
    backoffUntil: Number(p.backoffUntil || 0),
    cooling: Number(p.backoffUntil || 0) > now,
    counts,
    caps: cfg.dailyCaps,
    day,
  }
}

/**
 * 申请执行一次写操作。
 * wait=false 时只判断"现在能不能做"，返回 {ok:false, waitMs} 让调用方自己决定。
 * wait=true 时真的 sleep 到可以为止（上限 maxWaitMs，默认 5 分钟）。
 */
export async function gate(root, platform, kind, opts = {}) {
  const cfg = { ...PACING_DEFAULTS, ...(opts.cfg || {}) }
  const wait = opts.wait !== false
  const maxWaitMs = Number(opts.maxWaitMs || 5 * 60_000)
  const minGapMs = Number(opts.minGapMs || cfg.minGapMs)
  const maxGapMs = Math.max(minGapMs, Number(opts.maxGapMs || cfg.maxGapMs))
  const cap = Number((cfg.dailyCaps || {})[kind] ?? 0)

  const st = platformState(root, platform, cfg)
  const used = Number(st.counts[kind] || 0)

  if (cap > 0 && used >= cap) {
    return {
      ok: false,
      reason: 'daily-cap',
      kind,
      used,
      cap,
      msg: `今天 ${platform} 的 ${kind} 已经做了 ${used}/${cap} 次，明天再来吧（多刷只会更容易被风控）`,
    }
  }
  // 同类写操作之间要隔得比"任意两条"更久一点，避免"刚好卡在 45s"
  const sameKindLast = Number((st.counts[`${kind}At`]) || 0)
  const needAt = Math.max(
    st.lastActionAt ? st.lastActionAt + minGapMs : 0,
    sameKindLast ? sameKindLast + minGapMs * 3 : 0,
    st.backoffUntil,
  )
  const now = Date.now()
  const waitMs = Math.max(0, needAt - now)

  if (waitMs > 0) {
    if (waitMs > maxWaitMs) {
      return { ok: false, reason: 'too-soon', waitMs, msg: `要等 ${Math.ceil(waitMs / 60000)} 分钟才能再对 ${platform} 做 ${kind}，这次先算了` }
    }
    if (!wait) return { ok: false, reason: 'too-soon', waitMs, msg: `再等 ${Math.ceil(waitMs / 1000)} 秒` }
    await new Promise((r) => setTimeout(r, waitMs))
  }

  // 真正执行前再随机抖一下：让总间隔落在一个区间里，而不是恒定值
  const jitter = Math.floor(Math.random() * Math.max(1500, Math.min(maxGapMs - minGapMs, 20_000)))
  if (wait && jitter) await new Promise((r) => setTimeout(r, jitter))

  noteAction(root, platform, kind)
  return { ok: true, waitedMs: waitMs + jitter, jitterMs: jitter, used: used + 1, cap }
}

/** 记一次已执行的写操作（gate 成功会自动调；手工调用用于事后补记）。 */
export function noteAction(root, platform, kind) {
  const raw = loadRaw(root)
  const day = today()
  const p = raw.platforms[platform] || {}
  const counts = p.day === day ? (p.counts || {}) : {}
  counts[kind] = Number(counts[kind] || 0) + 1
  counts[`${kind}At`] = Date.now()
  raw.platforms[platform] = { ...p, day, counts, lastActionAt: Date.now() }
  saveRaw(root, raw)
  return raw.platforms[platform]
}

/**
 * 平台返回了风控信号时调用：整个平台进入冷却，冷却期内 gate 会直接拒绝。
 * hit 一般是 HTTP 状态码或接口里的 code/message。
 */
export function noteRisk(root, platform, hit = {}, cfg = PACING_DEFAULTS) {
  const raw = loadRaw(root)
  const p = raw.platforms[platform] || {}
  const cooldown = Number(hit.cooldownMs || cfg.riskCooldownMs)
  raw.platforms[platform] = {
    ...p,
    backoffUntil: Date.now() + cooldown,
    lastRisk: {
      at: Date.now(),
      code: hit.code ?? null,
      message: String(hit.message || '').slice(0, 200),
      cooldownMs: cooldown,
    },
  }
  saveRaw(root, raw)
  return raw.platforms[platform]
}

/** 判定一段响应文本/结构是否像"被风控了"。 */
export function looksLikeRisk(status, body) {
  if (status === 429 || status === 412 || status === 403) return true
  const s = typeof body === 'string' ? body : JSON.stringify(body || '')
  if (!s) return false
  if (/频繁|过快|稍作休息|异常|风险|风控|验证|too\s*many|rate\s*limit/i.test(s)) return true
  const m = s.match(/"(?:code|error_code)"\s*:\s*(-?\d+)/)
  if (m) {
    const c = Number(m[1])
    return [-412, -352, -403, 4031, 412, 429, 352].includes(c)
  }
  return false
}

/** 面板用：一次看所有平台的节奏状态。 */
export function allPlatformStates(root, platforms = [], cfg = PACING_DEFAULTS) {
  const out = {}
  for (const p of platforms) out[p] = platformState(root, p, cfg)
  return out
}
