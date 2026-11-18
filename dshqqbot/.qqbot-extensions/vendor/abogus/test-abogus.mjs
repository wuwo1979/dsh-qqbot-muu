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
// 实测：abogus 签名 + 真实 cookie 能不能拉到抖音作品列表和评论（只读）
import * as douyin from pathToFileURL(join(__repoRoot(), "dshqqbot/.qqbot-extensions/lib/platforms/douyin.mjs")).href
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const AB = require(__repoRoot() + "/dshqqbot/.qqbot-extensions/vendor/abogus/node_modules/abogus")

const root = __repoRoot() + "/dshqqbot"
const st = await douyin.status(root)
const ck = douyin.loadCookie(root)
console.log('login:', st.loggedIn, st.nickname, 'aweme count:', st.stats && st.stats.aweme)

const UA = douyin.UA
const uifid = (ck.map && ck.map.UIFID) || ''
const msToken = (ck.map && ck.map.msToken) || (await AB.getValidMsToken(UA))
const webid = AB.getWebid(UA)

function baseParams() {
  return {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '126.0.0.0',
    browser_online: 'true',
    engine_name: 'Blink',
    engine_version: '126.0.0.0',
    os_name: 'Windows',
    os_version: '10',
    cpu_core_num: '8',
    device_memory: '8',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '50',
    webid,
    uifid,
    msToken,
  }
}

async function signedGet(path, extra, referer) {
  const params = { ...baseParams(), ...extra }
  const url = 'https://www.douyin.com' + path
  const { searchParams, aBogus } = AB.signParams(params, { url, body: '', userAgent: UA })
  searchParams.set('a_bogus', aBogus)
  console.log('  [sign] a_bogus len', aBogus.length, 'msToken len', String(msToken).length)
  const full = url + '?' + searchParams.toString()
  const r = await fetch(full, {
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: referer || 'https://www.douyin.com/',
      cookie: ck.raw,
    },
    signal: AbortSignal.timeout(15000),
  })
  const text = await r.text()
  return { httpStatus: r.status, text }
}

// 1) 作品列表
let p = await signedGet('/aweme/v1/web/aweme/post/', {
  sec_uid: st.secUid, max_cursor: '0', count: '10', publish_video_strategy_type: '2', source: '0',
}, 'https://www.douyin.com/user/' + st.secUid)
console.log('POST-LIST http', p.httpStatus, 'len', p.text.length)
let list = []
try {
  const j = JSON.parse(p.text)
  list = j.aweme_list || []
  console.log('  code', j.status_code, 'items', list.length, list.slice(0, 3).map((a) => a.aweme_id + ':' + String(a.desc || '').slice(0, 24)))
} catch { console.log('  body:', p.text.slice(0, 120)) }

if (!list.length) process.exit(0)
const aid = list[0].aweme_id

// 2) 评论列表
let c = await signedGet('/aweme/v1/web/comment/list/', {
  aweme_id: aid, cursor: '0', count: '20', item_type: '0',
}, 'https://www.douyin.com/video/' + aid)
console.log('COMMENT-LIST http', c.httpStatus, 'len', c.text.length)
try {
  const j = JSON.parse(c.text)
  console.log('  code', j.status_code, 'total', j.total, 'comments', (j.comments || []).length)
  for (const cm of (j.comments || []).slice(0, 5)) {
    console.log('   ·', cm.user && cm.user.nickname, '#', String(cm.text || '').slice(0, 40), '| 赞', cm.digg_count, '| cid', cm.cid)
  }
} catch { console.log('  body:', c.text.slice(0, 120)) }
