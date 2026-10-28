/**
 * self-echo.mjs —— 「她自己刚说过什么」反重复块
 *
 * 为什么这是"活人感"的关键：
 *   AI 味的最大来源之一是**重复**——同一个口头禅、同一个梗、同一个句式连着来。
 *   真人不会三句话里两次"呜~"、不会每轮都把同一个冷笑话讲一遍。
 *   所以每轮把**她最近说过的 2~3 句**取出来，附在入站文本后面：
 *     [别重复] 刚说过：… / …
 *   成本 ≈ 60~110 字，比任何 prompt 规则都直接（模型看到自己的原话就不会照抄）。
 *
 * 数据来自 `outbound/turn-memory.mjs` 写进记忆库的 kind='say' / 'promise'。
 */

import { listAll } from './memory.mjs';

/** 取本会话她最近说过的几句（新的在前，去重） */
export function recentSelfLines(dataRoot, scope, limit = 3) {
  const n = Math.max(1, Math.min(6, Number(limit) || 3));
  try {
    const rows = listAll(dataRoot, { limit: 80, scopeFilter: String(scope || '') });
    const out = [];
    const seen = new Set();
    for (const r of rows) {
      if (!r) continue;
      const kind = String(r.kind || '');
      if (kind !== 'say' && kind !== 'promise') continue;
      if (String(r.scope || '') !== String(scope || '')) continue;
      const t = String(r.text || '').trim();
      if (!t) continue;
      const key = t.slice(0, 20);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= n) break;
    }
    return out;
  } catch { return []; }
}

/**
 * 拼成注入块。
 * @returns {{block:string, lines:string[]}}
 */
export function formatEchoBlock(dataRoot, scope, opts = {}) {
  const maxChars = Math.max(40, Math.min(240, Number(opts.maxChars) || 110));
  const lines = recentSelfLines(dataRoot, scope, opts.limit || 3)
    .map((t) => t.replace(/\s+/g, ' ').slice(0, 28));
  if (!lines.length) return { block: '', lines: [] };

  let body = '';
  for (const t of lines) {
    const next = body ? body + ' / ' + t : t;
    if (next.length > maxChars) break;
    body = next;
  }
  if (!body) body = lines[0].slice(0, maxChars);
  return { block: '\n[别重复]刚说过：' + body, lines };
}
