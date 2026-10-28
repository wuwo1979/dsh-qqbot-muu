// 抖音平台适配 —— 登录走"官方页面 + 二维码 + 手工确认"，不伪造登录、不爆破接口。
// 现状说明（写死在代码里，免得以后有人以为能自动）：抖音网页端的写操作接口带 a_bogus / X-Bogus
// 签名与设备指纹，纯 HTTP 硬闯既脆弱又容易被判成高危机器人。所以这里的定位是：
//   1) 给出可以扫的码（官方登录页）与登录状态检测；
//   2) 把"要上传什么"准备好，交给创作者中心网页上传（一键打开）；
//   3) 所有写操作都过 pacing 闸门，绝不并发刷。
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import https from 'node:https'
import http from 'node:http'
import http2 from 'node:http2'
import { gate, noteRisk, looksLikeRisk, platformState } from './pacing.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLATFORM = 'douyin'

export const LOGIN_URL = 'https://www.douyin.com/'
// 2026-10-27 实测：creator.douyin.com / sso.douyin.com 在这台机器上 UND_ERR_CONNECT_TIMEOUT，
// but www.douyin.com/creator-micro/* 是 200 可达 ⇒ 统一走 www 前缀，链接才点得开。
// 2026-10-27：www.douyin.com/creator-micro/* 已全部 404（抖音把创作平台迁到 creator 域名）；
// 链接是给**浏览器**开的（宿主直连 creator 域名超时无所谓，浏览器走自己的通道）
export const CREATOR_URL = 'https://creator.douyin.com/creator-micro/home'
export const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'
export const COOKIE_FILE = (root) => join(root, 'douyin-cookie.json')

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 二维码：把官方地址编成 SVG（本地生成，不联网、不经过任何第三方）。 */
export async function qrSvg(text, opts = {}) {
  // vendored：.qqbot-extensions/vendor/qrcode（装在宿主可读位置，不依赖 node_modules 链）
  const vendored = join(HERE, '..', '..', 'vendor', 'qrcode', 'node_modules', 'qrcode', 'lib', 'index.js')
  const cands = [vendored, 'qrcode']
  let lastQrError = ''
  for (const c of cands) {
    try {
      const spec = c === 'qrcode' ? c : pathToFileURL(vendored).href
      const mod = await import(spec)
      const Q = mod.default || mod
      const svg = await Q.toString(String(text), {
        type: 'svg',
        margin: Number(opts.margin ?? 1),
        errorCorrectionLevel: opts.level || 'M',
        width: Number(opts.width || 260),
      })
      return { ok: true, svg }
    } catch (e) {
      lastQrError = e.message
    }
  }
  return { ok: false, error: `二维码库不可用：${lastQrError || 'qrcode 未安装'}`, url: String(text) }
}

/** 登录信息：给面板直接用（url + svg + 说明）。 */
export async function loginInfo() {
  const qr = await qrSvg(LOGIN_URL)
  return {
    platform: PLATFORM,
    label: '抖音',
    url: LOGIN_URL,
    creatorUrl: CREATOR_URL,
    uploadUrl: UPLOAD_URL,
    qr,
    howto: [
      '浏览器登录 douyin.com（抖音不开放扫码登录接口，硬算会被判风控）；',
      '用 Cookie-Editor 导出，或 F12 → Network → 任意请求 → 复制 Cookie 值：',
      '　· Cookie-Editor 的 Export As → Header String / JSON / Netscape 三种都能直接粘；',
      '　· 手抄也能用：`a=1; b=2; …` 这种 Header String 形式；',
      '把导出内容整段粘到下面输入框（JSON 数组、制表符表格都认），点「保存 Cookie」。',
    ],
    why: '抖音网页端的投稿接口要 a_bogus/X-Bogus 签名 + 设备指纹，硬算等于把自己标成高危机器人；所以这里只做登录态与成片准备，不做自动投稿。',
  }
}

export function loadCookie(root) {
  try {
    const f = COOKIE_FILE(root)
    if (!existsSync(f)) return null
    const j = JSON.parse(readFileSync(f, 'utf8'))
    if (!j || typeof j !== 'object') return null
    const raw = String(j.cookie || j.raw || '').trim()
    if (!raw) return null
    const pairs = raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf('=')
        return i > 0 ? { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim() } : null
      })
      .filter((x) => x && x.name)
    const map = {}
    for (const p of pairs) map[p.name] = p.value
    const hasSid = pairs.some((p) => /^(sessionid|sessionid_ss|sid_tt)$/.test(p.name))
    return { raw, map, pairs, hasSid, savedAt: Number(j.savedAt || 0), note: String(j.note || '') }
  } catch {
    return null
  }
}

/**
 * 三种粘贴格式都认：
 *  1) Header String —— `a=1; b=2; ...`
 *  2) Cookie-Editor 的 JSON —— [{domain,name,value,...}, ...] / {"a":"1"} / {cookies:[...]}
 *  3) Netscape —— 制表符分隔七列，`#HttpOnly_` 前缀行也算
 * 返回 { ok, header, pairs, format, hasSid } 或 { ok:false, error }
 */
export function parseCookieInput(input) {
  let raw = String(input || '')
    .replace(/^\uFEFF/, '')
    .trim()
  if (!raw) return { ok: false, error: 'Cookie 是空的' }
  // 有人会把整段请求头粘进来，先切出 Cookie: 那一行的值
  const cookieLine = raw.match(/^cookie:\s*(.+)$/im)
  if (cookieLine) raw = cookieLine[1].trim()
  if (/HTTP\/1\.1|^(GET|POST|Host:|Accept:)/im.test(raw)) {
    return { ok: false, error: '这看起来是整段请求头，请只粘 Cookie 的值（或 Cookie-Editor 导出）' }
  }

  const META = new Set(['domain', 'path', 'expires', 'secure', 'httponly', 'samesite', 'hostonly', 'session', 'expirationdate', 'storeid'])
  const pairs = []
  const push = (name, value) => {
    const n = String(name || '').trim()
    if (!n) return
    if (META.has(n.toLowerCase())) return
    pairs.push({ name: n, value: String(value ?? '') })
  }

  let format = ''
  const looksJson = /^[[{]/.test(raw)
  if (looksJson) {
    try {
      const j = JSON.parse(raw)
      const arr = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : null
      if (arr) {
        for (const c of arr) if (c && c.name) push(c.name, c.value)
        format = 'json-array'
      } else if (j && typeof j === 'object') {
        for (const [k, v] of Object.entries(j)) {
          if (v && typeof v === 'object' && 'value' in v) push(k, v.value)
          else if (typeof v === 'string') push(k, v)
        }
        format = 'json-map'
      }
    } catch {
      return { ok: false, error: 'JSON 解析失败：检查是不是完整的数组/对象（Cookie-Editor 的 JSON 导出）' }
    }
  }

  if (!format && /\t/.test(raw)) {
    for (const line of raw.split(/\r?\n/)) {
      let ln = line.trim()
      if (!ln) continue
      if (ln.startsWith('#HttpOnly_')) ln = ln.slice('#HttpOnly_'.length)
      else if (ln.startsWith('#')) continue
      const cols = ln.split('\t')
      if (cols.length >= 7) push(cols[5], cols[6])
    }
    if (pairs.length) format = 'netscape'
  }

  if (!format) {
    for (const seg of raw.split(/;|\r?\n/)) {
      const s = seg.trim()
      if (!s) continue
      const i = s.indexOf('=')
      if (i > 0) push(s.slice(0, i), s.slice(i + 1))
    }
    if (pairs.length) format = 'header'
  }

  if (!pairs.length) {
    return { ok: false, error: '没解析出任何 cookie：支持 Header String（a=1; b=2）、Cookie-Editor 的 JSON、Netscape 三种' }
  }
  // 同名去重（后者优先）
  const map = new Map()
  for (const p of pairs) map.set(p.name, p.value)
  const list = [...map.entries()].map(([name, value]) => ({ name, value }))
  const header = list.map((p) => `${p.name}=${p.value}`).join('; ')
  const hasSid = list.some((p) => /^(sessionid|sessionid_ss|sid_tt|s_v_web_id)$/.test(p.name))
  return { ok: true, header, pairs: list, format, hasSid }
}

export function saveCookie(root, rawCookie, note = '') {
  const parsed = parseCookieInput(rawCookie)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const raw = parsed.header
  if (raw.length < 20) return { ok: false, error: '只解析出 ' + raw.length + ' 个字符，Cookie 可能不全（至少要含 sessionid）' }
  const f = COOKIE_FILE(root)
  try {
    mkdirSync(dirname(f), { recursive: true })
    if (existsSync(f)) {
      try {
        writeFileSync(`${f}.bak-${Date.now()}`, readFileSync(f, 'utf8'), 'utf8')
      } catch {}
    }
    writeFileSync(
      f,
      JSON.stringify(
        { savedAt: Date.now(), note: String(note || ''), format: parsed.format, cookie: raw, pairs: parsed.pairs },
        null,
        1,
      ),
      'utf8',
    )
    return { ok: true, path: f, bytes: raw.length, count: parsed.pairs.length, format: parsed.format, hasSid: parsed.hasSid }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function headers(cookie) {
  const h = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: CREATOR_URL,
    origin: 'https://creator.douyin.com',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  }
  if (cookie) h.cookie = cookie
  return h
}

/**
 * 用 www.douyin.com 的 self profile 接口验登录态。
 * 实测（2026-10-27）：这个端点**不需要 a_bogus 签名**，带 Cookie 就回 status_code:0 + user；
 * 而 creator.douyin.com / sso.douyin.com 在这台机器上是 UND_ERR_CONNECT_TIMEOUT（连不上），
 * 所以核验只能走 www.douyin.com。
 */
/**
 * 双路 HTTP：宿主进程的网络栈和普通 Node 不一样（Electron 内嵌运行时），
 * global fetch 在宿主里对 douyin 域名全部超时（2026-10-27 实测：同一台机器
 * shell 直连 86-177ms，宿主 6s×3 全超时）。所以这里不用 fetch：
 *   ① node:https 直连（绕开任何 undici/代理拦截）
 *   ② 失败且环境里有 HTTPS_PROXY 时，手动 CONNECT 隧道再试（宿主可能只能出代理）
 * 返回 { httpStatus, text } 或 throw。
 */
function proxyTunnel(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl)
    const req = http.request({
      host: u.hostname, port: Number(u.port) || 80, method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: { host: targetHost + ':' + targetPort, 'user-agent': 'node' },
      timeout: timeoutMs,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket)
      else { socket.destroy(); reject(new Error('代理 CONNECT 失败（' + res.statusCode + '）')) }
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('代理 CONNECT 超时')) })
    req.on('error', reject)
    req.end()
  })
}

function httpsSend(urlStr, { headers = {}, timeoutMs = 8000, method = 'GET', body = null, socket = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const req = https.request({
      host: u.hostname, port: Number(u.port) || 443, path: u.pathname + u.search, method,
      headers, timeout: timeoutMs,
      ...(socket ? { socket, agent: false } : {}),
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) res.destroy() })
      res.on('end', () => resolve({ httpStatus: res.statusCode, text: data, headers: res.headers }))
    })
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })) })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

export async function netText(urlStr, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 8000)
  let lastErr = null
  try {
    return await httpsSend(urlStr, { ...opts, timeoutMs })
  } catch (e) { lastErr = e }
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (proxy && !opts.noProxy) {
    try {
      const u = new URL(urlStr)
      const socket = await proxyTunnel(proxy, u.hostname, Number(u.port) || 443, timeoutMs)
      return await httpsSend(urlStr, { ...opts, timeoutMs, socket })
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('网络不可达')
}

export async function profileSelf(cookie, opts = {}) {
  const url = 'https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383'
  return netText(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://www.douyin.com/',
      cookie,
    },
    timeoutMs: Number(opts.timeoutMs || 6000),
  })
}

/**
 * 登录态检测。抖音对裸请求很敏感，所以：
 *  - 没有 cookie → 直接 logged-out（不打扰服务器）；
 *  - 有 cookie → 只打一个只读接口，命中风控就记冷却并如实返回 blocked，绝不重试。
 */
const LAST_STATUS_FILE = (root) => join(root, 'data', 'douyin-ops', 'last-status.json')

function writeStatusCache(root, s) {
  try {
    mkdirSync(join(root, 'data', 'douyin-ops'), { recursive: true })
    writeFileSync(LAST_STATUS_FILE(root), JSON.stringify({ at: Date.now(), loggedIn: s.loggedIn, nickname: s.nickname, uid: s.uid, uniqueId: s.uniqueId, stats: s.stats }))
  } catch {}
}

function readStatusCache(root) {
  try { return JSON.parse(readFileSync(LAST_STATUS_FILE(root), 'utf8')) } catch { return null }
}

export async function status(root, opts = {}) {
  const ck = loadCookie(root)
  const st = platformState(root, PLATFORM)
  const base = {
    platform: PLATFORM,
    label: '抖音',
    url: LOGIN_URL,
    creatorUrl: CREATOR_URL,
    uploadUrl: UPLOAD_URL,
    pacing: st,
    cookieAt: ck?.savedAt || 0,
    cookieBytes: ck?.raw?.length || 0,
    cookieCount: Array.isArray(ck?.pairs) ? ck.pairs.length : 0,
  }
  if (!ck) return { ...base, ok: true, loggedIn: false, reason: 'no-cookie', hint: '还没登录：把 Cookie-Editor 导出的内容（Header String / JSON / Netscape）粘到下面的框里保存；抖音不开放扫码登录' }
  if (st.cooling) {
    return {
      ...base,
      ok: true,
      loggedIn: null,
      reason: 'cooldown',
      hint: `平台在冷却中（到 ${new Date(st.backoffUntil).toLocaleTimeString()}），这段时间不探测也不操作`,
    }
  }
  try {
    // 网络瞬断重试（宿主进程偶发 UND_ERR_CONNECT_TIMEOUT / ETIMEDOUT，一次就报"状态未知"太误判；
    // 只对网络层错误重试）。
    // [qqbot-mod] budget-guard 2026-10-27：整个重试循环受「总预算」硬约束——
    // netText 失败后会再走代理隧道（CONNECT+发送≈2×单次超时），不做总预算的话
    // 3 次×18s≈56s，直接把账号总览拖过浮窗客户端的 HTTP 超时，出现"读取失败：空返回"。
    let httpStatus = 0
    let text = ''
    let netErr = null
    const budgetMs = Math.min(Number(opts.budgetMs || 0) || 7000, 8000)
    const t0 = Date.now()
    const probe = { ...opts, timeoutMs: 6000 }
    for (let i = 0; i < 3; i++) {
      const remain = budgetMs - (Date.now() - t0)
      // 剩余预算不够再打一轮（单次最坏 = 直连+代理隧道 ≈ 3×单次超时）就收手，交给缓存兜底
      const attempt = Math.min(6000, Math.max(1500, Math.floor(remain / 3)))
      if (i && remain < 1600) break
      if (i) await new Promise((d) => setTimeout(d, 400 * i))
      try {
        ;({ httpStatus, text } = await profileSelf(ck.raw, { ...probe, timeoutMs: attempt }))
        netErr = null
        break
      } catch (e) {
        netErr = e
      }
    }
    if (netErr) throw netErr
    if (looksLikeRisk(httpStatus, text)) {
      noteRisk(root, PLATFORM, { code: httpStatus, message: text.slice(0, 160) })
      return { ...base, ok: true, loggedIn: null, reason: 'risk', hint: '抖音这边把请求判成风险了，已进入 30 分钟冷却，期间不再探测' }
    }
    let j = null
    try {
      j = JSON.parse(text)
    } catch {
      return { ...base, ok: true, loggedIn: null, reason: 'not-json', hint: `接口回了非 JSON（HTTP ${httpStatus}），可能页面结构变了` }
    }
    const code = Number(j?.status_code ?? j?.code ?? 0)
    if (code === 0 && j?.user && (j.user.uid || j.user.sec_uid)) {
      const u = j.user
      const out = {
        ...base,
        ok: true,
        loggedIn: true,
        nickname: String(u.nickname || ''),
        uid: String(u.uid || ''),
        uniqueId: String(u.unique_id || u.short_id || ''),
        secUid: String(u.sec_uid || ''),
        stats: {
          follower: Number(u.follower_count || 0),
          following: Number(u.following_count || 0),
          aweme: Number(u.aweme_count || 0),
          liked: Number(u.total_favorited || 0),
        },
        hint: '已登录（www.douyin.com 自检通过）',
      }
      writeStatusCache(root, out)
      return out
    }
    if (code !== 0) {
      return { ...base, ok: true, loggedIn: false, reason: 'expired', hint: `Cookie 可能失效了（status_code ${code}），重新导出一次` }
    }
    return { ...base, ok: true, loggedIn: false, reason: 'no-user', hint: '接口没回 user 字段，Cookie 大概率没带对（缺 sessionid？）' }
  } catch (e) {
    const code = (e && e.cause && e.cause.code) || ''
    const msg = code || ((e && e.message) || '').slice(0, 60)
    // 缓存兑底：宿主网络环境对 douyin 抖損时，至少把上次成功核验的结果亮出来，
    // 不要把明明有效的账号显示成「状态未知」（2026-10-27 主人被这个误导了一下午）
    const c = readStatusCache(root)
    const ageMin = c ? Math.round((Date.now() - c.at) / 60000) : 0
    if (c && c.loggedIn) {
      return {
        ...base,
        ok: true,
        loggedIn: true,
        stale: true,
        nickname: c.nickname, uid: c.uid, uniqueId: c.uniqueId, stats: c.stats,
        hint: `已登录（上次在线核验 ${ageMin >= 1 ? ageMin + ' 分钟前' : '刚刚'}通过；本次在线核验失败：${msg}。Cookie 还在，不影响手动上传）`,
      }
    }
    return {
      ...base,
      ok: true,
      loggedIn: null,
      reason: 'net',
      hint: `在线核验失败（${msg}）：Cookie 已经存下了（${base.cookieCount} 条${ck?.hasSid === false ? '，但没有 sessionid' : ''}），不影响你打开创作者中心手动上传；网络好了再点「🔄 刷新」就会重新核验`,
    }
  }
}

// ═══ [[douyin-sign] 只读数据：vendored abogus 本地生成 a_bogus 签名 ═══
// 实测（2026-10-27，本机 + 真实 Cookie）：
//   · /aweme/v1/web/comment/list/  —— 带本地 a_bogus 签名即可用（code 0，真实评论）✅
//   · /aweme/v1/web/aweme/post/    —— ArgusSecurityPlugin "Signature Not Found" ❌（签名之外还要设备票）
//   · /aweme/v1/web/aweme/detail/  —— 同上 ❌
// 所以"作品列表"自动拉不到，让用户把抖音 App 的分享链接粘进浮窗即可；只读、不写不评。
const __req = createRequire(join(HERE, 'noop.js'))
let __AB = null
function ab() {
  if (__AB !== null) return __AB
  for (const c of [join(HERE, '..', '..', 'vendor', 'abogus', 'node_modules', 'abogus'), 'abogus']) {
    try { __AB = __req(c); break } catch {}
  }
  if (!__AB) __AB = false
  return __AB
}

let __msToken = ''
async function msToken() {
  if (__msToken) return __msToken
  try { __msToken = await ab().getValidMsToken(UA) } catch {}
  if (!__msToken) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    __msToken = encodeURIComponent(Array.from({ length: 116 }, () => chars[(Math.random() * chars.length) | 0]).join(''))
  }
  return __msToken
}

let __webid = ''
function webid() {
  if (!__webid) { try { __webid = String(ab().getWebid(UA)) } catch {} }
  return __webid
}

/** 带签名的只读 GET。签名与请求用同一个 UA（指纹里含 UA，对不上会被拒）。 */
export async function signedGet(root, path, extra, opts = {}) {
  const AB = ab()
  if (!AB) return { ok: false, error: '本地签名库没装上（.qqbot-extensions/vendor/abogus）' }
  const ck = loadCookie(root)
  if (!ck || !ck.raw) return { ok: false, needCookie: true, error: '还没保存抖音 Cookie，先在「账号管理」里粘一次' }
  const url = 'https://www.douyin.com' + path
  const params = {
    device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
    version_code: '170400', version_name: '17.4.0',
    cookie_enabled: 'true', screen_width: '1920', screen_height: '1080',
    browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome',
    browser_version: '126.0.0.0', browser_online: 'true', engine_name: 'Blink', engine_version: '126.0.0.0',
    os_name: 'Windows', os_version: '10', cpu_core_num: '8', device_memory: '8', platform: 'PC',
    downlink: '10', effective_type: '4g', round_trip_time: '50',
    webid: webid(), uifid: (ck.map && ck.map.UIFID) || '', msToken: (ck.map && ck.map.msToken) || (await msToken()),
    ...extra,
  }
  const { searchParams, aBogus } = AB.signParams(params, { url, body: '', userAgent: UA })
  searchParams.set('a_bogus', aBogus)
  // 走双路 netText（node:https 直连 + 代理隧道回退），不走 global fetch——
  // 宿主进程里 fetch 对 douyin 全超时（2026-10-27 实测），评论/状态共用这条通路
  const r = await netText(url + '?' + searchParams.toString(), {
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: opts.referer || 'https://www.douyin.com/',
      cookie: ck.raw,
    },
    timeoutMs: Number(opts.timeoutMs || 12000),
  })
  return { ok: r.httpStatus === 200, httpStatus: r.httpStatus, text: r.text }
}

/**
 * 认视频链接。三种输入都行：
 *  1) 抖音 App 分享短链：https://v.douyin.com/xxxx/（302 跳转里带真实 ID）
 *  2) 完整链接：https://www.douyin.com/video/7xxx（或 ?modal_id=7xxx）
 *  3) 纯数字视频 ID
 */
export async function parseVideoLink(text) {
  const s = String(text || '').trim()
  if (!s) return { ok: false, error: '把抖音 App 的分享内容整段粘进来（App 里点「复制链接」后直接粘，不用手拣）' }
  // 宽松匹配（2026-10-27 主人要求）：分享文本混着文案/表情也照收，只从里面抠链接或 ID
  // ① 显式视频路径：/video/6532… /note/… ?modal_id=… ?item_ids=… aweme_id=… awemeId=…
  const m1 = s.match(/(?:video|modal_id|note|item_ids|aweme_id|awemeId)[=/](\d{15,25})/)
  if (m1) return { ok: true, awemeId: m1[1] }
  // ② 纯 ID
  if (/^\d{15,25}$/.test(s)) return { ok: true, awemeId: s }
  // ③ 短链（v.douyin.com/xxx，分享文本里最常见，可能被文案包着）
  const m2 = s.match(/v\.douyin\.com\/([A-Za-z0-9_-]+)/)
  if (m2) return expandShort(m2[1])
  // ④ iesdouyin 老版分享页
  const m4 = s.match(/iesdouyin\.com\/share\/(?:video|note|general)\/(\d{15,25})/)
  if (m4) return { ok: true, awemeId: m4[1], via: 'iesdouyin' }
  // ⑤ 兜底：文本里独立的 7 开头 18-19 位数字串（aweme id 形态）
  const m5 = s.match(/(?:^|\D)(7\d{16,19})(?:\D|$)/)
  if (m5) return { ok: true, awemeId: m5[1], via: 'loose-digits' }
  return { ok: false, error: '没认出视频链接：在抖音 App 里点「分享 → 复制链接」，把整段内容粘进来即可（文案带表情也没关系）；或粘 /video/ 链接、纯数字 ID' }
}

/** HTTP/2 GET：v.douyin.com 只认 h2（2026-10-27 实测：TCP 51ms 通，但 h1.1 请求被静默黑洞；浏览器能用就是因为 h2）。 */
function h2Get(urlStr, { headers = {}, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const session = http2.connect(u.origin, { settings: { enablePush: false } })
    session.on('error', (e) => { try { session.close() } catch {} ; reject(e) })
    const timer = setTimeout(() => { try { session.close() } catch {} ; reject(Object.assign(new Error('h2 请求超时'), { code: 'ETIMEDOUT' })) }, timeoutMs)
    const req = session.request({
      ':method': 'GET', ':path': u.pathname + u.search, ':authority': u.host, ':scheme': 'https',
      'user-agent': headers['user-agent'] || UA, accept: headers.accept || '*/*',
      ...(headers.cookie ? { cookie: headers.cookie } : {}),
      ...(headers.referer ? { referer: headers.referer } : {}),
    })
    let status = 0
    let loc = ''
    let text = ''
    req.on('response', (h) => { status = Number(h[':status'] || 0); loc = String(h.location || '') })
    req.setEncoding('utf8')
    req.on('data', (c) => { text += c; if (text.length > 4 * 1024 * 1024) req.close() })
    req.on('error', (e) => { clearTimeout(timer); try { session.close() } catch {} ; reject(e) })
    req.on('close', () => {
      clearTimeout(timer)
      try { session.close() } catch {}
      resolve({ httpStatus: status, text, headers: { location: loc } })
    })
    req.end()
  })
}

/** 展开 v.douyin.com 短链：h2 优先（唯一能通的协议），回退 h1/代理隧道，最后如实报错。 */
async function expandShort(code) {
  const url = 'https://v.douyin.com/' + code + '/'
  const pick = (loc, via) => {
    const m = String(loc || '').match(/(?:video|modal_id|note|item_ids|aweme_id)[=/](\d{15,25})/)
    return m ? { ok: true, awemeId: m[1], via } : null
  }
  // ① h2
  try {
    const r = await h2Get(url, { headers: { 'user-agent': UA }, timeoutMs: 8000 })
    const hit = pick(r.headers.location, 'short-link-h2')
      || (r.httpStatus === 200 ? pick(String(r.text || '').match(/(?:video|modal_id|note|item_ids|aweme_id)[=/](\d{15,25})/), 'short-link-h2-html') : null)
    if (hit) return hit
  } catch {}
  // ② h1 + 代理隧道
  try {
    const r = await netText(url, { headers: { 'user-agent': UA }, timeoutMs: 6000 })
    const hit = pick(r.headers && r.headers.location, 'short-link-h1')
    if (hit) return hit
  } catch {}
  return { ok: false, error: '短链这台机器解析不了（douyin 短链只认浏览器同款 h2 通道）：在浏览器里打开短链，等跳到 /video/… 后把地址栏完整链接粘进来；或直接粘作品数字 ID' }
}

/** 拉评论列表（只读，不发送任何评论）。按接口原序返回；上层要按赞排序自己排。 */
export async function commentList(root, awemeId, opts = {}) {
  const id = String(awemeId || '')
  if (!/^\d{15,25}$/.test(id)) return { ok: false, error: '视频 ID 不对：' + id.slice(0, 40) }
  const st = platformState(root, PLATFORM)
  if (st.cooling) return { ok: false, cooling: true, error: '平台在冷却中（到 ' + new Date(st.backoffUntil).toLocaleTimeString() + '），先歇一会儿' }
  try {
    const r = await signedGet(root, '/aweme/v1/web/comment/list/', {
      aweme_id: id,
      cursor: String(Number(opts.cursor || 0) || 0),
      count: String(Math.min(50, Number(opts.count || 20) || 20)),
      item_type: '0',
    }, { referer: 'https://www.douyin.com/video/' + id })
    if (!r.ok && r.httpStatus !== 200) {
      if (looksLikeRisk(r.httpStatus, r.text)) {
        noteRisk(root, PLATFORM, { code: r.httpStatus, message: r.text.slice(0, 160) })
        return { ok: false, risk: true, error: '被风控了（HTTP ' + r.httpStatus + '），已进 30 分钟冷却，期间不再探测' }
      }
      return { ok: false, error: '拉评论失败：HTTP ' + r.httpStatus }
    }
    let j = null
    try { j = JSON.parse(r.text) } catch { return { ok: false, error: '接口回了非 JSON（HTTP ' + r.httpStatus + '），可能被风控，稍后再试' } }
    if (Number(j.status_code ?? 0) !== 0) return { ok: false, error: '接口报错 status_code=' + j.status_code }
    const list = (j.comments || []).filter(Boolean).map((c) => ({
      cid: String(c.cid || ''),
      text: String(c.text || '').slice(0, 500),
      nickname: String((c.user && c.user.nickname) || '').slice(0, 40),
      digg: Number(c.digg_count || 0),
      at: Number(c.create_time || 0) * 1000,
      replies: Number(c.reply_comment_total || 0),
    }))
    return {
      ok: true,
      awemeId: id,
      total: Number(j.total || list.length),
      cursor: Number(j.cursor || 0),
      hasMore: Number(j.has_more || 0) === 1,
      comments: list,
    }
  } catch (e) {
    return { ok: false, error: (e.cause && e.cause.code) || e.message }
  }
}

/**
 * [qqbot-mod] video-detail 2026-10-27：视频详情（视频雷达用）。
 * 走与 comment/list 同一条 a_bogus 签名通路；失败时退回分享页 HTML 抠标题。
 */
export async function videoDetail(root, awemeId, opts = {}) {
  const id = String(awemeId || '')
  if (!/^\d{15,25}$/.test(id)) return { ok: false, error: '视频 ID 不对：' + id.slice(0, 40) }
  try {
    const r = await signedGet(root, '/aweme/v1/web/aweme/detail/', {
      aweme_id: id,
    }, { referer: 'https://www.douyin.com/video/' + id, timeoutMs: Number(opts.timeoutMs || 10000) })
    if (r.ok) {
      try {
        const j = JSON.parse(r.text)
        const a = j && j.aweme_detail
        if (a) {
          const st = a.statistics || {}
          return {
            ok: true,
            id,
            title: String(a.desc || '').slice(0, 200),
            author: String((a.author && a.author.nickname) || '').slice(0, 40),
            url: 'https://www.douyin.com/video/' + id,
            stats: {
              digg: Number(st.digg_count || 0), comment: Number(st.comment_count || 0),
              share: Number(st.share_count || 0), play: Number(st.play_count || 0),
            },
            durationMs: Number(a.duration || 0),
            cover: String((a.video && a.video.cover && (a.video.cover.url_list || [])[0]) || ''),
          }
        }
      } catch { /* 落到 HTML 兜底 */ }
    }
    // 兜底：分享页抠 desc（不签名、只读）
    const h = await netText('https://www.douyin.com/video/' + id, {
      headers: { 'user-agent': UA, accept: 'text/html', cookie: (loadCookie(root) || {}).raw || '' },
      timeoutMs: 8000,
    })
    if (h.httpStatus === 200) {
      const m = String(h.text || '').match(/<title[^>]*>([^<]{2,200})<\/title>/)
      if (m) {
        return { ok: true, id, title: m[1].replace(/ - 抖音$/, '').trim(), author: '', url: 'https://www.douyin.com/video/' + id, stats: null, via: 'html' }
      }
    }
    return { ok: false, error: '拉视频详情失败（HTTP ' + r.httpStatus + '）' }
  } catch (e) {
    return { ok: false, error: (e.cause && e.cause.code) || e.message }
  }
}

/**
 * 操作记账：追加一条到 data/douyin-ops/records.jsonl（与 B 站 bili-ops 的 records 同构）。
 * 只记本地动作（存 cookie / 拉评论 / 起草 / 打开创作者中心），抖音线上状态一律不伪造。
 */
export function opsLog(root, type, detail = {}) {
  const dir = join(root, 'data', 'douyin-ops')
  const file = join(dir, 'records.jsonl')
  try {
    mkdirSync(dir, { recursive: true })
    const rec = { at: new Date().toISOString(), type, ...detail }
    appendFileSync(file, JSON.stringify(rec) + '\n')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

export function opsRead(root, { limit = 50 } = {}) {
  const file = join(root, 'data', 'douyin-ops', 'records.jsonl')
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((s) => s.trim())
    return { ok: true, records: lines.slice(-limit).reverse().map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean), total: lines.length }
  } catch {
    return { ok: true, records: [], total: 0 }
  }
}

/**
 * [qqbot-mod] douyin-like 2026-10-28：给抖音视频点赞 / 取消赞（尽力而为）。
 *
 * 实测结论（`tmp/probe-dy-actions.mjs` / `probe-dy-actions2.mjs`）：
 *  · `/aweme/v1/web/commit/item/digg/` 在 a_bogus 签名下回 **403（空 body）**，
 *    与 `/aweme/v1/web/aweme/post/` 的 `Blocked by ArgusSecurityPlugin Signature Not Found` 同类；
 *  · 也就是说"点赞"这条写路径还要 Argus/X-Bogus 级签名，本机只有 a_bogus；
 *  · 所以本函数会把 403 明确翻成"需要更强签名"的人话，不当成"网络错误"。
 * 只读路径（视频详情 / 评论列表）是通的，喜欢就先用它们。
 */
export async function diggVideo(root, { awemeId, like = true } = {}) {
  const id = String(awemeId || '').trim()
  if (!/^\d{15,25}$/.test(id)) return { ok: false, error: '视频 ID 不对：' + id.slice(0, 40) }
  const st = platformState(root, PLATFORM)
  if (st.cooling) return { ok: false, cooling: true, error: '抖音在冷却中（到 ' + new Date(st.backoffUntil).toLocaleTimeString() + '），先歇一会儿' }
  try {
    const r = await signedGet(root, '/aweme/v1/web/commit/item/digg/', {
      aweme_id: id,
      type: like ? '1' : '0',
      channel_id: '0',
    }, { referer: 'https://www.douyin.com/video/' + id })
    if (r.httpStatus === 403) {
      return {
        ok: false,
        blocked: true,
        httpStatus: 403,
        error: '抖音点赞被签名挡住（403 / ArgusSecurityPlugin）——a_bogus 不够，得 X-Bogus/Argus 那种设备票；这条路径暂时做不了，建议在 App 里手动点，或把视频链给我由我打开页面',
      }
    }
    if (!r.ok) {
      if (looksLikeRisk(r.httpStatus, r.text)) {
        noteRisk(root, PLATFORM, { code: r.httpStatus, message: String(r.text || '').slice(0, 160) })
        return { ok: false, risk: true, error: '被风控了（HTTP ' + r.httpStatus + '），已进 30 分钟冷却' }
      }
      return { ok: false, error: '点赞失败：HTTP ' + r.httpStatus }
    }
    let j = null
    try { j = JSON.parse(r.text) } catch { return { ok: false, error: '接口回了非 JSON（可能被风控）' } }
    if (Number(j.status_code ?? 0) !== 0) return { ok: false, error: '接口报错 status_code=' + j.status_code + ' ' + String(j.status_msg || '') }
    return { ok: true, awemeId: id, liked: !!like, msg: like ? '已点赞' : '已取消赞' }
  } catch (e) {
    return { ok: false, error: (e.cause && e.cause.code) || e.message }
  }
}

/**
 * 我关注/互关的人（只读）。实测 `/aweme/v1/web/im/spotlight/relation/` 会回 JSON（status_code 0），
 * 但对方账号 followings 常常是空数组 —— 拿得到就拿，拿不到就老实说"平台没给"。
 */
export async function followingList(root, { count = 20 } = {}) {
  try {
    const r = await signedGet(root, '/aweme/v1/web/im/spotlight/relation/', { count: String(count), cursor: '0' })
    if (!r.ok) return { ok: false, httpStatus: r.httpStatus, error: '拉关注列表失败：HTTP ' + r.httpStatus, users: [] }
    let j = null
    try { j = JSON.parse(r.text) } catch { return { ok: false, error: '接口回了非 JSON', users: [] } }
    const arr = Array.isArray(j.followings) ? j.followings : []
    return {
      ok: true,
      total: arr.length,
      users: arr.map((u) => ({
        nickname: String(u.nickname || '').slice(0, 40),
        uniqueId: String(u.unique_id || ''),
        secUid: String(u.sec_uid || ''),
      })),
      note: arr.length === 0 ? '平台这次没给关注列表（接口 200 但 followings 为空），私信只能去 App 里手动发' : '',
    }
  } catch (e) {
    return { ok: false, error: (e.cause && e.cause.code) || e.message, users: [] }
  }
}

// ── [[douyin-replies] 回复待审队列：和 B 站"待审评论"同构的管理件 ──
// 抖音自动发评论被设备票挡死，所以队列的终点是"复制去手动发"：可编辑、可复制、可标记已发。
const REPLIES_FILE = (root) => join(root, 'data', 'douyin-ops', 'replies.jsonl')

function __repliesRead(root) {
  try {
    return readFileSync(REPLIES_FILE(root), 'utf8').split('\n').filter((s) => s.trim())
      .map((s) => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

/** 起草一条回复进待审（同一评论重复起草会更新原草稿而不是堆重复）。 */
export function replyDraft(root, { awemeId, nickname, comment, text, videoUrl } = {}) {
  const list = __repliesRead(root)
  const key = String(awemeId || '') + '|' + String(comment || '').slice(0, 60)
  const prev = list.find((r) => r.key === key && r.status === 'pending')
  if (prev) {
    if (text) prev.text = String(text).slice(0, 300)
    prev.updatedAt = Date.now()
  } else {
    list.push({
      id: 'dy-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5),
      key,
      awemeId: String(awemeId || ''),
      nickname: String(nickname || ''),
      comment: String(comment || '').slice(0, 300),
      text: String(text || '').slice(0, 300),
      videoUrl: String(videoUrl || ''),
      status: 'pending',
      createdAt: Date.now(),
    })
  }
  try {
    mkdirSync(join(root, 'data', 'douyin-ops'), { recursive: true })
    writeFileSync(REPLIES_FILE(root), list.slice(-200).map((r) => JSON.stringify(r)).join('\n'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

export function replyList(root) {
  const list = __repliesRead(root)
  return { ok: true, replies: list.slice(-60).reverse(), total: list.length }
}

/** 更新待审回复：改文字 / 标记已发 / 删除。 */
export function replyUpdate(root, { id, text, status } = {}) {
  const list = __repliesRead(root)
  const r = list.find((x) => x.id === id)
  if (!r) return { ok: false, error: '找不到这条待审回复' }
  if (text != null) r.text = String(text).slice(0, 300)
  if (status != null) r.status = String(status)
  if (status === 'sent') r.sentAt = Date.now()
  r.updatedAt = Date.now()
  try {
    writeFileSync(REPLIES_FILE(root), list.map((x) => JSON.stringify(x)).join('\n'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 写操作之前统一过闸门；抖音的写操作目前只有"准备好要发的东西"，所以只用于配额记账。 */
export async function gateAction(root, kind, opts = {}) {
  return gate(root, PLATFORM, kind, opts)
}

export const CAPABILITIES = {
  login: { auto: false, how: '官方登录页 + 二维码 + 手工粘 Cookie' },
  upload: { auto: false, how: '生成成片后一键打开创作者中心上传页（抖音要签名，不做自动投稿）' },
  publish: { auto: false, how: '同上' },
  comment: { auto: true, how: '只读评论（本地 a_bogus 签名，粘贴视频链接即读）；回复仍走手工，不做自动评论' },
  analytics: { auto: false, how: '登录态与账号统计可见；作品级数据要设备票，暂不自动拉' },
}
