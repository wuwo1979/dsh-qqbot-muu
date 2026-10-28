/**
 * memory-graph-llm.mjs — 用本地小模型补三元组（"类海马体"图谱的实体/关系抽取）
 *
 * 为什么需要它：
 *   规则抽取（memory-db 的 extractIndex）只认「甲是乙」这种显式句式，
 *   而真实聊天里大量关系是隐式的：「我上周搬去南山了」「老王现在管审核」。
 *   这类话用正则会漏，用小模型抽三元组刚好够用，而且**本地跑**——
 *   聊天记录不出本机，这是数据隔离的底线（用户明确要求）。
 *
 * 设计约束：
 *   · 永不抛：模型离线/超时/吐垃圾 → 返回 {ok:false, reason}，调用方什么都不做；
 *   · 有预算：单条超时 + 整体预算，宁可这次不抽，也不能把入库流程拖死；
 *   · 只补边，不改正文：抽出来的三元组写 mem_edge，原文一个字都不动；
 *   · 冲突消解与规则抽的边同权（走 memory-db 的 addEdges → 单值关系会失效旧的）。
 */

import { chat, loadConfig, health } from './local-llm.mjs';
import { getHandle, memDecrypt, addEdges, edgeHistory } from './memory-db.mjs';

export const DEFAULTS = {
  enabled: true,
  limit: 20,          // 一次最多处理多少条记忆
  budgetMs: 20000,    // 整批预算，超了就停（剩下的下次再补）
  timeoutMs: 4000,    // 单条超时
  maxTriples: 6,      // 单条记忆最多抽几个三元组
  maxInChars: 200,
  minTextLen: 6,
};

const SYSTEM = [
  '你是一个信息抽取器。从聊天记录里抽「实体—关系—实体」三元组。',
  '规则：',
  '1. 只输出 JSON 数组，不要解释、不要代码块标记；',
  '2. 每个元素形如 {"src":"老王","rel":"负责","dst":"审核"}；',
  '3. 实体用原文里的称呼（人名/群名/物品/地点），不要改写成代词；',
  '4. 关系用 2~4 个汉字（是/住在/负责/喜欢/想去/在…），不要长句；',
  '5. 抽不出就输出 []。',
  '',
  '例：',
  '输入：老王现在管审核了，他自己说的',
  '输出：[{"src":"老王","rel":"负责","dst":"审核"}]',
].join('\n');

/** 去掉模型爱加的解释/代码块，拿到第一段 JSON 数组 */
export function pickJsonArray(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : t;
  const i = body.indexOf('[');
  const j = body.lastIndexOf(']');
  if (i >= 0 && j > i) return body.slice(i, j + 1);
  return body.startsWith('[') ? body : '';
}

const BAD_NAME_RE = /^(他|她|它|他们|她们|我|你|您|这个|那个|这|那|东西|事情|什么|谁|大家|有人)$/;

/** 清洗并过滤模型吐出来的三元组：太长的、纯符号的、自己指向自己的，一律丢掉 */
export function tidyTriples(raw, maxTriples = 6) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const norm = (v) => String(v ?? '').replace(/^[\s"'「『（(]+|[\s"'」』）)]+$/g, '').trim();
    let src = norm(x.src ?? x.subject ?? x.头实体 ?? x.主语);
    let rel = norm(x.rel ?? x.predicate ?? x.relation ?? x.关系 ?? x.谓词);
    let dst = norm(x.dst ?? x.object ?? x.尾实体 ?? x.宾语);
    if (!src || !rel || !dst) continue;
    if (src === dst) continue;
    if (src.length > 12 || dst.length > 12) continue;
    if (rel.length > 6) continue;
    if (BAD_NAME_RE.test(src) || BAD_NAME_RE.test(dst)) continue;
    // 名字里至少要有汉字或字母：纯数字/纯符号不是实体
    // （注意别用 /^[\s\d\W]+$/——中文在非 u 模式下也算 \W，会把正常人名全过滤掉）
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(src) || !/[\u4e00-\u9fa5A-Za-z]/.test(dst)) continue;
    const key = src + '|' + rel + '|' + dst;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ src, rel, dst });
    if (out.length >= Math.max(1, maxTriples)) break;
  }
  return out;
}

/**
 * 抽一条文本的三元组。永不抛。
 * @returns {Promise<{ok:boolean, triples:Array, reason?:string, ms?:number}>}
 */
export async function extractTriples(text, opt = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, Number(opt.maxInChars) || 200);
  if (t.length < (Number(opt.minTextLen) || 6)) return { ok: false, triples: [], reason: 'too-short' };

  let llmCfg;
  try {
    llmCfg = { ...loadConfig({ dataRoot: opt.dataRoot }), ...(opt.llmCfg || {}) };
  } catch {
    llmCfg = { ...(opt.llmCfg || {}) };
  }
  try {
    const h = await health(llmCfg);
    if (!h || !h.ok || !h.hasModel) return { ok: false, triples: [], reason: 'llm-offline' };
  } catch {
    return { ok: false, triples: [], reason: 'health-throw' };
  }

  const started = Date.now();
  let r;
  try {
    r = await chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `输入：${t}\n输出：` },
      ],
      cfg: llmCfg,
      maxTokens: 220,
      temperature: 0.1,
      timeoutMs: Number(opt.timeoutMs) || DEFAULTS.timeoutMs,
      model: opt.model || undefined,
    });
  } catch (e) {
    return { ok: false, triples: [], reason: 'chat-throw:' + String(e?.message || '').slice(0, 60) };
  }
  const ms = Date.now() - started;
  if (!r || !r.ok || !r.text) return { ok: false, triples: [], reason: 'chat-fail', ms };

  const json = pickJsonArray(r.text);
  if (!json) return { ok: false, triples: [], reason: 'no-json', ms, raw: r.text.slice(0, 120) };
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, triples: [], reason: 'bad-json', ms };
  }
  const triples = tidyTriples(parsed, opt.maxTriples ?? DEFAULTS.maxTriples);
  if (!triples.length) return { ok: false, triples: [], reason: 'empty', ms };
  return { ok: true, triples, ms };
}

/**
 * 批量给某个 scope 补图：挑还没有「模型边」的记忆，逐条抽三元组写入。
 * 任何一步失败都只影响那一条；模型整体离线则立刻收工（不白跑 20 秒）。
 *
 * @returns {Promise<{ok:boolean, scanned:number, picked:number, added:number, superseded:number,
 *                    failed:number, reason?:string, ms:number, samples:Array}>}
 */
export async function enrichScopeGraph(dataRoot, scope, opt = {}) {
  const started = Date.now();
  const cfg = { ...DEFAULTS, ...(opt.cfg || {}), ...opt };
  const res = {
    ok: false, scanned: 0, picked: 0, added: 0, superseded: 0,
    failed: 0, skipped: 0, reason: '', ms: 0, samples: [],
  };
  if (cfg.enabled === false) { res.reason = 'disabled'; return res; }

  const sc = String(scope || '');
  const limit = Math.max(1, Math.min(200, Number(cfg.limit) || DEFAULTS.limit));
  const budget = Math.max(1000, Number(cfg.budgetMs) || DEFAULTS.budgetMs);

  let rows = [];
  try {
    const h = getHandle(dataRoot);
    // 优先补"还没被模型看过"的：模型边一条都没有的记忆
    rows = h.db.prepare(
      `SELECT m.id, m.text FROM mem m
        WHERE m.scope = ?
          AND NOT EXISTS (
            SELECT 1 FROM mem_edge e
             WHERE e.scope = m.scope AND e.mem_id = m.id AND COALESCE(e.src_kind, 'rule') = 'llm')
        ORDER BY m.ts DESC LIMIT ?`,
    ).all(sc, limit);
  } catch (e) {
    res.reason = 'db:' + String(e?.message || '').slice(0, 60);
    return res;
  }
  res.picked = rows.length;
  if (!rows.length) { res.ok = true; res.reason = 'nothing-to-do'; return res; }

  let offline = 0;
  for (const row of rows) {
    if (Date.now() - started > budget) { res.reason = 'budget'; break; }
    res.scanned += 1;
    const r = await extractTriples(memDecrypt(dataRoot, row.text), { ...cfg, dataRoot });
    if (!r.ok) {
      res.failed += 1;
      if (r.reason === 'llm-offline' || r.reason === 'health-throw') {
        offline += 1;
        // 模型离线：这一批没必要继续，直接把控制权还给调用方
        if (offline >= 2) { res.reason = 'llm-offline'; break; }
      }
      continue;
    }
    try {
      const w = addEdges(dataRoot, sc, row.id, r.triples, { srcKind: 'llm' });
      res.added += Number(w.added) || 0;
      res.superseded += Number(w.superseded) || 0;
      if (res.samples.length < 3) {
        res.samples.push({ text: String(memDecrypt(dataRoot, row.text)).slice(0, 24), triples: r.triples });
      }
    } catch {
      res.failed += 1;
    }
  }
  res.ms = Date.now() - started;
  res.ok = res.added > 0 || res.scanned > 0;
  return res;
}

/** 某条关系的当前状态（给面板回答"她现在是谁的群主"） */
export function relationState(dataRoot, scope, src, rel) {
  const hist = edgeHistory(dataRoot, scope, src, rel);
  const live = hist.filter((x) => x.status === 'active');
  return {
    src, rel,
    current: live.length ? live[live.length - 1].dst : '',
    history: hist,
    changed: hist.length > 1,
  };
}

export default { extractTriples, enrichScopeGraph, tidyTriples, pickJsonArray, relationState, DEFAULTS };
