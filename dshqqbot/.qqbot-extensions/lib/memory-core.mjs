/**
 * memory-core.mjs — 小蓝的长期记忆库（Neuro 式「检索而非重放」的落地）
 *
 * 设计要点（见 F:\qqbot\qqbot-mod\01-神经人设与记忆架构.md §3）：
 *   · 每条记忆 = 一行 JSONL { id, ts, kind, text, vec, hits, lastHit, subj? }
 *   · 向量用插件自带的本地小模型（零 token、离线）；拿不到就退化成字符 n-gram
 *   · 召回打分 = cos * (0.5 + 0.5*recency) * (1 + 0.1*min(hits,5))
 *   · 写入去重：cos > 0.92 视为同一条，只累加 hits
 *   · 容量：每 scope 上限 cap 条，超出按 score 最低淘汰
 *
 * 为什么放在 .qqbot-extensions/lib 而不是改 dist：
 *   插件升级会覆盖 dist，扩展目录不会。可以长期存活。
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { findPluginDir } from './plugin-dir.mjs';

// ── 参数（可被 memory-config.json 覆盖）────────────────────────────────
const DEFAULTS = {
  cap: 1500,              // 每 scope 最大记忆条数
  recallTopK: 4,          // 每次召回几条
  // 召回门槛：实测 bge-small-zh 对"改述型问句"（如"你之前答应我什么了" vs "小蓝答应过…冷笑话"）
  // 余弦只有 ~0.50，0.55 会漏召回。0.45 是实测能同时压住噪声又能召回改述的档位。
  // 换了 bge-base/large 之后可以再往上调（更准，分也更高）。
  recallMinCos: 0.45,
  recallMaxChars: 300,    // 注入块的字数上限
  dedupeCos: 0.92,        // 高于这个视为重复
  halfLifeDays: 30,       // 时间衰减半衰期
  minTextLen: 6,          // 短于此的消息不进记忆
  digestEvery: 40,        // 每攒够多少条 event 做一次中层摘要（零 token，不删原记忆）
  pluginDir: '',          // 空 = 运行时按 .generations/live 自动找（见 lib/plugin-dir.mjs）
};

let CONFIG = { ...DEFAULTS };

/** 读一次配置（扩展目录下 memory-config.json，可选） */
export function loadConfig(dataRoot) {
  try {
    const p = join(dataRoot, '.qqbot-extensions', 'memory-config.json');
    if (existsSync(p)) CONFIG = { ...DEFAULTS, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch { /* 配置坏了就用默认，绝不因此中断 */ }
  return CONFIG;
}

// ── 路径 ────────────────────────────────────────────────────────────────
export function memoryDir(dataRoot) {
  return join(dataRoot, '.qqbot', 'memory');
}
export function memoryFile(dataRoot, scope) {
  const safe = String(scope || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(memoryDir(dataRoot), `${safe}.jsonl`);
}

// ── 嵌入器（优先插件本地小模型，退化为字符 n-gram）──────────────────────
let _embedderPromise;
let _embedderMode = 'pending';

async function getEmbedder(cfg) {
  if (!_embedderPromise) {
    _embedderPromise = (async () => {
      try {
        const _pd = String(cfg.pluginDir || '').trim() || findPluginDir();
        if (!_pd) throw new Error('找不到插件目录（.generations/live 里也没有）');
        const mod = await import('file:///' + _pd.replace(/\\/g, '/') + '/dist/features/local-embed.js');
        const emb = mod.createLocalEmbedder({ modelDir: cfg.modelDir || '', logger: undefined });
        // 探一次，确认真的能算
        const probe = await emb.embedQuery('测试');
        if (!Array.isArray(probe)) throw new Error('embedder 不可用');
        _embedderMode = 'model';
        return { embed: (t) => emb.embedPassages([t]).then((r) => r?.[0]), query: (t) => emb.embedQuery(t) };
      } catch {
        _embedderMode = 'lexical';
        return null;
      }
    })();
  }
  return _embedderPromise;
}

/** 字符 n-gram 兜底（256 维，纯 JS，零依赖） */
function lexicalVec(text, dims = 256) {
  const v = new Float64Array(dims);
  const s = String(text).toLowerCase().replace(/\s+/g, '');
  const add = (gram, w) => {
    let h = 2166136261;
    for (let i = 0; i < gram.length; i++) { h ^= gram.charCodeAt(i); h = Math.imul(h, 16777619); }
    const idx = (h >>> 0) % dims;
    v[idx] += ((h >>> 31) ? -1 : 1) * w;
  };
  for (let i = 0; i < s.length; i++) {
    add(s[i], 0.35);
    if (i + 1 < s.length) add(s.slice(i, i + 2), 1);
    if (i + 2 < s.length) add(s.slice(i, i + 3), 0.5);
  }
  let n = 0;
  for (let i = 0; i < dims; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dims; i++) v[i] /= n;
  return Array.from(v);
}

export function embedderMode() { return _embedderMode; }

async function embedMany(texts, cfg, asQuery = false) {
  const e = await getEmbedder(cfg);
  if (e) {
    try {
      const out = [];
      for (const t of texts) {
        const r = asQuery ? await e.query(t) : await e.embed(t);
        if (!Array.isArray(r)) throw new Error('no vec');
        out.push(r);
      }
      return out;
    } catch { _embedderMode = 'lexical'; }
  }
  return texts.map((t) => lexicalVec(t));
}

// ── 向量运算 ────────────────────────────────────────────────────────────
export function cos(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return d / Math.sqrt(na * nb);
}

/** 时间衰减：越久越淡，半衰期 halfLifeDays */
function recency(ts, halfLifeDays) {
  const ageDays = (Date.now() - Number(ts || 0)) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// ── 读写 ────────────────────────────────────────────────────────────────
const _cache = new Map(); // scope → { mtimeMs, items }

export function loadMemories(dataRoot, scope, cfg = CONFIG) {
  const file = memoryFile(dataRoot, scope);
  if (!existsSync(file)) return [];
  const mtimeMs = statSync(file).mtimeMs;
  const hit = _cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.items;
  const items = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { items.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
    }
  } catch { /* 读不了就当空 */ }
  _cache.set(file, { mtimeMs, items });
  return items;
}

function appendLine(dataRoot, scope, obj) {
  const dir = memoryDir(dataRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(memoryFile(dataRoot, scope), JSON.stringify(obj) + '\n', 'utf8');
  _cache.delete(memoryFile(dataRoot, scope)); // 失效缓存
}

function rewriteAll(dataRoot, scope, items) {
  const dir = memoryDir(dataRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = memoryFile(dataRoot, scope);
  const tmp = file + '.tmp';
  writeFileSync(tmp, items.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  renameSync(tmp, file);
  _cache.delete(file);
}

function newId() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── 写入 ────────────────────────────────────────────────────────────────
/**
 * 记一条。返回 { ok, reason, id }。
 * kind: fact（事实）/ event（事件）/ preference（偏好）/ relation（关系）
 */
export async function remember(dataRoot, scope, { text, kind = 'fact', subj = '' }, cfg = CONFIG) {
  const t = String(text || '').trim();
  if (t.length < 2) return { ok: false, reason: 'too-short' };

  const items = loadMemories(dataRoot, scope, cfg);
  const [vec] = await embedMany([t], cfg, false);

  // 去重：与已有记忆比相似度
  for (const it of items) {
    const c = cos(vec, it.vec);
    if (c >= cfg.dedupeCos) {
      it.hits = (it.hits || 0) + 1;
      it.lastHit = Date.now();
      rewriteAll(dataRoot, scope, items);
      return { ok: true, reason: 'deduped', id: it.id, cos: c };
    }
  }

  const entry = { id: newId(), ts: Date.now(), kind, text: t, subj: String(subj || ''), vec, hits: 0, lastHit: 0 };
  items.push(entry);

  // 超容量：按 权重*新鲜度 淘汰
  if (items.length > cfg.cap) {
    items.sort((a, b) => (b.hits || 0) * recency(b.ts, cfg.halfLifeDays) - (a.hits || 0) * recency(a.ts, cfg.halfLifeDays));
    items.length = cfg.cap;
  }
  rewriteAll(dataRoot, scope, items);
  return { ok: true, reason: 'added', id: entry.id };
}

/** 删一条 */
export function forget(dataRoot, scope, id, cfg = CONFIG) {
  const items = loadMemories(dataRoot, scope, cfg);
  const idx = items.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  items.splice(idx, 1);
  rewriteAll(dataRoot, scope, items);
  return true;
}

// ── 词面重合（JSONL 回退后端专用）───────────────────────────────────────
/**
 * 为什么需要它：
 *   没有向量模型时，lexicalVec 是字 n-gram 哈希向量，同一对真实问答只有 0.02~0.14，
 *   而毫不相干的句子之间随便就有 0.10~0.19 —— 噪声底噪**高于**真实命中，
 *   拿 recallMinCos=0.45 去卡，结果是一条都召不回来（"她完全不记得你"）。
 *   所以回退模式下准入改看"字面重合"，余弦只留作展示。
 */
const STOP_BG = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '什么', '怎么', '就是', '不是', '可以',
  '一个', '没有', '还是', '因为', '所以', '但是', '如果', '已经', '现在', '然后', '之后',
  '这样', '那样', '时候', '东西', '自己', '大家', '一下', '一点', '一些', '觉得', '知道',
  '应该', '真的', '有点', '其实', '好像', '的话', '记得', '说过', '讲过', '提过',
  '上次', '下次', '之前', '以前', '这次',
]);
const STOP_CH = new Set(Array.from(
  '的了着过吗呢啊吧呀哦嘛是在有我你他她它们这那和与就都也还很太更最不没要会能可被把给对从到向往说个一二三四五六七八九十么什怎哪谁何时地得',
));

/** 切出（二元组集合, 单字集合）；单字只留实词，虚词会把整库拉进来 */
function lexUnits(s) {
  const text = String(s || '');
  const bg = new Set();
  const uni = new Set();
  for (const run of (text.match(/[\u4e00-\u9fa5]+/g) || [])) {
    for (let i = 0; i + 1 < run.length; i++) {
      const g = run.slice(i, i + 2);
      if (!STOP_BG.has(g)) bg.add(g);
    }
    for (const ch of run) if (!STOP_CH.has(ch)) uni.add(ch);
  }
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) bg.add(m[0].toLowerCase());
  return { bg, uni };
}

/**
 * 查询与记忆的字面重合度。
 * 返回 { ev, bgHit }：ev 是覆盖率（0~1，拿来当排序底座），bgHit 是"有没有二元组证据"。
 * 二元组命中才算证据——单个汉字（"子""学"）几乎人人都有，不能当召回依据。
 */
function lexOverlap(qUnits, text) {
  const t = lexUnits(text);
  let bgHit = 0;
  for (const g of qUnits.bg) if (t.bg.has(g)) bgHit += 1;
  let uniHit = 0;
  for (const c of qUnits.uni) if (t.uni.has(c)) uniHit += 1;
  const denom = qUnits.bg.size + qUnits.uni.size * 0.3;
  const ev = denom > 0 ? (bgHit + uniHit * 0.3) / denom : 0;
  return { ev, bgHit, uniHit };
}

// ── 召回 ────────────────────────────────────────────────────────────────
/**
 * 给当前消息召回 topK 条记忆。返回 [{ text, score, kind, ts }]。
 */
export async function recall(dataRoot, scope, queryText, cfg = CONFIG) {
  const q = String(queryText || '').trim();
  if (q.length < 2) return [];
  const items = loadMemories(dataRoot, scope, cfg);
  if (items.length === 0) return [];

  const [qvec] = await embedMany([q], cfg, true);
  const lexical = _embedderMode === 'lexical';
  const qUnits = lexical ? lexUnits(q) : null;
  const scored = [];
  for (const it of items) {
    const c = cos(qvec, it.vec);
    // 自匹配护栏：与查询几乎逐字相同的条目**不算"历史记忆"**（那是刚刚这句话自己），
    // 注回去纯属浪费 token。正常情况下顺序已经保证（先召回后沉淀），这里是二道保险。
    if (c > 0.98) continue;
    let base;
    if (lexical) {
      const { ev, bgHit, uniHit } = lexOverlap(qUnits, it.text);
      // 证据门槛：至少一个共同二元组，或两个以上实词单字。
      // 达不到就当作"跟这条查询无关"——宁可召回为空，也不要往上下文里塞噪声。
      if (bgHit === 0 && uniHit < 2) continue;
      base = ev;
    } else {
      if (c < cfg.recallMinCos) continue;
      base = c;
    }
    // 命中热度次线性封顶（最高 1.3×）：早先满额 1.5×，足以压过真实的排序差异
    const score = base * (0.5 + 0.5 * recency(it.ts, cfg.halfLifeDays))
      * (1 + 0.3 * (1 - 1 / (1 + Math.log1p(it.hits || 0))));
    scored.push({ it, cos: c, score, vecMode: lexical ? 'lexical' : _embedderMode });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, cfg.recallTopK);

  // 命中计数（不改 ts，只提升 hits —— 常被想起的更容易再被想起）
  if (top.length) {
    const ids = new Set(top.map((x) => x.it.id));
    for (const it of items) if (ids.has(it.id)) { it.hits = (it.hits || 0) + 1; it.lastHit = Date.now(); }
    try { rewriteAll(dataRoot, scope, items); } catch { /* 计量失败不影响召回 */ }
  }

  return top.map((x) => ({
    id: x.it.id, text: x.it.text, kind: x.it.kind, ts: x.it.ts,
    cos: x.cos, score: x.score, vecMode: x.vecMode,
  }));
}

/** 把召回结果拼成注入块（≤ recallMaxChars 字） */
export function formatRecallBlock(hits, cfg = CONFIG) {
  if (!hits || hits.length === 0) return '';
  const lines = [];
  let used = 0;
  for (const h of hits) {
    const line = `${lines.length + 1}. ${h.text}`;
    if (used + line.length > cfg.recallMaxChars) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '';
  return `\n[记忆]\n${lines.join('\n')}\n[/记忆]`;
}

/** 统计（给面板/调试用） */
export function stats(dataRoot, scope, cfg = CONFIG) {
  const items = loadMemories(dataRoot, scope, cfg);
  const byKind = {};
  for (const it of items) byKind[it.kind || '?'] = (byKind[it.kind || '?'] || 0) + 1;
  return { scope, total: items.length, byKind, mode: _embedderMode, file: memoryFile(dataRoot, scope) };
}

// ── 收件箱：解耦"工具不知道当前是哪个群"的问题 ──────────────────────────
/**
 * 记忆工具（tool 扩展）拿不到"当前会话作用域"，而记忆是按群分文件的。
 * 与其猜 scope，不如：工具只往**公共收件箱**写一行，入站扩展在下一条消息到来时
 * 把收件箱并进**当前群**的作用域，然后清空。
 * 代价：延迟一条消息（可接受）；收益：永远不会写错群。
 */
export function inboxFile(dataRoot) {
  const dir = join(dataRoot, '.qqbot', 'memory');
  return join(dir, '_inbox.jsonl');
}

export function pushInbox(dataRoot, { text, kind = 'fact', subj = ' ' }) {
  const t = String(text || '').trim();
  if (t.length < 2) return { ok: false, reason: 'too-short' };
  const file = inboxFile(dataRoot);
  try {
    const dir = memoryDir(dataRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: Date.now(), kind, subj: String(subj || '').trim(), text: t }) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 把收件箱并入某个 scope，然后清空。返回并入条数。绝不抛。 */
export async function drainInbox(dataRoot, scope, cfg = CONFIG) {
  const file = inboxFile(dataRoot);
  if (!existsSync(file)) return 0;
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return 0;
  }
  if (lines.length === 0) return 0;
  let n = 0;
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o?.text) continue;
      const r = await remember(dataRoot, scope, { text: o.text, kind: o.kind || 'fact', subj: o.subj }, cfg);
      if (r.ok) n += 1;
    } catch { /* 单行坏了继续 */ }
  }
  try { rmSync(file, { force: true }); } catch { /* 清不掉就下次再清（会去重） */ }
  return n;
}

/** 跨 scope 列出记忆（工具的 list 用） */
export function listAll(dataRoot, { limit = 30, scopeFilter = '' } = {}) {
  const dir = memoryDir(dataRoot);
  if (!existsSync(dir)) return [];
  const out = [];
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('_')); } catch { return []; }
  for (const f of files) {
    const scope = f.replace(/\.jsonl$/, '');
    if (scopeFilter && !scope.includes(scopeFilter)) continue;
    let items = [];
    try {
      items = readFileSync(join(dir, f), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
        .map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    } catch { continue; }
    for (const it of items) out.push({ scope, id: it.id, kind: it.kind, subj: it.subj || '', text: it.text, ts: it.ts, hits: it.hits || 0 });
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out.slice(0, limit);
}

/** 跨 scope 按 id 删除（工具的 forget 用） */
export function forgetAnywhere(dataRoot, id, cfg = CONFIG) {
  const dir = memoryDir(dataRoot);
  if (!existsSync(dir)) return false;
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('_')); } catch { return false; }
  for (const f of files) {
    const scope = f.replace(/\.jsonl$/, '');
    const items = loadMemories(dataRoot, scope, cfg);
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) continue;
    items.splice(idx, 1);
    rewriteAll(dataRoot, scope, items);
    return true;
  }
  return false;
}

// ── 中层记忆：抽取式摘要（零 token，不删原记忆）──────────────────────────
/**
 * 三层记忆里的"中层"：
 *   短期 = historyLimit 那几条原文
 *   中层 = **本函数产出的 summary**（把一段时间的碎碎念压成 1~2 句"前情"）
 *   长期 = 一条条可检索的 episode / fact
 *
 * 做法是**抽取式**（extractive）：算这一批记忆的向量质心，挑离质心最近的 1~2 条原句
 * 拼成一行。不调用任何 LLM ⇒ 零 token；代价是摘要由原句组成，不会"换一种说法"。
 *
 * 为什么**不删**原记忆：删了就等于用摘要替代细节，风险太大（可能删掉关键事实）。
 * 容量靠 cap + 时间衰减自然淘汰，摘要只是额外多一条"跨度更大"的索引。
 */
function digestStateFile(dataRoot, scope) {
  const safe = String(scope || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(memoryDir(dataRoot), `_digest_${safe}.json`);
}
function readDigestState(dataRoot, scope) {
  const f = digestStateFile(dataRoot, scope);
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; } catch { return {}; }
}
function writeDigestState(dataRoot, scope, st) {
  const dir = memoryDir(dataRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(digestStateFile(dataRoot, scope), JSON.stringify(st), 'utf8');
}

/** 向量质心 */
function centroid(vecs) {
  const n = vecs.length;
  const dim = vecs[0].length;
  const c = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) c[i] += v[i];
  for (let i = 0; i < dim; i++) c[i] /= n;
  return c;
}

/**
 * 给某个 scope 做一次中层摘要。返回 { ok, added, covered } 或 { ok:false, reason }。
 * 触发条件：距上次摘要累积的 event 条数 >= cfg.digestEvery（默认 40）。
 */
export function digestScope(dataRoot, scope, cfg = CONFIG) {
  const every = Math.max(10, Number(cfg.digestEvery) || 40);
  const items = loadMemories(dataRoot, scope, cfg);
  const st = readDigestState(dataRoot, scope);
  const since = Number(st.lastDigestTs) || 0;

  const fresh = items
    .filter((it) => it.kind === 'event' && Number(it.ts) > since && Array.isArray(it.vec) && it.vec.length > 0)
    .sort((a, b) => a.ts - b.ts);
  if (fresh.length < every) return { ok: false, reason: `不足 ${every} 条（现有 ${fresh.length}）` };

  const batch = fresh.slice(0, every);
  const c = centroid(batch.map((x) => x.vec));
  // 离质心最近的两条（且彼此不重复）
  const ranked = batch
    .map((it) => ({ it, c: cos(c, it.vec) }))
    .sort((a, b) => b.c - a.c);
  const picked = [];
  for (const r of ranked) {
    if (picked.some((p) => cos(p.vec, r.it.vec) > 0.9)) continue;
    picked.push(r.it);
    if (picked.length >= 2) break;
  }
  if (picked.length === 0) return { ok: false, reason: '挑不出代表句' };

  const from = new Date(batch[0].ts).toISOString().slice(5, 16).replace('T', ' ');
  const to = new Date(batch[batch.length - 1].ts).toISOString().slice(5, 16).replace('T', ' ');
  const text = `（${from}~${to} 群里的 ${batch.length} 条消息，主要围绕）` + picked.map((p) => p.text).join('；');

  // 直接写一条 summary（不走去重：摘要本来就该独立存在）
  const entry = {
    id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ts: Date.now(), kind: 'summary', text: text.slice(0, 260), subj: '',
    vec: c, hits: 0, lastHit: 0,
  };
  items.push(entry);
  if (items.length > cfg.cap) {
    items.sort((a, b) => (b.hits || 0) * recency(b.ts, cfg.halfLifeDays) - (a.hits || 0) * recency(a.ts, cfg.halfLifeDays));
    items.length = cfg.cap;
  }
  rewriteAll(dataRoot, scope, items);
  writeDigestState(dataRoot, scope, { lastDigestTs: batch[batch.length - 1].ts, lastRun: Date.now() });
  return { ok: true, added: 1, covered: batch.length, text: entry.text };
}

/** 把"该不该做摘要"的判断做成廉价守卫（避免每条消息都扫全库） */
export function shouldDigest(dataRoot, scope, cfg = CONFIG) {
  try {
    const every = Math.max(10, Number(cfg.digestEvery) || 40);
    const items = loadMemories(dataRoot, scope, cfg);
    const since = Number(readDigestState(dataRoot, scope).lastDigestTs) || 0;
    let n = 0;
    for (const it of items) if (it.kind === 'event' && Number(it.ts) > since) n += 1;
    return n >= every;
  } catch { return false; }
}
