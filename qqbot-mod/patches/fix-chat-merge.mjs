// 修 chat/history：把"本地代答说过的话"和"同一 peer 的其它会话"也并进聊天页。
// 起因（主人 2026-10-23 反馈）：私聊发「你好」，浮窗聊天里既看不到本地那句、也看不到云端那句；
//   而「最近判定」里明明有记录 ⇒ 聊天页只读**当前登记的那一条会话**的快照，
//   本地代答走 caps.text 直发、不经过该会话；换过会话时旧会话里的话更是整段消失。
// 做法：仍然保留原有解码逻辑，只在写响应前追加两类条目并整体按时间排序：
//   1) {数据根}/.qqbot/local-answer-log.jsonl 里 by=local/gag/skip 的**她说过的话**
//   2) 同一 scope+peerId 的其它会话（reg.listPeerRecordsWeb 的候选）最后 40 条事件
// 用用法：node fix-chat-merge.mjs --check | --apply | --revert
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const EOL = CR + LF
const NL = 'String.fromCharCode(10)' // 插入代码里需要换行字符时用它（避免反斜杠）

const FILE = join(PLUGIN, 'settings-host.js')
const BACKUP = 'F:/qqbot/qqbot-mod/backups/settings-host.js.orig-chatmerge'
const MARK = '// [qqbot-mod] chat-merge'

const ANCHOR = '      writeJson(res, 200, { ok: true, items, hasMore: !reachedEnd, tailSeq: sess.seq, debug: diag });'

const MERGE = [
  '      // [qqbot-mod] chat-merge：把"本地代答说过的话"和"同一 peer 的其它会话"并进聊天页',
  '      try {',
  '        var _cmEol = ' + NL,
  '        var _cmRoot = ""',
  '        try { _cmRoot = resolveMemoryRoot(bot) } catch (_e0) { _cmRoot = "" }',
  '        var _cmSeen = {}',
  '        for (var _cmI = 0; _cmI < items.length; _cmI++) {',
  '          var _cmIt = items[_cmI] || {}',
  '          _cmSeen[String(Number(_cmIt.time) || 0) + "|" + String(_cmIt.text || "").slice(0, 24)] = 1',
  '        }',
  '        var _cmWant = (scope === "c2c" ? "c2c:" : "group:") + peerId',
  '        // 1) 本地代答/死梗/跳过：她真的说过的话（云端的不加，session 快照里已有）',
  '        if (_cmRoot) {',
  '          try {',
  '            var _cmLog = join(_cmRoot, ".qqbot", "local-answer-log.jsonl")',
  '            if (existsSync(_cmLog)) {',
  '              var _cmRows = readFileSync(_cmLog, "utf8").split(_cmEol)',
  '              var _cmFrom = Math.max(0, _cmRows.length - 400)',
  '              for (var _cmR = _cmFrom; _cmR < _cmRows.length; _cmR++) {',
  '                var _cmLine = String(_cmRows[_cmR] || "").trim()',
  '                if (!_cmLine) continue',
  '                var _cmO = null',
  '                try { _cmO = JSON.parse(_cmLine) } catch (_e1) { continue }',
  '                if (!_cmO || !_cmO.reply) continue',
  '                var _cmSc = String(_cmO.scope || "")',
  '                if (_cmSc && _cmSc !== _cmWant && _cmSc.indexOf(peerId) < 0) continue',
  '                var _cmT = Number(_cmO.ts) || 0',
  '                var _cmK = String(_cmT) + "|" + String(_cmO.reply).slice(0, 24)',
  '                if (_cmSeen[_cmK]) continue',
  '                _cmSeen[_cmK] = 1',
  '                items.push({ seq: 0, time: _cmT, dir: "out", sender: "", text: String(_cmO.reply), images: [], tag: "", by: String(_cmO.by || "local"), ms: Number(_cmO.ms) || 0, model: String(_cmO.model || "") })',
  '              }',
  '            }',
  '          } catch (_e2) { /* 日志读不到不影响主流程 */ }',
  '        }',
  '        // 2) 同一个 peer 的其它会话（换过会话时，旧会话里的话也要能看见）',
  '        try {',
  '          var _cmCands = (typeof reg.listPeerRecordsWeb === "function") ? (reg.listPeerRecordsWeb(scope, peerId) || []) : []',
  '          for (var _cmC = 0; _cmC < _cmCands.length; _cmC++) {',
  '            var _cmRec = _cmCands[_cmC]',
  '            if (!_cmRec || _cmRec === rec) continue',
  '            if (rec && String(_cmRec.sessionId || "") === String(rec.sessionId || "")) continue',
  '            var _cmS2 = null',
  '            try {',
  '              if (typeof reg.findSessionBySessionIdWeb === "function" && _cmRec.sessionId) {',
  '                _cmS2 = reg.findSessionBySessionIdWeb(String(_cmRec.sessionId))',
  '              }',
  '            } catch (_e3) { _cmS2 = null }',
  '            if (!_cmS2 || !Array.isArray(_cmS2.events)) continue',
  '            var _cmEvs = _cmS2.events.slice(Math.max(0, _cmS2.events.length - 40))',
  '            for (var _cmX = _cmEvs.length - 1; _cmX >= 0; _cmX--) {',
  '              var _cmGot = null',
  '              try { _cmGot = chatDecodeEvent(_cmEvs[_cmX], scope, nameByMid, fallbackSender) } catch (_e4) { _cmGot = null }',
  '              if (!_cmGot) continue',
  '              var _cmArr = Array.isArray(_cmGot) ? _cmGot : [_cmGot]',
  '              for (var _cmY = 0; _cmY < _cmArr.length; _cmY++) {',
  '                var _cmOne = _cmArr[_cmY]',
  '                if (!_cmOne) continue',
  '                var _cmT2 = Number(_cmOne.time) || 0',
  '                var _cmK2 = String(_cmT2) + "|" + String(_cmOne.text || "").slice(0, 24)',
  '                if (_cmSeen[_cmK2]) continue',
  '                _cmSeen[_cmK2] = 1',
  '                items.push(_cmOne)',
  '              }',
  '            }',
  '          }',
  '        } catch (_e5) { /* 其它会话读不到就算了 */ }',
  '        items.sort(function (a, b) { return (Number(a.time) || 0) - (Number(b.time) || 0) })',
  '        while (items.length > limit) items.shift()',
  '        diag.merged = items.length',
  '        try { diag.byCount = items.filter(function (x) { return !!x.by }).length } catch (_e6) { /* ignore */ }',
  '      } catch (_e7) {',
  '        try { diag.mergeErr = String((_e7 && _e7.message) || _e7) } catch (_e8) { /* ignore */ }',
  '      }',
  '      writeJson(res, 200, { ok: true, items, hasMore: !reachedEnd, tailSeq: sess.seq, debug: diag });',
].join(EOL)

function apply(checkOnly) {
  announce()
  if (!existsSync(FILE)) {
    console.log('找不到 ' + FILE)
    process.exit(2)
  }
  const src = readFileSync(FILE, 'utf8')
  const has = src.indexOf(MARK) >= 0
  const anchor = src.indexOf(ANCHOR)
  if (has) {
    console.log('已应用（聊天页合并本地代答/其它会话）')
    return
  }
  if (anchor < 0) {
    console.log('未匹配：找不到 chat/history 的写响应锚点')
    process.exit(1)
  }
  if (checkOnly) {
    console.log('可打：settings-host.js chat/history 合并块（锚点位置 ' + anchor + '）')
    return
  }
  copyFileSync(FILE, BACKUP)
  console.log('备份 → ' + BACKUP)
  const out = src.slice(0, anchor) + MERGE + EOL + src.slice(anchor + ANCHOR.length)
  writeFileSync(FILE, out, 'utf8')
  console.log('已写入 ' + FILE + '（' + src.length + ' → ' + out.length + ' 字符）')
}

function revert() {
  if (!existsSync(BACKUP)) {
    console.log('没有备份可回滚：' + BACKUP)
    process.exit(2)
  }
  copyFileSync(BACKUP, FILE)
  console.log('已回滚 settings-host.js')
}

const arg = process.argv[2] || '--check'
if (arg === '--apply') apply(false)
else if (arg === '--revert') revert()
else apply(true)
