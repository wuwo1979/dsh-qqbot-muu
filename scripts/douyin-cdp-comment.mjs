// 抖音评论回复（真实 Chrome + CDP，坐标点击，兼容 React）
// 用法：
//   node scripts/douyin-cdp-comment.mjs --url <作品链接> --scan
//   node scripts/douyin-cdp-comment.mjs --url <链接> --match "<评论片段>" --text "<回复>" [--dry]
// 只走浏览器 UI，不碰私信；发完截图留证。
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const CDP = 'http://127.0.0.1:9222'
const argv = process.argv.slice(2)
const arg = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const flag = (n) => argv.includes(`--${n}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[dy-comment]', ...a)

const url = arg('url')
const match = arg('match')
const text = arg('text')
const shotPath = arg('shot', `F:/qqbot/tmp/dy-comment-${Date.now()}.png`)

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) { log('没有页面 target'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
let id = 0
const waiters = new Map()
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } })
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; waiters.set(mid, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: mid, method, params })) })
const run = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value
const shot = async () => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(shotPath, Buffer.from(s.data, 'base64')); log('shot', shotPath) }
const shot0 = async () => { const s2 = await send('Page.captureScreenshot', { format: 'png' }); const p2 = `F:/qqbot/tmp/dy-comment-${Date.now()}.png`; writeFileSync(p2, Buffer.from(s2.data, 'base64')); return p2 }
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

await send('Page.enable'); await send('Runtime.enable')
if (url) { await send('Page.navigate', { url }); await sleep(9000) }

log('tab', await run(`(() => {
  const el = [...document.querySelectorAll('div,span,a')].find(e => /^评论\\(?\\d*\\)?$/.test((e.textContent||'').trim()) && e.children.length === 0 && e.getBoundingClientRect().height > 0);
  if (!el) return 'not-found';
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`))
const tab = await run(`(() => {
  const el = [...document.querySelectorAll('*')].find(e => /^评论\\(\\d+\\)$/.test((e.textContent||'').trim()) && e.children.length === 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`)
if (tab) { await clickAt(tab.x, tab.y); await sleep(4000) }

for (let i = 0; i < 8; i += 1) {
  await run(`(() => { const els=[...document.querySelectorAll('div')].filter(e=>{const s=getComputedStyle(e);return (s.overflowY==='auto')&&e.scrollHeight>e.clientHeight+80}); for(const e of els) e.scrollTop=e.scrollHeight; return els.length })()`)
  await sleep(700)
}

if (flag('scan') || !match) {
  const items = await run(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('div[class*="comment-item"]')) {
      const r = el.getBoundingClientRect();
      if (r.height < 20) continue;
      if (el.querySelector('div[class*="comment-item"]')) continue;
      const t = (el.innerText || '').trim().replace(/\\n/g, ' | ');
      out.push({ t: t.slice(0, 90), h: Math.round(r.height), top: Math.round(r.top) });
    }
    return out.slice(0, 25);
  })()`)
  console.log(JSON.stringify(items, null, 1))
  await shot()
  ws.close()
  process.exit(0)
}

const found = await run(`(() => {
  const frag = ${JSON.stringify(match)};
  const links = [...document.querySelectorAll('*')].filter(e => (e.textContent || '').trim() === '回复' && e.children.length === 0 && e.getBoundingClientRect().height > 4);
  for (const el of links) {
    let host = el, ok = false;
    for (let i = 0; i < 8 && host; i += 1) { if ((host.innerText || '').includes(frag)) { ok = true; break } host = host.parentElement }
    if (!ok) continue;
    host.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), sample: (host.innerText || '').replace(/\\n/g, ' ').slice(0, 40) };
  }
  return { err: 'no-match', links: links.length };
})()`)
log('found', JSON.stringify(found))
if (!found || found.err) { await shot(); ws.close(); process.exit(2) }
await sleep(400)
await clickAt(found.x, found.y)
await sleep(1800)

const boxInfo = await run(`(() => {
  const all = [...document.querySelectorAll('[contenteditable="true"], textarea')]
    .map(e => ({ e, r: e.getBoundingClientRect() }))
    .filter(x => x.r.width > 120 && x.r.height > 10 && x.r.bottom > 0 && x.r.top < window.innerHeight);
  if (!all.length) return null;
  all.sort((a, b) => b.r.bottom - a.r.bottom);
  // 优先「回复@…」那个（点回复后底部输入框会变），否则取最靠下的
  const picked = all.find(x => /回复@/.test((x.e.getAttribute('placeholder') || '') + (x.e.innerText || '') + ((x.e.closest('div') || {}).innerText || ''))) || all[0];
  picked.e.setAttribute('data-dy-focus', '1');
  picked.e.focus();
  return { x: Math.round(picked.r.x + picked.r.width / 2), y: Math.round(picked.r.y + picked.r.height / 2), placeholder: (picked.e.getAttribute('placeholder') || picked.e.innerText || '').slice(0, 20) };
})()`)
log('input', JSON.stringify(boxInfo))
if (!boxInfo) { await shot(); ws.close(); process.exit(3) }
await clickAt(boxInfo.x, boxInfo.y)
await sleep(400)
await send('Input.insertText', { text })
await sleep(700)
const typed = await run(`(() => { const e = document.querySelector('[data-dy-focus="1"]'); return e ? (e.value || e.innerText || '').slice(0, 80) : '' })()`)
log('typed', JSON.stringify(typed))
if (flag('dry')) { await shot(); ws.close(); process.exit(0) }

const sendBtn = await run(`(() => {
  const cands = [...document.querySelectorAll('div,span,button')]
    .filter(e => /^(发送|发布)$/.test((e.textContent || '').trim()) && e.children.length === 0)
    .map(e => ({ e, r: e.getBoundingClientRect() }))
    .filter(x => x.r.width > 6 && x.r.bottom > 0 && x.r.top < window.innerHeight && x.r.height > 6);
  if (!cands.length) return null;
  const { r } = cands[cands.length - 1];
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`)
log('send_button', JSON.stringify(sendBtn))
if (sendBtn) { await clickAt(sendBtn.x, sendBtn.y) } else {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  log('enter_pressed')
}
await sleep(2500)
const still = await run(`(() => { const e=[...document.querySelectorAll('[contenteditable="true"], textarea')].find(e=>e.getBoundingClientRect().height>10); return e ? (e.value || e.innerText || '').slice(0,40) : '' })()`)
log('after_send_input', JSON.stringify(still))
const shotPath2 = await shot0()
const modal = await run(`document.body.innerText.includes('接收短信验证码') || document.body.innerText.includes('为确保是本人操作')`)
if (modal) console.log(JSON.stringify({ ok: false, error: '抖音要短信验证码（本人操作校验），先人工过一下验证再点审批', shot: shotPath2 }))
else if (String(still || '').trim() === '') console.log(JSON.stringify({ ok: true, sent: true, shot: shotPath2 }))
else console.log(JSON.stringify({ ok: false, error: '输入框还有内容，可能没发出去', shot: shotPath2 }))
ws.close()
