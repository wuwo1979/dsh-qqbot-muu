/**
 * outbound/aa-sanitize.mjs — 出站第一道闸：把不该让群友看到的东西剥掉
 *
 * 真机踩到的（2026-10-31 主人贴实锤）：她把**整段注入回显**原样发了出来 ——
 *   「[消息号: 11018] …好。[信条]…[/信条][状态]…[/状态][别重复]刚说过：…」
 * 旧清单只盖了 6 种块，[信条]/[消息号]/[旧识]/[成长]/[性格观察]/[情绪回响]/[约定]/[手边]
 * 全部漏网。v2（2026-10-31）：块清单与入站 stripMemoryBlock 对齐 + 三道兜底：
 *   ① 成对块（[x]…[/x]）逐个剥；
 *   ② 单行块（[别重复]/[手边]/[消息号: N]）整行剥；
 *   ③ 截断回显兜底：剥完还残留开块标记（后面没有闭块，模型回显常被截断）→ 从标记剥到结尾。
 * 文件名 aa- 开头 = 出站链里排最前，先洗干净再让别的扩展改写。
 */
export const name = 'sanitize-out';

// 成对块：与 inbound/aa-memory-recall.mjs stripMemoryBlock 同一清单（两处增删要同步）
const PAIRED = [
  '记忆', '信条', '设定', '印象', '旧识', '性格观察', '成长',
  '关系', '状态', 'B站', '学', '情绪回响', '约定',
];
// 单行块：没有闭标记，一行就是一块
const LINE_TAGS = ['别重复', '手边'];

const PATTERNS = [
  // ① 成对注入块
  ...PAIRED.map((t) => [new RegExp(`\\[${t}\\][\\s\\S]*?\\[/${t}\\]`, 'g'), '']),
  // ② 单行块
  ...LINE_TAGS.map((t) => [new RegExp(`\\n?\\[${t}\\][^\\n]*`, 'g'), '']),
  // [消息号: 11018] 头（入站 msgRef，模型有时会原样念出来）
  [/\[消息号[^\]\n]{0,24}\]\n?/g, ''],
  [/\[消息号(?!\])[^\n]{0,30}\n?/g, ''],
  // 内部消息号：m01013b / m001f / m01013 这类（真实聊天里不会出现）
  [/\b[mM][0-9a-fA-F]{4,8}\b/g, ''],
  // 形如 #0913a 的裸消息号（[rf:…] 里的不动，因为那是引用语法）
  [/(^|[\s，。！？、])#([0-9a-fA-F]{5})(?=$|[\s，。！？、])/g, '$1'],
  // ③ 截断回显兜底（必须放最后：成对块先剥完，剩下的开标记 = 没有闭块的残段）
  [new RegExp(`\\[(?:${PAIRED.join('|')})\\][\\s\\S]*$`), ''],
];

export function sanitize(text) {
  let t = String(text == null ? '' : text);
  for (const [re, to] of PATTERNS) t = t.replace(re, to);
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

// ── 同文重复发送拦截（2026-10-31 主人反馈「容易把同一消息反复发送」）──
// 短窗口内（120s）与刚发出去的正文完全相同（去标点/空白归一后）→ 消灭这条，不再出站。
// 只拦整句重复： Length≥8 才算（「嗯」「6」这种短句自然重复不拦）；主人让她「再说一遍」
// 时隔得久，不受影响。
const _lastSent = new Map(); // key: target → { norm, at }
function normForDup(s) {
  return String(s || '').replace(/[\s\u3000]+/g, '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').toLowerCase();
}
function dupKeyOf(ctx) {
  try {
    const t = ctx?.target;
    if (t && typeof t === 'object') return String(t.openid || t.id || t.chatId || JSON.stringify(t));
  } catch { /* ignore */ }
  return String(ctx?.target ?? 'unknown');
}

export async function onOutbound(ctx, next) {
  if (!ctx || ctx.phase !== 'send' || ctx.kind !== 'text') return next();
  const before = String(ctx.text || '');
  if (!before) return next();
  let after = sanitize(before);
  if (!after) after = '……';

  // 同文重复拦截（剥完块再比，免得被剥掉的前后缀造成假差异）
  try {
    const now = Date.now();
    const key = dupKeyOf(ctx);
    const norm = normForDup(after);
    const last = _lastSent.get(key);
    if (norm && norm.length >= 8 && last && last.norm === norm && now - last.at < 120_000) {
      try { ctx.logger?.warn?.(`[sanitize] 同文重复发送已拦截（${Math.round((now - last.at) / 1000)}s 前发过同一句）`); } catch {}
      try { ctx.note && ctx.note('sanitize: 拦截同文重复'); } catch {}
      ctx.annihilate?.('重复发送拦截');
      return; // 已被消灭，链不必再走
    }
  } catch { /* 判重失败不拦正常发送 */ }

  if (after !== before) {
    try {
      ctx.note && ctx.note('sanitize: 剥掉了内部标记');
    } catch {}
    try {
      ctx.rewrite(after);
    } catch {}
  }
  // 记录「已发出去的正文」供下一条判重（在 next() 之前记 —— 下游失败也宁可漏拦不误拦）
  try {
    const norm = normForDup(after);
    if (norm && norm.length >= 8) _lastSent.set(dupKeyOf(ctx), { norm, at: Date.now() });
  } catch { /* ignore */ }
  return next();
}

export default onOutbound;
