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
/**
 * index.js — DSH 插件壳（市场兼容层）
 *
 * 这个包的主体是「扩展包 + 补丁集」，真正的功能在 `.qqbot-extensions/` 与
 * `qqbot-mod/patches/` 里。这里提供最小但真实的 cordis 插件入口，让
 * `dsh plugin add dsh-qqbot-muu` / 插件市场能识别并加载它。
 *
 * 它不做任何危险操作：只注册一个启动日志和一个状态说明；安装扩展仍走
 * `dsh-qqbot-muu-install`（install.mjs），避免插件加载时偷偷改用户文件。
 */
export const name = 'dsh-qqbot-muu';
export const inject = [];

export function apply(ctx, config = {}) {
  const dataRoot = String(config.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || __repoRoot() + "/dshqqbot");
  ctx.logger?.info?.(
    `[dsh-qqbot-muu] extension pack loaded (dataRoot=${dataRoot}). ` +
      'Run `dsh-qqbot-muu-install` to install/update .qqbot-extensions and patches.',
  );
}
