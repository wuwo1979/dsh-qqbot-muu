/**
 * outbound/ad-sticker-auto.mjs — 主动配表情包（2026-10-24）
 *
 * 背景：`sticker_auto` 工具只写了开关和隔离名单，真正干活的出站扩展
 *   `outbound/sticker-semantic.mjs` 一直不存在 —— 所以"自动配图"从未生效。
 *
 * 本扩展补上这一环：
 *   · 在出站文本（phase=send, kind=text）末尾追加一张与正文语义最接近的表情；
 *   · 检索以本地向量为主（embedder 的 local ONNX，失败才退关键词），
 *     结果必须过准入分，宁可不发也不乱配；
 *   · 遵守 sticker_auto 的两个文件：总开关 auto-sticker.json + 隔离名单
 *     sticker-semantic-scope.json（不存在 = whitelist 空名单 = 谁都不发）；
 *   · 限流：最小间隔、每小时上限、概率、最近用过的去重；
 *   · 所有决定写入 .qqbot/auto-sticker-log.jsonl，方便回看"为什么没发"。
 *
 * 排序：ac-media-fix 之后（文件名 ad-），它追加的 [MEDIA:image|…] 是标准写法，
 *       不会再被 media-fix 改坏。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIndex, pathOfItem, haystackOf, lexicalScore } from '../lib/sticker-resolve.mjs';
import { embedTexts, loadRetrieval, modelTagOf } from '../lib/embedder.mjs';

export const name = 'sticker-auto';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  minGapMs: 8 * 60 * 1000,
  hourlyMax: 6,
  probability: 0.5,
  // [qqbot-mod] minscore-tune2 2026-10-28：0.42 实测会乱配——「收到，马上处理」
  //   配到「嫖娼被抓获」(0.474)、「无语死了」配到「免死金牌」(0.424)。
  //   好匹配（不想写代码 0.632 / 我最强 0.470）与乱配在 0.42~0.5 区间重叠，
  //   自动路径宁可错过也不能乱发，抬到 0.5；表达欲强的场合交给主脑主动调
  //   sticker_send（worldbook 已改教它用这个工具）。
  minScore: 0.5,
  lexicalMin: 0.4,
  recentKeep: 12,
  maxQueryChars: 200,
  timeoutMs: 2500,
};

export function dataRootOf(ctx) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  if (ctx && typeof ctx.dataRoot === 'string' && ctx.dataRoot) return ctx.dataRoot;
  return dirname(dirname(HERE));
}

function dataDir(root) {
  return join(String(root || ''), '.qqbot-extensions', 'data');
}
export function stateFile(root) { return join(dataDir(root), 'auto-sticker.json'); }
export function scopeFile(root) { return join(dataDir(root), 'sticker-semantic-scope.json'); }
export function runtimeFile(root) { return join(dataDir(root), 'auto-sticker-state.json'); }

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    // [qqbot-mod] bom-tolerant 2026-10-27：auto-sticker.json / sticker-semantic-scope.json 实测都带 BOM，
    //   不剥掉的话 JSON.parse 直接抛 → scope 被当成空名单 → 永远不发且不留日志（这就是"从不发表情包"的真因）
    return JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch { return null; }
}

function writeJson(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/** 总开关 + 可选调参（文件不存在 = 开，与 sticker_auto 一致） */
export function loadOptions(root) {
  const j = readJson(stateFile(root)) || {};
  const opt = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(j[k]);
    if (Number.isFinite(v)) opt[k] = v;
  }
  return {
    enabled: typeof j.enabled === 'boolean' ? j.enabled : true,
    exists: existsSync(stateFile(root)),
    ...opt,
  };
}

/** 隔离名单（不存在 ⇒ whitelist + 空名单 ⇒ 谁都不发） */
export function loadScope(root) {
  const j = readJson(scopeFile(root));
  return {
    exists: !!j,
    mode: j?.mode === 'all' ? 'all' : 'whitelist',
    targets: (Array.isArray(j?.targets) ? j.targets : [])
      .map((t) => (typeof t === 'string' ? { key: t } : { key: String(t?.key || '') }))
      .map((t) => t.key.trim())
      .filter(Boolean),
  };
}

/** 当前出站目标是否被允许（whitelist 认 `group:id` / `c2c:id`，也认裸 id） */
export function targetAllowed(scope, target = {}) {
  const s = String(target.scope || '');
  const id = String(target.targetId ?? target.peerId ?? '');
  if (!id) return false;
  if (scope.mode === 'all') return true;
  const full = s ? `${s}:${id}` : id;
  return scope.targets.includes(full) || scope.targets.includes(id);
}

/** 限流 + 最近去重状态（每进程一份，落盘共享） */
export function loadRuntime(root) {
  const j = readJson(runtimeFile(root)) || {};
  return {
    lastAt: Number(j.lastAt) || 0,
    hourStart: Number(j.hourStart) || 0,
    hourCount: Number(j.hourCount) || 0,
    recent: Array.isArray(j.recent) ? j.recent.map(String).slice(-40) : [],
  };
}

export function rateAllowed(rt, opt, now = Date.now()) {
  if (now - rt.lastAt < Math.max(0, opt.minGapMs)) return { ok: false, why: 'gap' };
  const hour = 3600_000;
  if (now - rt.hourStart > hour) return { ok: true, hourCount: 1, hourStart: now };
  if (rt.hourCount >= Math.max(1, opt.hourlyMax)) return { ok: false, why: 'hourly' };
  return { ok: true, hourCount: rt.hourCount + 1, hourStart: rt.hourStart || now };
}

function appendLog(root, rec) {
  try {
    const dir = join(String(root || ''), '.qqbot');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'auto-sticker-log.jsonl'), JSON.stringify({ ts: Date.now(), ...rec }) + '\n', 'utf8');
  } catch { /* 日志失败不影响发消息 */ }
}

// 表情向量缓存（按 index.json 的 mtime + 模型名失效；一个进程内只算一次）
const docCache = new Map();

async function docsWithVectors(root, items, cfg) {
  const rec = loadIndex(root);
  const model = modelTagOf(cfg.stickerEmbeddingModel || cfg.embeddingModel);
  const key = rec.file + '|' + model;
  const hit = docCache.get(key);
  if (hit && hit.mtimeMs === rec.mtimeMs && hit.vecs.length === items.length) return hit.vecs;
  const texts = items.map((it) => haystackOf(it) || String(it.id || ''));
  const r = await embedTexts(root, texts, { role: 'sticker', kind: 'passage', cfg });
  if (!r.vecs || r.vecs.length !== items.length || r.mode === 'lexical') return null;
  docCache.set(key, { mtimeMs: rec.mtimeMs, vecs: r.vecs, mode: r.mode, model: r.model });
  return r.vecs;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// 自动路径的黑名单标签：命中就不自动发（主人私下的 sticker_send 不受限）
// [qqbot-mod] risky-tags 2026-10-28：实测「收到，马上处理」被语义配到「嫖娼被抓获」，
//   这类图发进群是事故，直接按标签拦截。
const AUTO_BLOCK_TAGS = ['嫖娼', '抓获', '警察', '通报', '暴力', '血'];

function isBlocked(item) {
  const hay = String(item.desc || '') + ' ' + String(item.descZh || '') + ' ' + (Array.isArray(item.tags) ? item.tags.join(' ') : '');
  return AUTO_BLOCK_TAGS.some((t) => hay.includes(t));
}

/**
 * 选一张表情。语义优先（本地向量），不足再退回关键词；都过不了准入分就返回 null。
 * @returns {Promise<{ok:true,item:object,path:string,score:number,mode:string}|{ok:false,reason:string}>}
 */
export async function choose(root, query, { exclude = [], opt = DEFAULTS, cfg = null } = {}) {
  const q = String(query || '').replace(/\[MEDIA:[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, Math.max(20, opt.maxQueryChars));
  if (q.length < 4) return { ok: false, reason: 'query-too-short' };
  const rec = loadIndex(root);
  // [qqbot-mod] layer-guard 2026-10-28：trash/negative 层没有 removed 标记但文件还在，
  //   不显式排除的话自动路径会把回收站的图捞出来发群。
  const tagged = rec.items.filter((it) => it && !it.removed && it.layer !== 'trash' && it.layer !== 'negative' && !isBlocked(it) && haystackOf(it));
  if (!tagged.length && !rec.items.length) return { ok: false, reason: 'empty-library' };
  if (!tagged.length) return { ok: false, reason: 'no-tags' };

  const c = cfg || loadRetrieval(root);
  const vecs = await docsWithVectors(root, tagged, { ...c, timeoutMs: opt.timeoutMs });
  let best = null;
  let mode = 'lexical';
  if (vecs) {
    const qr = await embedTexts(root, [q], { role: 'sticker', kind: 'query', cfg: { ...c, timeoutMs: opt.timeoutMs } });
    if (qr.mode !== 'lexical' && qr.vecs[0]) {
      mode = 'semantic';
      for (let i = 0; i < tagged.length; i += 1) {
        const score = cosine(qr.vecs[0], vecs[i]);
        if (score >= opt.minScore && (!best || score > best.score)) best = { item: tagged[i], score };
      }
    }
  }
  if (!best) {
    // 兜底：标签原文包含查询里的词（高置信才收，宁可不发也不乱配）
    for (const it of tagged) {
      const score = lexicalScore(q, it);
      if (score >= opt.lexicalMin && (!best || score > best.score)) best = { item: it, score };
    }
  }
  // [qqbot-mod] tag-hit 2026-10-28：短情绪句（「无语死了」「好委屈哦」）的向量分
  //   天然在 0.42~0.48 徘徊，过不了 0.5 的准入线；但句子里字面含标签词（无语/委屈）
  //   就是强证据——只要查询原文包含某张图的完整标签（2~6 字），直接给 0.55 起步。
  //   标签词直击的精度远高于向量，语义更好的结果（>0.55）依然优先。
  if (q.length >= 2) {
    for (const it of tagged) {
      const tags = Array.isArray(it.tags) ? it.tags : [];
      for (const t of tags) {
        const tag = String(t || '').trim();
        if (tag.length >= 2 && tag.length <= 6 && q.includes(tag)) {
          const score = 0.55 + Math.min(0.05, tag.length * 0.01);
          if (!best || score > best.score) best = { item: it, score, mode: 'tag-hit' };
          break;
        }
      }
    }
  }
  if (!best) return { ok: false, reason: 'no-match' };
  const id = String(best.item.id || '');
  if (exclude.includes(id)) return { ok: false, reason: 'recent' };
  const p = pathOfItem(root, best.item);
  if (!existsSync(p)) return { ok: false, reason: 'file-missing' };
  return { ok: true, item: best.item, path: p, score: best.score, mode: best.mode || mode };
}

function summaryOf(text, n = 60) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export async function onOutbound(ctx, next) {
  if (!ctx || ctx.phase !== 'send' || ctx.kind !== 'text') return next();
  const text = String(ctx.text || '');
  if (!text || text.length < 2) return next();
  if (/\[MEDIA:/i.test(text)) return next();           // 已经配了图
  if (/^\s*[\/!]/.test(text)) return next();            // 命令回执
  if (/^\[[^\]]*\]$/.test(text.trim())) return next(); // 纯占位符

  try {
    const root = dataRootOf(ctx);
    const opt = loadOptions(root);
    if (!opt.enabled) return next();
    const scope = loadScope(root);
    if (!targetAllowed(scope, ctx.target || {})) return next();

    const rt = loadRuntime(root);
    const rate = rateAllowed(rt, opt);
    if (!rate.ok) {
      appendLog(root, { result: 'skip', why: rate.why, scope: ctx?.target?.scope || '' });
      return next();
    }
    if (Math.random() > Math.max(0, Math.min(1, opt.probability))) {
      appendLog(root, { result: 'skip', why: 'probability', scope: ctx?.target?.scope || '' });
      return next();
    }

    const picked = await choose(root, text, { exclude: rt.recent, opt });
    if (!picked.ok) {
      appendLog(root, { result: 'skip', why: picked.reason, scope: ctx?.target?.scope || '' });
      return next();
    }

    const nextText = text.replace(/\s+$/, '') + '\n[MEDIA:image|' + picked.path.replace(/\\/g, '/') + ']';
    try { ctx.rewrite(nextText); } catch { /* ignore */ }
    try { ctx.note && ctx.note(`sticker-auto: ${picked.item.id} (${picked.mode} ${picked.score.toFixed(2)})`); } catch { /* ignore */ }

    const recent = [...rt.recent, String(picked.item.id)].slice(-Math.max(1, opt.recentKeep));
    const saved = writeJson(runtimeFile(root), { lastAt: Date.now(), hourStart: rate.hourStart, hourCount: rate.hourCount, recent, updatedAt: Date.now() });
    appendLog(root, {
      result: 'sent', id: picked.item.id, score: Number(picked.score.toFixed(3)), mode: picked.mode,
      scope: ctx?.target?.scope || '', query: summaryOf(text), persisted: saved,
    });
  } catch (e) {
    appendLog(dataRootOf(ctx), { result: 'error', error: e instanceof Error ? e.message : String(e) });
  }

  return next();
}

export default onOutbound;
