/**
 * 统一运维入口：一次看清所有常驻服务，能起、能停、能看日志。
 *
 * 用法：
 *   node scripts/ops.mjs status          # 状态表
 *   node scripts/ops.mjs health          # 只判活（关键项失败退出码 2；--strict 连 warn 也失败）
 *   node scripts/ops.mjs start           # 拉起桥接 / adb 隧道 / ollama（幂等）
 *   node scripts/ops.mjs stop            # 停桥接并拆隧道
 *   node scripts/ops.mjs logs [名称] [-n 50] [-f]
 *
 * 不引入依赖；端口/路径全部来自 wechat-bridge/constants.mjs。
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, openSync, readFileSync, statSync, readSync, closeSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORTS, PATHS, SERVICES, validateConfig } from '../wechat-bridge/constants.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const BRIDGE_DIR = join(ROOT, 'wechat-bridge')
const CONFIG_PATH = join(BRIDGE_DIR, 'config.json')
const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {}
const ADB = String(config.adb?.exe || '')

const args = process.argv.slice(2)
const cmd = args[0] || 'status'
const opt = (name, dflt = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : dflt
}
const flag = (name) => args.includes(name)

/* ------------------------------ 输出工具 ------------------------------ */
const ansi = process.stdout.isTTY
const paint = (s, c) => (ansi ? `\x1b[${c}m${s}\x1b[0m` : s)
const green = (s) => paint(s, '32')
const red = (s) => paint(s, '31')
const yellow = (s) => paint(s, '33')
const dim = (s) => paint(s, '90')
const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\uFFDF\u3000-\u303F]/.test(ch) ? 2 : 1), 0)
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)))

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))))
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ')
  console.log(dim(line(headers)))
  console.log(dim(widths.map((n) => '─'.repeat(n)).join('  ')))
  for (const r of rows) console.log(line(r))
}

/* ------------------------------ 探针 ------------------------------ */
async function httpProbe(host, port, path, timeoutMs = 2000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`http://${host}:${port}${path || '/'}`, { signal: ac.signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, json }
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === 'AbortError' ? 'timeout' : (e?.code || e?.message || 'error') }
  } finally { clearTimeout(timer) }
}

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port })
    let done = false
    const finish = (ok, error) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* ignore */ }
      resolve({ ok, error })
    }
    sock.setTimeout(timeoutMs, () => finish(false, 'timeout'))
    sock.on('connect', () => finish(true))
    sock.on('error', (e) => finish(false, e.code || e.message))
  })
}

function adb(args, timeout = 15000) {
  if (!ADB) return Promise.resolve({ ok: false, out: '', err: 'adb 未配置' })
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, windowsHide: true }, (e, so, se) => {
      resolve({ ok: !e, out: String(so || ''), err: String(se || e?.message || '') })
    })
  })
}

const maskSerial = (s) => {
  const v = String(s || '')
  if (!v) return '(默认设备)'
  if (v.includes(':')) {
    const [host, port] = v.split(':')
    const parts = host.split('.')
    return `${parts.slice(0, 2).join('.')}.***.${parts.slice(-1)[0]}:${port}`
  }
  return v.length > 8 ? v.slice(0, 4) + '…' : v
}

/* ------------------------------ 状态汇总 ------------------------------ */
async function collect() {
  const bridgeHealth = await httpProbe('127.0.0.1', PORTS.bridge, '/wx/health')
  const h = bridgeHealth.json || {}
  const wcxReach = Boolean(h?.tablet?.reachable)
  const tunnel = String(h?.tunnel || 'unknown')
  const wcx = h?.wcx || {}
  const gh = h?.ghProxy || {}

  const checks = await Promise.all(SERVICES.filter((s) => s.probe !== 'via-bridge').map((s) =>
    s.probe === 'http'
      ? httpProbe(s.host, s.port, s.path)
      : tcpProbe(s.host, s.port)
  ))
  const checkById = new Map(SERVICES.filter((s) => s.probe !== 'via-bridge').map((s, i) => [s.id, checks[i]]))

  const dev = await adb(['devices'])
  const deviceLines = dev.out.split('\n').slice(1).filter((l) => l.trim())
  const devices = deviceLines.map((l) => l.trim().split(/\s+/)).filter((x) => x[0])
  const attached = devices.length ? devices.map(([serial, state]) => `${maskSerial(serial)} ${state}`).join('; ') : '无'

  // 多设备在线时必须指定 -s，否则 forward/reverse --list 读到的可能是另一台（USB）的隧道
  const serial = String(config.adb?.serial || '').trim()
  const adbPre = serial ? ['-s', serial] : []
  const fwd = (await adb([...adbPre, 'forward', '--list'])).out.trim()
  const rev = (await adb([...adbPre, 'reverse', '--list'])).out.trim()
  const hasForward = new RegExp(`tcp:${PORTS.wcx}`).test(fwd)
  const hasReverse = new RegExp(`tcp:${PORTS.bridge}`).test(rev)

  const rows = []
  const push = (name, ok, detail, critical = false, warn = false) => rows.push({ name, ok, detail, critical, warn })

  push('微信桥接 :' + PORTS.bridge, bridgeHealth.ok, bridgeHealth.ok ? `${h.status || 'ok'}${h.warnings?.length ? ' · ' + h.warnings.join(',') : ''}` : bridgeHealth.error || 'down', true)
  push('平板 WCX :' + PORTS.wcx, wcxReach, wcxReach ? `tunnel=${tunnel} watch=${h.watchCount ?? '?'}` : (tunnel === 'down' ? '隧道断开' : '不可达'), true)
  for (const s of SERVICES.filter((x) => x.probe !== 'via-bridge' && x.id !== 'bridge')) {
    const r = checkById.get(s.id) || { ok: false, error: 'no-probe' }
    let ok = r.ok
    let detail = ok ? 'up' : (r.error || `down :${s.port}`)
    if (s.id === 'ollama' && r.json?.models) detail = `up · ${r.json.models.length} 模型`
    if (s.id === 'ghProxy') {
      if (gh.enabled === false) { ok = false; detail = 'config 里已禁用' }
      else if (gh.enabled === true) { ok = Boolean(gh.listening); detail = gh.listening ? 'gh-proxy ok' : `失败 ${gh.error || ''}`.trim() }
      else detail = r.ok ? '端口有监听（桥接未上报状态）' : detail
    }
    push(s.name + ' :' + s.port, ok, detail, s.critical)
  }
  push('WCX 版本', Boolean(wcx.version), wcx.version ? `v${wcx.version}${wcx.readOnly ? ' · 只读(已知坏版本)' : ''}` : '未知（探测失败/旧桥接）', false, Boolean(wcx.readOnly))
  push('adb 连接', attached !== '无', attached, true)
  push(`adb forward :${PORTS.wcx}`, hasForward, hasForward ? 'ok' : '缺失', true)
  push(`adb reverse :${PORTS.bridge}`, hasReverse, hasReverse ? 'ok' : '缺失（平板推送通道会死）', true)

  return { rows, health: h, bridgeOk: bridgeHealth.ok, hasForward, hasReverse, wcxReach }
}

/* ------------------------------ 命令 ------------------------------ */
async function cmdStatus() {
  const cfg = validateConfig(config)
  if (cfg.errors.length) console.log(red('配置错误：' + cfg.errors.join('；')))
  for (const w of cfg.warnings) console.log(yellow('配置提醒：' + w))
  const { rows, health } = await collect()
  table(['服务', '状态', '说明'], rows.map((r) => [
    r.name,
    r.ok ? (r.warn ? yellow('WARN') : green('OK')) : (r.critical ? red('DOWN') : yellow('DOWN')),
    r.detail,
  ]))
  if (health.lastPushSecsAgo != null) console.log(dim(`\n最近推送 ${health.lastPushSecsAgo}s 前 · pushTotal=${health.pushTotal} · 轮询错误=${health.pollErrors ?? 0}`))
}

async function cmdHealth() {
  const { rows } = await collect()
  const failed = rows.filter((r) => r.critical && !r.ok)
  const warned = rows.filter((r) => !r.ok)
  for (const r of warned) console.log((r.critical ? red('FAIL') : yellow('WARN')) + ' ' + r.name + ' · ' + r.detail)
  if (!failed.length) console.log(green(`health: ${warned.length ? 'warn' : 'ok'}（关键服务全部在线）`))
  else console.log(red(`health: ${failed.length} 项关键服务不可用`))
  if (failed.length || (flag('--strict') && warned.length)) process.exit(2)
}

function ensureDir(p) { try { return existsSync(p) } catch { return false } }

async function cmdStart() {
  const cfg = validateConfig(config)
  if (!cfg.ok) { console.log(red('配置冲突，拒绝启动：' + cfg.errors.join('；'))); process.exit(1) }

  // 1) 桥接
  const probe = await httpProbe('127.0.0.1', PORTS.bridge, '/wx/health')
  if (probe.ok) console.log(green('bridge 已在运行 :' + PORTS.bridge))
  else {
    const vbs = join(BRIDGE_DIR, 'start-bridge-hidden.vbs')
    if (existsSync(vbs)) {
      // 走 WScript 隐藏启动：脱离当前 shell 的 job object，关掉终端也不会被带走
      await new Promise((resolve) => execFile('wscript', [vbs], { windowsHide: true }, () => resolve()))
      console.log('bridge 启动中：wscript start-bridge-hidden.vbs')
    } else {
      const outLog = PATHS.logs.bridgeOut
      const errLog = PATHS.logs.bridgeErr
      const fdOut = openSync(outLog, 'a')
      const fdErr = openSync(errLog, 'a')
      const child = spawn(process.execPath, [join(BRIDGE_DIR, 'server.mjs')], {
        cwd: BRIDGE_DIR, detached: true, windowsHide: true, stdio: ['ignore', fdOut, fdErr],
      })
      child.unref()
      console.log(`bridge 启动中：node server.mjs（日志 ${outLog}）`)
    }
    let again = { ok: false }
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 900))
      again = await httpProbe('127.0.0.1', PORTS.bridge, '/wx/health')
      if (again.ok) break
    }
    console.log(again.ok ? green('bridge OK') : red('bridge 启动失败，看 logs bridge 或 bridge-err'))
  }

  // 2) adb 隧道
  if (ADB) {
    const serial = String(config.adb?.serial || '').trim()
    const pre = serial ? ['-s', serial] : []
    if (serial.includes(':')) await adb(['connect', serial])
    const f = await adb([...pre, 'forward', `tcp:${config.adb?.localPort || PORTS.wcx}`, `tcp:${config.adb?.remotePort || PORTS.wcx}`])
    const r = await adb([...pre, 'reverse', `tcp:${PORTS.bridge}`, `tcp:${PORTS.bridge}`])
    console.log((f.ok ? green('adb forward OK') : red('adb forward 失败 ' + f.err)))
    console.log((r.ok ? green('adb reverse OK') : red('adb reverse 失败 ' + r.err)))
  } else console.log(yellow('config.adb.exe 未配置，跳过隧道'))

  // 3) ollama
  const ol = await httpProbe('127.0.0.1', PORTS.ollama, '/api/tags')
  if (ol.ok) console.log(green('ollama 已运行 :' + PORTS.ollama))
  else {
    try {
      const c = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
      c.unref()
      console.log('ollama 启动中（若未安装请手动安装）')
    } catch (e) { console.log(yellow('ollama 启动失败：' + (e?.message || e))) }
  }

  // 4) 其余服务只提示
  const tts = await tcpProbe('127.0.0.1', PORTS.tts)
  if (!tts.ok) console.log(dim(`TTS :${PORTS.tts} 未监听（按你的 TTS 启动方式手动拉起）`))
  console.log(dim(`pet-gate :${PORTS.petGate} 为云端中继，本机只需 agent（见 pet-gate/README）`))
  if (!ensureDir(PATHS.outbox)) console.log(yellow('outbox 目录不存在：' + PATHS.outbox))
  await cmdStatus()
}

function pidOnPort(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { timeout: 15000, windowsHide: true }, (e, so) => {
      if (e) return resolve([])
      const pids = new Set()
      for (const line of String(so).split('\n')) {
        const cols = line.trim().split(/\s+/)
        // 形如：TCP  127.0.0.1:4311  0.0.0.0:0  LISTENING  1234
        if (cols.length >= 5 && cols[0] === 'TCP' && cols[1].endsWith(`:${port}`) && /LISTEN/i.test(cols[3])) {
          pids.add(cols[4])
        }
      }
      resolve([...pids].filter((x) => Number.isFinite(Number(x))))
    })
  })
}

async function cmdStop() {
  const pids = await pidOnPort(PORTS.bridge)
  if (!pids.length) console.log(dim('bridge 未在监听 :' + PORTS.bridge))
  for (const pid of pids) {
    await new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => resolve()))
    console.log(`已停止 bridge pid=${pid}`)
  }
  if (ADB) {
    await adb(['forward', '--remove', `tcp:${config.adb?.localPort || PORTS.wcx}`])
    await adb(['reverse', '--remove', `tcp:${PORTS.bridge}`])
    console.log(dim(`已拆除 adb forward/reverse（只拆端口，不停 adb server）`))
  }
}

const LOG_MAP = {
  bridge: PATHS.logs.bridge,
  'bridge-out': PATHS.logs.bridgeOut,
  'bridge-err': PATHS.logs.bridgeErr,
  wechat: PATHS.logs.pluginWechat,
  harness: PATHS.logs.harness,
  debug: PATHS.logs.debug,
}

function tail(file, n) {
  if (!existsSync(file)) return []
  const st = statSync(file)
  const size = Math.min(st.size, 1024 * 1024)
  if (!size) return []
  const buf = Buffer.alloc(size)
  let fd = null
  try {
    fd = openSync(file, 'r')
    readSync(fd, buf, 0, size, st.size - size)
  } finally {
    if (fd != null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
  return buf.toString('utf8').split('\n').filter(Boolean).slice(-n)
}

async function cmdLogs() {
  const which = args[1] && !args[1].startsWith('-') ? args[1] : 'bridge'
  const n = Number(opt('-n', 60))
  const files = which === 'all' ? Object.values(LOG_MAP) : [LOG_MAP[which] || which]
  for (const f of files) {
    console.log(dim(`\n== ${f} ==`))
    const lines = tail(f, n)
    if (!lines.length) console.log(dim('(空或不存在)'))
    for (const l of lines) console.log(l)
  }
  if (flag('-f')) {
    console.log(dim('\n-- 跟随模式：Ctrl+C 退出 --'))
    const seen = new Map(files.map((f) => [f, existsSync(f) ? statSync(f).size : 0]))
    setInterval(() => {
      for (const f of files) {
        try {
          if (!existsSync(f)) continue
          const size = statSync(f).size
          const last = seen.get(f) || 0
          if (size <= last) { seen.set(f, size); continue }
          const buf = Buffer.alloc(size - last)
          const fd = openSync(f, 'r')
          readSync(fd, buf, 0, buf.length, last)
          seen.set(f, size)
          for (const l of buf.toString('utf8').split('\n').filter(Boolean)) console.log(l)
        } catch { /* ignore */ }
      }
    }, 1500)
  }
}

/* ------------------------------ 入口 ------------------------------ */
const main = async () => {
  if (cmd === 'status') return cmdStatus()
  if (cmd === 'health') return cmdHealth()
  if (cmd === 'start') return cmdStart()
  if (cmd === 'stop') return cmdStop()
  if (cmd === 'logs') return cmdLogs()
  console.log('用法：node scripts/ops.mjs status|health|start|stop|logs [名称] [-n N] [-f]')
  process.exit(1)
}
main().catch((e) => { console.error(red('ops 失败：' + (e?.stack || e))); process.exit(1) })
