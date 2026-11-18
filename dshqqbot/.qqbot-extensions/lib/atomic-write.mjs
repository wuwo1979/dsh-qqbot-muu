// [qqbot-mod] atomic-write 2026-10-27：原子写盘（学自 ops-handoff-design 02 号文档 §5.6 并发契约）
// 纪律：临时文件 → fs.renameSync（同目录内 rename 是原子的），绝不直接 writeFileSync(目标)。
// Windows 上目标被占用时 rename 会抛 EPERM/EBUSY —— 按 50/150/400ms 重试 3 次，绝不退化为直接写。
import { writeFileSync, renameSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── 覆盖前留底（2026-11-11 主人要求：动手前先保留源文件，可回溯、可撤销、可一键清理）──
// 这里是全项目写盘的**唯一喉点**，所以留底挂在这：目标已存在 → 先把旧字节存进快照，再 rename 覆盖。
// 三条克制规矩（主人特别强调「不宜过深、别堆历史文件」）：
//   ① 同一文件 10 分钟内只留一次底（状态文件每轮都写，不节流会瞬间堆爆）；
//   ② 单文件 > 8MB 不留（大文件不是"手滑覆盖"高危区）；
//   ③ 每留 20 次自动 prune 一次：保留 7 天 / 总量 1GB 封顶，最旧的先删。
const BACKUP_MAX_BYTES = 8 * 1024 * 1024
const BACKUP_THROTTLE_MS = 10 * 60 * 1000
const PRUNE_EVERY = 20
const PRUNE_DAYS = 7
const PRUNE_MAX_BYTES = 1024 * 1024 * 1024
const _backupAt = new Map()
let _backupCount = 0
let _safeFs = null

function dataRootOfModule() {
  // lib/atomic-write.mjs → <dataRoot>/.qqbot-extensions/lib/
  try { return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') } catch { return 'F:/qqbot/dshqqbot' }
}

function autoBackupBeforeOverwrite(target) {
  try {
    if (!_safeFs) return // 懒加载失败就算了（留底绝不阻塞写盘）
    if (!existsSync(target)) return // 新建文件没有"源文件"可留
    const st = statSync(target)
    if (!st.isFile() || st.size > BACKUP_MAX_BYTES) return
    const now = Date.now()
    const prev = _backupAt.get(target) || 0
    if (now - prev < BACKUP_THROTTLE_MS) return
    _backupAt.set(target, now)
    if (_backupAt.size > 400) for (const [k, v] of _backupAt) if (now - v > BACKUP_THROTTLE_MS) _backupAt.delete(k)
    _safeFs.backup(dataRootOfModule(), [target], {
      reason: 'overwrite:' + basename(target).slice(0, 40),
      scope: 'atomic-write',
    })
    if (++_backupCount % PRUNE_EVERY === 0) _safeFs.prune(dataRootOfModule(), { days: PRUNE_DAYS, maxBytes: PRUNE_MAX_BYTES })
  } catch { /* 留底失败不影响写盘 */ }
}

// 懒加载 safe-fs（循环依赖保护：safe-fs 自己也用 writeFileSync，不经过这里）
try {
  const mod = await import('./safe-fs.mjs')
  _safeFs = mod.default || mod
} catch { _safeFs = null }

const RETRY_DELAYS = [50, 150, 400]
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

// 同步上下文里真睡眠（不烧 CPU）：Atomics.wait 超时返回 'timed-out'
function sleepSync(ms) { try { Atomics.wait(SLEEP_BUF, 0, 0, ms) } catch { } }

function renameWithRetry(tmp, target) {
  let lastErr = null
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    try {
      renameSync(tmp, target)
      return
    } catch (e) {
      lastErr = e
      const code = (e && e.code) || ''
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e
      if (i < RETRY_DELAYS.length) sleepSync(RETRY_DELAYS[i])
    }
  }
  throw lastErr
}

/** 原子写文本。返回 true=成功。绝不部分写入目标文件。 */
export function writeTextAtomic(target, text) {
  const tmp = join(dirname(target), '.' + basename(target) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8))
  try {
    try { mkdirSync(dirname(target), { recursive: true }) } catch { }
    // 2026-11-11：覆盖前留底（目标已存在才留；节流/大小/自动清理见 autoBackupBeforeOverwrite）
    if (_safeFs) autoBackupBeforeOverwrite(target)
    writeFileSync(tmp, text, 'utf8')
    renameWithRetry(tmp, target)
    return true
  } catch (e) {
    try { unlinkSync(tmp) } catch { }
    throw e
  }
}

/** 原子写 JSON（等价 writeFileSync(p, JSON.stringify(data, null, 2))）。 */
export function writeJsonAtomic(target, data, indent = 2) {
  return writeTextAtomic(target, JSON.stringify(data, null, indent))
}
