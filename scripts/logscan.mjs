/**
 * 发布前日志脱敏扫描：PIN / token / wxid / 手机号 / cookie / 密钥字面量。
 *
 * 用法：
 *   node scripts/logscan.mjs                 # 扫默认日志（最近 2000 行/文件）
 *   node scripts/logscan.mjs --lines 5000    # 扩大范围
 *   node scripts/logscan.mjs --json          # 机器可读
 *
 * 设计约束：
 *   · 只输出「类别 + 文件 + 行号 + 打码片段」，绝不回显命中的完整值；
 *   · 会读取 secrets/ 下的值做精确比对（只用于内存匹配，不打印、不落盘）；
 *   · 命中即退出码 1，作为发布前必跑项。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { PATHS } from '../wechat-bridge/constants.mjs'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : dflt
}
const LINES = Number(opt('--lines', 2000))
const JSON_OUT = args.includes('--json')
const APPDATA = process.env.APPDATA || ''
const QQ_PLUGIN_LOG = join(APPDATA, 'dsh-desktop', 'harness', 'dsh-qqbot-muu', 'logs.txt')

const TARGETS = [
  ['bridge.log', PATHS.logs.bridge],
  ['bridge-stdout.log', PATHS.logs.bridgeOut],
  ['bridge-stderr.log', PATHS.logs.bridgeErr],
  ['wechat-muu/logs.txt', PATHS.logs.pluginWechat],
  ['qqbot-muu/logs.txt', QQ_PLUGIN_LOG],
  ['harness.log', PATHS.logs.harness],
  ['debug.log', PATHS.logs.debug],
  // 桥接重启时轮转出来的历史日志（start-bridge.bat 保留最近 10 份）
  ...(() => {
    const dir = join(dirname(PATHS.logs.bridge), 'logs')
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir).filter((f) => /^bridge-\d{8}-\d{6}\.log$/.test(f)).sort()
        .map((f) => [`logs/${f}`, join(dir, f)])
    } catch { return [] }
  })(),
].filter(([, p]) => existsSync(p))

/* ---------------------- 从 secrets/ 取精确字面量（不外显） ---------------------- */
function collectSecrets(dir) {
  const out = []
  if (!existsSync(dir)) return out
  const walk = (d) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        // log-archive 里存的是历史日志，拿它当「密钥字面量」只会制造海量误报
        if (e.name !== 'docs' && e.name !== 'runtime' && e.name !== 'log-archive') walk(p)
        continue
      }
      if (!e.isFile() || statSync(p).size > 2 * 1024 * 1024) continue
      let text = ''
      try { text = readFileSync(p, 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        const v = line.trim()
        if (v.length >= 8 && !v.startsWith('#') && !v.includes('\\') && !v.startsWith('{')) {
          out.push({ file: basename(p), value: v })
        }
      }
    }
  }
  walk(dir)
  const env = String(process.env.WCX_TOKEN || '').trim()
  if (env.length >= 8) out.push({ file: 'env:WCX_TOKEN', value: env })
  // 去重 + 长值优先（避免短值误报）
  const seen = new Set()
  const uniq = []
  for (const s of out) {
    if (s.value.length < 8 || seen.has(s.value)) continue
    seen.add(s.value)
    uniq.push(s)
  }
  return uniq
}

const SECRETS = collectSecrets(PATHS.secrets)

/* ---------------------- 规则 ---------------------- */
const RULES = [
  { id: 'wxid', re: /wxid_[A-Za-z0-9_-]{4,}/g },
  { id: 'wxid', re: /(?:wxid|talker|convId)["'\s:=：]{1,4}[A-Za-z0-9_-]{6,}/gi },
  { id: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { id: 'token', re: /(?:token|secret|api[_-]?key)[\w-]{0,6}["'\s]{0,4}[:=：]\s*[A-Za-z0-9._~+/=-]{8,}/gi },
  { id: 'openai-key', re: /sk-[A-Za-z0-9]{12,}/g },
  { id: 'cookie', re: /(?:SESSDATA|bili_jct|sessionid)["'\s:=：]{1,4}[^;\s"']{8,}/gi },
  { id: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { id: 'pin', re: /(?:pin|PIN|密码|口令)["'\s:=：]{1,4}[0-9A-Za-z!@#$%^&*._-]{4,}/g },
]

/** 打码：只留前 2 个字符与长度，其余星号 */
function masked(s) {
  const v = String(s || '')
  if (v.length <= 4) return '****'
  return v.slice(0, 2) + '*'.repeat(Math.min(12, Math.max(4, v.length - 2)))
}

function displayTime(line) {
  const m = line.match(/^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]?/)
  if (m) {
    try {
      const d = new Date(m[1])
      return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + line.slice(m[0].length)
    } catch { return line }
  }
  return line
}

/* ---------------------- 扫描 ---------------------- */
// 宿主启动时会打印本机 Web UI 的一次性会话 URL（dsh web: http://127.0.0.1:43129/?token=…）。
// 它是 DSH 自己生成的临时本地凭据，只存在于本机 harness.log，不归本项目管理，也不出网；
// 计入「发布前必跑」只会让门禁永远红。单独跳过，不计命中。
const LOCAL_UI_TOKEN = /dsh web:\s*http:\/\/127\.0\.0\.1:\d+\/\?token=/i

const hits = []
for (const [label, file] of TARGETS) {
  let lines = []
  try {
    const text = readFileSync(file, 'utf8')
    lines = text.split('\n').slice(-LINES)
  } catch { continue }
  lines.forEach((line, i) => {
    if (!line) return
    if (LOCAL_UI_TOKEN.test(line)) return
    const shown = displayTime(line)
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(shown)) !== null) {
        // 纯数字值多为账号/ID（如 QQ appId），不是凭据 → 不算泄露
        const val = (m[0].match(/[:=：]\s*(.+)$/) || [])[1] || m[0]
        if (/^\d+$/.test(val)) continue
        if (/^[\\/]/.test(val)) continue // 路径片段（如 "token generated F:\..."）不是凭据
        hits.push({ file: label, line: i + 1, category: rule.id, sample: masked(m[0]) })
        if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1
      }
    }
    for (const s of SECRETS) {
      if (line.includes(s.value)) hits.push({ file: label, line: i + 1, category: `secret:${s.file}`, sample: masked(s.value) })
    }
  })
}

/* ---------------------- 输出 ---------------------- */
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: hits.length === 0, scanned: TARGETS.length, secretsLoaded: SECRETS.length, hits }, null, 2))
} else {
  console.log(`扫描 ${TARGETS.length} 个日志文件（每个最近 ${LINES} 行），加载 ${SECRETS.length} 条 secret 字面量用于比对`)
  if (!hits.length) console.log('结论：干净（未发现 PIN/token/wxid/手机号/密钥泄露）')
  else {
    console.log(`结论：发现 ${hits.length} 处疑似敏感信息（值已打码）`)
    const byCat = {}
    for (const h of hits) byCat[h.category] = (byCat[h.category] || 0) + 1
    for (const [k, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`)
    console.log('\n明细（最多 30 条）：')
    for (const h of hits.slice(0, 30)) console.log(`  ${h.file}:${h.line}  [${h.category}]  ${h.sample}`)
    if (hits.length > 30) console.log(`  … 其余 ${hits.length - 30} 条省略`)
  }
}
process.exit(hits.length ? 1 : 0)
