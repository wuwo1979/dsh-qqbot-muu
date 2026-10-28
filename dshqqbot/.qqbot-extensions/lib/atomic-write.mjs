// [qqbot-mod] atomic-write 2026-10-27：原子写盘（学自 ops-handoff-design 02 号文档 §5.6 并发契约）
// 纪律：临时文件 → fs.renameSync（同目录内 rename 是原子的），绝不直接 writeFileSync(目标)。
// Windows 上目标被占用时 rename 会抛 EPERM/EBUSY —— 按 50/150/400ms 重试 3 次，绝不退化为直接写。
import { writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { mkdirSync } from 'node:fs'

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
