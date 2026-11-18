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
 * backfill-wechat-archive.mjs — 把微信桥自己的 messages.jsonl 补进统一台账。
 *
 * 为什么：桥（4311）每收/发一条都会记录到 wechat-bridge/messages.jsonl，但插件
 * 直到 2026-11-13 晚才开始写 chat 表，之前的消息只在桥的 jsonl 里，补回/检索都看不到。
 * 口径：不按内容去重，appendChat 用「scope+dir+sender+ts+text」做幂等键，重复跑也安全。
 *
 * 用法：node scripts/backfill-wechat-archive.mjs [--dry-run]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = __repoRoot() + ""
const DATA_ROOT = __repoRoot() + "/dshqqbot"
const SRC = join(REPO, 'wechat-bridge', 'messages.jsonl')
const dry = process.argv.includes('--dry-run')

const { loadPeople, scopeFor } = await import(pathToFileURL(join(__repoRoot(), "dshqqbot/.qqbot-extensions/lib/person-link.mjs")).href)
const { appendChat } = await import(pathToFileURL(join(__repoRoot(), "dshqqbot/.qqbot-extensions/lib/chatlog-db.mjs")).href)

if (!existsSync(SRC)) { console.log('没有 messages.jsonl，跳过'); process.exit(0) }
const rows = []
for (const line of readFileSync(SRC, 'utf8').split('\n')) {
  const s = line.trim()
  if (!s) continue
  try { rows.push(JSON.parse(s)) } catch { /* 坏行跳过 */ }
}

let added = 0
let skipped = 0
for (const r of rows) {
  const convId = String(r.convId || '')
  if (!convId || !r.text) { skipped += 1; continue }
  const isGroup = Boolean(r.isGroup) || convId.endsWith('@chatroom')
  const scope = scopeFor(DATA_ROOT, 'wechat', convId, { isGroup })
  const dir = r.dir === 'out' ? 'out' : 'in'
  const ts = Number(r.t) || Date.now()
  const senderId = String(r.sender || '').startsWith('<') ? '' : String(r.senderId || '')
  const ok = dry ? true : appendChat(DATA_ROOT, {
    scope,
    ts,
    dir,
    senderId,
    sender: String(r.sender || ''),
    kind: String(r.msgType || 'text'),
    text: String(r.text),
    msgId: String(r.svrid || ''), // 桥的归档里通常没有 svrid，回退到文本+时间指纹
    src: 'wechat-bridge',
  })
  if (ok) added += 1; else skipped += 1
}
console.log(`${dry ? '[dry-run] ' : ''}桥归档 ${rows.length} 行：写入 ${added}，跳过/重复 ${skipped}`)
