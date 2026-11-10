/**
 * 00-inbound-probe.mjs — 已停用（2026-11-03 08:0x）。
 * 排查"消息有没有进到插件"用的临时探针；怀疑它参与导致异常，先摘掉。
 */
export const name = 'inbound-probe-disabled';

export async function onInbound(ctx, next) {
  return next();
}
