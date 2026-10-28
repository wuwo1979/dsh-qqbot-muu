/**
 * memory-hippo.mjs — 类海马体记忆层（检索 + 巩固 + 人格漂移护栏）
 *
 * 为什么再叠一层：
 *   memory-db.mjs 已经有「向量 + 倒排 + 实体锚定 + RRF」的**候选筛选**，
 *   但它仍然是「查一次、按分数取前 K 条」——这在真实聊天里会犯两个错：
 *     ① 重复：同一件事的 4 种说法占满名额（真实事件一条没进）；
 *     ② 断片：拿到的都是零散句子，缺"这件事的前后发生了什么"。
 *   海马体不是这么工作的：齿状回先把相似的经历**分开**（pattern separation），
 *   CA3 再用一点线索把整段经历**补全**（pattern completion），最后在睡眠里
 *   反复回放、把情节压成语义（systems consolidation）。这套文件就照着做：
 *
 *   ┌─ hippoRecall ────────────────────────────────────────────────┐
 *   │ 1. 复用 memory-db.recall 拿到 3× 候选（多路召回已经做过融合）   │
 *   │ 2. 时间邻近扩散：命中事件的 ±window 内的事件一起进来（情节重建）  │
 *   │ 3. 归纳补全：命中项若属于某条 gist，把 gist 作为上下文补一条      │
 *   │ 4. MMR 去重排序：λ·相关 − (1−λ)·与已选最大相似（模式分离）        │
 *   └───────────────────────────────────────────────────────────────┘
 *   replay()  回放巩固：把同一主题的 N 条情节压成 gist（纯抽取式，零 token）
 *   belief*   人格信念：带**步长上限 + 负向证据要重复 + 锚点基线**的更新
 *
 * 设计约束：
 *   · 纯本地、零依赖、不联网、不调模型（巩固用抽取式摘要，不烧 token）
 *   · 任何一步失败都降级回 memory-db 的原始召回，绝不打断聊天
 *   · 表用 CREATE IF NOT EXISTS 自建，老库不用迁移
 */
import { createHash } from 'node:crypto';
import { getHandle, cos, recall as baseRecall, loadConfig, embedderMode, tokensOf, memDecrypt } from './memory-db.mjs';

// ── 表 ─────────────────────────────────────────────────────────────────
const SCHEMA_ADD = `
CREATE TABLE IF NOT EXISTS mem_gist (
  id    TEXT PRIMARY KEY,
  scope TEXT,
  text  TEXT,
  vec   BLOB,
  ts    INTEGER,
  n     INTEGER DEFAULT 0,
  keys  TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mem_gist_scope ON mem_gist(scope, ts);

CREATE TABLE IF NOT EXISTS mem_link (
  scope   TEXT,
  gist_id TEXT,
  mem_id  TEXT,
  sim     REAL,
  ts      INTEGER,
  PRIMARY KEY(scope, gist_id, mem_id)
);
CREATE INDEX IF NOT EXISTS idx_mem_link_mem ON mem_link(scope, mem_id);

CREATE TABLE IF NOT EXISTS belief (
  scope    TEXT,
  key      TEXT,
  value    REAL DEFAULT 0,
  base     REAL DEFAULT 0,
  conf     REAL DEFAULT 0,
  n        INTEGER DEFAULT 0,
  pos      INTEGER DEFAULT 0,
  neg      INTEGER DEFAULT 0,
  note     TEXT DEFAULT '',
  first_ts INTEGER,
  last_ts  INTEGER,
  PRIMARY KEY(scope, key)
);

CREATE TABLE IF NOT EXISTS hippo_log (
  ts     INTEGER,
  scope  TEXT,
  action TEXT,
  detail TEXT
);
`;

const _ready = new Set();

function h_(dataRoot) {
  const h = getHandle(dataRoot);
  const k = h.file || String(dataRoot);
  if (!_ready.has(k)) {
    h.db.exec(SCHEMA_ADD);
    _ready.add(k);
  }
  return h;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function log(h, scope, action, detail = '') {
  try {
    h.db.prepare('INSERT INTO hippo_log(ts, scope, action, detail) VALUES (?,?,?,?)')
      .run(Date.now(), String(scope || ''), String(action), String(detail).slice(0, 400));
  } catch { /* 日志失败无所谓 */ }
}

function shortId(prefix, s) {
  return prefix + createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
}

// ── ① 类海马体召回 ─────────────────────────────────────────────────────
/**
 * @param {object} cfg memory-config 的合并结果（可选）
 * @param {object} opt { topK, lambda, temporalWindowSec, widen }
 * @returns {Promise<Array<{id,text,kind,ts,cos,score,why:string[],gist?:string}>>}
 */
export async function hippoRecall(dataRoot, scope, queryText, cfg = loadConfig(dataRoot), opt = {}) {
  const sc = String(scope || 'unknown');
  const topK = Math.max(1, Math.min(12, num(opt.topK, cfg.recallTopK || 4)));
  const lambda = clamp(num(opt.lambda, cfg.hippoLambda ?? 0.72), 0.3, 0.95);
  const winSec = Math.max(0, num(opt.temporalWindowSec, cfg.hippoTemporalSec ?? 150));
  const widen = Math.max(topK, Math.min(40, num(opt.widen, topK * 3)));

  let base = [];
  try {
    base = await baseRecall(dataRoot, scope, queryText, { ...cfg, recallTopK: widen });
  } catch {
    base = [];
  }
  if (!base.length) return [];

  let h;
  try { h = h_(dataRoot); } catch { return base.slice(0, topK); }

  // 候选池：原始命中 + 时间邻近 + gist
  const pool = new Map();
  for (const b of base) {
    // 保留 kw/ent 证据字段：面板与测试都靠它解释"为什么想起这条"
    pool.set(b.id, { ...b, why: ['recall'], kw: num(b.kw), ent: num(b.ent) });
  }

  // 情节重建：命中事件的邻近事件（同一段对话里前后发生的）
  if (winSec > 0) {
    const seeds = base.slice(0, Math.min(3, base.length));
    for (const s of seeds) {
      try {
        const rows = h.db.prepare(
          `SELECT id, kind, text, ts, hits FROM mem
            WHERE scope = ? AND ts BETWEEN ? AND ? AND id <> ?
            ORDER BY ABS(ts - ?) ASC LIMIT 3`,
        ).all(sc, num(s.ts) - winSec * 1000, num(s.ts) + winSec * 1000, s.id, num(s.ts));
        for (const r of rows) {
          if (pool.has(r.id)) {
            pool.get(r.id).why.push('temporal');
          } else {
            pool.set(r.id, {
              id: r.id, kind: r.kind || 'event', text: memDecrypt(dataRoot, r.text), ts: num(r.ts),
              cos: 0, score: num(s.score) * 0.45, why: ['temporal'],
            });
          }
        }
      } catch { /* 邻近查询失败就跳过 */ }
    }
  }

  // 归纳补全：命中项所属的 gist（如果巩固过）
  for (const b of base.slice(0, 3)) {
    try {
      const g = h.db.prepare(
        `SELECT g.id, g.text, g.ts, L.sim FROM mem_link L
           JOIN mem_gist g ON g.id = L.gist_id
          WHERE L.scope = ? AND L.mem_id = ?
          ORDER BY L.sim DESC LIMIT 1`,
      ).get(sc, b.id);
      if (g && g.id && !pool.has(g.id)) {
        pool.set(g.id, {
          id: g.id, kind: 'gist', text: g.text, ts: num(g.ts),
          cos: 0, score: num(b.score) * 0.7, why: ['gist'],
        });
      }
    } catch { /* ignore */ }
  }

  // 取向量（MMR 需要两两相似）
  const vecs = new Map();
  const ids = [...pool.keys()].filter((id) => !String(id).startsWith('g_'));
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    try {
      const rows = h.db.prepare(
        `SELECT id, vec FROM mem WHERE scope = ? AND id IN (${chunk.map(() => '?').join(',')})`,
      ).all(sc, ...chunk);
      for (const r of rows) {
        const v = toVec(r.vec);
        if (v.length) vecs.set(r.id, v);
      }
    } catch { /* ignore */ }
  }
  const gistIds = [...pool.keys()].filter((id) => String(id).startsWith('g_'));
  for (const gid of gistIds) {
    try {
      const r = h.db.prepare('SELECT vec FROM mem_gist WHERE id = ?').get(gid);
      const v = r ? toVec(r.vec) : [];
      if (v.length) vecs.set(gid, v);
    } catch { /* ignore */ }
  }

  // 归一化分数 + 情节加成
  const list = [...pool.values()];
  const maxScore = Math.max(...list.map((x) => num(x.score)), 1e-6);
  for (const x of list) {
    x.rel = clamp(num(x.score) / maxScore, 0, 1);
    if (x.why.includes('temporal')) x.rel = Math.max(x.rel, 0.55);
    if (x.why.includes('gist')) x.rel = Math.max(x.rel, 0.6);
  }

  // MMR：先挑最相关，再挑「既相关又不重复」的（模式分离）
  const picked = [];
  const rest = list.slice();
  while (picked.length < Math.min(widen, list.length) && rest.length) {
    let best = null;
    let bestVal = -Infinity;
    for (const x of rest) {
      let maxSim = 0;
      for (const p of picked) {
        const a = vecs.get(x.id);
        const b = vecs.get(p.id);
        const s = a && b ? cos(a, b) : 0;
        if (s > maxSim) maxSim = s;
      }
      const val = lambda * x.rel - (1 - lambda) * maxSim;
      if (val > bestVal) { bestVal = val; best = x; }
    }
    if (!best) break;
    best.mmr = Number(bestVal.toFixed(4));
    picked.push(best);
    rest.splice(rest.indexOf(best), 1);
  }

  // 名额：最多 1 条 gist（它是前情提要，不该挤掉真实情节）
  const out = [];
  let gists = 0;
  for (const x of picked) {
    if (out.length >= topK) break;
    if (String(x.kind) === 'gist') {
      if (gists >= 1) continue;
      gists += 1;
    }
    out.push({
      id: x.id,
      text: x.text,
      kind: x.kind,
      ts: num(x.ts),
      cos: num(x.cos),
      score: Number((x.rel * 100).toFixed(2)),
      kw: num(x.kw),
      ent: num(x.ent),
      why: x.why,
      mmr: x.mmr,
    });
  }
  return out;
}

function toVec(blob) {
  if (!blob || !blob.byteLength) return [];
  try {
    const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    const f32 = (u8.byteOffset % 4 === 0)
      ? new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4))
      : new Float32Array(u8.slice().buffer, 0, Math.floor(u8.byteLength / 4));
    return Array.from(f32);
  } catch { return []; }
}

// ── ② 回放巩固（把情节压成 gist）────────────────────────────────────────
const GISTABLE = new Set(['event', 'fact', 'say', 'preference', 'relation', 'promise']);

/**
 * 同主题情节聚类 → 抽取式 gist。
 * 纯抽取：取簇内"最中心"的两句原话，不改写、不编造（避免幻觉污染长期记忆）。
 * @param {object} opts { windowDays, minSize, threshold, maxClusters, dryRun }
 */
export function replay(dataRoot, scope, opts = {}) {
  const sc = String(scope || 'unknown');
  const windowDays = clamp(num(opts.windowDays, 45), 1, 365);
  const minSize = Math.max(2, Math.min(12, num(opts.minSize, 3)));
  // 阈值跟向量口径走：真向量（bge-small）近义句 0.65~0.85；
  // 退化成词频哈希时 cosine 只有 0.1~0.3，用 0.68 会一条都聚不上——所以按后端自适应。
  const lexical = String(embedderMode() || '').includes('lexical');
  const defTh = lexical ? 0.2 : 0.68;
  const th = clamp(num(opts.threshold, defTh), lexical ? 0.12 : 0.4, 0.95);
  const maxClusters = Math.max(1, Math.min(40, num(opts.maxClusters, 6)));
  const dryRun = opts.dryRun === true;

  let h;
  try { h = h_(dataRoot); } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
  const since = Date.now() - windowDays * 86400000;

  let rows = [];
  try {
    rows = h.db.prepare(
      `SELECT id, kind, text, vec, ts, hits FROM mem
        WHERE scope = ? AND ts >= ? ORDER BY ts ASC`,
    ).all(sc, since);
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
  const linked = new Set();
  try {
    for (const r of h.db.prepare('SELECT mem_id FROM mem_link WHERE scope = ?').all(sc)) linked.add(r.mem_id);
  } catch { /* ignore */ }

  const pool = rows
    .map((r) => ({ id: r.id, kind: r.kind || '', text: memDecrypt(dataRoot, r.text) || '', ts: num(r.ts), hits: num(r.hits), vec: toVec(r.vec) }))
    .filter((r) => r.vec.length && GISTABLE.has(r.kind) && !linked.has(r.id) && String(r.text).length >= 6);

  if (pool.length < minSize) {
    return { ok: true, clusters: 0, gists: 0, reason: '情节不足（需要至少 ' + minSize + ' 条未巩固的记忆）', pool: pool.length };
  }

  // 显著性：命中多 + 越新越优先当种子（回放偏爱"值得记住的"）
  const now = Date.now();
  const sal = (r) => (1 + Math.min(r.hits, 6)) * Math.pow(0.5, (now - r.ts) / 86400000 / 30);
  const order = pool.slice().sort((a, b) => sal(b) - sal(a));

  const used = new Set();
  const clusters = [];
  for (const seed of order) {
    if (used.has(seed.id)) continue;
    const group = [seed];
    used.add(seed.id);
    for (const cand of order) {
      if (used.has(cand.id)) continue;
      if (Math.abs(cand.ts - seed.ts) > windowDays * 86400000) continue;
      const s = cos(seed.vec, cand.vec);
      // 词频退化模式下 cosine 只有 0.1~0.3，光看相似度会把"咖啡"和"猫"并成一簇；
      // 所以退化模式再要求至少 3 个共同二元组，避免巩固出无意义的归纳。
      if (lexical && sharedTokens(seed.text, cand.text) < 3) continue;
      if (s >= th) {
        used.add(cand.id);
        group.push({ ...cand, sim: s });
      }
    }
    if (group.length >= minSize) clusters.push(group);
    if (clusters.length >= maxClusters) break;
  }

  const made = [];
  try {
    for (const group of clusters) {
      const central = centrality(group);
      const parts = [];
      for (const item of central) {
        const t = String(item.text).replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (parts.some((p) => p.includes(t) || t.includes(p))) continue;
        if (parts.length >= 3) break;
        parts.push(t);
        if (parts.join(' / ').length >= 96) break;
      }
      if (!parts.length) continue;
      const text = ('【归纳】' + parts.join(' / ')).slice(0, 160);
      const gid = shortId('g_', sc + '|' + text);
      const ts = Math.max(...group.map((g) => g.ts));
      const vec = aveVec(group.map((g) => g.vec));
      const keys = keysOf(group);
      if (dryRun) {
        made.push({ id: gid, text, n: group.length, ts, preview: true });
        continue;
      }
      h.db.prepare(
        `INSERT INTO mem_gist(id, scope, text, vec, ts, n, keys) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET n = excluded.n, ts = excluded.ts`,
      ).run(gid, sc, text, vecBlob(vec), ts, group.length, keys);
      const ins = h.db.prepare(
        'INSERT OR REPLACE INTO mem_link(scope, gist_id, mem_id, sim, ts) VALUES (?,?,?,?,?)',
      );
      for (const g of group) ins.run(sc, gid, g.id, num(g.sim, 1), Date.now());
      made.push({ id: gid, text, n: group.length, ts });
    }
    if (made.length) log(h, sc, 'replay', `gists=${made.length} n=${made.reduce((a, b) => a + b.n, 0)}`);
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), clusters: clusters.length, gists: made.length, made };
  }

  return {
    ok: true,
    pool: pool.length,
    clusters: clusters.length,
    gists: made.length,
    made,
    note: made.length ? '' : '没有达到阈值的簇（' + th + '），这批情节还不够像',
  };
}

/** 两条记忆共享多少个二元组（词频退化模式下防止过度合并） */
function sharedTokens(a, b) {
  const A = new Set(tokensOf(a));
  if (!A.size) return 0;
  let n = 0;
  for (const t of new Set(tokensOf(b))) if (A.has(t)) n += 1;
  return n;
}

/** 簇内中心度：与原句平均相似度最高者优先 */
function centrality(group) {
  const scored = group.map((a) => {
    let sum = 0;
    let n = 0;
    for (const b of group) {
      if (a === b) continue;
      sum += cos(a.vec, b.vec);
      n += 1;
    }
    return { ...a, c: n ? sum / n : 1 };
  });
  return scored.sort((x, y) => y.c - x.c || x.ts - y.ts);
}

function aveVec(list) {
  const dim = list[0]?.length || 0;
  if (!dim) return [];
  const out = new Array(dim).fill(0);
  for (const v of list) {
    if (!v || v.length !== dim) continue;
    for (let i = 0; i < dim; i += 1) out[i] += v[i];
  }
  const n = Math.sqrt(out.reduce((a, b) => a + b * b, 0)) || 1;
  return out.map((x) => x / n);
}

function vecBlob(vec) {
  if (!vec || !vec.length) return null;
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function keysOf(group) {
  const counts = new Map();
  for (const g of group) {
    for (const w of String(g.text).match(/[\u4e00-\u9fa5]{2,4}|[A-Za-z]{3,}/g) || []) {
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= Math.max(2, Math.ceil(group.length * 0.5)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w)
    .join(',');
}

// ── ③ 人格信念：漂移护栏 ───────────────────────────────────────────────
/**
 * 核心思路（为什么要这么绕）：
 *   性格判断最怕"一次极端事件定终身"——某天用户心情差说了句难听话，
 *   卡片就被写成"刻薄"，之后所有回复都带刺。所以：
 *     · 每次证据最多推动 maxStep（默认 0.06），单条消息改不了整体印象；
 *     · 方向反转（正→负）时步长再打 0.35 折，负向证据要**重复出现**才生效；
 *     · base 是锚点（首次/手动锚定），|value-base| 过大且证据不足 → 报警；
 *     · conf 随证据条数增长（1-e^{-n/6}），低 conf 的偏移只当"待观察"。
 */
export const TRAIT_KEYS = ['warmth', 'trust', 'humor', 'reliability', 'boundary', 'energy'];

export function observeTrait(dataRoot, scope, { key = '', delta = 0, weight = 1, note = '' } = {}) {
  const sc = String(scope || 'unknown');
  const k = String(key || '').trim();
  if (!k) return { ok: false, reason: 'no-key' };
  const d = clamp(delta, -1, 1);
  if (!d) return { ok: false, reason: 'zero-delta' };
  const w = clamp(weight, 0.1, 2);
  let h;
  try { h = h_(dataRoot); } catch (e) { return { ok: false, reason: String(e?.message || e) }; }

  const now = Date.now();
  let row = null;
  try {
    row = h.db.prepare('SELECT * FROM belief WHERE scope = ? AND key = ?').get(sc, k);
  } catch { row = null; }

  const cur = num(row?.value, 0);
  const n = num(row?.n, 0);
  const pos = num(row?.pos, 0);
  const neg = num(row?.neg, 0);
  const base = row ? num(row.base, 0) : 0;

  const maxStep = clamp(0.06 * w, 0.01, 0.12);
  let step = Math.min(Math.abs(d), maxStep) * Math.sign(d);
  // 方向反转：负向证据需要重复（避免一条坏消息把"温柔"翻成"刻薄"）
  const flipping = (cur > 0.12 && step < 0) || (cur < -0.12 && step > 0);
  if (flipping && n < 3) step *= 0.35;

  let value = clamp(cur + step, -1, 1);
  // 低证据时不要把值推离锚点太远（认知不发生大偏差）
  const conf0 = 1 - Math.exp(-n / 6);
  const cap = 0.25 + 0.6 * conf0;
  value = clamp(value, base - cap, base + cap);

  const conf = 1 - Math.exp(-(n + 1) / 6);
  const nextPos = pos + (d > 0 ? 1 : 0);
  const nextNeg = neg + (d < 0 ? 1 : 0);
  try {
    h.db.prepare(
      `INSERT INTO belief(scope, key, value, base, conf, n, pos, neg, note, first_ts, last_ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(scope, key) DO UPDATE SET
         value = excluded.value, conf = excluded.conf, n = excluded.n,
         pos = excluded.pos, neg = excluded.neg,
         note = excluded.note, last_ts = excluded.last_ts`,
    ).run(sc, k, value, base, conf, n + 1, nextPos, nextNeg, String(note).slice(0, 80), num(row?.first_ts, now), now);
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
  return { ok: true, key: k, value: Number(value.toFixed(3)), base, prev: cur, step: Number(step.toFixed(3)), conf: Number(conf.toFixed(2)), n: n + 1 };
}

/** 把当前值钉成锚点（主人点"这就是他"的时候用；之后偏移超过阈值会报警） */
export function anchorBeliefs(dataRoot, scope) {
  const sc = String(scope || 'unknown');
  let h;
  try { h = h_(dataRoot); } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  try {
    const rows = h.db.prepare('SELECT key, value FROM belief WHERE scope = ?').all(sc);
    const up = h.db.prepare('UPDATE belief SET base = value WHERE scope = ? AND key = ?');
    for (const r of rows) up.run(sc, r.key);
    log(h, sc, 'anchor', rows.map((r) => r.key).join(','));
    return { ok: true, anchored: rows.length };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

export function beliefs(dataRoot, scope) {
  const sc = String(scope || 'unknown');
  let h;
  try { h = h_(dataRoot); } catch { return []; }
  try {
    return h.db.prepare('SELECT key, value, base, conf, n, pos, neg, note, last_ts FROM belief WHERE scope = ? ORDER BY n DESC').all(sc)
      .map((r) => ({
        key: r.key,
        value: Number(num(r.value).toFixed(2)),
        base: Number(num(r.base).toFixed(2)),
        drift: Number((num(r.value) - num(r.base)).toFixed(2)),
        conf: Number(num(r.conf).toFixed(2)),
        n: num(r.n),
        pos: num(r.pos),
        neg: num(r.neg),
        note: r.note || '',
        lastTs: num(r.last_ts),
      }));
  } catch { return []; }
}

/**
 * 漂移报告：给浮窗看"我对这个人的认知稳不稳"。
 * level: ok（稳）/ watch（有偏移但证据少）/ alarm（偏移大且证据足 → 该复核）
 */
export function driftReport(dataRoot, scope) {
  const list = beliefs(dataRoot, scope);
  const rows = list.map((b) => {
    const a = Math.abs(b.drift);
    const level = a >= 0.45 && b.n >= 6 ? 'alarm' : a >= 0.25 ? 'watch' : 'ok';
    return { ...b, level };
  });
  const worst = rows.slice().sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))[0] || null;
  const stability = rows.length
    ? Number((100 * (1 - rows.reduce((s, r) => s + Math.abs(r.drift) * (0.4 + 0.6 * r.conf), 0) / rows.length)).toFixed(1))
    : 100;
  return { rows, stability: clamp(stability, 0, 100), worst, alarm: rows.filter((r) => r.level === 'alarm').length };
}

/** 面板/调试用：这一层现在有多少归纳、多少链接、上次回放何时 */
export function hippoStats(dataRoot, scope) {
  const sc = String(scope || 'unknown');
  let h;
  try { h = h_(dataRoot); } catch { return { ok: false }; }
  const one = (sql, ...p) => {
    try { return h.db.prepare(sql).get(...p) || {}; } catch { return {}; }
  };
  const g = one('SELECT COUNT(*) AS n FROM mem_gist WHERE scope = ?', sc);
  const l = one('SELECT COUNT(*) AS n FROM mem_link WHERE scope = ?', sc);
  const b = one('SELECT COUNT(*) AS n FROM belief WHERE scope = ?', sc);
  const last = one("SELECT ts, detail FROM hippo_log WHERE scope = ? AND action = 'replay' ORDER BY ts DESC LIMIT 1", sc);
  const drift = driftReport(dataRoot, sc);
  return {
    ok: true,
    gists: num(g.n),
    links: num(l.n),
    beliefs: num(b.n),
    lastReplay: num(last.ts),
    lastReplayDetail: last.detail || '',
    stability: drift.stability,
    drift: drift.rows.slice(0, 6),
    alarm: drift.alarm,
  };
}

export default {
  hippoRecall,
  replay,
  observeTrait,
  anchorBeliefs,
  beliefs,
  driftReport,
  hippoStats,
  TRAIT_KEYS,
};
