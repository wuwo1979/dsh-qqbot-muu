/**
 * sticker-resolve.mjs — 直接读表情库索引，把「id / 文件名 / 标签」解析成真实文件
 *
 * 为什么不走插件的 StickerStore：
 *   · 插件在启动时把 index.json 读进内存，运行中我们给表情补标签后它看不到；
 *   · 发图失败的根因之一就是模型只吐出裸文件名（c36d2851221a.jpg），
 *     出站侧需要一个「不依赖插件实例」的解析器把它换成绝对路径。
 *
 * 目录契约（与插件一致）：{dataRoot}/表情包/lib/<layer>/<id>.<ext>
 * 索引契约：{dataRoot}/表情包/index.json → { version, items:[{id,layer,ext,tags,desc,descZh,...}] }
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export function stickerDir(dataRoot) {
  return join(String(dataRoot || ''), '表情包');
}

export function indexPathOf(dataRoot) {
  return join(stickerDir(dataRoot), 'index.json');
}

const _cache = new Map(); // indexFile → { mtimeMs, items, byId }

/** 读索引（按 mtime 缓存；坏了返回空，不抛） */
export function loadIndex(dataRoot) {
  const file = indexPathOf(dataRoot);
  if (!existsSync(file)) return { items: [], byId: new Map(), file };
  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { /* ignore */ }
  const hit = _cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  let items = [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    items = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : []);
  } catch { /* 索引坏了就当空库 */ }
  const byId = new Map();
  for (const it of items) if (it && it.id) byId.set(String(it.id), it);
  const rec = { mtimeMs, items, byId, file };
  _cache.set(file, rec);
  return rec;
}

/** 清缓存（刚写完索引时调用） */
export function invalidateIndex(dataRoot) {
  _cache.delete(indexPathOf(dataRoot));
}

/** 条目 → 绝对路径（不检查存在性） */
export function pathOfItem(dataRoot, item) {
  const ext = String(item.ext || 'jpg').replace(/^\./, '');
  return join(stickerDir(dataRoot), 'lib', String(item.layer || 'candidate'), `${item.id}.${ext}`);
}

/** id → 绝对路径；找不到返回 '' */
export function pathOfId(dataRoot, id, layer = '') {
  const rec = loadIndex(dataRoot);
  const it = rec.byId.get(String(id || ''));
  if (!it) return '';
  if (layer && String(it.layer) !== String(layer)) {
    const p = pathOfItem(dataRoot, { ...it, layer });
    return existsSync(p) ? p : '';
  }
  return pathOfItem(dataRoot, it);
}

/** 条目可搜索的文本（标签 + 描述 + 备注） */
export function haystackOf(item) {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  return [item.desc, item.descZh, item.note, ...tags]
    .filter(Boolean).join(' ').trim();
}

/** 2-gram token 化（中文友好；英文按词） */
function tokens(s) {
  const out = [];
  const text = String(s || '').toLowerCase();
  const latin = text.match(/[a-z0-9_]{2,}/g) || [];
  out.push(...latin);
  const cjk = text.replace(/[a-z0-9_\s\p{P}]/gu, '');
  for (let i = 0; i + 1 < cjk.length; i += 1) out.push(cjk.slice(i, i + 2));
  return out;
}

/** 关键词打分（0~1） */
export function lexicalScore(query, item) {
  const q = tokens(query);
  if (!q.length) return 0;
  const h = haystackOf(item).toLowerCase();
  const raw = String(item.id || '') + ' ' + String(item.ext || '');
  if (!h) {
    // 没标签没描述：只能靠 id 命中
    const t = String(query || '').toLowerCase().replace(/\.(jpe?g|png|gif|webp)$/, '');
    return t && (raw.includes(t) || t.includes(String(item.id))) ? 0.35 : 0;
  }
  let hit = 0;
  for (const t of q) if (h.includes(t)) hit += 1;
  return hit / q.length;
}

/**
 * 按 token 解析：绝对路径 / id / id.ext / hash 前缀 / 标签或描述
 * @returns {{ok:boolean,path?:string,item?:object,reason?:string}}
 */
export function resolveToken(dataRoot, token) {
  const raw = String(token || '').trim()
    .replace(/^\[?MEDIA:[^|]*\|/i, '')
    .replace(/\]$/, '')
    .replace(/^["'`“”]+|["'`“”]+$/g, '')
    .trim();
  if (!raw) return { ok: false, reason: '空 token' };
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return existsSync(raw) ? { ok: true, path: raw, item: null } : { ok: false, reason: '文件不存在' };
  }
  if (raw.includes('/') || raw.includes('\\')) {
    const p = join(stickerDir(dataRoot), raw);
    return existsSync(p) ? { ok: true, path: p, item: null } : { ok: false, reason: '相对路径不存在' };
  }
  const rec = loadIndex(dataRoot);
  const bare = raw.replace(/\.(jpe?g|png|gif|webp)$/i, '').toLowerCase();

  // 1) 精确 id / id.ext
  let it = rec.byId.get(bare) || null;
  // 2) hash 前缀（≥8 位）
  if (!it && bare.length >= 8) {
    it = rec.items.find((x) => String(x.hash || '').toLowerCase().startsWith(bare)) || null;
  }
  if (it) {
    const p = pathOfItem(dataRoot, it);
    return existsSync(p) ? { ok: true, path: p, item: it } : { ok: false, reason: '索引有但文件缺失', item: it };
  }
  // 3) 标签/描述完全包含
  const hits = rec.items
    .map((x) => ({ item: x, s: lexicalScore(raw, x) }))
    .filter((x) => x.s >= 0.6)
    .sort((a, b) => b.s - a.s);
  if (hits.length) {
    const p = pathOfItem(dataRoot, hits[0].item);
    if (existsSync(p)) return { ok: true, path: p, item: hits[0].item };
  }
  return { ok: false, reason: 'no-match' };
}

/**
 * 本地检索（表情/描述为主）
 * @param {object} o
 * @param {string} o.dataRoot
 * @param {string} o.query
 * @param {number} [o.limit]
 * @param {(query:string, items:object[])=>Promise<Array<{item:object,score:number}>>} [o.semantic]
 *   可选：调用方注入 embedding 排序（本地模型为主），拿不到就纯关键词
 * @param {number} [o.semanticMin] 语义结果的准入分（默认 0.5；向量总是有分数，
 *   不设阈值会把风马牛不相及的图也当成候选）
 */
export async function search(dataRoot, query, { limit = 8, semantic = null, layer = '', semanticMin = 0.5 } = {}) {
  const rec = loadIndex(dataRoot);
  const pool = rec.items.filter((x) => !layer || String(x.layer) === String(layer));
  const scored = [];
  for (const it of pool) {
    if (it && it.removed) continue;
    const s = lexicalScore(query, it);
    if (s > 0) scored.push({ item: it, score: s, path: pathOfItem(dataRoot, it) });
  }
  scored.sort((a, b) => b.score - a.score);
  if (semantic) {
    try {
      const sem = await semantic(query, pool);
      if (Array.isArray(sem) && sem.length) {
        const merged = new Map();
        for (const r of scored) merged.set(r.item.id, r);
        for (const r of sem) {
          if (!r || !r.item) continue;
          if (Number(r.score) < Number(semanticMin || 0.5)) continue;
          const old = merged.get(r.item.id);
          const score = Math.max(0.001, Number(r.score) || 0);
          merged.set(r.item.id, {
            item: r.item,
            score: old ? old.score * 0.5 + score : score,
            path: pathOfItem(dataRoot, r.item),
          });
        }
        const out = [...merged.values()]
          .filter((x) => existsSync(x.path))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(1, Number(limit) || 8));
        return out;
      }
    } catch { /* 语义失败就用关键词结果 */ }
  }
  return scored.filter((x) => existsSync(x.path)).slice(0, Math.max(1, Number(limit) || 8));
}

export default { stickerDir, loadIndex, pathOfItem, pathOfId, resolveToken, search, haystackOf };
