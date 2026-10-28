/**
 * outbound/aa-sanitize.mjs — 出站第一道闸：把不该让群友看到的东西剥掉
 *
 * 真机踩到的：她会把上下文里的内部消息号（形如 m01013b）当成"证据"念出来，
 * 群里就是一条莫名其妙的乱码；偶尔还会漏出 [记忆]…[/记忆] 这种注入块。
 * 文件名 aa- 开头 = 出站链里排最前，先洗干净再让别的扩展改写。
 */
export const name = 'sanitize-out';

const PATTERNS = [
  // 注入块（理论上入站会剥，这里是兜底）
  [/\[记忆\][\s\S]*?\[\/记忆\]/g, ''],
  [/\[设定\][\s\S]*?\[\/设定\]/g, ''],
  [/\[印象\][\s\S]*?\[\/印象\]/g, ''],
  [/\[关系\][\s\S]*?\[\/关系\]/g, ''],
  [/\[状态\][\s\S]*?\[\/状态\]/g, ''],
  [/\[B站\][\s\S]*?\[\/B站\]/g, ''],
  [/\[学\][\s\S]*?\[\/学\]/g, ''],
  [/\n?\[别重复\][^\n]*/g, ''],
  // 内部消息号：m01013b / m001f / m01013 这类（真实聊天里不会出现）
  [/\b[mM][0-9a-fA-F]{4,8}\b/g, ''],
  // 形如 #0913a 的裸消息号（[rf:…] 里的不动，因为那是引用语法）
  [/(^|[\s，。！？、])#([0-9a-fA-F]{5})(?=$|[\s，。！？、])/g, '$1'],
];

export function sanitize(text) {
  let t = String(text == null ? '' : text);
  for (const [re, to] of PATTERNS) t = t.replace(re, to);
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

export async function onOutbound(ctx, next) {
  if (!ctx || ctx.phase !== 'send' || ctx.kind !== 'text') return next();
  const before = String(ctx.text || '');
  if (!before) return next();
  let after = sanitize(before);
  if (!after) after = '……';
  if (after !== before) {
    try {
      ctx.note && ctx.note('sanitize: 剥掉了内部标记');
    } catch {}
    try {
      ctx.rewrite(after);
    } catch {}
  }
  return next();
}

export default onOutbound;
