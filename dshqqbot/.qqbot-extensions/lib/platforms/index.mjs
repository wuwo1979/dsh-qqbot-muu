// 账号管理：把各平台收在一个入口下，面板只跟这里说话。
// 目标：浮窗里「B 站管理」变成「账号管理」，B 站、抖音各一张卡；
// 每个平台自己声明"能自动化到什么程度"，不假装能做的能力。
import * as bili from '../bili-api.mjs'
import * as douyin from './douyin.mjs'
import { platformState } from './pacing.mjs'

export const PLATFORM_IDS = ['bili', 'douyin']

export const PLATFORM_META = {
  bili: {
    id: 'bili',
    label: 'B 站',
    site: 'https://www.bilibili.com',
    homeUrl: 'https://member.bilibili.com/platform/home',
    uploadUrl: 'https://member.bilibili.com/platform/upload/video/frame',
    capabilities: {
      // [qqbot-mod] s-tier 2026-10-27：自治光谱定档（学自 ops-handoff-design 02 号文档）
      // S2=无害全自动 S3=人批计划机执行 S4=动作级人批准 S5=仅人
      login: { auto: true, tier: 'S1', how: '扫码（web 二维码接口）' },
      upload: { auto: true, tier: 'S3', how: 'upos 分片 + /x/vu/web/add' },
      publish: { auto: true, tier: 'S3', how: '审核通过后自动投稿（requireApproval）' },
      comment: { auto: true, tier: 'S2', how: '限速发表 + 匿名复核是否公开（草稿需人批= S4）' },
      analytics: { auto: true, tier: 'S2', how: '阅读历史/播放心跳/稿件状态' },
      rename: { auto: false, tier: 'S5', how: '6 个月只能改一次，绝不代发' },
    },
  },
  douyin: {
    id: 'douyin',
    label: '抖音',
    site: 'https://www.douyin.com',
    homeUrl: douyin.CREATOR_URL,
    uploadUrl: douyin.UPLOAD_URL,
    capabilities: douyin.CAPABILITIES,
  },
}

async function biliStatus(root) {
  const ck = bili.loadCookie(root)
  const st = platformState(root, 'bili')
  const base = {
    platform: 'bili',
    label: 'B 站',
    paced: st,
    cookieAt: ck?.savedAt || ck?.savedAtMs || 0,
  }
  if (!ck) return { ...base, ok: true, loggedIn: false, reason: 'no-cookie', hint: '还没登录：点「扫码登录」' }
  try {
    const r = await bili.nav(root)
    // [qqbot-mod] 2026-10-28 修「明明登录了却显示未登录」：nav() 成功时返回 { ok, data:{mid,name,…} }，
    //   没有.loggedIn字段（未登录/失效它自己就回 ok:false）——之前检查 r.loggedIn 恒为 undefined，
    //   导致有效登录态被误判成 expired。
    if (r && r.ok) {
      return { ...base, ok: true, loggedIn: true, nickname: (r.data && (r.data.name || r.data.uname)) || '', uid: (r.data && r.data.mid) || '', hint: '已登录' }
    }
    return { ...base, ok: true, loggedIn: false, reason: 'expired', hint: r?.error || '登录态失效，重新扫码' }
  } catch (e) {
    return { ...base, ok: true, loggedIn: null, reason: 'net', hint: e.message }
  }
}

/**
 * [qqbot-mod] budget-guard 2026-10-27：总预算硬闸。
 * 账号总览是浮窗首屏，客户端 HTTP 超时 30s；网络坏时 douyin 重试链 + bili nav(15s fetch)
 * 可能拖到 50s+，客户端 abort 后只显示"读取失败：空返回"。
 * 这里给每个平台的核验 promise 限时，到点不再等，降级返回（抖音侧另有 last-status.json 缓存兑底）。
 */
function withBudget(p, ms, degrade) {
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => { if (!done) { done = true; resolve(degrade('核验超时')) } }, ms)
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } },
      (e) => { if (!done) { done = true; clearTimeout(t); resolve(degrade(String((e && e.message) || e))) } },
    )
  })
}

/**
 * [qqbot-mod] overview-cache 2026-10-27：进程内 TTL 缓存 + 单飞（single-flight）。
 * 学自 ops-handoff-design 06 号文档 §3.2：面板与数据层同进程时，
 * 进程内缓存就够（不落盘快照）；并发请求合并成一次重算。
 * 总览只用来点亮页签角标，30s 新鲜度足够；force=true（点🔄）绕过缓存。
 */
const __ovCache = new Map() // root -> { at, data, promise }
const OVERVIEW_TTL = 30000

/** 所有平台一眼看全（面板「账号管理」首屏角标）。 */
export async function overview(root, opts = {}) {
  const force = !!opts.force
  const cached = __ovCache.get(root)
  // 单飞不分 force 与否：并发请求一律合并（force 只绕 TTL，不绕单飞——否则连点两下刷新就是两次重算）
  if (cached && cached.promise) return cached.promise
  if (!force && cached && cached.data && Date.now() - cached.at < OVERVIEW_TTL) return cached.data
  const entry = cached || { at: 0, data: null, promise: null }
  entry.promise = (async () => {
    const data = await __overviewCompute(root, opts)
    entry.data = data
    entry.at = Date.now()
    return data
  })().finally(() => { entry.promise = null; __ovCache.set(root, entry) })
  __ovCache.set(root, entry)
  return entry.promise
}

async function __overviewCompute(root, opts) {
  const budget = Math.min(Number(opts.budgetMs || 0) || 8500, 12000)
  const deg = (id) => (m) => ({
    platform: id, label: PLATFORM_META[id]?.label || id, ok: true, loggedIn: null, reason: 'timeout',
    hint: `在线核验超时（${m}），账号数据可能不准；Cookie 没动，点「🔄 刷新」重试`,
  })
  const [b, d] = await Promise.all([
    withBudget(biliStatus(root), budget, deg('bili')),
    withBudget(douyin.status(root, { budgetMs: budget - 1500 }), budget, deg('douyin')),
  ])
  return {
    ok: true,
    root,
    checkedAt: Date.now(),
    platforms: [b, d],
    meta: PLATFORM_META,
  }
}

export async function detail(root, id) {
  if (id === 'douyin') {
    const s = await douyin.status(root, { budgetMs: 8000 })
    const info = await douyin.loginInfo()
    return { ok: true, status: s, login: info, meta: PLATFORM_META.douyin }
  }
  if (id === 'bili') {
    const s = await biliStatus(root)
    let qr = null
    try {
      const g = await bili.qrGenerate()
      qr = g && g.ok ? { url: g.url, key: g.key, qr: g.qr } : null
    } catch (e) {
      qr = { error: e.message }
    }
    return { ok: true, status: s, qr, meta: PLATFORM_META.bili }
  }
  return { ok: false, error: `未知平台：${id}` }
}
