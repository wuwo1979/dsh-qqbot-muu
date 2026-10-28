// chat/history 的"暂无活跃会话"分支：不要直接给空列表。
// 起因（主人 2026-10-23）：私聊发「你好」，浮窗聊天页显示"该目标暂无活跃会话"，
//   可 QQ 里明明有两句回复 —— 因为本地代答走 caps.text 直发、不写进会话，会话又换过 id。
// 做法：新增 chatLocalOnlyItems()（只从 local-answer-log.jsonl 取她说过的话），
//   "没有活跃会话 / 会话未就绪" 两个分支改成先试它，拿到就直接返回（code: 'local-only'）。
// 用法：node fix-chat-nosession.mjs --check | --apply | --revert
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const EOL = CR + LF
const NL = 'String.fromCharCode(10)'

const FILE = join(PLUGIN, 'settings-host.js')
const BACKUP = 'F:/qqbot/qqbot-mod/backups/settings-host.js.orig-chatnosession'
const MARK = '// [qqbot-mod] chat-local-only'

const HELPER_ANCHOR = 'function extCfgPath(root, which) {'
const HELPER = [
  '// [qqbot-mod] chat-local-only：没有活跃会话时，至少把"本地代答说过的话"拿出来',
  'function chatLocalOnlyItems(bot, scope, peerId, limit) {',
  '  const out = []',
  '  try {',
  '    const root = resolveMemoryRoot(bot)',
  '    if (!root) return out',
  '    const file = join(root, ".qqbot", "local-answer-log.jsonl")',
  '    if (!existsSync(file)) return out',
  '    const eol = ' + NL,
  '    const rows = readFileSync(file, "utf8").split(eol)',
  '    const from = Math.max(0, rows.length - 400)',
  '    const seen = {}',
  '    for (let i = from; i < rows.length; i++) {',
  '      const line = String(rows[i] || "").trim()',
  '      if (!line) continue',
  '      let o = null',
  '      try { o = JSON.parse(line) } catch { continue }',
  '      if (!o || !o.reply) continue',
  '      const sc = String(o.scope || "")',
  '      if (sc && sc.indexOf(String(peerId)) < 0) continue',
  '      const t = Number(o.ts) || 0',
  '      const k = String(t) + "|" + String(o.reply).slice(0, 24)',
  '      if (seen[k]) continue',
  '      seen[k] = 1',
  '      out.push({ seq: 0, time: t, dir: "out", sender: "", text: String(o.reply), images: [], tag: "", by: String(o.by || "local"), ms: Number(o.ms) || 0, model: String(o.model || "") })',
  '    }',
  '  } catch { /* 读不到就当没有 */ }',
  '  out.sort(function (a, b) { return (Number(a.time) || 0) - (Number(b.time) || 0) })',
  '  const cap = Math.max(1, Math.min(200, Number(limit) || 80))',
  '  while (out.length > cap) out.shift()',
  '  return out',
  '}',
  '',
].join(EOL)

const R1_OLD = "      return writeJson(res, 200, { ok: true, code: 'no-session', items: [], hasMore: false, msg: '该目标暂无活跃会话' });"
const R1_NEW = [
  '      // [qqbot-mod] chat-local-only：会话记录没了，但"她说过的话"还在日志里',
  '      {',
  '        const only = chatLocalOnlyItems(bot, scope, peerId, limit)',
  "        if (only.length) return writeJson(res, 200, { ok: true, code: 'local-only', items: only, hasMore: false, msg: '只找到本地代答记录（会话记录已换/未就绪）' })",
  '      }',
  "      return writeJson(res, 200, { ok: true, code: 'no-session', items: [], hasMore: false, msg: '该目标暂无活跃会话' });",
].join(EOL)

const R2_OLD = "      return writeJson(res, 200, { ok: true, code: 'no-session', items: [], hasMore: false, msg: '会话未就绪' });"
const R2_NEW = [
  '      {',
  '        const only2 = chatLocalOnlyItems(bot, scope, peerId, limit)',
  "        if (only2.length) return writeJson(res, 200, { ok: true, code: 'local-only', items: only2, hasMore: false, msg: '只找到本地代答记录（会话未就绪）' })",
  '      }',
  "      return writeJson(res, 200, { ok: true, code: 'no-session', items: [], hasMore: false, msg: '会话未就绪' });",
].join(EOL)

const src = readFileSync(FILE, 'utf8')
const arg = process.argv[2] || '--check'
if (arg === '--revert') {
  if (!existsSync(BACKUP)) { console.log('没有备份：' + BACKUP); process.exit(2) }
  copyFileSync(BACKUP, FILE)
  console.log('已回滚 ' + FILE)
  process.exit(0)
}
announce()
if (src.indexOf(MARK) >= 0) { console.log('已应用（无会话时回落到本地代答记录）'); process.exit(0) }
const atHelper = src.indexOf(HELPER_ANCHOR)
const at1 = src.indexOf(R1_OLD)
const at2 = src.indexOf(R2_OLD)
const miss = []
if (atHelper < 0) miss.push('helper 锚点(extCfgPath)')
if (at1 < 0) miss.push('no-session 分支1')
if (at2 < 0) miss.push('no-session 分支2')
if (miss.length) { console.log('未匹配：' + miss.join(' / ')); process.exit(1) }
if (arg !== '--apply') { console.log('可打：3 处（helper ' + atHelper + ' / 分支1 ' + at1 + ' / 分支2 ' + at2 + '）'); process.exit(0) }
copyFileSync(FILE, BACKUP)
console.log('备份 → ' + BACKUP)
let out = src
out = out.replace(R2_OLD, R2_NEW)
out = out.replace(R1_OLD, R1_NEW)
out = out.slice(0, atHelper) + HELPER + out.slice(atHelper)
writeFileSync(FILE, out, 'utf8')
console.log('已写入（' + src.length + ' → ' + out.length + ' 字符）')
