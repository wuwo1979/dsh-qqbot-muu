// chat-merge 的"其它会话"分支取错了 API：
//   findSessionBySessionIdWeb() 返回的是 [{ns,scope,peerId,…}]（注册表记录），不是带 events 的会话对象，
//   所以旧代码 `Array.isArray(_cmS2.events)` 永远 false ⇒ 换会话前的话一条都进不来（静默失效）。
// 正确做法（与主路径同源）：listPeerRecordsWeb() 的每条记录都带 .agent，
//   agent.session（或 agent.ctx.session）才是带 events 的会话。
// 用法：node fix-chat-merge2.mjs --check | --apply | --revert
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const EOL = CR + LF

const FILE = join(PLUGIN, 'settings-host.js')
const BACKUP = 'F:/qqbot/qqbot-mod/backups/settings-host.js.orig-chatmerge2'
const MARK = '[_cmAg] chat-merge2'

const OLD = [
  '            var _cmS2 = null',
  '            try {',
  '              if (typeof reg.findSessionBySessionIdWeb === "function" && _cmRec.sessionId) {',
  '                _cmS2 = reg.findSessionBySessionIdWeb(String(_cmRec.sessionId))',
  '              }',
  '            } catch (_e3) { _cmS2 = null }',
  '            if (!_cmS2 || !Array.isArray(_cmS2.events)) continue',
  '            var _cmEvs = _cmS2.events.slice(Math.max(0, _cmS2.events.length - 40))',
].join(EOL)

const NEW = [
  '            var _cmEvs = null [{_cmAg] chat-merge2}'.replace('[{_cmAg] chat-merge2}', '// ' + MARK),
  '            try {',
  '              var _cmAg = _cmRec.agent',
  '              var _cmS2 = _cmAg && (_cmAg.session || (_cmAg.ctx && _cmAg.ctx.session))',
  '              if (_cmS2 && Array.isArray(_cmS2.events)) _cmEvs = _cmS2.events',
  '            } catch (_e3) { _cmEvs = null }',
  '            if (!_cmEvs) continue',
  '            _cmEvs = _cmEvs.slice(Math.max(0, _cmEvs.length - 40))',
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
if (src.indexOf(MARK) >= 0) { console.log('已应用（其它会话改用 agent.session.events）'); process.exit(0) }
const at = src.indexOf(OLD)
if (at < 0) { console.log('未匹配：其它会话取 events 的那段'); process.exit(1) }
if (arg !== '--apply') { console.log('可打：1 处（偏移 ' + at + '）'); process.exit(0) }
copyFileSync(FILE, BACKUP)
console.log('备份 → ' + BACKUP)
const out = src.slice(0, at) + NEW + src.slice(at + OLD.length)
writeFileSync(FILE, out, 'utf8')
console.log('已写入（' + src.length + ' → ' + out.length + ' 字符）')
