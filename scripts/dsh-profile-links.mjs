// 把 F:\qqbot 里的三个本地插件以「profile 内相对路径」接进 DSH profile，
// 并在 profile 里建 local-plugins/<包名> 的 junction（软链）指向真身。
//
// 为什么要这么绕（2026-11-14 触发安全模式的事故）：
//   profile 的 package.json 曾经写成  "dsh-qqbot-muu": "file:F:/qqbot"。
//   桌面端自带的是 pnpm 10.34.5，它把 file: 后面的 "F:/qqbot" 当**相对路径**，
//   拼成 C:\...\profiles\web\F:\qqbot 再去 scandir，直接 ENOENT：
//     ENOENT: no such file or directory, scandir '...\profiles\web\F:\qqbot'
//   install 一失败，dshmarket 基线就立不起来，桌面端判定「正常 profile 不可恢复」
//   → 自动进安全模式，所有第三方插件（QQ/微信/小天才）全部不加载。
//   （pnpm 12 能正确解析这种写法，所以换个 pnpm 版本就复现不出来，很难猜。）
//
// 现在改成：profile 里 local-plugins/<包名> 是指向真身的 junction，
//   package.json 里写相对路径 file:./local-plugins/<包名>。
//   pnpm 只往 lockfile 里记相对路径，任何版本都能重装；junction 是软链，不复制 62 GB 源码。
//
// 用法：
//   node scripts/dsh-profile-links.mjs            # 修正（需要写 AppData，沙箱需放权）
//   node scripts/dsh-profile-links.mjs --check    # 只检查，有漂移就退出码 1
//   node scripts/dsh-profile-links.mjs --home "D:/dsh/home"
//
// 改完 profile 的 package.json 之后，还要让 pnpm 真正装一遍（否则 node_modules 里没链）：
//   pnpm --dir "<profile>" install --no-frozen-lockfile
// 桌面端重启时会自己跑一遍这个 install；也可以用 scripts/dsh-profile-install.mjs。

import { existsSync, lstatSync, readlinkSync, symlinkSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** [包名, 真身绝对路径] —— 和 package.json 的 dsh.profile.bundles 对应 */
const PLUGINS = [
  ['dsh-qqbot-muu', 'F:/qqbot'],
  ['dsh-wechat-muu', 'F:/qqbot/dsh-wechat-muu'],
  ['dsh-xtc-muu', 'F:/qqbot/dsh-xtc-muu'],
]

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const homeIndex = args.indexOf('--home')
const dshHome = homeIndex >= 0 && args[homeIndex + 1]
  ? resolve(args[homeIndex + 1])
  : join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'dsh-desktop', 'harness')

const profileDir = join(dshHome, 'profiles', 'web')
const manifestPath = join(profileDir, 'package.json')
const localDir = join(profileDir, 'local-plugins')

const problems = []
const changes = []

function samePath(a, b) {
  const norm = (p) => resolve(p).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 返回 'missing' | 'link:<target>' | 'dir' */
function inspect(path) {
  let st
  try { st = lstatSync(path) } catch { return { kind: 'missing' } }
  if (st.isSymbolicLink()) return { kind: 'link', target: readlinkSync(path) }
  return { kind: 'dir' }
}

if (!existsSync(manifestPath)) {
  console.error(`✗ 找不到 profile manifest：${manifestPath}`)
  process.exit(2)
}

const raw = readFileSync(manifestPath, 'utf8')
if (raw.charCodeAt(0) === 0xfeff) problems.push('package.json 带 UTF-8 BOM（桌面端 pnpm runner 会报 invalid JSON）')

/** @type {any} */
let manifest
try {
  manifest = JSON.parse(raw.replace(/^\uFEFF/, ''))
} catch (error) {
  console.error(`✗ package.json 不是合法 JSON：${error?.message ?? error}`)
  process.exit(2)
}

manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []

// 1) 一切绝对盘符的 file: 依赖都是雷（pnpm 10 会拼成 <profile>\F:\...）
for (const [name, spec] of Object.entries(manifest.dependencies)) {
  if (typeof spec === 'string' && /^file:[a-zA-Z]:/.test(spec)) {
    problems.push(`依赖 ${name} 用了绝对路径 ${spec} —— pnpm 10 会 ENOENT，必须改成相对路径`)
  }
}

for (const [name, source] of PLUGINS) {
  if (!existsSync(source)) { problems.push(`真身不存在：${source}`); continue }

  // 2) package.json 用相对路径
  const wantSpec = `file:./local-plugins/${name}`
  const spec = manifest.dependencies[name]
  if (spec !== wantSpec) {
    manifest.dependencies[name] = wantSpec
    changes.push(`${name}: ${spec ?? '(缺失)'} → ${wantSpec}`)
  }

  // 3) bundles 里要有它（否则插件不会被加载）
  if (!manifest.dsh.profile.bundles.includes(name)) {
    manifest.dsh.profile.bundles.push(name)
    changes.push(`${name}: 补进 dsh.profile.bundles`)
  }

  // 4) local-plugins/<name> 必须是指向真身的 junction
  const linkPath = join(localDir, name)
  const state = inspect(linkPath)
  if (state.kind === 'link' && samePath(state.target, source)) continue
  if (state.kind === 'dir') {
    problems.push(`${linkPath} 是真实目录而不是软链，请先确认内容后手动删除（不会自动删）`)
    continue
  }
  if (checkOnly) {
    problems.push(`${linkPath} ${state.kind === 'link' ? `指向 ${state.target}` : '不存在'}`)
    continue
  }
  mkdirSync(localDir, { recursive: true })
  if (state.kind === 'link') {
    // 指错了就直接重建
    rmSync(linkPath, { force: true })
  }
  symlinkSync(source, linkPath, 'junction')
  changes.push(`建立软链 local-plugins/${name} → ${source}`)
}

const nextJson = `${JSON.stringify(manifest, null, 2)}\n`
const changed = nextJson !== raw

if (problems.length > 0) {
  console.error('✗ 发现不安全的 profile 配置：')
  for (const p of problems) console.error(`  - ${p}`)
  if (checkOnly) {
    console.error('\n跑一次 `node scripts/dsh-profile-links.mjs` 修正，再跑 install。')
    process.exit(1)
  }
}

if (changed && !checkOnly) {
  writeFileSync(manifestPath, nextJson, 'utf8')
  changes.push(`已写回 ${manifestPath}`)
}

if (checkOnly) {
  if (changed) {
    console.error('✗ package.json 与期望不一致（相对路径 / bundles）')
    process.exit(1)
  }
  console.log(`✓ profile 依赖配置正常：${manifestPath}`)
  process.exit(0)
}

if (changes.length === 0) console.log('✓ 已经是期望状态，没有改动')
else for (const c of changes) console.log(`✓ ${c}`)
console.log('\n下一步：让 pnpm 真正装一遍，然后重启 DSH。')
