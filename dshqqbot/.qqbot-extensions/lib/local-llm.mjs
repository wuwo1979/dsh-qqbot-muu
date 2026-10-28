/**
 * local-llm.mjs — 本地小模型（Ollama）客户端
 *
 * 为什么要有这一层：
 *   "哈哈哈"、"在吗"、"鲸鲸" 这种消息走云端大模型是纯浪费（一次几百~上千 token）。
 *   本机跑一个 0.5B 的小模型，这类消息直接本地出话，**云端 token = 0**，
 *   而且延迟 200~600ms，比等云快得多。
 *
 * 设计原则（和记忆库一致）：
 *   · 永不抛异常，失败一律返回 { ok:false, error }，调用方照常走云端；
 *   · 服务没起来 / 模型没拉 / 超时 —— 全部静默降级，不影响正常聊天；
 *   · 只要 HTTP，不需要装任何 npm 依赖（Node 24 自带 fetch）。
 *
 * 配置：{dataRoot}/.qqbot-extensions/local-llm-config.json
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { keepAliveFor, noteUse, ensureWatcher, snapshot as policySnapshot } from './model-policy.mjs';

export const CONFIG_NAME = 'local-llm-config.json';

export const DEFAULTS = {
  enabled: true,
  // Ollama 默认监听；若用户改了 OLLAMA_HOST 需要同步改这里
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5:7b',
  // 单次生成超时（实测 qwen2.5:7b 热态 0.27s、冷启 7.3s，留足余量）
  timeoutMs: 12000,
  // 生成上限：小蓝的回复本来就 ≤50 字，48 token 够了（中文约 1 字 ≈ 1 token）
  maxTokens: 48,
  // 模型常驻时长（Ollama keep_alive）。
  // 2026-10-26 改口：主人要求"不要常驻，有需求再唤醒" ⇒ 这里只是兜底，
  // 真正的取值走 residency（见下）与 lib/model-policy.mjs：
  //   没有被 pin（游戏/配音）时 = '0'（这一轮生成完就离开显存）
  //   被 pin 时 = '10m'（多轮之间不冷启）
  keepAlive: '0',
  /** 显存/常驻策略（详见 lib/model-policy.mjs） */
  residency: {
    enabled: true,
    idleUnloadSec: 60,       // 没 pin 且 60 秒没人用就全卸
    pinnedKeepAlive: '10m',  // 游戏/配音期间钉住
    looseKeepAlive: '0',     // 平时生成完即卸
    watchMs: 20000,
  },
  temperature: 0.7,
  topP: 0.9,
  // 健康检查结果缓存多久（避免每条消息都探测一次）
  healthTtlMs: 5000,
  // ── 下面这些是「入站代答」的策略参数（local-answer 用）──
  /**
   * 谁来回这条消息（★ 面板里那个下拉就是它）：
   *   off    全交云端（本地只当语义检索用）
   *   simple 只有"简单消息"本地答（默认；碎句/打招呼/表情）
   *   chat   简单 + 闲聊也本地答（更省 token，废话精度略降）
   *   all    尽量本地（除任务型/长文，全本地）
   * 判据见 local-answer.mjs 的 worthLocal()。
   */
  whoAnswers: 'simple',
  maxInputChars: 80,      // 超过这么多字就不给本地模型（长文它会胡说）
  maxReplyChars: 60,      // 本地回复截断上限（人设 ≤50 字/3 句，留余量）
  shortChatChars: 12,     // ≤ 这个字数的非任务句也算"简单消息"
  minIntervalMs: 6000,    // 两次本地代答的最小间隔
  maxPerWindow: 6,        // 每窗口最多几条
  windowMs: 60000,
  allowUnmentioned: false, // 群里没 @ 她要不要也抢答
  unmentionedProb: 0.25,   // allowUnmentioned=true 时，没 @ 她的消息按这个概率接
  ownerToo: true,          // 主人的消息要不要也本地代答（只限简单话；复杂活照样交云端）
  /**
   * "简单话本地先接"的开关（2026-10-23 晚改口）：
   *   主人实测"私聊里一句你好也调大模型太浪费" ⇒ 私聊 / 被 @ 的**简单话**也归本地，
   *   摘得掉（annihilate 成功，含 ownerAck）就省下一整轮云 token，摘不掉自动回落云端。
   *   c2cLocal=false / onlyUnmentioned=true 仍然可用，含义变成"连简单话也不许本地抢"。
   */
  onlyUnmentioned: false,
  c2cLocal: true,
  /**
   * 单脑仲裁窗口（毫秒）：云端在这个窗口内被放行过 / 刚说完，本地就不插嘴。
   * 0 = 关闭仲裁（想复现"左右脑互搏"时用）。
   * 12 秒的依据：云端一回合（含工具调用）通常 3~10 秒，窗口盖住一个回合即可。
   */
  brainHoldMs: 12000,
  systemPrompt: '',        // 空 = 用 local-answer 内置人设
};

/** 解析数据根（环境变量优先，便于测试隔离） */
export function dataRootOf(cfg) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  return (cfg && cfg.dataRoot) || 'F:/qqbot/dshqqbot';
}

export function configPath(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot-extensions', CONFIG_NAME);
}

/** 读配置：文件不存在就用默认值（不写盘），字段缺失用默认值补齐 */
export function loadConfig(dataRoot) {
  const def = { ...DEFAULTS, dataRoot };
  try {
    const p = configPath(dataRoot);
    if (!existsSync(p)) return def;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return def;
    // ★ 这里踩过坑：原来只拷贝 DEFAULTS 里有的键 ⇒ 配置文件里那些"策略参数"
    //   （minIntervalMs / maxPerWindow / allowUnmentioned / systemPrompt …）
    //   被静默丢掉，改配置等于没改。现在反过来：文件里的键**全部生效**。
    const out = { ...def, ...raw };
    out.dataRoot = dataRoot;
    return out;
  } catch {
    return def;
  }
}

/** 写配置（给脚本/工具用） */
export function saveConfig(dataRoot, patch) {
  const p = configPath(dataRoot);
  try {
    const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    const next = { ...DEFAULTS, ...(cur && typeof cur === 'object' ? cur : {}), ...(patch || {}) };
    delete next.dataRoot;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
    return { ok: true, path: p, config: next };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function urlOf(cfg, path) {
  const base = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
  return base + path;
}

// ── 判定日志（面板要靠它显示"这条是谁答的"）─────────────────────
/**
 * 为什么要有日志：本地代答不生效时，界面上**什么都看不出来**（用户实测反馈
 * "本地小模型似乎没有生效"）。把每次判定写进 jsonl，面板就能显示
 * "最近 8 条：本地 took=1 / 云端 why=tier:task"，一眼看出是被哪道门挡了。
 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

export function logFile(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot', 'local-answer-log.jsonl');
}

export function appendLog(dataRoot, rec) {
  try {
    const p = logFile(dataRoot);
    mkdirSync(dirname(p), { recursive: true });
    try {
      // 轮转：太大就先截掉一半（只留最近的行）
      const st = readFileSync(p, 'utf8');
      if (st.length > LOG_MAX_BYTES) {
        const lines = st.split('\n').filter(Boolean);
        writeFileSync(p, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', 'utf8');
      }
    } catch { /* 文件不存在 → 直接追加 */ }
    writeFileSync(p, JSON.stringify({
      ts: Date.now(),
      by: String(rec.by || 'cloud'),
      why: String(rec.why || ''),
      model: String(rec.model || ''),
      ms: Number(rec.ms || 0),
      scope: String(rec.scope || ''),
      text: String(rec.text || '').slice(0, 120),
      reply: String(rec.reply || '').slice(0, 120),
    }) + '\n', { encoding: 'utf8', flag: 'a' });
    return true;
  } catch { return false; }
}

/** 读最近 N 条判定（面板用；新的在后面） */
export function readLog(dataRoot, limit = 10) {
  try {
    const p = logFile(dataRoot);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const n = Math.max(1, Math.min(200, Number(limit) || 10));
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** 带超时的 fetch（Node 自带 AbortController） */
async function timedFetch(url, opts = {}, timeoutMs = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, Math.max(500, timeoutMs));
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── 健康检查（带缓存） ─────────────────────────────────────────────
// 缓存按 **baseUrl** 分桶（2026-10-23 修：原来只有一个全局槽，测过一个坏地址之后
// 好地址的检查结果会被那次的失败污染 5 秒，表现为"模型明明起着却说离线"）。
let _health = { key: '', at: 0, ok: false, models: [], error: null };

/**
 * 探测 Ollama 是否活着、模型是否已拉下来。
 * @returns {{ok:boolean, models:string[], hasModel:boolean, error:string|null}}
 */
export async function health(cfg, force = false) {
  const now = Date.now();
  const ttl = Number(cfg && cfg.healthTtlMs) || DEFAULTS.healthTtlMs;
  const key = String(urlOf(cfg, '/api/tags'));
  if (!force && _health.at && _health.key === key && now - _health.at < ttl) {
    return { ..._health, hasModel: _health.models.includes(String(cfg?.model || DEFAULTS.model)) };
  }
  let ok = false;
  let models = [];
  let error = null;
  try {
    const res = await timedFetch(urlOf(cfg, '/api/tags'), { method: 'GET' }, 2500);
    if (!res.ok) {
      error = 'HTTP ' + res.status;
    } else {
      const j = await res.json();
      models = Array.isArray(j?.models) ? j.models.map((m) => String(m?.name || '')).filter(Boolean) : [];
      ok = true;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  _health = { key, at: now, ok, models, error };
  return { ok, models, error, hasModel: models.includes(String(cfg?.model || DEFAULTS.model)) };
}

/** 测试用：清空健康缓存 */
export function resetHealthCache() {
  _health = { key: '', at: 0, ok: false, models: [], error: null };
}

/**
 * 调 /api/chat（非流式）。
 * @param {object} p
 * @param {Array<{role:string,content:string}>} p.messages
 * @param {object} [p.cfg]
 * @returns {Promise<{ok:boolean, text?:string, ms?:number, model?:string, error?:string}>}
 */
export async function chat({ messages, cfg, model, timeoutMs, maxTokens, temperature, format } = {}) {
  const c = cfg || loadConfig(dataRootOf());
  const started = Date.now();
  // [qqbot-mod] ollama-prefix 2026-10-27：配置里允许写 'ollama:qwen2.5:7b'（说明自己也是这么写的），
  //   但 ollama API 不认这个前缀 —— digest 历史切片就因此 404 秒失败（10-24 后切片再没长过）。
  //   统一在入口剥掉，写不写前缀都通。
  const wantModel = String(model || c.model || DEFAULTS.model).replace(/^ollama:/, '');
  // 常驻策略：默认 0（生成完即离开显存）；游戏/配音期间被 pin 住才给 10m
  ensureWatcher(() => c.residency || DEFAULTS.residency);
  const keepAlive = keepAliveFor({ residency: { ...DEFAULTS.residency, ...(c.residency || {}) } });
  try {
    const body = {
      model: wantModel,
      messages: Array.isArray(messages) ? messages : [],
      stream: false,
      // Ollama 的结构化输出：写脚本时传 'json'，解析成功率明显高
      ...(format ? { format } : {}),
      // ★ 2026-10-26：不再无条件常驻。没被 pin → '0'（显存立刻释放），
      //   被游戏/配音 pin 住 → '10m'（多轮不冷启）。见 lib/model-policy.mjs
      keep_alive: keepAlive,
      options: {
        temperature: typeof temperature === 'number' ? temperature : c.temperature,
        top_p: c.topP,
        top_k: 40,
        min_p: 0.05,
        num_predict: typeof maxTokens === 'number' ? maxTokens : c.maxTokens,
        // 小模型容易发散，压低重复惩罚让它更像人说话
        repeat_penalty: 1.15,
      },
    };
    const res = await timedFetch(urlOf(c, '/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, typeof timeoutMs === 'number' ? timeoutMs : c.timeoutMs);
    if (!res.ok) {
      const hint = res.status === 404 ? '模型不存在(需要 ollama pull ' + wantModel + ')' : 'HTTP ' + res.status;
      noteUse('chat', wantModel);
      return { ok: false, error: hint, ms: Date.now() - started, model: wantModel };
    }
    const j = await res.json();
    noteUse('chat', wantModel);
    const text = String(j?.message?.content || '').trim();
    if (!text) return { ok: false, error: 'empty', ms: Date.now() - started, model: wantModel };
    return { ok: true, text, ms: Date.now() - started, model: wantModel };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = /abort/i.test(msg) ? 'timeout' : msg;
    return { ok: false, error: friendly, ms: Date.now() - started, model: wantModel };
  }
}

/** 一句话问答的便捷封装（单轮） */
export async function ask(prompt, { system, cfg, model, timeoutMs, maxTokens } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(prompt || '') });
  return chat({ messages, cfg, model, timeoutMs, maxTokens });
}

/** 预热：把模型加载进内存（避免第一条消息等 3~5 秒加载） */
export async function warmup(cfg, model) {
  const started = Date.now();
  const r = await chat({
    messages: [{ role: 'user', content: '咕' }],
    cfg,
    model,
    maxTokens: 4,
    timeoutMs: 60000,
  });
  return { ok: r.ok, ms: Date.now() - started, error: r.error || null };
}

/**
 * 把模型从显存里卸掉（keep_alive=0）。
 *
 * 为什么需要：RTX 3060 只有 6GB，qwen2.5:7b 量化占 ~5GB、sd-turbo 占 ~4GB，
 * 两个一起挂在显存里必然 `CUDA out of memory`。
 * 出图前先把它请出去，画完下一次对话它会自己冷启动回来（~7 秒，只付一次）。
 */
export async function unload(cfg, model) {
  try {
    const c = cfg || loadConfig(dataRootOf());
    const m = String(model || c.model || '').trim();
    if (!m) return { ok: false, error: 'no-model' };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const r = await fetch(urlOf(c, '/api/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: m, keep_alive: 0 }),
      signal: ac.signal,
    });
    clearTimeout(t);
    return { ok: r.ok };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 状态汇总（给面板/脚本用） */
export async function status(cfg, force = false) {
  const c = cfg || loadConfig(dataRootOf());
  const h = await health(c, force);
  return {
    enabled: c.enabled !== false,
    baseUrl: c.baseUrl,
    model: c.model,
    timeoutMs: c.timeoutMs,
    serverUp: h.ok,
    models: h.models,
    hasModel: h.hasModel,
    error: h.error,
    residency: await policySnapshot(c.baseUrl),
  };
}
