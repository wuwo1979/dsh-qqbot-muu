/**
 * lib/imitate.mjs — 从群聊/导入记录里学说话习惯（像小孩模仿大人）
 *
 * 只做"可解释的浅层模仿"：高频短语、句长、标点/语气习惯。
 * 不复制别人的观点，不把别人的私事写进人格；结果是一条短文本，存 persona(global, style)。
 */
import { queryChat } from './chatlog-db.mjs';
import { getPersonaValue, setPersona } from './memory.mjs';
import { listAll } from './memory.mjs';

const STOP = new Set([
  '就是', '这个', '那个', '什么', '怎么', '可以', '不是', '没有', '我们', '你们', '他们', '自己',
  '现在', '今天', '明天', '昨天', '时候', '真的', '然后', '还是', '因为', '所以', '但是', '如果',
  '已经', '知道', '觉得', '应该', '可能', '一样', '这样', '那样', '怎么', '一个', '一下', '有点',
  '哈哈', '哈哈哈', '呵呵', '嗯嗯', '哦哦', '好的', '好吧', '行吧',
]);

function clean(s) {
  return String(s || '').replace(/<@[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function countPhrases(texts) {
  const m = new Map();
  for (const t of texts) {
    const cleanText = clean(t);
    const hits = cleanText.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
    for (const w of hits) {
      if (STOP.has(w)) continue;
      m.set(w, (m.get(w) || 0) + 1);
    }
  }
  return [...m.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8);
}

export function summarizeStyle(texts) {
  const arr = (Array.isArray(texts) ? texts : []).map(clean).filter(Boolean);
  if (!arr.length) return '';
  const phrases = countPhrases(arr).map(([w]) => w);
  const q = arr.filter((t) => /[?？]/.test(t)).length;
  const ex = arr.filter((t) => /[!！]/.test(t)).length;
  const tilde = arr.filter((t) => /[~～]/.test(t)).length;
  const avg = Math.round(arr.reduce((a, t) => a + t.length, 0) / arr.length);
  const bits = [];
  if (phrases.length >= 2) bits.push('常挂嘴边：' + phrases.slice(0, 5).join('、'));
  if (q / arr.length > 0.25) bits.push('爱反问');
  if (ex / arr.length > 0.2) bits.push('爱用感叹号');
  if (tilde / arr.length > 0.15) bits.push('句尾爱带波浪号');
  bits.push(avg <= 12 ? '说话很短' : avg >= 28 ? '会一口气说长句' : '句子不长不短');
  return bits.join('；').slice(0, 160);
}

/** 学一次：读这个 scope 最近 N 条群聊，提炼一句话存进 persona(global, style) */
export function learnStyle(dataRoot, { scope = '', limit = 240 } = {}) {
  let rows = [];
  try {
    if (scope) rows = queryChat(dataRoot, scope, { limit: Math.max(20, Math.min(800, Number(limit) || 240)) }) || [];
  } catch { rows = []; }
  // 没有聊天台账时退回记忆库（至少能学到她记住的那些句子）
  if (!rows.length) {
    try {
      rows = (listAll(dataRoot, { limit: Math.max(20, Math.min(200, Number(limit) || 120)) }) || [])
        .map((x) => ({ text: x.text, dir: 'in' }));
    } catch { rows = []; }
  }
  const texts = rows.map((r) => r.text).filter(Boolean);
  const line = summarizeStyle(texts);
  if (!line) return { ok: false, error: '素材太少，先多聊几句' };
  try {
    setPersona(dataRoot, 'global', { ckey: 'style', cvalue: line, weight: 1 });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, style: line, samples: texts.length };
}

export function currentStyle(dataRoot) {
  try {
    const v = getPersonaValue(dataRoot, 'global', 'style');
    const s = typeof v === 'string'
      ? v
      : (v && (v.cvalue ?? v.value ?? v.text)) || '';
    return s ? String(s).slice(0, 160) : '';
  } catch { return ''; }
}

export default { summarizeStyle, learnStyle, currentStyle };
