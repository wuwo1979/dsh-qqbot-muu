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
// 抖音投稿（真实 Chrome + CDP）：把本地成片塞进创作中心的上传框
// 用法：node scripts/douyin-cdp-upload.mjs --file "F:\...\video.mp4" --title "..." --desc "..."
// 只做「塞文件 + 填文案」，最后一步发布按钮留给人点（抖音对自动发布风控很凶）
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const CDP = 'http://127.0.0.1:9222'
const argv = process.argv.slice(2)
const arg = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const file = arg('file'), title = arg('title'), desc = arg('desc')
const out = (o) => console.log(JSON.stringify(o))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!file) { out({ ok: false, error: '缺 --file' }); process.exit(1) }

let page
try {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  page = list.find((t) => t.type === 'page')
} catch (e) { out({ ok: false, error: '连不上 Chrome（9222）' }); process.exit(1) }
if (!page) { out({ ok: false, error: '没有可用页面' }); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
let id = 0
const waiters = new Map()
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } })
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; waiters.set(mid, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: mid, method, params })) })
const run = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value
const shot = async (p) => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(p, Buffer.from(s.data, 'base64')); return p }

await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable')
await send('Page.navigate', { url: 'https://creator.douyin.com/creator-micro/content/upload' })
await sleep(9000)
const href = await run('location.href')
const shotPath = await shot(`${__repoRoot()}/tmp/dy-upload-${Date.now()}.png`)

// 找 input[type=file] 并塞文件
const doc = await send('DOM.getDocument', { depth: -1, pierce: true })
async function findInput(node) {
  if (node.nodeName === 'INPUT' && (node.attributes || []).includes('file')) return node.nodeId
  for (const c of node.children || []) { const r = await findInput(c); if (r) return r }
  for (const s of node.shadowRoots || []) { const r = await findInput(s); if (r) return r }
  for (const c of node.contentDocument ? [node.contentDocument] : []) { const r = await findInput(c); if (r) return r }
  return 0
}
const inputId = await findInput(doc.root)
if (!inputId) { out({ ok: false, error: '页面上没找到上传框', href, shot: shotPath }); ws.close(); process.exit(2) }
await send('DOM.setFileInputFiles', { files: [file], nodeId: inputId })
await sleep(6000)

// 尝试填标题/简介（创作者中心是富文本框，尽量写得宽容）
if (title) {
  await run(`(() => {
    const el = document.querySelector('input[placeholder*="标题"], textarea[placeholder*="标题"], .semi-input[placeholder*="标题"] input') || document.querySelector('input.semi-input')
    if (!el) return false
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    if (setter && el.tagName === 'INPUT') { setter.call(el, ${JSON.stringify(title)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true }
    if (el.tagName === 'TEXTAREA') { el.value = ${JSON.stringify(title)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true }
    return false
  })()`)
}
const shot2 = await shot(`${__repoRoot()}/tmp/dy-upload-${Date.now()}.png`)
const bodyText = await run('document.body.innerText.slice(0, 400)')
out({ ok: true, href, shot: shot2, needsManualPublish: true, hint: '文件已塞进去，剩下「发布」按钮需要人点（抖音对自动发布风控）', bodyText })
ws.close()
