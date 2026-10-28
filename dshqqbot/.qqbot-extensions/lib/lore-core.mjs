/**
 * lore-core.mjs — 世界书（lorebook）检索：设定不常驻上下文，命中才注入
 *
 * 为什么不是为了好看：
 *   现在"人设"是 641 字的常驻 prompt，里面其实塞不下"妈妈是谁、老家在哪、2+3=6"这些细节。
 *   Neuro 那类 bot 的做法是：核心人设常驻（短），设定做成条目，按当前这句话命中后才带 1~2 条。
 *   结果：每轮只多 40~120 字，却能记住几十条设定，而且改设定不用改 prompt。
 *
 * 文件位置（按优先级）：
 *   1) 环境变量 QQBOT_WORLDBOOK 指向的 json
 *   2) {dataRoot}/.qqbot-extensions/worldbook.json
 *   3) {dataRoot}/.qqbot-extensions/persona/worldbook.json
 *
 * 契约：全程 try/catch，出错就返回空块 —— 绝不影响聊天。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = {
  enabled: true,
  topK: 2,          // 一次最多注入几条
  maxChars: 200,    // 块的总字数上限
  minScore: 1.0,    // 低于这个分不注入（避免"随便提个吃就带出食物设定"）
};

let _cache = { at: 0, path: '', entries: [] };

export function resolveWorldbookPath(dataRoot) {
  const env = String(process.env.QQBOT_WORLDBOOK || '').trim();
  if (env && existsSync(env)) return env;
  const base = join(dataRoot, '.qqbot-extensions');
  const a = join(base, 'worldbook.json');
  if (existsSync(a)) return a;
  const b = join(base, 'persona', 'worldbook.json');
  if (existsSync(b)) return b;
  return '';
}

/** 读世界书（带 10 秒缓存，改文件不用重启） */
export function loadWorldbook(dataRoot) {
  try {
    const p = resolveWorldbookPath(dataRoot);
    if (!p) return [];
    const now = Date.now();
    if (_cache.path === p && now - _cache.at < 10_000) return _cache.entries;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const list = Array.isArray(j) ? j : (Array.isArray(j?.entries) ? j.entries : []);
    const entries = list
      .filter((e) => e && typeof e.text === 'string' && e.text.trim())
      .map((e) => ({
        id: String(e.id || ''),
        keys: Array.isArray(e.keys) ? e.keys.map((k) => String(k)) : [],
        always: e.always === true,
        w: typeof e.w === 'number' ? e.w : 1,
        text: String(e.text),
      }));
    _cache = { at: now, path: p, entries };
    return entries;
  } catch {
    return [];
  }
}

/** 关键词计分：命中次数 × 权重；always 条目给一个保底分 */
export function scoreLore(entries, text) {
  const t = String(text || '').toLowerCase();
  if (!t) return [];
  const out = [];
  for (const e of entries) {
    let hits = 0;
    for (const k of e.keys) {
      if (!k) continue;
      const kk = k.toLowerCase();
      let idx = t.indexOf(kk);
      while (idx >= 0) { hits++; idx = t.indexOf(kk, idx + kk.length); }
    }
    const score = hits > 0 ? hits * e.w : (e.always ? 0.8 : 0);
    if (score > 0) out.push({ ...e, score });
  }
  out.sort((a, b) => b.score - a.score || b.w - a.w);
  return out;
}

/** 拼成注入块；超预算就截断，保证不会因为设定把上下文撑爆 */
export function formatLoreBlock(hits, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  if (!c.enabled) return '';
  const picked = [];
  let used = 0;
  for (const h of (Array.isArray(hits) ? hits : [])) {
    if (!h || typeof h.text !== 'string') continue;
    if (h.score < c.minScore && !h.always) continue;
    if (picked.length >= c.topK) break;
    if (used + h.text.length > c.maxChars && picked.length > 0) break;
    picked.push(h);
    used += h.text.length;
  }
  if (!picked.length) return '';
  const body = picked.map((p) => '- ' + p.text).join('\n').slice(0, c.maxChars);
  return '\n[设定]\n' + body + '\n[/设定]';
}

/** 一步到位：文本 → 注入块（调用方只需要这一行） */
export function loreFor(dataRoot, text, cfg = {}) {
  try {
    const c = { ...DEFAULTS, ...(cfg || {}) };
    if (!c.enabled) return { block: '', hits: [] };
    const entries = loadWorldbook(dataRoot);
    if (!entries.length) return { block: '', hits: [] };
    const hits = scoreLore(entries, text);
    return { block: formatLoreBlock(hits, c), hits };
  } catch {
    return { block: '', hits: [] };
  }
}
