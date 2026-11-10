// 把 F:\qqbot 里改过的插件源码同步到 DSH 真正加载的 pnpm 安装副本。
//
// 为什么需要：DSH 通过 profiles/web 的 pnpm file: 依赖加载插件，file: 依赖是
// **拷贝**（不是软链/硬链接），所以改 F:\qqbot 下的源码不会影响正在跑的那一份，
// 重启宿主也白重启。改完源码后跑一次本脚本，再重启 DSH。
//
// 用法：
//   F:\nodejs\node.exe F:\qqbot\scripts\sync-plugin-copies.mjs
// 注意：目标目录在 AppData 下，DSH 沙箱默认写不了，需要在放开权限的终端里跑
//       （或在 DSH 里用 danger-full-access 执行）。

import { readdirSync, cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PROF = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/web'
const PNPM = join(PROF, 'node_modules', '.pnpm')

/** [源目录, .pnpm 目录名前缀, 副本内相对路径] */
const PAIRS = [
  ['F:/qqbot/dsh-wechat-muu', 'dsh-wechat-muu@', 'dsh-wechat-muu'],
  ['F:/qqbot/dshqqbot/.qqbot-extensions', 'dsh-qqbot-muu@', 'dsh-qqbot-muu/dshqqbot/.qqbot-extensions'],
]

let bad = 0
for (const [src, prefix, rel] of PAIRS) {
  if (!existsSync(src)) { console.log(`✗ 源目录不存在：${src}`); bad += 1; continue }
  const hit = readdirSync(PNPM).filter((x) => x.startsWith(prefix)).sort().pop()
  if (!hit) { console.log(`✗ 没找到安装副本：${prefix}`); bad += 1; continue }
  const dst = join(PNPM, hit, 'node_modules', rel)
  if (!existsSync(dst)) { console.log(`✗ 副本内路径不存在：${dst}`); bad += 1; continue }
  try {
    cpSync(src, dst, { recursive: true, force: true })
    console.log(`✓ 已同步 ${rel}`)
  } catch (e) {
    console.log(`✗ 同步失败 ${rel}：${e?.message ?? e}`)
    bad += 1
  }
}

console.log(bad ? `\n完成，但有 ${bad} 项失败。` : '\n全部同步完成，重启 DSH 后生效。')
process.exitCode = bad ? 1 : 0
