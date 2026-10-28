/**
 * outbox.mjs —— 语音发件箱兜底投递（出站扩展）
 *
 * 背景（2026-10-23 真机）：第一版只挂 `phase === 'turnEnd'`，结果线上队列里
 * 2 条语音永远没人取 —— **turnEnd 这一跳不可靠**（回合异常结束、会话复用报
 * `ERROR creating session: … already exists` 时根本跑不到 turnEnd）。
 *
 * 现在双保险：
 *   ① `phase === 'send'` 且是本回合最后一块 ⇒ 先 next() 把正文放出去，再补语音；
 *   ② `phase === 'turnEnd'` ⇒ 同样处理（哪跳先跑到哪跳发，drain 是原子的，不会重发）。
 *
 * 正常情况下 `tools/voice.mjs` 已经用 `env.caps.voice()` 当场直发了，
 * 队列里只有"直发失败"的残留 —— 所以这里只做兜底，日志用 warn 级。
 */

import { drain } from '../lib/voice-queue.mjs';

export const name = 'outbox';

function dataRootOf(ctx) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  if (ctx && typeof ctx.dataRoot === 'string' && ctx.dataRoot) return ctx.dataRoot;
  return 'F:/qqbot/dshqqbot';
}

/** 这一跳该不该投递 */
function shouldFlush(ctx) {
  const phase = String(ctx?.phase || '');
  if (phase === 'turnEnd') return true;
  if (phase === 'send') return ctx?.isLastChunk !== false;
  return false;
}

export async function onOutbound(ctx, next) {
  if (!ctx || !shouldFlush(ctx)) return next();

  let items = [];
  try {
    items = drain(dataRootOf(ctx));
  } catch { items = []; }
  if (!items.length) return next();

  await next();

  for (const it of items) {
    try {
      const sent = await ctx.sendMedia({ path: it.path, kind: 'voice' });
      if (sent === false) {
        ctx?.logger?.warn?.(`[outbox] 语音补发失败(phase=${ctx?.phase})`);
      } else {
        ctx?.logger?.warn?.(`[outbox] 语音补发 ${it.bytes || 0}B (phase=${ctx?.phase}): ${String(it.text || '').slice(0, 20)}`);
      }
    } catch (e) {
      ctx?.logger?.warn?.(`[outbox] 语音补发异常(已忽略): ${e instanceof Error ? e.message : String(e)}`);
    }
    // 多条之间隔一下，别糊成一坨
    if (items.length > 1) await new Promise((r) => setTimeout(r, 500));
  }
}
