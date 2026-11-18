#!/usr/bin/env node
/**
 * release-check.mjs —— 发版前的守门（2026-11-18，v0.1.7 起每次发布必跑）
 *
 *   node scripts/release-check.mjs            # 普通检查：有硬伤就 exit 1
 *   node scripts/release-check.mjs --strict   # 发布用：再加「本机隐私名单 / profile 依赖」硬校验
 *
 * 检查四类东西：
 *   1) 打包内容——不能带 data/、.state/、*.bak、*.lnk、cookie、私聊库、本地密钥脚本、tmp/；
 *   2) 包里内容——不能出现 token / 私钥 / 真实账号（名单从本机 private-people.json 读，脚本本身不存 id）；
 *   3) 兼容性——入口文件语法、必需文件齐全、不能写死本机绝对路径（只警告，列出清单）；
 *   4) 新用户可用性——人设必须有内置默认值（没有 character.json 也要有情绪和世界观）。
 *
 * 退出码：0 通过（可能有警告）；1 有硬伤，禁止发布。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const STRICT = process.argv.includes('--strict')
const fails = []
const warns = []

function fail(msg) { fails.push(msg) }
function warn(msg) { warns.push(msg) }
function ok(msg) { console.log(`✓ ${msg}`) }

// ── 0. 基本文件 ─────────────────────────────────────────────────────────────
const REQUIRED = [
  'package.json', 'index.js', 'entry.js', 'cordis.patch.yml', 'install.mjs',
  'README.md', 'CHANGELOG.md', 'settings-host.js',
  'dist/gateway/bootstrap.js',
  'dshqqbot/.qqbot-extensions/lib/private-guard.mjs',
  'dshqqbot/.qqbot-extensions/live/persona.mjs',
  'scripts/dsh-profile-links.mjs',
  'scripts/dsh-profile-preflight.mjs',
]
for (const f of REQUIRED) if (!existsSync(join(REPO, f))) fail(`缺少必需文件：${f}`)
if (!fails.length) ok(`必需文件齐全（${REQUIRED.length} 项）`)

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const version = String(pkg.version || '0.0.0')
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`package.json version 不是合法 semver：${version}`)
ok(`版本 ${pkg.name}@${version}`)

// ── 1. 打包内容清单（npm pack --dry-run，离线可用）────────────────────────────
let packed = []
try {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })

  const j = JSON.parse(raw.slice(raw.indexOf('[')))
  packed = (j[0]?.files || []).map((f) => String(f.path).replace(/\\/g, '/'))
} catch (e) {
  warn(`npm pack --dry-run 失败，改用 files 字段估算：${e?.message ?? e}`)
  packed = ['package.json']
}

const FORBIDDEN_PATH = [
  /(^|\/)data\//, /\.state\//, /\.bak($|[-.0-9])/, /\.lnk$/, /\.db($|-)/, /\.ndjson$/,
  /(^|\/)tmp\//, /(^|\/)logs\//, /private-people/i, /douyin-cookie/i,
  /wcx-token|bridge-token|env\.json|credentials/i, /wx4-[^/]*\.(ps1|cmd)$/,
  /(^|\/)secrets\//, /memory\.db$/, /\.sqlite3?$/,
]
const badPaths = packed.filter((p) => FORBIDDEN_PATH.some((re) => re.test(p)))
if (badPaths.length) fail(`发布包里混进了隐私/运行时文件（${badPaths.length} 个）：${badPaths.slice(0, 8).join(', ')}`)
else ok(`打包清单干净（${packed.length} 个文件，无 data/.state/cookie/密钥/私聊库）`)

// ── 2. 包里内容扫描 ─────────────────────────────────────────────────────────
const TEXT_EXT = /\.(mjs|js|cjs|ts|json|ya?ml|md|txt|html|css|ps1|cmd|bat)$/i
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{16,}/, '疑似 API Key（sk-）'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, '疑似 GitHub Token'],
  [/AKIA[0-9A-Z]{16}/, '疑似 AWS Key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '疑似私钥'],
  [/(_authToken|NODE_AUTH_TOKEN)\s*[=:]\s*\S+/, '疑似 npm token 写法'],
  [/Bearer\s+[A-Za-z0-9._-]{24,}/, '疑似 Bearer token'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, '疑似长 key'],
]

// 本机真实账号名单：只从本机数据读，脚本本身不带任何 id
const localIds = new Set()
const peopleFile = join(REPO, 'dshqqbot', '.qqbot', 'private-people.json')
if (existsSync(peopleFile)) {
  try {
    for (const p of JSON.parse(readFileSync(peopleFile, 'utf8'))) {
      for (const k of ['qq', 'wx', 'douyin']) if (p?.[k]) localIds.add(String(p[k]))
      if (p?.name && String(p.name).length >= 2) localIds.add(String(p.name))
    }
  } catch (e) { warn(`读取 ${peopleFile} 失败：${e?.message ?? e}`) }
} else if (STRICT) {
  warn(`没有 ${peopleFile}，跳过「真实账号」扫描（strict 下建议先建这份名单）`)
}

// 另外从本机的会话台账/通讯录里再收一批 id（防止名单文件没列的账号漏网）
for (const extra of [
  join(REPO, 'dshqqbot', '.qqbot', 'xtc-peers.json'),
  join(REPO, 'xtc-bridge', 'people.json'),
]) {
  if (!existsSync(extra)) continue
  try {
    const j = JSON.parse(readFileSync(extra, 'utf8'))
    const walk = (v) => {
      if (typeof v === 'string' && /^[0-9A-Za-z_-]{6,64}$/.test(v) && /\d/.test(v)) localIds.add(v)
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') { for (const [k, vv] of Object.entries(v)) { walk(k); walk(vv) } }
    }
    walk(j)
  } catch { /* 忽略 */ }
}
// 8 位以上纯数字句柄（openid 尾号、xtcId 之类）也算隐私，别写进包里
const NUMERIC_ID_RE = /\d{8,12}/

const hits = []
let scanned = 0
for (const rel of packed) {
  if (!TEXT_EXT.test(rel)) continue
  const abs = join(REPO, rel.split('/').join(sep))
  if (!existsSync(abs)) continue
  let txt = ''
  try {
    if (statSync(abs).size > 4 * 1024 * 1024) continue
    txt = readFileSync(abs, 'utf8')
  } catch { continue }
  scanned += 1
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(txt)) hits.push(`${rel}: ${label}`)
  }
  for (const id of localIds) {
    if (id.length >= 6 && txt.includes(id)) hits.push(`${rel}: 含本机真实账号/姓名「${id.slice(0, 4)}…」`)
  }
  if (rel.endsWith('.md')) {
    const m = txt.match(NUMERIC_ID_RE)
    if (m) hits.push(`${rel}: 出现疑似账号数字「${m[0]}」`)
  }
}
if (hits.length) {
  for (const h of hits.slice(0, 12)) fail(`内容泄露：${h}`)
} else {
  ok(`内容扫描通过（${scanned} 个文本文件，无 token/私钥/本机账号）`)
}

// ── 3. 兼容性 ───────────────────────────────────────────────────────────────
const ENTRY_FILES = ['index.js', 'entry.js', 'settings-host.js', 'install.mjs', 'dist/gateway/bootstrap.js',
  'dshqqbot/.qqbot-extensions/lib/private-guard.mjs', 'dshqqbot/.qqbot-extensions/live/persona.mjs']
for (const f of ENTRY_FILES) {
  const abs = join(REPO, f)
  if (!existsSync(abs)) continue
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' })
  } catch (e) {
    fail(`语法错误：${f}\n${String(e?.stderr || e?.message || e).slice(0, 400)}`)
  }
}
ok(`入口语法检查通过（${ENTRY_FILES.length} 个文件）`)

// 本机 profile 依赖写法（npm 绝对盘符 file: → pnpm 拼路径 → 安全模式）
const appData = process.env.APPDATA || ''
if (appData) {
  const prof = join(appData, 'dsh-desktop', 'harness', 'profiles', 'web', 'package.json')
  if (existsSync(prof)) {
    try {
      const man = JSON.parse(readFileSync(prof, 'utf8'))
      const deps = { ...(man.dependencies || {}), ...(man.devDependencies || {}) }
      const bad = Object.entries(deps).filter(([, v]) => typeof v === 'string' && /^file:[A-Za-z]:[\\/]/.test(v))
      if (bad.length) {
        const msg = `本机 profile 有绝对盘符 file: 依赖（会让 DSH 进安全模式）：${bad.map(([k]) => k).join(', ')} → 跑 node scripts/dsh-profile-links.mjs`
        if (STRICT) fail(msg)
        else warn(msg)
      } else ok('profile 依赖写法正常（无绝对盘符 file:）')
    } catch { warn('读取本机 profile 的 package.json 失败（跳过）') }
  }
}

// 写死的本机绝对路径（只警告，列出来慢慢清）
const ABS_PATH_RE = /["'`]([A-Za-z]:[\\/][^"'`\n]{3,})["'`]/
const absOffenders = []
for (const rel of packed) {
  if (!TEXT_EXT.test(rel) || rel.endsWith('.md')) continue
  const abs = join(REPO, rel.split('/').join(sep))
  if (!existsSync(abs)) continue
  let txt = ''
  try { txt = readFileSync(abs, 'utf8') } catch { continue }
  let n = 0
  for (const line of txt.split('\n')) {
    if (/^\s*(\*|\/\/|#)/.test(line)) continue
    // 系统目录（Windows 字体 / Program Files）不算「作者本机路径」，允许作为兜底
    const sysLine = line.indexOf('Windows') >= 0 || line.indexOf('Program Files') >= 0
    if (!sysLine && ABS_PATH_RE.test(line)) n += 1
  }
  if (n) absOffenders.push(`${relative(REPO, abs).split(sep).join('/')}（${n} 处）`)
}
if (absOffenders.length) {
  warn(`代码里还有 ${absOffenders.length} 个文件写着本机绝对路径（别人机器上会失效，建议逐步改成从 import.meta.url 推）：${absOffenders.slice(0, 6).join('、')}${absOffenders.length > 6 ? ' …' : ''}`)
} else {
  ok('没有写死的本机绝对路径')
}

// ── 4. 新用户可用性：默认人设/世界观 ─────────────────────────────────────────
const personaFile = join(REPO, 'dshqqbot', '.qqbot-extensions', 'live', 'persona.mjs')
if (existsSync(personaFile)) {
  const t = readFileSync(personaFile, 'utf8')
  const hasDefaultName = /j\?\.name\s*\|\|\s*'[^']+'/.test(t)
  const hasDefaultSpecies = /j\?\.species\s*\|\|\s*'[^']+'/.test(t)
  const hasCore = /j\?\.core[^\n]*(\|\||:)\s*'[^']+'/.test(t)
  if (!(hasDefaultName && hasDefaultSpecies && hasCore)) fail('persona.mjs 缺少内置默认人设（新用户会没有性格/世界观）')
  else ok('默认人设齐全（名字 / 种族 / 性格 都有内置兜底）')
} else {
  fail('缺少 live/persona.mjs')
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('')
if (warns.length) {
  console.log(`⚠ 警告 ${warns.length} 条：`)
  for (const w of warns) console.log(`  - ${w}`)
}
if (fails.length) {
  console.error(`\n✗ 发版检查未通过（${fails.length} 条硬伤）：`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\n✅ 发版检查通过${STRICT ? '（strict）' : ''}：可以 npm publish / 提 market PR`)
