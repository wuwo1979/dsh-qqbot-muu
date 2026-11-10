/**
 * hooks/live.mjs — 直播模块启动入口
 *
 * 插件加载时按 live-config.json 拉起长连；卸载时优雅关闭 adapter（官方通道会调用 end）。
 * 模块本身独立在 .qqbot-extensions/live/，这里只做桥接。
 */
import { startLive, stopLive, getController } from '../live/index.mjs';

function dataRootOf(env = {}) {
  return String(env?.caps?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
}

export async function run(env = {}) {
  const dataRoot = dataRootOf(env);
  if (!dataRoot) {
    env?.logger?.warn?.('[live] 拿不到 dataRoot，跳过启动');
    return { skipped: 'no-data-root' };
  }
  const r = await startLive(dataRoot, { logger: env.logger });
  if (r?.ok === false) env?.logger?.warn?.('[live] 启动失败：' + String(r.error || ''));
  return r;
}

export async function dispose(env = {}) {
  const dataRoot = dataRootOf(env);
  if (!dataRoot) return { ok: true };
  const c = getController(dataRoot, { logger: env.logger });
  if (!c.running) return { ok: true, skipped: 'not-running' };
  await stopLive(dataRoot, { logger: env.logger });
  return { ok: true };
}
