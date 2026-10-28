/**
 * hooks/comment-watch.mjs — 评论巡检定时任务（2026-10-28 主人需求）
 *
 * 有人在我们视频下评论 → 回复；回复过的不二次回复。
 *   · B 站：auto=true 时直接回复（拟人间隔，自带匿名回读校验）；
 *     auto=false 只出草稿。开关在 bili-ops-config.json 的 commentReply.auto（默认 true）。
 *   · 每 30 分钟巡检一次；单次最多回 maxReply 条；已回复的 rpid 记进
 *     {storage}/comment-replied.json —— 这是防二次回复的唯一判据。
 */
import * as Ops from '../lib/bili-ops.mjs';
import * as CW from '../lib/comment-watch.mjs';

function dataRootOf() {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  return env;
}

export async function run(env = {}) {
  const logger = env.logger;
  const dataRoot = String(env?.caps?.dataRoot || dataRootOf());
  if (!dataRoot) { logger?.warn?.('[comment-watch] 拿不到 dataRoot，跳过'); return { skipped: 'no-data-root' }; }

  let stopped = false;
  let busy = false;
  let lastRunAt = 0;

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const cfg = Ops.loadOpsConfig(dataRoot);
      if (cfg.enabled === false) return;
      const cr = cfg.commentReply || {};
      if (cr.enabled === false) return;             // 总开关（默认开）
      // 至少间隔 25 分钟（interval 30min，这里防手动触发后连跑）
      if (Date.now() - lastRunAt < 25 * 60_000) return;
      lastRunAt = Date.now();
      const auto = cr.auto !== false;               // 默认自动回复
      const r = await CW.biliCheck(dataRoot, {
        auto,
        maxReply: Number(cr.maxReply) || 3,
        limit: Number(cr.limit) || 10,
      });
      if (r.ok && (r.replied > 0 || (r.results || []).length)) {
        logger?.info?.(`[comment-watch] B站巡检：${r.videos} 个视频，新评论 ${(r.results || []).length} 条，已回复 ${r.replied} 条${auto ? '' : '（草稿）'}`);
      }
    } catch (e) {
      logger?.warn?.(`[comment-watch] 出错：${e?.message || String(e)}`);
    } finally {
      busy = false;
    }
  }

  // 启动后 2 分钟跑第一轮（避开宿主启动高峰），之后每 30 分钟一轮
  const first = setTimeout(() => { tick().catch(() => {}); }, 2 * 60_000);
  const timer = setInterval(() => { tick().catch(() => {}); }, 30 * 60_000);
  try { first.unref?.(); } catch { /* ignore */ }
  try {
    if (typeof env.registerDispose === 'function') {
      env.registerDispose(() => {
        stopped = true;
        clearInterval(timer);
        clearTimeout(first);
      });
    }
  } catch { /* ignore */ }
  return { started: true };
}

export default run;
