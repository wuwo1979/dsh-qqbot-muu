/**
 * qqbot-mod/muu-shared.mjs —— 微信 / 小天才 通道共享的「小蓝人设加载」
 *
 * 设计意图（2026-11-13）：微信与小天才都是 dsh-qqbot-muu 的附庸，应当「向 qqbot 对齐/调用代码」，
 * 而不是各抄一份 loadMuuSettings。QQ 侧若改动人格/预设来源，只需改这里，两个通道自动跟上，
 * 避免「qq 侧一改、微信和小天才没及时更新」的漂移。
 *
 * 这里只放真正跨通道共有的最小逻辑：仓库根定位 + 人设/预设文件读取。
 * 各通道独有的传输层、记忆、面板仍各自维护，保证隔离、互不污染。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 定位仓库根：优先环境变量，其次本文件所在 qqbot-mod 的上一级，再回落 F:/qqbot（老部署），最后 HOME。
 *  2026-11-14：插件会被 pnpm 复制进 profiles/web/node_modules/.pnpm/…，
 *  复制后本文件的上一级是 node_modules 而不是仓库根，所以 F:/qqbot 这条兜底不能少。 */
export function pickRepoRoot() {
  const cands = [
    String(process.env.QQBOT_REPO_ROOT || '').trim(),
    dirname(dirname(fileURLToPath(import.meta.url))), // qqbot-mod 的上一级 = 仓库根
    'F:/qqbot',
    process.env.HOME || process.env.USERPROFILE || '.',
  ].filter(Boolean)
  return cands.find((p) => { try { return existsSync(join(p, 'wechat-bridge', 'util.mjs')) } catch { return false } })
    || cands[cands.length - 1]
}

const REPO_ROOT = pickRepoRoot()

/**
 * 读取小蓝人设 / 预设 / 工作目录（与 qqbot-muu 同源，单一来源）。
 * 返回 { file, data }；找不到时 data 为空对象，调用方降级处理。
 */
export function loadMuuSettings(explicit) {
  const home = process.env.DSH_HOME
  const base = process.env.HOME || process.env.USERPROFILE || '.'
  const candidates = []
  if (explicit) candidates.push(explicit)
  candidates.push(join(REPO_ROOT, 'secrets', 'runtime', 'im-qqbot.json'))
  if (home) {
    candidates.push(join(home, 'qqbot-settings', 'web', 'im-qqbot.json'))
    candidates.push(join(home, 'qqbot-settings', 'im-qqbot.json'))
  }
  candidates.push(join(base, '.dsh', 'qqbot-settings', 'web', 'im-qqbot.json'))
  candidates.push(join(base, '.dsh', 'qqbot-settings', 'im-qqbot.json'))
  for (const p of candidates) {
    try {
      if (p && existsSync(p)) {
        const o = JSON.parse(readFileSync(p, 'utf8'))
        if (o && typeof o === 'object') return { file: p, data: o }
      }
    } catch { /* ignore */ }
  }
  return { file: null, data: {} }
}

export { REPO_ROOT }
