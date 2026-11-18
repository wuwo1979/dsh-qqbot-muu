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
// 抖音私信导出（真实 Chrome + CDP）→ ndjson + memory.db
// 用法：
//   node scripts/douyin-cdp-export.mjs --peer <昵称> --scope douyin:dm:<id> [--reset] [--dry] [--no-db]
// 说明：滚动加载历史（最多 40 次），按「会话 ID + 时间」落库，src=douyin-dm，不碰 QQ/微信 scope。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import { DatabaseSync } from 'node:sqlite'

const ROOT = __repoRoot() + ""
const CDP = 'http://127.0.0.1:9222'
const DB = join(ROOT, 'dshqqbot', '.qqbot', 'memory.db')
const OUTDIR = join(ROOT, 'data', 'douyin-exports')

const argv = process.argv.slice(2)
const arg = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const flag = (n) => argv.includes(`--${n}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[dy-export]', ...a)

const peer = arg('peer')
const scope = arg('scope') || `douyin:dm:${peer}`
if (!peer) { log('缺 --peer'); process.exit(1) }

const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.find((t) => t.type === 'page')
if (!target) { log('没有页面 target，先起 Chrome'); process.exit(1) }
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
let id = 0
const waiters = new Map()
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) } })
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; waiters.set(mid, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: mid, method, params })) })
const run = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value

await send('Page.enable'); await send('Runtime.enable')
if (!String(await run('location.href')).includes('/chat')) {
  await send('Page.navigate', { url: 'https://www.douyin.com/chat' })
  await sleep(9000)
}

const opened = await run(`(() => {
  const rows = Array.from(document.querySelectorAll('div,li,a')).filter(e => {
    const t=(e.textContent||'').trim(); const r=e.getBoundingClientRect();
    return t.startsWith(${JSON.stringify(peer)}) && r.width>150 && r.width<400 && r.height>40 && r.height<140;
  });
  if (!rows.length) return false;
  const el = rows[rows.length-1];
  for (const t of ['mousedown','mouseup','click']) el.dispatchEvent(new MouseEvent(t,{bubbles:true}));
  return true;
})()`)
log('opened', opened)
if (!opened) { log('会话列表里没找到', peer); process.exit(2) }
await sleep(2500)

// 往上滚，把历史触发出来
let lastH = -1
for (let i = 0; i < 40; i += 1) {
  const h = await run(`(() => { const el=document.querySelector('.messageMessageListlist'); if(!el) return -1; el.scrollTop=0; el.dispatchEvent(new Event('scroll',{bubbles:true})); return el.scrollHeight })()`)
  if (h < 0) { log('找不到消息容器'); break }
  await sleep(1300)
  const h2 = await run(`document.querySelector('.messageMessageListlist')?.scrollHeight ?? -1`)
  if (h2 === lastH && h2 === h) break
  lastH = h2
}

const raw = await run(`(() => {
  const listEl = document.querySelector('.messageMessageListlist');
  if (!listEl) return null;
  const out = [];
  for (const el of listEl.querySelectorAll('div')) {
    const cls = String(el.className || '');
    if (!cls.includes('messageBox')) continue;
    const content = el.querySelector('[class*="contentBox"]');
    if (!content) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 8) continue;
    const ccls = String(content.className || '');
    let text = (content.innerText || '').trim();
    if (!text) continue;
    let label = '';
    const m = text.match(/^(刚刚|\d+分钟前|\d+小时前|昨天\s*\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2})\s*/);
    if (m) { label = m[1]; text = text.slice(m[0].length).trim(); }
    if (!text) continue;
    out.push({ text, mine: /isFromMe/.test(ccls), top: Math.round(r.top), cx: Math.round(content.getBoundingClientRect().x + content.getBoundingClientRect().width / 2), idx: out.length, time: label });
  }
  return out;
})()`)
log('raw_items', Array.isArray(raw) ? raw.length : 'null')
if (!Array.isArray(raw)) { log('抽取失败'); process.exit(3) }
const ccx = await run(`(() => { const el = document.querySelector('.messageMessageListlist'); if (!el) return 0; const r = el.getBoundingClientRect(); return Math.round(r.x + r.width / 2) })()`)
raw.sort((a, b) => a.idx - b.idx)
raw.reverse()
for (const it of raw) { if (ccx && Math.abs(it.cx - ccx) > 30) it.mine = it.cx > ccx }

// 时间分隔条（`.MessageBoxTimetimeLayout`）单独抽，再按纵向位置归到下面的消息
const timeMarks = await run(`(() => {
  const listEl = document.querySelector('.messageMessageListlist');
  const out = [];
  if (!listEl) return out;
  for (const el of listEl.querySelectorAll('div')) {
    if (!String(el.className || '').includes('timeLayout')) continue;
    const t = (el.innerText || '').trim();
    if (!t) continue;
    out.push({ t, top: Math.round(el.getBoundingClientRect().top) });
  }
  return out;
})()`)
const marks = Array.isArray(timeMarks) ? timeMarks.sort((a, b) => a.top - b.top) : []
log('time_marks', marks.length, JSON.stringify(marks.slice(0, 3)))

const now = Date.now()
let lastTs = 0
function parseLabel(label) {
  if (!label) return null
  const m1 = label.match(/^(\d+)分钟前/)
  if (m1) return now - Number(m1[1]) * 60_000
  const m2 = label.match(/^(\d+)小时前/)
  if (m2) return now - Number(m2[1]) * 3_600_000
  if (label === '刚刚') return now
  const m0 = label.match(/^(\d{1,2}):(\d{2})$/)
  if (m0) {
    const d = new Date()
    d.setHours(+m0[1], +m0[2], 0, 0)
    if (d.getTime() > now + 60_000) d.setDate(d.getDate() - 1)
    return d.getTime()
  }
  const m3 = label.match(/^昨天\s*(\d{1,2}):(\d{2})/)
  if (m3) { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(+m3[1], +m3[2], 0, 0); return d.getTime() }
  const m4 = label.match(/^(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/)
  if (m4) { const d = new Date(); d.setMonth(+m4[1] - 1, +m4[2]); d.setHours(+m4[3], +m4[4], 0, 0); return d.getTime() }
  return null
}

const msgs = []
let curLabel = null
let base = null
let seq = 0
for (const it of raw) {
  const mark = [...marks].reverse().find((m) => m.top <= it.top)
  const label = it.time || mark?.t || ''
  if (label && label !== curLabel) {
    curLabel = label
    const t = parseLabel(label)
    base = t ?? (base ? base + 60_000 : now - 3_600_000)
    seq = 0
  }
  seq += 1
  const ts = (base ?? now - 3_600_000) + seq * 1000
  msgs.push({ ts, dir: it.mine ? 'out' : 'in', text: it.text, label })
}
const inN = msgs.filter((m) => m.dir === 'in').length
msgs.sort((a, b) => a.ts - b.ts)
for (let i = 1; i < msgs.length; i += 1) if (msgs[i].ts <= msgs[i - 1].ts) msgs[i].ts = msgs[i - 1].ts + 1000
log('parsed', msgs.length, `in=${inN} out=${msgs.length - inN}`)
log('first', JSON.stringify(msgs[0]))
log('last', JSON.stringify(msgs[msgs.length - 1]))

if (flag('dry')) { ws.close(); process.exit(0) }

mkdirSync(OUTDIR, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10)
const file = join(OUTDIR, `dm-${peer}-${stamp}.ndjson`)
writeFileSync(file, msgs.map((m) => JSON.stringify({ scope, peer, ...m })).join('\n') + '\n')
log('file', file)

if (!flag('no-db')) {
  const db = new DatabaseSync(DB)
  if (flag('reset')) {
    const d = db.prepare('delete from chat where scope = ? and src = ?').run(scope, 'douyin-dm')
    log('reset_deleted', d.changes)
  }
  const ins = db.prepare('insert or ignore into chat (fp, scope, ts, dir, sender_id, sender, kind, text, media, msg_id, src) values (?,?,?,?,?,?,?,?,?,?,?)')
  let n = 0
  for (const m of msgs) {
    const fp = createHash('sha1').update(`${scope}|${m.ts}|${m.dir}|${m.text}`).digest('hex')
    const r = ins.run(fp, scope, m.ts, m.dir, m.dir === 'out' ? 'self' : peer, m.dir === 'out' ? '小蓝' : peer, 'text', m.text, null, null, 'douyin-dm')
    n += r.changes
  }
  log('db_inserted', n, 'scope', scope)
  db.close()
}
ws.close()
