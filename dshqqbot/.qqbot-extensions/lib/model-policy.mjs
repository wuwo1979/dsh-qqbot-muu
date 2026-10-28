/**
 * model-policy.mjs — 显存/模型常驻策略（2026-10-26）
 *
 * 主人的要求：
 *   "聊天模型不要常驻，有需求再唤醒；常驻时检测是否有聊天 / 特别关心的；
 *    330MB 的语义模型也一样，需要时再唤醒。"
 *
 * 于是把「谁在用模型 / 现在要不要让它挂在显存里」收成一处：
 *
 *   1. 默认按需：调用方每次真用完都 `noteUse()`，然后 keep_alive 给 0
 *      （生成完这一轮立刻从显存里走，占显存 0 秒）
 *   2. 需要连续几轮的场景（游戏、视频配音）用 `pin(reason, ttlMs)` 钉住，
 *      钉住期间 keep_alive 给一个较长值，让多轮之间不必冷启
 *   3. 空闲看门狗每 20 秒看一眼：没有 pin、且超过 idleUnloadSec 没动静
 *      → 把 /api/ps 里挂着的模型全部 `keep_alive:0` 卸掉
 *
 * 为什么必须钉住：qwen2.5:7b 冷启实测 7.3s（记忆代理里甚至 17s+），
 * 一局海龟汤要问十几次，每次都冷启会让游戏没法玩。
 *
 * 只用 HTTP（Node 24 自带 fetch），失败一律静默 —— 显存策略坏了不能拖垮聊天。
 */

const DEFAULT_BASE = 'http://127.0.0.1:11434';

export const POLICY_DEFAULTS = {
  enabled: true,
  baseUrl: DEFAULT_BASE,
  /** 没有任何 pin 时，闲置多久卸载（秒）。0 = 生成完立刻卸 */
  idleUnloadSec: 60,
  /** 钉住时的 keep_alive 值（Ollama 语法：'10m' / '900s' / -1 表示永久） */
  pinnedKeepAlive: '10m',
  /** 未钉住时的 keep_alive（'0' = 生成完即卸载） */
  looseKeepAlive: '0',
  /** 看门狗轮询间隔（毫秒） */
  watchMs: 20000,
};

const state = {
  /** reason -> { until, at, note } */
  pins: new Map(),
  /** 最近一次"有人在用模型"的时间戳 */
  lastUse: 0,
  lastUseKind: '',
  lastUseModel: '',
  /** 看门狗：累计卸载次数（给面板/日志看） */
  unloads: 0,
  lastUnloadAt: 0,
  lastUnloadModels: [],
  /** 最近一次错误，仅供诊断 */
  lastError: '',
  watcher: null,
};

function baseUrlOf(baseUrl) {
  return String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

function nowMs() {
  return Date.now();
}

/** 清掉过期 pin */
function prunepins() {
  const t = nowMs();
  for (const [k, v] of state.pins) {
    if (!v || (v.until > 0 && v.until <= t)) state.pins.delete(k);
  }
}

/** 现在有没有活跃 pin */
export function hasPin() {
  prunepins();
  return state.pins.size > 0;
}

/** 钉住模型（游戏开局 / 视频配音这类连续用的场景） */
export function pin(reason, ttlMs = 10 * 60 * 1000, note = '') {
  const key = String(reason || 'default');
  const ttl = Number(ttlMs) || 0;
  state.pins.set(key, { until: ttl > 0 ? nowMs() + ttl : 0, at: nowMs(), note: String(note || '') });
  ensureWatcher();
  return listPins();
}

/** 解除 pin（游戏收摊 / 配音结束） */
export function unpin(reason) {
  const key = String(reason || 'default');
  state.pins.delete(key);
  return listPins();
}

/** 当前 pin 列表（诊断用） */
export function listPins() {
  prunepins();
  return [...state.pins.entries()].map(([reason, v]) => ({
    reason,
    note: v.note,
    ageMs: nowMs() - v.at,
    remainMs: v.until ? Math.max(0, v.until - nowMs()) : -1,
  }));
}

/** 记一次"有人在用模型"（调用方每次真用完都该调） */
export function noteUse(kind = 'chat', model = '') {
  state.lastUse = nowMs();
  state.lastUseKind = String(kind || '');
  state.lastUseModel = String(model || '');
  ensureWatcher();
}

/** 本轮该给 Ollama 的 keep_alive 值 */
export function keepAliveFor(cfg = {}) {
  const p = { ...POLICY_DEFAULTS, ...(cfg && cfg.residency ? cfg.residency : {}) };
  if (p.enabled === false) return '30m';
  return hasPin() ? String(p.pinnedKeepAlive || '10m') : String(p.looseKeepAlive || '0');
}

/** GET /api/ps：当前挂在显存里的模型 */
export async function ps(baseUrl, timeoutMs = 1500) {
  const url = baseUrlOf(baseUrl) + '/api/ps';
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, models: [], error: 'HTTP ' + res.status };
    const j = await res.json();
    const models = (Array.isArray(j?.models) ? j.models : []).map((m) => ({
      name: String(m?.name || m?.model || ''),
      size: Number(m?.size || 0),
      sizeVram: Number(m?.size_vram || 0),
    }));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** 把指定模型（或全部挂着的模型）从显存里卸掉 */
export async function unload({ baseUrl, models, timeoutMs = 4000 } = {}) {
  const base = baseUrlOf(baseUrl);
  let targets = Array.isArray(models) ? models.filter(Boolean).map(String) : [];
  if (!targets.length) {
    const r = await ps(base);
    targets = r.models.map((m) => m.name).filter(Boolean);
  }
  const done = [];
  for (const m of targets) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(base + '/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: m, keep_alive: 0 }),
        signal: ac.signal,
      });
      clearTimeout(t);
      if (res.ok) done.push(m);
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
    }
  }
  if (done.length) {
    state.unloads += 1;
    state.lastUnloadAt = nowMs();
    state.lastUnloadModels = done;
  }
  return { ok: done.length > 0, unloaded: done };
}

/** 把模型叫醒（一条极短的 generate，只为了触发加载） */
export async function ensureLoaded({ baseUrl, model, timeoutMs = 90000 } = {}) {
  const base = baseUrlOf(baseUrl);
  const m = String(model || '').trim();
  if (!m) return { ok: false, error: 'no-model' };
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(base + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: m, prompt: '咕', stream: false, keep_alive: '10m', options: { num_predict: 1 } }),
      signal: ac.signal,
    });
    clearTimeout(t);
    return { ok: res.ok, error: res.ok ? '' : 'HTTP ' + res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 看门狗：没有 pin 且久没人用 → 全卸 */
async function tick(opts = {}) {
  if (hasPin()) return;
  const p = { ...POLICY_DEFAULTS, ...(opts.policy || {}) };
  if (p.enabled === false) return;
  const idleMs = Math.max(0, Number(p.idleUnloadSec) * 1000);
  const since = nowMs() - (state.lastUse || 0);
  if (state.lastUse && since < idleMs) return;
  const cur = await ps(p.baseUrl);
  if (!cur.ok || !cur.models.length) return;
  await unload({ baseUrl: p.baseUrl });
}

/** 确保看门狗只起一次（unref，不阻止进程退出） */
export function ensureWatcher(getPolicy) {
  if (state.watcher) return state.watcher;
  const p = typeof getPolicy === 'function' ? getPolicy() : null;
  const every = Math.max(5000, Number((p && p.watchMs) || POLICY_DEFAULTS.watchMs));
  try {
    state.watcher = setInterval(() => {
      let policy = null;
      try { policy = typeof getPolicy === 'function' ? getPolicy() : null; } catch { /* 忽略 */ }
      tick({ policy }).catch(() => { /* 静默 */ });
    }, every);
    if (typeof state.watcher.unref === 'function') state.watcher.unref();
  } catch {
    state.watcher = null;
  }
  return state.watcher;
}

/** 停掉看门狗（测试用） */
export function stopWatcher() {
  if (state.watcher) {
    try { clearInterval(state.watcher); } catch { /* 忽略 */ }
    state.watcher = null;
  }
}

/** 给面板/工具看的状态快照 */
export async function snapshot(baseUrl) {
  const cur = await ps(baseUrl);
  return {
    pins: listPins(),
    idleSec: Math.round((nowMs() - (state.lastUse || 0)) / 1000),
    lastUseKind: state.lastUseKind,
    lastUseModel: state.lastUseModel,
    unloads: state.unloads,
    lastUnloadAt: state.lastUnloadAt,
    lastUnloadModels: state.lastUnloadModels,
    loaded: cur.models,
    error: state.lastError,
  };
}
