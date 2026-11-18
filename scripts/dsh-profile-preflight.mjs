// DSH profile 启动前自检：防止 2026-11-14 那种「依赖写法不对 → install 失败 → 安全模式」再发生。
//
// 背景：桌面端自带 pnpm 10.34.5，遇到 "file:F:/qqbot" 这种带盘符的绝对路径依赖，
// 会把它当相对路径拼成 C:\...\profiles\web\F:\qqbot 再 scandir，直接 ENOENT；
// 整次 install 失败 → dshmarket 基线立不起来 → 桌面端判定正常 profile 不可恢复 → 安全模式，
// 所有第三方插件（QQ / 微信 / 小天才）全都不加载。
//
// 检查项：
//   1. package.json 里没有 file:<盘符>: 这种绝对路径依赖。
//   2. local-plugins/<三个本地插件> 的软链在，且指向真身。
//   3. node_modules/<三个本地插件> 已经装好（否则插件不会加载）。
//   4. 三个插件都在 dsh.profile.bundles 里。
//
// 用法：
//   node scripts/dsh-profile-preflight.mjs                    # 只检查（快，无副作用），有漂移退出码 1
//   node scripts/dsh-profile-preflight.mjs --repair           # 修软链 + 改 manifest
//   node scripts/dsh-profile-preflight.mjs --repair --install # 再跑一次桌面端自己的 pnpm install
//   node scripts/dsh-profile-preflight.mjs --check --quiet    # 开机脚本用：只有异常时写日志
//
// 退出码：0 正常，1 有漂移（未修/修不动），2 环境找不到。

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const repair = has('--repair')
const install = has('--install')
const forceInstall = has('--force-install')
const quiet = has('--quiet')
const noSmoke = has('--no-smoke')

const homeArg = args.indexOf('--home')
const dshHome = homeArg >= 0 && args[homeArg + 1]
  ? resolve(args[homeArg + 1])
  : join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'dsh-desktop', 'harness')

const profileDir = join(dshHome, 'profiles', 'web')
const manifestPath = join(profileDir, 'package.json')
const logPath = join(here, '..', 'tmp', 'profile-preflight.log')
const PLUGINS = ['dsh-qqbot-muu', 'dsh-wechat-muu', 'dsh-xtc-muu']

/** 每个插件真正被加载的入口文件（在 node_modules 里那一份，不是源码） */
const ENTRY_POINTS = [
  ['dsh-qqbot-muu', 'entry.js'],
  ['dsh-wechat-muu', 'index.mjs'],
  ['dsh-xtc-muu', 'index.mjs'],
]

/**
 * 在子进程里真 import 一遍插件入口。
 *
 * 2026-11-14 的第二次安全模式就是这么来的：dsh-xtc-muu 里写了
 * `import ... from '../qqbot-mod/muu-shared.mjs'`，pnpm 把插件**复制**进
 * node_modules/.pnpm/<包名>@…/node_modules/<包名> 之后，上一级从仓库根变成 node_modules，
 * import 阶段直接 ERR_MODULE_NOT_FOUND → required 插件起不来 → DSH 掉安全模式。
 * 这种错只看文件在不在是查不出来的，必须真 import。
 */
function checkEntryImports() {
  const drift = []
  for (const [name, entry] of ENTRY_POINTS) {
    const file = join(profileDir, 'node_modules', name, entry)
    if (!existsSync(file)) continue // "没装"上面已经报过了
    const url = pathToFileURL(file).href
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    })
    if (run.error?.code === 'EPERM' || run.error?.code === 'EACCES') continue // 沙箱不让 spawn，跳过
    if (run.status !== 0) {
      const tail = `${run.stderr ?? ''}`
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /Error|ERR_|Cannot find|not defined/.test(l))
        .slice(-2)
        .join(' ')
      drift.push(`${name} 入口 import 失败（DSH 启动必然掉安全模式）：${tail || `exit=${run.status ?? run.signal}`}`)
    }
  }
  return drift
}

function log(line) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* 日志写不了不影响主流程 */ }
}

function say(line) {
  if (!quiet) console.log(line)
  log(line)
}

function inspectDrift() {
  const drift = []
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return [`package.json 不是合法 JSON：${error?.message ?? error}`]
  }

  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof spec === 'string' && /^file:[a-zA-Z]:/.test(spec)) {
      drift.push(`${name} 用了绝对路径 ${spec}（pnpm 10 会 ENOENT → 安全模式）`)
    }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  for (const name of PLUGINS) {
    if (manifest.dependencies?.[name] !== `file:./local-plugins/${name}`) {
      drift.push(`${name} 的依赖写法不是 file:./local-plugins/${name}`)
    }
    if (!bundles.includes(name)) drift.push(`${name} 不在 dsh.profile.bundles`)
    try { statSync(join(profileDir, 'local-plugins', name)) } catch { drift.push(`local-plugins/${name} 软链不存在`) }
    if (!existsSync(join(profileDir, 'node_modules', name, 'package.json'))) {
      drift.push(`node_modules/${name} 没装（插件不会加载）`)
    }
  }
  if (!noSmoke && !drift.some((d) => d.includes('没装'))) drift.push(...checkEntryImports())
  return drift
}

if (!existsSync(manifestPath)) {
  console.error(`✗ 找不到 profile manifest：${manifestPath}`)
  process.exit(2)
}

let drift = inspectDrift()
if (drift.length === 0) {
  // --quiet 是开机脚本用的：正常就完全安静，别每 5 分钟往日志里写一行
  if (!quiet) say('✓ DSH profile 自检通过')
  process.exit(0)
}

say(`✗ DSH profile 自检发现 ${drift.length} 处漂移：`)
for (const d of drift) say(`  - ${d}`)

if (!repair) {
  say('（只检查，未修改；加 --repair --install 可自动修复）')
  process.exit(1)
}

// 1) 修软链 + manifest（复用 dsh-profile-links.mjs，避免两套实现漂移）
const linksScript = join(here, 'dsh-profile-links.mjs')
const fix = spawnSync(process.execPath, [linksScript, '--home', dshHome], { encoding: 'utf8' })
if (fix.status !== 0) {
  say(`✗ 修 profile 依赖失败：${(fix.stderr || fix.stdout || '').trim()}`)
  process.exit(1)
}
for (const line of (fix.stdout ?? '').trim().split(/\r?\n/).filter((l) => l.startsWith('✓'))) say(line)

drift = inspectDrift()

// 2) node_modules 里还没装 → 用桌面端自己的 pnpm shim 装一遍（版本一致，不会踩 pnpm 版本差异）
const missingInstall = drift.some((d) => d.includes('没装'))
if (missingInstall && (install || forceInstall)) {
  const pnpmCmd = join(dshHome, '.desktop-bin', 'pnpm.cmd')
  if (!existsSync(pnpmCmd)) {
    say(`✗ 找不到 ${pnpmCmd}，无法自动 install`)
    process.exit(1)
  }
  say('… 正在跑 pnpm install（最多 5 分钟）')
  const run = spawnSync(pnpmCmd, ['install', '--no-frozen-lockfile'], {
    cwd: profileDir,
    shell: true,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 300_000,
  })
  const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
  if (run.status !== 0) {
    say(`✗ pnpm install 失败（exit=${run.status}）：\n${tail}`)
    process.exit(1)
  }
  say(`✓ pnpm install 完成\n${tail}`)
  drift = inspectDrift()
}

if (drift.length > 0) {
  say('✗ 修复后仍有漂移：')
  for (const d of drift) say(`  - ${d}`)
  if (drift.some((d) => d.includes('没装'))) {
    say('还差安装：node scripts/dsh-profile-preflight.mjs --repair --install')
  }
  process.exit(1)
}

say('✓ 已修复，DSH profile 自检通过')
process.exit(0)
