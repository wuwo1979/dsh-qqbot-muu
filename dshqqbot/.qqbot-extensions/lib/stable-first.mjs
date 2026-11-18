/**
 * lib/stable-first.mjs — 稳定块置顶（2026-11-11 主人报 bug 后的兜底）
 *
 * 背景：入站钩子一律 `ctx.text + extra` 往**尾部**追加注入块，于是出现过
 *   `[消息号: 0913a]\n正文\n[信条]…[/信条]`
 * 这种「消息号在信条前」的形态。信条/设定这类跨轮不变的块被塞在末尾，
 * 既让 prompt 前缀不稳定（缓存打不中），也让模型把它当成正文的附注。
 *
 * 纪律：**稳定块永远在最前，易变块（记忆/状态/世界书/反重复…）照旧垫底。**
 *   - 拆：把一个文本里的稳定块全抽出来（返回 {stable, rest}）
 *   - 合：把 stable 拼到 rest 前面（保持内容不变，只换位置）
 *
 * 幂等：已经置顶的文本再走一遍，结果不变。
 */

/** 跨轮不变的块（顺序即展示顺序） */
export const STABLE_TAGS = ['信条', '设定', '旧识', '印象', '性格观察', '成长', '约定', '手边', '关系'];

const _re = (tag) => new RegExp(`\\n?\\[${tag}\\][\\s\\S]*?\\[/${tag}\\]\\n?`, 'g');

/** 抽出稳定块：返回 { stable: string, rest: string } */
export function splitStable(text) {
  let rest = String(text ?? '');
  const hits = [];
  for (const tag of STABLE_TAGS) {
    rest = rest.replace(_re(tag), (m) => {
      const body = m.trim();
      if (body) hits.push({ tag, body });
      return '\n';
    });
  }
  // 按 STABLE_TAGS 顺序还原（而不是按出现顺序），保证前缀稳定
  hits.sort((a, b) => STABLE_TAGS.indexOf(a.tag) - STABLE_TAGS.indexOf(b.tag));
  const stable = hits.map((h) => h.body).join('\n');
  rest = rest.replace(/\n{3,}/g, '\n\n').trim();
  return { stable, rest };
}

/** 稳定块置顶：把 text 里散落的稳定块移到最前 */
export function hoistStable(text) {
  const t = String(text ?? '');
  if (!STABLE_TAGS.some((tag) => t.includes(`[${tag}]`))) return t; // 快路径：没有稳定块
  const { stable, rest } = splitStable(t);
  if (!stable) return t;
  // 已经在最前（第一个非空行就是某个稳定块的开标记）→ 原样返回，避免每轮重排制造 diff
  const firstLine = rest.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (STABLE_TAGS.some((tag) => firstLine.startsWith(`[${tag}]`) && firstLine.includes('[/'))) {
    return [stable, rest].filter(Boolean).join('\n\n');
  }
  return [stable, rest].filter(Boolean).join('\n\n');
}

/**
 * 把「本轮新增注入 extra」并进 ctx.text —— 稳定块在前、其余垫底。
 * @param {string} text  原始消息文本（可能已带 [消息号]）
 * @param {string} extra 本轮要注入的块（可能含 [信条] 等稳定块）
 */
export function mergeStableFirst(text, extra) {
  const merged = [String(text ?? ''), String(extra ?? '')].filter((s) => s.trim()).join('\n');
  return hoistStable(merged);
}

export default { STABLE_TAGS, splitStable, hoistStable, mergeStableFirst };
