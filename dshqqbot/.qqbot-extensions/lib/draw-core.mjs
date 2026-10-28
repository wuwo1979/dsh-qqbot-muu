/**
 * draw-core.mjs — 本地文生图（sd-turbo，走常驻 python 微服务）
 *
 * 为什么是"常驻服务 + HTTP"而不是"每张图 spawn 一次 python"：
 *   diffusers 加载 sd-turbo 要 5~15 秒，一次一张等于每张都重付这笔钱。
 *   常驻后：首张 ~2 秒，之后每张 0.5~2 秒（RTX 3060 / 512px / 2 步）。
 *
 * 与沙箱的相处方式：
 *   宿主进程里 spawn 子进程**不允许管道 stdio**（拿不到 stdout），
 *   所以 python 那边不打印结果，结果一律走 HTTP 响应；spawn 时 `stdio:'ignore'`。
 *
 * 配置：`{dataRoot}/.qqbot-extensions/draw-config.json`
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_NAME = 'draw-config.json';

export const DEFAULTS = {
  enabled: true,
  // 画画的 python：优先用专门的 venv（不污染 Anaconda 基环境）
  pythonBin: 'F:/qqbot/.venv-draw/Scripts/python.exe',
  serverScript: 'F:/qqbot/qqbot-mod/scripts/sd_server.py',
  // 默认用 SD1.5 动漫模型（单文件）：sd-turbo 2 步出来的图糊得没法看
  modelDir: 'F:/qqbot/.models/counterfeit3/Counterfeit-V3.0_fix_fp16.safetensors',
  baseUrl: 'http://127.0.0.1:7861',
  /** 单张图最多等多久（首次含加载） */
  timeoutMs: 120000,
  /** 启动服务后等它把模型加载完的上限 */
  bootWaitMs: 120000,
  width: 512,
  height: 512,
  steps: 24,
  /** CFG：SD1.5 用 7；turbo/lcm 类模型由服务端强制 0 */
  cfg: 7,
  /** 画风后缀（拼在英文 prompt 后面） */
  styleSuffix: ', anime illustration, best quality, clean line art, soft lighting, cute, highly detailed face',
  /** 负面词（SD1.5 动漫模型必须喂，否则十指/多手） */
  negative: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, ugly, deformed, extra limbs',
  /** 中文 → 英文 prompt 的本地模型（空 = 用 local-llm 的默认模型） */
  translateModel: '',
  maxPromptChars: 300,
  /**
   * 模型档位（6GB 显存的现实约束）：
   *   profiles.<name> = { modelDir, steps, cfg, width, height, vae, lowvram, styleSuffix, negative }
   *   activeProfile 选中哪一档；把更好的单文件模型塞进 modelDir 就能升级，不用改代码。
   */
  profiles: {},
  activeProfile: '',
  /** 外挂 VAE（fp16 VAE 能明显改善 SD1.5 偏灰/糊；空 = 用模型自带） */
  vae: '',
  /** 6GB 卡爆显存时打开：模型分块驻留 CPU（慢一些但不 OOM） */
  lowvram: false,
  /** LoRA 列表：[{path, weight}]，本地小改装（画风/角色一致性）靠它，不用重训底座 */
  loras: [],
};

/** 解析数据根（与其它扩展同口径） */
export function dataRootOf(cfg) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  return (cfg && cfg.dataRoot) || 'F:/qqbot/dshqqbot';
}

export function configPath(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot-extensions', CONFIG_NAME);
}

export function loadConfig(dataRoot) {
  const def = { ...DEFAULTS };
  try {
    const p = configPath(dataRootOf(dataRoot));
    if (!existsSync(p)) return { dataRoot: dataRootOf(dataRoot), ...def };
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const merged = { ...def, ...(raw && typeof raw === 'object' ? raw : {}) };
    // 档位覆盖：activeProfile 里的字段优先（模型/步数/CFG/VAE/offload 一起切）
    const profiles = merged.profiles && typeof merged.profiles === 'object' ? merged.profiles : {};
    const active = String(merged.activeProfile || '').trim();
    if (active && profiles[active] && typeof profiles[active] === 'object') {
      const pick = { ...profiles[active] };
      delete pick['_说明'];
      Object.assign(merged, pick);
      merged.activeProfile = active;
    }
    return { ...merged, dataRoot: dataRootOf(dataRoot) };
  } catch {
    return { dataRoot: dataRootOf(dataRoot), ...def };
  }
}

/** 可用的档位名（面板/测试用） */
export function listProfiles(cfg) {
  const p = cfg && cfg.profiles && typeof cfg.profiles === 'object' ? cfg.profiles : {};
  return Object.keys(p);
}

export function saveConfig(dataRoot, patch) {
  try {
    const p = configPath(dataRootOf(dataRoot));
    const cur = loadConfig(dataRoot);
    const next = { ...cur, ...(patch || {}) };
    delete next.dataRoot;
    mkdirSync(join(String(dataRootOf(dataRoot)), '.qqbot-extensions'), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 探一下服务在不在（1.5 秒超时，绝不阻塞消息链） */
export async function health(cfg) {
  const c = cfg || loadConfig();
  const url = String(c.baseUrl || '').replace(/\/+$/, '') + '/health';
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: 'http-' + r.status, baseUrl: c.baseUrl };
    const j = await r.json();
    return { ok: true, loaded: j.loaded === true, device: String(j.device || ''), model: String(j.model || ''), kind: String(j.kind || ''), steps: num(j.steps, 0), cfg: num(j.cfg, 0), error: String(j.error || ''), baseUrl: c.baseUrl };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), baseUrl: c.baseUrl };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 服务里正跑着的是不是配置里这个模型（比 basename，忽略路径分隔符/大小写） */
function sameModel(serverModel, wantModel) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean).pop() || '';
  const a = norm(serverModel);
  const b = norm(wantModel);
  if (!a || !b) return true; // 问不出来就别瞎重启
  return a === b;
}

/**
 * 出图前把 Ollama 的模型从显存里请出去（6GB 卡上两个模型不能共存）。
 * 失败一律忽略 —— 显存够的机器根本不需要这一步。
 */
async function freeLlm(cfg, log) {
  if (cfg.freeLlmBeforeDraw === false) return;
  try {
    const llm = await import('./local-llm.mjs');
    const lcfg = llm.loadConfig(dataRootOf(cfg));
    const h = await llm.health(lcfg);
    if (!h.ok || !h.hasModel) return;
    const r = await llm.unload(lcfg);
    if (r?.ok) log?.('info', '[draw] 已把本地模型挪出显存（给 sd-turbo 腾地方）');
  } catch {
    /* 忽略 */
  }
}

/**
 * 确保服务在跑且模型已加载。
 * @returns {Promise<{ok:boolean, started?:boolean, reason?:string, device?:string}>}
 */
export async function ensure(cfg, log) {
  const c = cfg || loadConfig();
  const h = await health(c);

  // 换了模型（面板/配置里改了 modelDir）→ 把旧服务关掉重起，否则还在画旧模型
  if (h.ok && sameModel(h.model, c.modelDir) === false) {
    log?.('info', `[draw] 模型变了（服务在跑 ${h.model}），重启出图服务：${c.modelDir}`);
    await stopServer(c);
    await sleep(400);
  } else if (h.ok && h.loaded) {
    return { ok: true, started: false, device: h.device };
  } else if (h.ok && !h.loaded) {
    // 服务起了但还在加载模型（正常：冷启 10~20 秒）
    if (!h.error) {
      const okBoot = await waitLoaded(c);
      if (okBoot.ok) return { ok: true, started: false, device: okBoot.device };
      return { ok: false, reason: okBoot.reason || 'loading-timeout' };
    }
    return { ok: false, reason: 'load-failed: ' + h.error };
  }

  // 服务不在 → 先腾显存，再起一个（detached：不阻塞、不随扩展卸载而死）
  await freeLlm(c, log);
  const py = String(c.pythonBin || '');
  const script = String(c.serverScript || '');
  if (!py || !existsSync(py)) return { ok: false, reason: 'no-python: ' + py };
  if (!script || !existsSync(script)) return { ok: false, reason: 'no-server-script: ' + script };
  if (!existsSync(String(c.modelDir || ''))) return { ok: false, reason: 'no-model-dir: ' + c.modelDir };

  const port = String(c.baseUrl || '').split(':').pop();
  const args = [script, '--model', String(c.modelDir), '--port', String(num(port, 7861)),
    '--outdir', join(String(c.dataRoot || dataRootOf(c)), '.qqbot', 'draw')];
  if (String(c.vae || '').trim()) args.push('--vae', String(c.vae));
  if (c.lowvram === true) args.push('--lowvram');
  for (const l of (Array.isArray(c.loras) ? c.loras : [])) {
    const path = typeof l === 'string' ? l : String(l?.path || '');
    if (!path || !existsSync(path)) continue;
    const weight = typeof l === 'object' && Number(l?.weight) > 0 ? Number(l.weight) : 0.8;
    args.push('--lora', path + '@' + weight);
  }
  try {
    log?.('info', `[draw] 启动本地出图服务：${py} ${args.join(' ')}`);
    const child = spawn(py, args, { stdio: 'ignore', detached: true, windowsHide: true, env: process.env });
    child.unref();
  } catch (e) {
    return { ok: false, reason: 'spawn-failed: ' + (e instanceof Error ? e.message : String(e)) };
  }

  const boot = await waitLoaded(c);
  if (boot.ok) return { ok: true, started: true, device: boot.device };
  return { ok: false, reason: boot.reason || 'boot-timeout' };
}

/** 轮询 /health 直到 loaded 或超时 */
async function waitLoaded(c) {
  const until = Date.now() + num(c.bootWaitMs, 90000);
  let last = '';
  while (Date.now() < until) {
    const h = await health(c);
    if (h.ok && h.loaded) return { ok: true, device: h.device };
    if (h.ok && h.error) return { ok: false, reason: 'load-failed: ' + h.error };
    last = h.ok ? 'loading' : h.reason || 'down';
    await sleep(1200);
  }
  return { ok: false, reason: 'boot-timeout(' + last + ')' };
}

/**
 * 画一张。
 * @param {string} prompt 英文 prompt（中文请先 translatePrompt）
 * @param {{width?:number,height?:number,steps?:number,seed?:number,out?:string,initImage?:string,strength?:number}} opts
 */
export async function draw(prompt, opts = {}, cfg) {
  const c = { ...(cfg || loadConfig()), ...(opts.cfg || {}) };
  const text = String(prompt || '').trim().slice(0, num(c.maxPromptChars, 300));
  if (!text) return { ok: false, reason: 'empty-prompt' };

  const ready = await ensure(c);
  if (!ready.ok) return { ok: false, reason: 'server: ' + (ready.reason || '?') };

  const dir = join(String(c.dataRoot || dataRootOf(c)), '.qqbot', 'draw');
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const out = opts.out || join(dir, `draw-${Date.now()}.png`);

  const negBase = String(c.negative || '');
  const negExtra = String(opts.negative || '');
  const body = {
    prompt: text + String(c.styleSuffix || ''),
    negative: [negBase, negExtra].filter(Boolean).join(', '),
    width: num(opts.width, num(c.width, 512)),
    height: num(opts.height, num(c.height, 512)),
    steps: num(opts.steps, num(c.steps, 24)),
    cfg: num(opts.cfg, num(c.cfg, 7)),
    seed: num(opts.seed, 0),
    out: out.replace(/\\/g, '/'),
  };
  if (opts.initImage) {
    body.init_image = String(opts.initImage).replace(/\\/g, '/');
    body.strength = num(opts.strength, 0.6);
  }
  const url = String(c.baseUrl || '').replace(/\/+$/, '') + '/draw';
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), num(c.timeoutMs, 120000));
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.ok !== true) return { ok: false, reason: 'draw-failed: ' + (j?.error || 'http-' + r.status) };
    const p = String(j.path || out);
    let bytes = 0;
    try { bytes = statSync(p).size; } catch { /* ignore */ }
    return { ok: true, path: p, ms: num(j.ms, 0), seed: num(j.seed, 0), bytes, device: ready.device || '' };
  } catch (e) {
    return { ok: false, reason: 'request-failed: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

/** 关掉服务（换了模型 / 要省显存时用） */
export async function stopServer(cfg) {
  const c = cfg || loadConfig();
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    await fetch(String(c.baseUrl || '').replace(/\/+$/, '') + '/stop', { signal: ac.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

const ZH_RE = /[\u4e00-\u9fa5]/;
const EN_WORD_RE = /[a-zA-Z]{3,}/g;

/** 把模型输出里的中文片段剔掉，只留英文（SD 的文本编码器只认英文） */
function englishOnly(s) {
  let t = String(s || '');
  t = t.replace(/["'“”‘’]/g, ' ');
  // 括号里的中文注释（很常见："(意思是…)"）直接整组丢掉
  t = t.replace(/[（(][^）)]*[）)]/g, ' ');
  // 剩下的中文片段（连同紧跟的标点）丢掉，汉字前后补空格
  t = t.replace(/[\u3000-\u303f\u4e00-\u9fa5\uff00-\uffef]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[,:;\-–—\s]+/, '').replace(/[,:;\-–—\s]+$/, '');
  return t;
}

/**
 * 中文 prompt → 英文 SD prompt（用本机 Ollama 小模型，失败就原样返回）。
 * 为什么要翻译：sd-turbo 的文本编码器只认英文，中文它基本画不出来。
 *
 * 实测 qwen2.5:7b 会三种跑偏：①带中文解释 ②给 "subject:/action:" 结构 ③偶尔超时。
 * 所以：两次尝试 + 只留英文 + 至少 2 个英文词才算数。
 */
export async function translatePrompt(zh, cfg) {
  const text = String(zh || '').trim();
  if (!text) return { ok: false, prompt: '', reason: 'empty' };
  if (!ZH_RE.test(text)) return { ok: true, prompt: text, translated: false };

  const c = cfg || loadConfig();
  const SYS1 = 'You translate Chinese image requests into ONE short English Stable Diffusion prompt. Output only the prompt: subject, action, style, colors. No quotes, no explanation, no Chinese.';
  const SYS2 = 'Translate to English keywords for image generation. Reply with English words and commas ONLY. Never output Chinese characters. No labels, no explanation.';
  try {
    const llm = await import('./local-llm.mjs');
    const lcfg = llm.loadConfig(dataRootOf(c));
    const h = await llm.health(lcfg);
    if (!h.ok || !h.hasModel) return { ok: false, prompt: text, reason: 'llm-offline' };
    const model = String(c.translateModel || lcfg.model || '');
    let last = '';
    for (const [i, sys] of [SYS1, SYS2].entries()) {
      const r = await llm.chat({
        cfg: { ...lcfg, model, timeoutMs: Math.min(25000, num(lcfg.timeoutMs, 12000) + 8000), maxTokens: 96, temperature: i === 0 ? 0.3 : 0.1 },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: text },
        ],
      });
      const en = englishOnly(r?.text || '');
      const words = (en.match(EN_WORD_RE) || []).length;
      last = String(r?.text || '').slice(0, 120);
      if (r?.ok && words >= 2) return { ok: true, prompt: en, translated: true, model, attempt: i + 1 };
    }
    return { ok: false, prompt: text, reason: 'translate-failed: ' + last };
  } catch (e) {
    return { ok: false, prompt: text, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 一句话状态（给工具/面板用） */
export async function status(cfg) {
  const c = cfg || loadConfig();
  const h = await health(c);
  return {
    enabled: c.enabled !== false,
    baseUrl: c.baseUrl,
    modelDir: c.modelDir,
    up: h.ok === true,
    loaded: h.loaded === true,
    device: h.device || '',
    error: h.error || h.reason || '',
    python: c.pythonBin,
  };
}

export default { DEFAULTS, loadConfig, saveConfig, health, ensure, draw, stopServer, translatePrompt, status, configPath, dataRootOf };
