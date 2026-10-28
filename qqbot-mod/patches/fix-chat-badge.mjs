// 聊天页气泡加"这句话是谁说的"来源小标：⚡本地 / 🎯梗 / ⏭跳过
// 起因（主人 2026-10-23）：只有「最近判定」里能看到来源，聊天气泡里看不到，
//   导致"本地答了一句、云端又答一句"时无从对照。现在 chat/history 会带回 by 字段，
//   这里把它渲染到气泡的 meta 行（时间前面）。
// 用法：node fix-chat-badge.mjs --check | --apply | --revert
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const EOL = CR + LF

const FILE = join(PLUGIN, 'client', 'qqbot-settings.js')
const BACKUP = 'F:/qqbot/qqbot-mod/backups/qqbot-settings.js.orig-chatbadge'
const MARK = 'qqbot-mod chat-badge'

const ANCHOR = "            + '<span>' + esc(chatTime(it.time)) + '</span>'"

const NEW = [
  "            + (function () {",
  "                // qqbot-mod chat-badge：标出这句话是谁说的（本地小模型 / 死梗直答 / 跳过不花 token）",
  "                var _b = String(it.by || '')",
  "                if (!_b) return ''",
  "                var _t = _b === 'local' ? '⚡本地模型' : (_b === 'gag' ? '🎯死梗直答' : (_b === 'skip' ? '⏭跳过' : (it.model ? '⚡' + String(it.model) : '🤖')))",
  "                var _c = _b === 'local' ? '#2f9e44' : (_b === 'gag' ? '#f08c00' : '#868e96')",
  "                var _ms = Number(it.ms) > 0 ? ' · ' + Math.round(Number(it.ms)) + 'ms' : ''",
  "                return '<span style=\"color:' + _c + ';font-weight:600\">' + esc(_t + _ms) + '</span>'",
  "              })()",
  "            + '<span>' + esc(chatTime(it.time)) + '</span>'",
]
  .join(EOL)

const src = readFileSync(FILE, 'utf8')
const arg = process.argv[2] || '--check'
if (arg === '--revert') {
  if (!existsSync(BACKUP)) { console.log('没有备份：' + BACKUP); process.exit(2) }
  copyFileSync(BACKUP, FILE)
  console.log('已回滚 ' + FILE)
  process.exit(0)
}
announce()
if (src.indexOf(MARK) >= 0) { console.log('已应用（气泡来源小标）'); process.exit(0) }
const at = src.indexOf(ANCHOR)
if (at < 0) { console.log('未匹配：找不到 chatRowHTML 里 meta 的时间行'); process.exit(1) }
if (arg !== '--apply') { console.log('可打：气泡来源小标（锚点 ' + at + '）'); process.exit(0) }
copyFileSync(FILE, BACKUP)
console.log('备份 → ' + BACKUP)
const out = src.slice(0, at) + NEW + src.slice(at + ANCHOR.length)
writeFileSync(FILE, out, 'utf8')
console.log('已写入（' + src.length + ' → ' + out.length + ' 字符）')
