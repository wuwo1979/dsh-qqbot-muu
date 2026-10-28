/**
 * embedder.mjs — 记忆 / 表情检索的统一向量入口（本地优先，可切 Ollama）
 *
 * 用户 2026-10-23：给负责检索记忆的加个模型选择；图片检索也是，应以本地为主。
 *
 * 解析顺序：
 *   memory-config.json →
 *     retrieval.embeddingModel        记忆检索（'local' | 'ollama:nomic-embed-text'）
 *     retrieval.stickerEmbeddingModel 表情检索（缺省跟随 embeddingModel）
 *
 * 'local' = 插件自带的 ONNX bge-small-zh（零依赖、离线；插件升级不覆盖本文件）；
 * 'ollama:<name>' = 本机 Ollama /api/embed（nomic-embed-text / bge-m3 等）。
 * 模型拿不到时统一退化成 256 维字符 n-gram，保证召回永远有结果。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPluginDir } from './plugin-dir.mjs';
import { noteUse } from './model-policy.mjs';

export const EMBED_DEFAULTS = {
  embeddingModel: 'local',
  stickerEmbeddingModel: '',
  ollamaBase: 'http://127.0.0.1:11434',
  timeoutMs: 20000,
  batch: 16,
};

/** 找真正在跑的插件目录（桌面端 .generations/live 优先；QQBOT_PLUGIN_DIR 可覆盖） */
export function pluginDir() {
  const found = findPluginDir();
  if (found) return found;
  const envHome = String(process.env.DSH_HOME || '').trim();
  const cands = [
    envHome && join(envHome, 'profiles', 'web', 'node_modules', '@zaofan', 'dsh-qqbot'),
    'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/web/node_modules/@zaofan/dsh-qqbot',
    'C:/Users/Administrator/.dsh/profiles/web/node_modules/@zaofan/dsh-qqbot',
  ].filter(Boolean);
  return cands.find((p) => existsSync(join(p, 'dist', 'features', 'local-embed.js'))) || cands[1];
}

/** 读 retrieval 配置（独立读文件，避免与 memory.mjs 循环依赖） */
export function loadRetrieval(dataRoot) {
  let cfg = {};
  try {
    const p = join(String(dataRoot || ''), '.qqbot-extensions', 'memory-config.json');
    if (existsSync(p)) cfg = JSON.parse(readFileSync(p, 'utf8')) || {};
  } catch { /* 配置坏了用默认 */ }
  const r = (cfg && cfg.retrieval) || {};
  return {
    ...EMBED_DEFAULTS,
    ...r,
    embeddingModel: String(r.embeddingModel || EMBED_DEFAULTS.embeddingModel),
    stickerEmbeddingModel: String(r.stickerEmbeddingModel || r.embeddingModel || EMBED_DEFAULTS.embeddingModel),
  };
}

/** 模型标识（用于缓存/重建判断）：local → onnx:bge-small-zh */
export function modelTagOf(name) {
  const s = String(name || 'local').trim();
  if (!s || s === 'local') return 'onnx:bge-small-zh';
  if (s.startsWith('ollama:')) return s;
  return 'ollama:' + s;
}

// ── 本地 ONNX（插件自带）────────────────────────────────────────────────
let _localPromise = null;

function getLocal() {
  if (!_localPromise) {
    _localPromise = (async () => {
      try {
        const dir = pluginDir();
        const mod = await import('file:///' + String(dir).replace(/\\/g, '/') + '/dist/features/local-embed.js');
        const emb = mod.createLocalEmbedder({ modelDir: '', logger: undefined });
        const probe = await emb.embedQuery('测试');
        if (!Array.isArray(probe) || !probe.length) throw new Error('local embed probe failed');
        return emb;
      } catch { return null; }
    })();
  }
  return _localPromise;
}

// ── Ollama ──────────────────────────────────────────────────────────────
const _ollamaWarned = new Set();

async function ollamaEmbed(base, model, input, timeoutMs) {
  const url = String(base || EMBED_DEFAULTS.ollamaBase).replace(/\/+$/, '') + '/api/embed';
  const ctrl = new AbortController();
  const t = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, Math.max(1000, Number(timeoutMs) || 20000));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // ★ 2026-10-26：语义模型（nomic-embed-text ~274MB，主人说的"330MB 那个"）也按需唤醒，
      //   每次用完立刻 keep_alive:0 卸掉，不在显存里常驻。
      body: JSON.stringify({ model, input, keep_alive: 0 }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const arr = Array.isArray(j?.embeddings) ? j.embeddings : null;
    if (!arr || !arr.length) throw new Error('no embeddings');
    try { noteUse('embed', model); } catch { /* 策略模块坏了不影响检索 */ }
    return arr;
  } finally {
    clearTimeout(t);
  }
}

/** 字符 n-gram 兜底（与 memory-core 同实现，256 维） */
export function lexicalVec(text, dims = 256) {
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

/**
 * 批量算向量。
 * @param {string} dataRoot
 * @param {string[]} texts
 * @param {object} [o]
 * @param {'memory'|'sticker'} [o.role]
 * @param {'query'|'passage'} [o.kind]
 * @returns {Promise<{vecs:number[][], model:string, mode:'local'|'ollama'|'lexical', error:string}>}
 */
export async function embedTexts(dataRoot, texts, { role = 'memory', kind = 'passage', cfg = null } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
  if (!list.length) return { vecs: [], model: '', mode: 'local', error: '' };
  const c = cfg || loadRetrieval(dataRoot);
  const raw = role === 'sticker' ? c.stickerEmbeddingModel : c.embeddingModel;
  const model = modelTagOf(raw);

  if (model.startsWith('ollama:')) {
    const name = model.slice('ollama:'.length);
    try {
      const vecs = await ollamaEmbed(c.ollamaBase, name, list, c.timeoutMs);
      if (vecs.length === list.length && Array.isArray(vecs[0])) {
        return { vecs, model, mode: 'ollama', error: '' };
      }
      throw new Error('返回数量不匹配');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!_ollamaWarned.has(model)) {
        _ollamaWarned.add(model);
        try { console.warn(`[embedder] ${model} 不可用，临时回退本地/词频：${msg}`); } catch { /* ignore */ }
      }
    }
  }

  const local = await getLocal();
  if (local) {
    try {
      const vecs = kind === 'query'
        ? await Promise.all(list.map((t) => local.embedQuery(t)))
        : await local.embedPassages(list);
      if (Array.isArray(vecs) && vecs.length === list.length && Array.isArray(vecs[0])) {
        return { vecs, model: 'onnx:bge-small-zh', mode: 'local', error: '' };
      }
      throw new Error('local 返回异常');
    } catch { /* 落到词频 */ }
  }
  return { vecs: list.map((t) => lexicalVec(t)), model: 'lexical:ngram256', mode: 'lexical', error: 'embeddings unavailable' };
}

/**
 * 给一组条目做语义排序（表情检索用）。失败返回 null，让调用方退回关键词。
 * @returns {Promise<Array<{item:object, score:number}>|null>}
 */
export async function rankItems(dataRoot, query, items, { role = 'sticker', textOf } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!query || !list.length) return null;
  const text = typeof textOf === 'function' ? textOf : (it) => String(it?.desc || it?.text || '');
  const c = loadRetrieval(dataRoot);
  const q = await embedTexts(dataRoot, [query], { role, kind: 'query', cfg: c });
  if (q.mode === 'lexical') return null;
  const docs = list.map((it) => text(it));
  const d = await embedTexts(dataRoot, docs, { role, kind: 'passage', cfg: c });
  if (d.mode === 'lexical' || d.vecs.length !== list.length) return null;
  const qv = q.vecs[0];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const v = d.vecs[i];
    if (!Array.isArray(v) || v.length !== qv.length) continue;
    let dot = 0; let na = 0; let nb = 0;
    for (let k = 0; k < v.length; k += 1) { dot += qv[k] * v[k]; na += qv[k] * qv[k]; nb += v[k] * v[k]; }
    const score = na && nb ? dot / Math.sqrt(na * nb) : 0;
    out.push({ item: list[i], score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 健康检查：当前每个角色的模型是否可用（给浮窗模型页显示） */
export async function health(dataRoot) {
  const c = loadRetrieval(dataRoot);
  const local = await getLocal();
  const out = {
    ok: true,
    local: { available: !!local, model: 'onnx:bge-small-zh' },
    retrieval: c,
    embedding: null,
    sticker: null,
    ollamaModels: [],
  };
  try {
    const res = await fetch(String(c.ollamaBase).replace(/\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = await res.json();
      out.ollamaModels = (Array.isArray(j?.models) ? j.models : []).map((m) => String(m?.name || '')).filter(Boolean);
    }
  } catch { /* Ollama 没开 */ }
  try { out.embedding = await embedTexts(dataRoot, ['健康检查'], { role: 'memory', kind: 'query', cfg: c }); } catch { /* ignore */ }
  try { out.sticker = await embedTexts(dataRoot, ['无语'], { role: 'sticker', kind: 'query', cfg: c }); } catch { /* ignore */ }
  return out;
}

export default { embedTexts, rankItems, loadRetrieval, modelTagOf, pluginDir, health };
