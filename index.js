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
  const dataRoot = String(config.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot');
  ctx.logger?.info?.(
    `[dsh-qqbot-muu] extension pack loaded (dataRoot=${dataRoot}). ` +
      'Run `dsh-qqbot-muu-install` to install/update .qqbot-extensions and patches.',
  );
}
