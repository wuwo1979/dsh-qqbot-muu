// resume 重试分类：原来 resume 失败一律 250/1000/2500ms 各试一次（共 3.75 秒，加上 create 前的等待
// = 首条消息白等 7.5 秒）。实际上两种失败根本不该重试：
//   session "…" not found                → 会话档还没建，重试也没用，直接 create
//   session "…" is already owned by …    → 有别的写句柄握着（另一个 DSH 实例/上个句柄），只等一小会儿
// 用法：node fix-resume-classify.mjs --check | --apply | --revert
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const FILE = join(PLUGIN, 'dist', 'session', 'session-manager.js')
const BACKUP = 'F:/qqbot/qqbot-mod/backups/session-manager.js.orig-resumeclassify'
const MARK = '[qqbot-mod] resume-classify'

const SRC = readFileSync(FILE, 'utf8')
const EOL = SRC.indexOf(CR + LF) >= 0 ? CR + LF : LF

const OLD = [
  '                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
  '                for (const waitMs of [250, 1000, 2500]) {',
].join(EOL)

const NEW = [
  '                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
  '                // ' + MARK + ' —— 分清"档还没建"(not found) 与"被别的宿主握着"(owned by an active write handle)：',
  '                //   not found 重试毫无意义（白等 7.5 秒才 create，首条消息全慢在这一步）',
  '                //   owned 只等一小会儿（上个句柄/另一个 DSH 实例还没放开），仍不行才轮到 create/轮换',
  '                const _rmsg = String(resumeErr?.message ?? resumeErr);',
  '                const _owned = /owned by an active/i.test(_rmsg);',
  '                const _gone = /not found/i.test(_rmsg);',
  '                for (const waitMs of (_gone ? [] : (_owned ? [400, 1200] : [250, 1000, 2500]))) {',
].join(EOL)

const arg = process.argv[2] || '--check'
if (arg === '--revert') {
  if (!existsSync(BACKUP)) { console.log('没有备份：' + BACKUP); process.exit(2) }
  copyFileSync(BACKUP, FILE)
  console.log('已回滚 ' + FILE)
  process.exit(0)
}
announce()
if (SRC.indexOf(MARK) >= 0) { console.log('已应用（resume 重试分类）'); process.exit(0) }
const at = SRC.indexOf(OLD)
if (at < 0) { console.log('未匹配：sleep + for (const waitMs of [250, 1000, 2500]) 两行'); process.exit(1) }
if (arg !== '--apply') { console.log('可打：1 处（偏移 ' + at + '）'); process.exit(0) }
copyFileSync(FILE, BACKUP)
console.log('备份 → ' + BACKUP)
const out = SRC.slice(0, at) + NEW + SRC.slice(at + OLD.length)
writeFileSync(FILE, out, 'utf8')
console.log('已写入（' + SRC.length + ' → ' + out.length + ' 字符）')
