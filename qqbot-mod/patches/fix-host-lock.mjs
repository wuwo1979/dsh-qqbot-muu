// 双实例保护：两个 DSH 桌面窗口同时跑同一个机器人 = 同一条消息被答两次、会话被两份宿主各开一套、
// 面板聊天页只看得见自己那份会话（主人 2026-10-23 反复遇到的"先本地后云端/信息对不上"）。
// 做法：启动前在 {dataRoot}/.qqbot/bot-host.lock 抢一把进程锁（PID + 30 秒心跳）；
//   锁被别人活着持有 → 本实例只打一条 error 日志，不连接 QQ（关掉多余窗口后 /bot-restart 即恢复）。
// 用法：node fix-host-lock.mjs --check | --apply | --revert
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)

const FILE = join(PLUGIN, 'dist', 'gateway', 'bootstrap.js')
const _srcPeek = readFileSync(FILE, 'utf8')
// bootstrap.js 是 LF，settings-host.js / client bundle 是 CRLF —— 按文件实际行尾走
const EOL = _srcPeek.indexOf(CR + LF) >= 0 ? CR + LF : LF
const BACKUP = 'F:/qqbot/qqbot-mod/backups/bootstrap.js.orig-hostlock'
const MARK = '[qqbot-mod] host-lock'

const IMPORT_ANCHOR = "import { join } from 'node:path';"
const IMPORT_NEW = [
  "import { join } from 'node:path';",
  "import { readFileSync as qqReadFileSync, writeFileSync as qqWriteFileSync, mkdirSync as qqMkdirSync } from 'node:fs';",
].join(EOL) + EOL

const GUARD = [
  '// [qqbot-mod] host-lock —— 同一机器人只许一个 DSH 实例连 QQ（防双答案/会话两开）',
  'function qqbotHostLock(dataRoot, logger) {',
  "    const dir = join(dataRoot, '.qqbot')",
  "    const file = join(dir, 'bot-host.lock')",
  '    const mine = process.pid',
  '    const now = Date.now()',
  '    try { qqMkdirSync(dir, { recursive: true }) } catch { }',
  '    let prev = null',
  "    try { prev = JSON.parse(qqReadFileSync(file, 'utf8')) } catch { prev = null }",
  '    const fresh = !!(prev && typeof prev.at === "number" && now - prev.at < 90000)',
  '    if (fresh && prev.pid && prev.pid !== mine) {',
  '        let alive = false',
  '        try { process.kill(prev.pid, 0); alive = true } catch { alive = false }',
  '        if (alive) return { ok: false, holder: prev }',
  '    }',
  "    const write = () => { try { qqWriteFileSync(file, JSON.stringify({ pid: mine, at: Date.now(), startedAt: new Date().toISOString() }), 'utf8') } catch { } }",
  '    write()',
  '    const timer = setInterval(write, 30000)',
  '    if (timer.unref) timer.unref()',
  "    return { ok: true, holder: null, release: () => { clearInterval(timer); try { qqWriteFileSync(file, JSON.stringify({ pid: mine, at: 0 }), 'utf8') } catch { } } }",
  '}',
  '',
].join(EOL)

const START_ANCHOR = [
  '    ctx',
  '        .effect(() => {',
  '        logger.info(`Starting bot (appId=${config.appId})`);',
].join(EOL)
const START_NEW = [
  '    const _qqHostLock = qqbotHostLock(dataRootOf(config), logger);',
  '    if (_qqHostLock && _qqHostLock.ok === false) {',
  '        logger.error(`[im-qqbot] 双实例保护：另一个 DSH 实例(pid=${(_qqHostLock.holder && _qqHostLock.holder.pid) ?? "?"}) 正在运行同一个机器人 -> 本实例暂不连接 QQ，等它让出锁后自动接管。`);',
  '    }',
  '    ctx',
  '        .effect(() => {',
  '        logger.info(`Starting bot (appId=${config.appId})`);',
  '        if (_qqHostLock && _qqHostLock.ok === false) {',
  '            // 锁被别人活着持有：不连接 QQ（否则同一条消息会被两个宿主各答一次）。',
  '            // 每 20 秒重试一次抢锁；对方心跳停了（死掉/关窗口）就自动接管。',
  '            const _qqRetry = setInterval(() => {',
  '                const again = qqbotHostLock(dataRootOf(config), logger);',
  '                if (!again || again.ok !== true) return;',
  '                clearInterval(_qqRetry);',
  '                logger.warn(`[im-qqbot] 双实例保护：锁已释放 -> 本实例现在接管并连接 QQ`);',
  '                bot.start().catch((err) => {',
  '                    logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);',
  '                });',
  '            }, 20000);',
  '            if (_qqRetry.unref) _qqRetry.unref();',
  '            logger.warn(`[im-qqbot] 已暂缓 bot.start()（双实例保护，20 秒后重试抢锁）`);',
  '            return;',
  '        }',
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
if (src.indexOf(MARK) >= 0) { console.log('已应用（双实例保护）'); process.exit(0) }
const aImport = src.indexOf(IMPORT_ANCHOR)
const aStart = src.indexOf(START_ANCHOR)
const miss = []
if (aImport < 0) miss.push('import 锚点')
if (aStart < 0) miss.push('ctx.effect 启动锚点')
if (miss.length) { console.log('未匹配：' + miss.join(' / ')); process.exit(1) }
if (arg !== '--apply') { console.log('可打：2 处（import ' + aImport + ' / start ' + aStart + '）'); process.exit(0) }
copyFileSync(FILE, BACKUP)
console.log('备份 → ' + BACKUP)
let out = src.slice(0, aImport) + IMPORT_NEW + GUARD + src.slice(aImport + IMPORT_ANCHOR.length + EOL.length)
const aStart2 = out.indexOf(START_ANCHOR)
if (aStart2 < 0) { console.log('插入后找不到启动锚点，放弃'); process.exit(1) }
out = out.slice(0, aStart2) + START_NEW + out.slice(aStart2 + START_ANCHOR.length)
writeFileSync(FILE, out, 'utf8')
console.log('已写入（' + src.length + ' → ' + out.length + ' 字符）')
