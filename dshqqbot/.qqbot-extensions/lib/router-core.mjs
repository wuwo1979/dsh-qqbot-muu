/**
 * router-core.mjs — 分流决策器（本地/云端）
 *
 * ⚠️ 重要设计修正（2026-10-22 实测后改）：
 *   第一版按"简单/中等/复杂"打三档，回归测试发现**中文闲聊几乎全是 0 分**，
 *   于是"简单→本地快答"，等于把她所有日常对话都推给本地话术池 —— 那不是省钱，
 *   那是把她变成复读机，人格直接没了。
 *
 *   真正该问的不是"这句话复不复杂"，而是"**这句话值不值得唤醒云端**"。
 *   正确答案：**除了退化输入，几乎都值得**。能省的只有下面这一类：
 *
 *     trivial 退化输入：纯表情/纯标点/单字/复读（"哈""哦""……""嗯嗯嗯"）
 *                       → 本地快答池，不唤醒云端
 *     task    要她干活：带请求动词 / 多个问句 / 带媒体 / 很长
 *                       → 云端 + 全工具 + 全记忆
 *     chat    普通闲聊：其余全部
 *                       → 云端 + 轻上下文
 *
 *   所以这个模块的主要产出是 `isTrivial`（唯一能省的分支），
 *   `score` 只用于观察期统计，不参与决策。
 */

const TRIVIAL_MAX_LEN = 4;

/** QQ 占位标签：[表情] [语音消息] 这类 —— 但媒体标签不算（那要调工具） */
const PLACEHOLDER_RE = /^\[[^\]]{1,8}\]$/;
const MEDIA_PLACEHOLDER_RE = /\[(图片|视频|文件|语音|image|video|file|voice)/i;

/** 纯表情 / 纯标点 / 纯语气词 / 复读 */
const TRIVIAL_RE = /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}。，、！？~…·.,!?~\-—=+\u3000]+$/u;
const FILLER_RE = /^[哈嗯哦啊额唔咦嘿呀嘛吧呃欸诶欸对是好的嗯哼]+$/;
const REPEAT_RE = /^(.)\1{2,}$/;

const REQ_WORDS = ['帮我', '帮我看', '写个', '写一', '生成', '查一下', '查下', '搜一下', '搜下',
  '算一下', '算算', '翻译', '总结', '整理', '列出', '对比', '修改', '改一下', '做个', '建个',
  '分析', '解释一下', '教我', '怎么弄', '怎么办', '为什么', '能不能', '可不可以', '帮我改'];
const REF_WORDS = ['那个', '这个', '前面', '刚才', '上次', '之前说的', '它', '继续',
  '还有呢', '接着说', '上面说的'];
const MEDIA_WORDS = ['[图片', '[视频', '[文件', '[语音', '发图', '这张图', '看这个'];

function countAny(text, words) {
  let n = 0;
  for (const w of words) if (text.includes(w)) n += 1;
  return n;
}

/** 是不是"不值得唤醒云端"的退化输入 */
export function isTrivial(rawText) {
  const t = String(rawText || '').trim();
  if (t.length === 0) return true;
  if (t.length <= TRIVIAL_MAX_LEN) {
    if (TRIVIAL_RE.test(t)) return true;
    if (FILLER_RE.test(t)) return true;
    if (REPEAT_RE.test(t)) return true;
  }
  if (TRIVIAL_RE.test(t)) return true;
  if (FILLER_RE.test(t)) return true;
  if (REPEAT_RE.test(t)) return true;
  // QQ 占位标签：[表情] 这种（媒体类除外 —— 带媒体要调工具，不能本地快答）
  if (PLACEHOLDER_RE.test(t) && !MEDIA_PLACEHOLDER_RE.test(t)) return true;
  return false;
}

/** 是不是"要她干活"（决定给多少上下文/工具） */
export function isTask(rawText) {
  const t = String(rawText || '');
  if (t.length > 60) return true;
  if (countAny(t, MEDIA_WORDS) > 0) return true;
  if (countAny(t, REQ_WORDS) > 0) return true;
  const qMarks = (t.match(/[？?]/g) || []).length;
  if (qMarks >= 2) return true;
  if (qMarks >= 1 && countAny(t, REF_WORDS) > 0) return true;
  return false;
}

/**
 * 分档。
 * @returns {{tier:'trivial'|'task'|'chat', score:number, signals:object}}
 *   score 只用于观察期统计（0=退化输入，1=重活），不参与决策。
 */
export function classify(rawText) {
  const t = String(rawText || '').trim();
  const trivial = isTrivial(t);
  const task = !trivial && isTask(t);
  const tier = trivial ? 'trivial' : (task ? 'task' : 'chat');

  const len = t.length;
  const c1 = Math.max(0, Math.min(1, (len - 8) / 52));
  const c2 = Math.min(1, countAny(t, REQ_WORDS) * 0.5);
  const c3 = Math.min(1, countAny(t, REF_WORDS) * 0.5);
  const c4 = countAny(t, MEDIA_WORDS) > 0 ? 1 : 0;
  const qMarks = (t.match(/[？?]/g) || []).length;
  const c5 = Math.min(1, Math.max(0, qMarks - 1) * 0.5);
  const score = trivial ? 0 : Number((0.25 * c1 + 0.3 * c2 + 0.2 * c3 + 0.1 * c4 + 0.15 * c5).toFixed(3));

  return { tier, score, signals: { len, c1: +c1.toFixed(2), c2, c3, c4, c5, qMarks } };
}

/** 兼容旧名 */
export const scoreComplexity = (t) => {
  const r = classify(t);
  return { score: r.score, tier: r.tier === 'trivial' ? 'simple' : (r.tier === 'task' ? 'complex' : 'mid'), signals: r.signals };
};

/** 给日志用的一行 */
export function describe(r, text) {
  return JSON.stringify({ ts: Date.now(), tier: r.tier, score: r.score, s: r.signals, text: String(text || '').slice(0, 60) });
}
