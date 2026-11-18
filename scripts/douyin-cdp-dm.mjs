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
// 抖音私信发送（真实 Chrome + CDP，绕过 web 写接口的 WAF 403）
// 用法：
//   node scripts/douyin-cdp-dm.mjs --peer <昵称> --text "妈，本鲸来打招呼啦～咕噜"
//   node scripts/douyin-cdp-dm.mjs --peer <昵称> --text "…" --dry     只打开会话、不发送
//   node scripts/douyin-cdp-dm.mjs --close                            关掉自己拉起的 Chrome
// 说明：首次会把 douyin-cookie.json 注入一个独立 profile（tmp/chrome-dy），不动你日常浏览器。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import WebSocket from 'ws'

const ROOT = __repoRoot() + ""
const PROFILE = join(ROOT, 'tmp', 'chrome-dy')
const CHROME = (process.env.CHROME_PATH || String((process.env.ProgramFiles || 'C:/Program Files') ).split(String.fromCharCode(92)).join('/') + '/Google/Chrome/Application/chrome.exe')
const PORT = 9222
const CDP = `http://127.0.0.1:${PORT}`

const argv = process.argv.slice(2)
const arg = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const flag = (name) => argv.includes(`--${name}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[dy]', ...a)

async function ensureChrome() {
  try {
    const v = await fetch(`${CDP}/json/version`)
    if (v.ok) return (await v.json()).Browser || 'chrome'
  } catch {}
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`)
  mkdirSync(PROFILE, { recursive: true })
  try {
    spawn(CHROME, [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1100,720',
      'about:blank',
    ], { detached: true, stdio: 'ignore' }).unref()
  } catch (e) {
    log('自动拉起 Chrome 被拦（', e.code || e.message, '），先手动启动：')
    log(`powershell -NoProfile -Command "Start-Process '${CHROME}' -ArgumentList '--remote-debugging-port=${PORT}','--user-data-dir=${PROFILE}','about:blank'"`)
    throw e
  }
  for (let i = 0; i < 40; i += 1) {
    await sleep(500)
    try {
      const v = await fetch(`${CDP}/json/version`)
      if (v.ok) return (await v.json()).Browser || 'chrome'
    } catch {}
  }
  throw new Error('Chrome 调试口没起来（9222）')
}

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  const target = list.find((t) => t.type === 'page')
  if (!target) throw new Error('没有可用的页面 target')
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let id = 0
  const waiters = new Map()
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    waiters.set(mid, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  const run = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value
  return { ws, send, run }
}

async function injectCookies(send) {
  const file = join(ROOT, 'dshqqbot', 'douyin-cookie.json')
  if (!existsSync(file)) throw new Error('还没保存抖音 Cookie')
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const cookies = []
  for (const seg of String(j.cookie || '').split(';')) {
    const i = seg.indexOf('=')
    if (i <= 0) continue
    const name = seg.slice(0, i).trim()
    if (!name) continue
    cookies.push({ name, value: seg.slice(i + 1).trim(), domain: '.douyin.com', path: '/', secure: true, httpOnly: false })
  }
  await send('Network.enable')
  await send('Network.setCookies', { cookies })
  return cookies.length
}

async function openChat(send, run) {
  if (!String(await run('location.href')).includes('/chat')) {
    await send('Page.navigate', { url: 'https://www.douyin.com/chat' })
    await sleep(9000)
  }
}

async function clickPeer(run, send, peer) {
  const hit = await run(`(() => {
    const rows = Array.from(document.querySelectorAll('div,li,a')).filter(e => {
      const t = (e.textContent||'').trim();
      const r = e.getBoundingClientRect();
      return t.startsWith(${JSON.stringify(peer)}) && r.width > 150 && r.width < 400 && r.height > 40 && r.height < 140;
    });
    if (!rows.length) return null;
    const el = rows[rows.length - 1];
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + 20), y: Math.round(r.y + r.height/2) };
  })()`)
  if (!hit) return false
  await sleep(2500)
  return true
}

async function findBox(run) {
  return run(`(() => {
    const el = Array.from(document.querySelectorAll('[contenteditable]')).find(e => {
      const r = e.getBoundingClientRect();
      return r.width > 200 && r.height > 20 && e.offsetParent !== null;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`)
}

const browser = await ensureChrome()
log('chrome', browser)
const { ws, send, run } = await connect()
await send('Page.enable')
await send('Runtime.enable')
log('cookies', await injectCookies(send))

if (flag('close')) {
  ws.send(JSON.stringify({ id: 999, method: 'Browser.close' }))
  await sleep(800)
  log('closed')
  process.exit(0)
}

const peer = arg('peer')
const text = arg('text')
if (!peer) { log('缺少 --peer'); process.exit(1) }

await openChat(send, run)
if (!(await clickPeer(run, send, peer))) { log('会话列表里没找到', peer); process.exit(2) }
const box = await findBox(run)
if (!box) { log('没找到输入框（可能被限流/需要先回复）'); process.exit(3) }
log('box', JSON.stringify(box))
if (flag('dry') || !text) { log('DRY_OK'); ws.close(); process.exit(0) }

for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
await sleep(300)
await send('Input.insertText', { text })
await sleep(500)
const typed = await run(`(() => { const e=Array.from(document.querySelectorAll('[contenteditable]')).find(x=>x.getBoundingClientRect().height>20); return e? e.textContent : '' })()`)
if (!String(typed).includes(text.slice(0, 6))) { log('输入没进编辑器，放弃发送', JSON.stringify(typed)); process.exit(4) }
for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await sleep(2500)
const seen = await run(`document.body.innerText.includes(${JSON.stringify(text)})`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const out = join(ROOT, 'tmp', `dy-dm-${Date.now()}.png`)
writeFileSync(out, Buffer.from(shot.data, 'base64'))
log(seen ? 'SENT' : 'UNCONFIRMED', out)
ws.close()
