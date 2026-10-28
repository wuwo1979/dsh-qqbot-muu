// 面板「聊天」页的目标下拉不全（主人 2026-10-23）：/api/qqbot-settings/known-chats 只读
//   {dataDir}/known-chats.jsonl 这一份台账，台账漏记/换了数据根就整条群聊/私聊都不见了。
// 做法：在台账之外再合并两个真实来源：
//   ① 记忆库 {root}/.qqbot/memory.db 的 DISTINCT scope（她聊过的每个群/每个人都在里面）
//   ② 判定日志 {root}/.qqbot/local-answer-log.jsonl 的 scope（本地代答过的）
// 用法：node fix-known-chats.mjs --check | --apply | --revert
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const FILE = join(PLUGIN, 'settings-host.js')
const BACKUP = 'F:/qqbot/qqbot-mod/backups/settings-host.js.orig-knownchats'
const MARK = '[qqbot-mod] known-chats-merge'

const ANCHOR = '      const chats = [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 80);'

const BLOCK = [
  '      // ' + MARK + '：台账会漏，把"她聊过的群/人"也补进来',
  '      try {',
  '        const _kcNs = String(u.searchParams.get("ns") || "");',
  '        const _kcBot = (typeof nsBot === "function" ? nsBot(_kcNs) : null) || (typeof bots !== "undefined" ? bots[0] : null);',
  '        const _kcRoot = _kcBot ? resolveMemoryRoot(_kcBot) : "";',
  '        if (_kcRoot) {',
  '          const _kcAdd = (scope, id, name, ts) => {',
  '            if (!id || (scope !== "group" && scope !== "c2c")) return;',
  '            const k = scope + ":" + id;',
  '            const cur = map.get(k);',
  '            if (!cur) map.set(k, { scope: scope, id: id, name: name, lastSeen: Number(ts) || 0, count: 1 });',
  '            else if ((Number(ts) || 0) > (Number(cur.lastSeen) || 0)) { cur.lastSeen = Number(ts) || 0; if (name) cur.name = name; }',
  '          };',
  '          try {',
  '            const _kcDb = join(_kcRoot, ".qqbot", "memory.db");',
  '            if (existsSync(_kcDb)) {',
  '              const _sqlite = await import("node:sqlite");',
  '              const _db = new _sqlite.DatabaseSync(_kcDb, { readOnly: true });',
  '              try {',
  '                const _rows = _db.prepare("SELECT scope, MAX(ts) AS t FROM mem GROUP BY scope").all();',
  '                for (const _r of _rows) {',
  '                  const _s = String((_r && _r.scope) || "");',
  '                  const _i = _s.indexOf(":");',
  '                  if (_i > 0) _kcAdd(_s.slice(0, _i), _s.slice(_i + 1), undefined, Number(_r.t) || 0);',
  '                }',
  '              } finally { _db.close(); }',
  '            }',
  '          } catch { }',
  '          try {',
  '            const _kcLog = join(_kcRoot, ".qqbot", "local-answer-log.jsonl");',
  '            if (existsSync(_kcLog)) {',
  '              const _lines = readFileSync(_kcLog, "utf8").split(String.fromCharCode(10));',
  '              for (let _li = Math.max(0, _lines.length - 400); _li < _lines.length; _li++) {',
  '                const _t = String(_lines[_li] || "").trim();',
  '                if (!_t) continue;',
  '                try {',
  '                  const _o = JSON.parse(_t);',
  '                  const _s2 = String((_o && _o.scope) || "");',
  '                  const _j = _s2.indexOf(":");',
  '                  if (_j > 0) _kcAdd(_s2.slice(0, _j), _s2.slice(_j + 1), undefined, Number(_o.ts) || 0);',
  '                } catch { }',
  '              }',
  '            }',
  '          } catch { }',
  '        }',
  '      } catch { }',
  '      const chats = [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 200);',
].join(CR + LF)

const src = readFileSync(FILE, 'utf8')
const arg = process.argv[2] || '--check'
if (arg === '--revert') {
  if (!existsSync(BACKUP)) { console.log('没有备份：' + BACKUP); process.exit(2) }
  copyFileSync(BACKUP, FILE)
  console.log('已回滚 ' + FILE)
  process.exit(0)
}
announce()
if (src.indexOf(MARK) >= 0) { console.log('已应用（known-chats 合并记忆库/判定日志）'); process.exit(0) }
const at = src.indexOf(ANCHOR)
if (at < 0) { console.log('未匹配：known-chats 的 chats 构建行'); process.exit(1) }
if (arg !== '--apply') { console.log('可打：1 处（偏移 ' + at + '）'); process.exit(0) }
copyFileSync(FILE, BACKUP)
console.log('备份 → ' + BACKUP)
const out = src.slice(0, at) + BLOCK + src.slice(at + ANCHOR.length)
writeFileSync(FILE, out, 'utf8')
console.log('已写入（' + src.length + ' → ' + out.length + ' 字符）')
