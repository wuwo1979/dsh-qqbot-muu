import { existsSync as __existsSync } from 'node:fs'
const __repoRoot = (() => {
  let cached = ''
  const norm = (p) => String(p || '').split(String.fromCharCode(92)).join('/')
  return () => {
    if (cached) return cached
    const cands = []
    const env = String(process.env.QQBOT_ROOT || process.env.QQBOT_REPO_ROOT || '').trim()
    if (env) cands.push(norm(env))
    try {
      let here = decodeURIComponent(new URL('.', import.meta.url).pathname)
      if (here[0] === '/' && here[2] === ':') here = here.slice(1)
      here = norm(here).replace(/\/+$/, '')
      let d = here
      for (let i = 0; i < 6; i += 1) {
        if (!d) break
        cands.push(d)
        const k = d.lastIndexOf('/')
        d = k > 0 ? d.slice(0, k) : ''
      }
    } catch { /* noop */ }
    try { cands.push(norm(process.cwd())) } catch { /* noop */ }
    for (const c of cands) {
      try {
        if (c && (__existsSync(c + '/qqbot-mod/muu-shared.mjs') || __existsSync(c + '/dshqqbot'))) { cached = c; return cached }
      } catch { /* noop */ }
    }
    cached = norm(cands.find(Boolean) || '.')
    return cached
  }
})()
// 把 F:\qqbot 里改过的插件源码同步到 DSH 真正加载的 pnpm 安装副本。
//
// 为什么需要：profile 里三个本地插件是 file:./local-plugins/<包名> 依赖，
// pnpm 10 会**复制**目录内容到 node_modules/.pnpm/<包名>@<hash>/node_modules/<包名>
// （不是软链，也不是硬链接），所以改 F:\qqbot 下的源码不会影响正在跑的那一份，
// 重启宿主也白重启。改完源码后跑一次本脚本，再重启 DSH。
//
// 用法：
//   F:\nodejs\node.exe F:\qqbot\scripts\sync-plugin-copies.mjs
// 注意：目标目录在 AppData 下，DSH 沙箱默认写不了，需要在放开权限的终端里跑
//       （或在 DSH 里用 danger-full-access 执行）。
//
// 2026-11-14 起：profile 依赖改成相对路径 + local-plugins 软链，
// 见 scripts/dsh-profile-links.mjs 的头注释（那次绝对路径 file: 直接触发过安全模式）。

import { readdirSync, cpSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const profileArg = process.argv.indexOf('--profile')
const PROF = profileArg >= 0 && process.argv[profileArg + 1]
  ? process.argv[profileArg + 1]
  : join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness', 'profiles', 'web')
const PNPM = join(PROF, 'node_modules', '.pnpm')

/** [源路径, .pnpm 目录名前缀, 副本内相对路径(文件可省略，默认同名)] */
const PAIRS = [
  // 根包 dsh-qqbot-muu（F:\qqbot 自身）
  [__repoRoot() + "/entry.js", 'dsh-qqbot-muu@', 'dsh-qqbot-muu/entry.js'],
  [__repoRoot() + "/index.js", 'dsh-qqbot-muu@', 'dsh-qqbot-muu/index.js'],
  [__repoRoot() + "/cordis.patch.yml", 'dsh-qqbot-muu@', 'dsh-qqbot-muu/cordis.patch.yml'],
  [__repoRoot() + "/dshqqbot/.qqbot-extensions", 'dsh-qqbot-muu@', 'dsh-qqbot-muu/dshqqbot/.qqbot-extensions'],
  // 2026-11-13：dist/（调度器、任务管理、事件评估）和设置面板也是拷贝加载的，改完必须一起同步
  [__repoRoot() + "/dist", 'dsh-qqbot-muu@', 'dsh-qqbot-muu/dist'],
  [__repoRoot() + "/client", 'dsh-qqbot-muu@', 'dsh-qqbot-muu/client'],
  [__repoRoot() + "/settings-host.js", 'dsh-qqbot-muu@', 'dsh-qqbot-muu/settings-host.js'],
  // 两个子插件：整目录同步（2026-11-14 补上 dsh-xtc-muu，之前漏了，改小天才通道不生效）
  [__repoRoot() + "/dsh-wechat-muu", 'dsh-wechat-muu@', 'dsh-wechat-muu'],
  [__repoRoot() + "/dsh-xtc-muu", 'dsh-xtc-muu@', 'dsh-xtc-muu'],
]

if (!existsSync(PNPM)) {
  console.error(`✗ 没有找到 pnpm 安装目录：${PNPM}`)
  console.error('  profile 还没装好？先跑：node scripts/dsh-profile-preflight.mjs --repair --install')
  process.exit(1)
}

let bad = 0
for (const [src, prefix, rel] of PAIRS) {
  if (!existsSync(src)) { console.log(`✗ 源不存在：${src}`); bad += 1; continue }
  const hit = readdirSync(PNPM).filter((x) => x.startsWith(prefix)).sort().pop()
  if (!hit) { console.log(`✗ 没找到安装副本：${prefix}`); bad += 1; continue }
  const root = join(PNPM, hit, 'node_modules')
  const dst = rel ? join(root, rel) : join(root, basename(src))
  try {
    if (statSync(src).isDirectory()) {
      if (!existsSync(dst)) { console.log(`✗ 副本内路径不存在：${dst}`); bad += 1; continue }
      cpSync(src, dst, { recursive: true, force: true })
    } else {
      if (!existsSync(dst)) { console.log(`✗ 副本内文件不存在：${dst}`); bad += 1; continue }
      cpSync(src, dst, { force: true })
    }
    console.log(`✓ 已同步 ${rel || basename(src)}`)
  } catch (e) {
    console.log(`✗ 同步失败 ${rel || basename(src)}：${e?.message ?? e}`)
    bad += 1
  }
}

console.log(bad ? `\n完成，但有 ${bad} 项失败。` : '\n全部同步完成，重启 DSH 后生效。')
process.exitCode = bad ? 1 : 0
