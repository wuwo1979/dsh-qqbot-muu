/**
 * DSH 单实例守护（2026-11-15）
 *
 * 背景：DSH Desktop 每次重启都会换 cookie、换 GUI 端口，旧进程有时没退干净，
 * 于是两套 DSH 同时加载 qqbot 插件、各自往 QQ/微信发消息 —— 同一条回复发两遍。
 *
 * 做法（不依赖 DSH 内部实现）：
 *   1. 启动时列出所有 DSH Desktop 进程，杀掉「启动时间早于我」的那些（连同子进程）。
 *   2. 抢占固定协调端口 4789：谁先绑上谁是主实例；绑不上就找出占用者、结束它、重试。
 *   3. 把 {pid, cookie, port, guiPort, startedAt} 写进锁文件；之后任何插件都能用
 *      verifyOwnership() 校验「锁里的 cookie 是不是我」，不是就说明自己是旁支实例。
 *
 * 纯 Node（netstat + powershell + taskkill），不依赖任何 DSH API。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LOCK_PORT = Number(process.env.DSH_GUARD_PORT || 4789)
export const LOCK_FILE = process.env.DSH_GUARD_LOCK || 'F:\\qqbot\\dshqqbot\\.qqbot\\dsh-instance.json'

const isWin = process.platform === 'win32'

/** 统一日志：被插件 import 时不要往 stdout 乱打，出错也不该影响调用方 */
function log(...args) {
  if (process.env.DSH_GUARD_QUIET === '1') return
  try { console.log('[instance]', ...args) } catch { /* ignore */ }
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, ...opts })
  } catch (e) {
    return e?.stdout ? String(e.stdout) : ''
  }
}

/** 当前进程是否就是 DSH 主进程（插件跑在主进程里） */
function selfProcessEntry(list) {
  return list.find((p) => p.Id === process.pid) || null
}

function listDshProcesses() {
  if (!isWin) return []
  const out = run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}' -f $_.Id, $_.StartTime.ToUniversalTime().ToString('o') }",
  ])
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+\|/.test(l))
    .map((l) => {
      const [id, iso] = l.split('|')
      return { Id: Number(id), Start: Date.parse(iso) }
    })
    .filter((p) => Number.isFinite(p.Id) && Number.isFinite(p.Start))
}

function killTree(pid, why) {
  if (!pid || pid === process.pid) return false
  if (!isWin) {
    try { process.kill(pid, 'SIGKILL'); return true } catch { return false }
  }
  run('taskkill.exe', ['/F', '/T', '/PID', String(pid)])
  console.log(`[instance-guard] 结束旧实例 ${pid}（${why}）`)
  return true
}

/** 找出占用某个本机端口的 pid */
function pidOnPort(port) {
  if (!isWin) return 0
  const out = run('netstat.exe', ['-ano'])
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    const pid = Number(parts[parts.length - 1])
    if (Number.isFinite(pid) && pid > 0) return pid
  }
  return 0
}

/** 当前进程监听的 GUI 端口（DSH 每次重启随机，这里只是记进锁里方便排查） */
function guessGuiPort(pid) {
  if (!isWin) return 0
  const out = run('netstat', ['-ano'])
  const ports = []
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    if (Number(parts[parts.length - 1]) !== pid) continue
    const m = parts[1]?.match(/:(\d+)$/)
    if (m) ports.push(Number(m[1]))
  }
  // GUI 端口通常是个 4 万以上的高位端口
  return ports.filter((p) => p >= 10000 && p < 65000).sort((a, b) => b - a)[0] || 0
}

function bindPort(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', (e) => resolve({ ok: false, code: e?.code || 'ERR', srv: null }))
    srv.listen(port, '127.0.0.1', () => resolve({ ok: true, srv }))
  })
}

function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 取某进程的祖先 pid 集合（最多 8 层）。拿不到就返回空集（宁可不动手）。 */
function ancestorsOf(pid) {
  const out = new Set()
  let cur = Number(pid)
  for (let i = 0; i < 8 && cur > 0; i++) {
    const r = run('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${cur}").ParentProcessId`])
    const parent = Number(String(r.stdout || '').trim())
    if (!parent || parent === cur || out.has(parent)) break
    out.add(parent)
    cur = parent
  }
  return out
}

function readLock() {
  try {
    if (!existsSync(LOCK_FILE)) return null
    return JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
  } catch { return null }
}

function writeLock(data) {
  try {
    mkdirSync(dirname(LOCK_FILE), { recursive: true })
    writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2))
  } catch (e) {
    console.log(`[instance-guard] 写锁失败（忽略）：${e?.message ?? e}`)
  }
}

/**
 * 保证本进程是唯一活着的 DSH 实例。
 * 幂等：同进程重复调用直接返回 ok。
 * @param {{ keepServer?: boolean }} opts keepServer=true 时把端口服务挂着（占位防别人再抢）
 */
export async function ensureSingleInstance(opts = {}) {
  const lock = readLock()
  // 同一轮启动的「兄弟」进程（qqbot 与 wechat 插件可能各在自己的宿主进程里）：
  // 锁是刚写的、进程还活着，就共用这把锁，绝不互相 kill。
  if (lock && lock.pid !== process.pid && isAlive(lock.pid)
      && Math.abs(Date.now() - Number(lock.startedAt || 0)) < 120_000) {
    return { ok: true, reused: true, sibling: true, cookie: lock.cookie, port: lock.port, guiPort: lock.guiPort, killed: [] }
  }
  if (lock && lock.pid === process.pid) {
    return { ok: true, reused: true, cookie: lock.cookie, port: lock.port, guiPort: lock.guiPort, killed: [] }
  }

  const killed = []
  const mine = Date.now()
  const procs = listDshProcesses()
  const me = selfProcessEntry(procs)
  const myStart = me?.Start || mine

  // 0. 最关键的一步：锁文件里记着的「上一套」如果还活着，说明上次没退干净。
  //    插件宿主往往不是 DSH 主进程，没法靠 StartTime 判断，但锁是准的。
  //    只杀「不在自己祖先链里」的，绝不会误杀自己的父进程。
  if (lock && Number(lock.pid) && Number(lock.pid) !== process.pid && isAlive(Number(lock.pid))) {
    const anc = ancestorsOf(process.pid)
    if (anc.has(Number(lock.pid))) {
      log(`锁里的 pid ${lock.pid} 是本进程的祖先（同一套 DSH），保留`)
    } else {
      killTree(Number(lock.pid), '锁文件里的上一套 DSH 还活着（旧 cookie）')
      killed.push(Number(lock.pid))
      await new Promise((ok) => setTimeout(ok, 800))
    }
  }

  // 1. 杀掉比我早启动的 DSH 实例（旧 cookie 的那套）
  // 安全闸：插件可能跑在 node 子进程里，此时 process.pid 不在 DSH Desktop 列表 ——
  // 这种情况下宁可不杀，也绝不能误杀宿主（那是「把自己弄死」）。
  const oldest = procs.length ? Math.min(...procs.map((p) => Number(p.Start) || Infinity)) : Infinity
  const isMainProc = !!me && (Number(me.Start) || 0) <= oldest + 1500
  if (!me) {
    log('本进程 pid 不在 DSH Desktop 列表里（跑在子进程），本次跳过清理，只做端口与锁')
  } else if (!isMainProc) {
    // 插件可能跑在 GPU/utility 辅助进程里：辅助进程也比主进程晚启动，
    // 这时候杀「更早的」就会把宿主一起干掉 —— 只允许主进程做清理。
    log('本进程不是最老的 DSH 进程（疑似辅助进程），跳过清理，只做端口与锁')
  } else {
    for (const p of procs) {
      if (p.Id === process.pid) continue
      if (p.Start < myStart - 2000) {
        if (killTree(p.Id, '启动早于本实例，视为残留')) killed.push(p.Id)
      }
    }
  }

  // 2. 抢固定协调端口
  let holder = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await bindPort(LOCK_PORT)
    if (r.ok) { holder = r.srv; break }
    if (r.code !== 'EADDRINUSE' && r.code !== 'EACCES') break
    const pid = pidOnPort(LOCK_PORT)
    if (!pid || pid === process.pid) break
    if (lock && lock.pid === pid && Math.abs(Date.now() - Number(lock.startedAt || 0)) < 120_000) break
    killTree(pid, `占用协调端口 ${LOCK_PORT}`)
    killed.push(pid)
    await new Promise((ok) => setTimeout(ok, 600))
  }

  const cookie = randomUUID()
  const guiPort = me ? guessGuiPort(process.pid) : 0
  writeLock({ pid: process.pid, cookie, port: LOCK_PORT, guiPort, startedAt: myStart, updatedAt: Date.now(), killed })

  if (holder && !opts.keepServer) holder.close()

  return { ok: Boolean(holder), cookie, port: LOCK_PORT, guiPort, killed, lockPath: LOCK_FILE }
}

/** 锁里的 cookie 是不是本实例的（不是 → 自己是旁支，别发送） */
export function verifyOwnership() {
  const lock = readLock()
  if (!lock) return { ok: false, reason: 'no-lock' }
  if (lock.pid === process.pid) return { ok: true, lock }
  // pid 不同：看看它是否还活着
  const live = listDshProcesses().some((p) => p.Id === lock.pid)
  return { ok: !live, reason: live ? `locked-by-pid-${lock.pid}` : 'stale-lock', lock }
}

export function releaseLock() {
  const lock = readLock()
  if (lock?.pid === process.pid) {
    try { writeFileSync(LOCK_FILE, JSON.stringify({ ...lock, releasedAt: Date.now() }, null, 2)) } catch { /* ignore */ }
  }
}

// 直接运行时：node scripts/dsh-instance-guard.mjs [--check]
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ lock: readLock(), processes: listDshProcesses(), ownership: verifyOwnership() }, null, 2))
  } else {
    const r = await ensureSingleInstance({ keepServer: false })
    console.log(JSON.stringify(r, null, 2))
  }
}
