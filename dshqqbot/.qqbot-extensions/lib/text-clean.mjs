/**
 * text-clean.mjs — 剥掉「扩展注入块」的共用实现
 *
 * 为什么单独抽出来（2026-10-23）：
 *   入站扩展 aa-memory-recall 用 ctx.rewrite() 把 [记忆]/[印象]/[关系] 注入到
 *   ctx.message.content；插件 transport/inbound.js 又拿同一个 content 落
 *   .qqbot/msg-history → 注入块被永久写进聊天台账，随后又被镜像进记忆库，
 *   形成「自己的注入污染自己的历史」。
 *
 *   修法有两层：
 *     ① 插件落盘时剥（patches/fix-history-injection.mjs 改 dist/features/msg-history.js）；
 *     ② 扩展侧读历史/写记忆时也剥（这里）。
 *   两边共用同一份正则，避免以后改一处漏一处。
 */

export const INJECT_BLOCKS = [
  /\[记忆\][\s\S]*?\[\/记忆\]/g,
  /\[信条\][\s\S]*?\[\/信条\]/g,
  /\[设定\][\s\S]*?\[\/设定\]/g,
  /\[印象\][\s\S]*?\[\/印象\]/g,
  /\[旧识\][\s\S]*?\[\/旧识\]/g,
  /\[性格观察\][\s\S]*?\[\/性格观察\]/g,
  /\[成长\][\s\S]*?\[\/成长\]/g,
  /\[关系\][\s\S]*?\[\/关系\]/g,
  /\[状态\][\s\S]*?\[\/状态\]/g,
  /\[B站\][\s\S]*?\[\/B站\]/g,
  /\n?\[别重复\][^\n]*/g,
];

/**
 * 旧版注入没有闭合标签（10-22 之前的台账，还被 TEXT_MAX 截断）。
 * 块总是追加在消息尾部 ⇒ 从残留的 [记忆] 起一刀切到结尾。
 */
export const LEGACY_TAGS = ['记忆', '信条', '设定', '印象', '旧识', '性格观察', '成长', '关系', '状态', 'B站'];

/** 剥掉所有注入块；保留正文（每个注入块独占的行会被整行删掉） */
export function cleanInjected(text) {
  let t = String(text == null ? '' : text);
  for (const re of INJECT_BLOCKS) t = t.replace(re, ' ');
  for (const tag of LEGACY_TAGS) t = t.replace(new RegExp('\\s*\\[' + tag + '\\][\\s\\S]*$', 'u'), '');
  return t
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

/** 这段文本里是否还残留注入块（自检/测试用） */
export function hasInjected(text) {
  const s = String(text == null ? '' : text);
  for (const re of INJECT_BLOCKS) {
    re.lastIndex = 0;
    if (re.test(s)) return true;
  }
  for (const tag of LEGACY_TAGS) {
    if (new RegExp('\\[' + tag + '\\]').test(s)) return true;
  }
  return false;
}

export default { cleanInjected, hasInjected, INJECT_BLOCKS };
