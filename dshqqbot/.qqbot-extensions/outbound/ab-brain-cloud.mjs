/**
 * ab-brain-cloud.mjs — 出站记账：云端**真的把话说出来了** ⇒ 记一笔
 *
 * 为什么需要它：
 *   入站那边的 brain-lock 只在"消息被放行给云端"时记 cloud；但一轮云端有时会
 *   先在入站放行后 3~10 秒才吐字（工具调用/长回复）。把这 10 秒也算进窗口，
 *   本地才不会在云端那条回复**刚落地**时又抢一句，造成"你一句我一句两个脑子"。
 *
 * 文件名用 `ab-` 前缀：出站链按文件名升序 ⇒ 排在 outbox / split-reply / tts-voice 之前，
 * 先记帐再让后面的扩展改写/补发，语义上"这一轮云端说过话了"最准。
 *
 * 纪律：任何异常都吞掉并 next()，绝不因为记账失败影响发消息。
 */
import { mark } from '../lib/brain-lock.mjs';

export const name = 'brain-cloud';

/** 出站 ctx 的 target → 与入站一致的会话键（group:<群号> / c2c:<对方>） */
function scopeOfTarget(ctx) {
  try {
    const t = ctx?.target || {};
    const s = String(t.scope || '');
    // 真机是 targetId（peerId 只出现在旧文档/测试桩里）
    const peer = String(t.peerId || t.targetId || '');
    if (!s) return '';
    return peer ? s + ':' + peer : s;
  } catch {
    return '';
  }
}

export async function onOutbound(ctx, next) {
  try {
    const phase = String(ctx?.phase || '');
    const kind = String(ctx?.kind || 'text');
    const lastChunk = ctx?.isLastChunk !== false;
    const text = String(ctx?.text ?? '').trim();
    if (phase === 'send' && kind === 'text' && lastChunk && text) {
      const root = String(ctx?.dataRoot || '');
      const sc = scopeOfTarget(ctx);
      if (root && sc) mark(root, sc, 'cloud', { why: 'spoke' });
    }
  } catch { /* 记账失败不影响发消息 */ }
  return next();
}

export default { name, onOutbound };
