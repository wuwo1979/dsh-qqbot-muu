/**
 * a0-tag-guard.mjs — 入站兜底：媒体占位标签绝不进模型上下文
 *
 * 真机问题（2026-11-07）：微信侧拿不到表情文件实体时，事件正文是 `<type:sticker>`；
 * 桥接旧版会原样透传，模型把它当正文读，回复里也开始复述这种标签。
 * 桥接已在源头归一；这里再兜一层，覆盖 QQ / 未来其它平台可能出现的同类占位符。
 *
 * 排序：文件名 a0- 排在 aa-memory-recall 之前，保证记忆沉淀拿到的是干净正文。
 * 安全契约：任何异常只记日志并 next()，绝不吞消息。
 */
import { normalizeTypeTags, readableFallback } from '../lib/placeholder-text.mjs';

export const name = 'a0-tag-guard';

export async function onInbound(ctx, next) {
  try {
    const text = String(ctx?.text == null ? '' : ctx.text);
    if (/<type\s*:/i.test(text)) {
      const clean = readableFallback(text);
      if (typeof ctx.rewrite === 'function' && clean !== text) {
        ctx.rewrite({ text: clean });
        ctx?.logger?.debug?.('[tag-guard] 占位标签已归一');
      }
    }
  } catch (e) {
    ctx?.logger?.debug?.(`[tag-guard] 失败(已忽略): ${e?.message || e}`);
  }
  return next();
}
