/**
 * context-budget.mjs — 注入块统一预算（2026-11-08，第 4 批「上下文统一」）
 *
 * QQ 与微信各自都在拼「注入块」（慢块/召回/状态…），但两边的「装不下怎么办」实现不同：
 *   · QQ：`aa-memory-recall.mjs` 按优先级逐块累加，超预算整块丢弃并记 dropped；
 *   · 微信：`dsh-wechat-muu/index.mjs` 的 `trimBudget()` 只裁动态块，召回块在预算之外额外追加。
 * 结果是同一套人设/记忆在两个通道的「注入字数」口径不一致，token 统计也对不上。
 *
 * 这里只做一件最小的事：给双方同一个纯函数打包器 —— 按顺序装、超预算整块丢弃、返回丢弃标签。
 * 不做任何 IO、不依赖任何通道上下文，方便单测与复用。
 */

/**
 * @param {Array<[string, string]>} parts  [标签, 块文本]；空块自动跳过
 * @param {number} budget  总字数上限
 * @param {number} minKeep 下限（防止配置写成 0 导致一个字都不注入）
 * @returns {{ kept: Array<[string, string]>, dropped: string[], chars: number }}
 */
export function packByBudget(parts, budget, minKeep = 400) {
  const limit = Math.max(Number(minKeep) || 0, Number(budget) || 0);
  const kept = [];
  const dropped = [];
  let chars = 0;
  for (const item of Array.isArray(parts) ? parts : []) {
    const label = String(item?.[0] ?? '');
    const raw = item?.[1];
    if (!raw) continue;
    const text = String(raw);
    if (chars + text.length > limit) { dropped.push(label); continue; }
    kept.push([label, text]);
    chars += text.length;
  }
  return { kept, dropped, chars };
}

/** 把打包结果拼回一段文本（分隔符由调用方决定，默认空串 = 块自带格式） */
export function joinKept(kept, sep = '') {
  return (Array.isArray(kept) ? kept : []).map((item) => String(item?.[1] ?? '')).join(sep);
}

export default packByBudget;
