/**
 * hooks/llm-panel.mjs — 浮窗「🖥 本地模型」页的数据与控制接口（2026-10-26）
 *
 *   GET  /api/qqbot-settings/llm-status   → Ollama 是否在跑 / 当前显存里的模型 / pin / 空闲 / 看门狗统计
 *   POST /api/qqbot-settings/llm-control  → 动作：
 *        {action:'load', model?, minutes?}    手动唤醒模型并钉住 N 分钟（默认 30）
 *        {action:'extend', minutes?}          手动延长驻留（重新钉 N 分钟，不重新冷启）
 *        {action:'unload'}                    立刻把显存里的模型全部卸掉
 *        {action:'reset'}                     复位：解除手动钉 + 立即卸载（回到"按需自动"）
 *
 * 方案说明（主人 2026-10-26 问「ollama 一直跑但不加载模型行不行」）：
 *   现状就是这样 —— ollama 进程常驻（只占 ~200MB 内存，不占显存），模型 keep_alive=0
 *   生成完即退场，空闲看门狗 60s 兜底全卸。唤醒一次 2~7s 是唯一的代价。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  existsSync, statSync, readdirSync, mkdirSync, mkdtempSync, rmSync, cpSync, createWriteStream,
} from 'node:fs';
import { loadConfig as loadLlmConfig } from '../lib/local-llm.mjs';
import {
  snapshot, ps, unload, ensureLoaded,
  pin, unpin, listPins,
} from '../lib/model-policy.mjs';

const MANUAL_PIN = 'manual';   // 浮窗手动钉住的 reason 名

/**
 * [qqbot-mod] gpu-probe 2026-10-27：整机显存 + 占用进程。
 * 背景：面板「当前挂在显存里（N 个）」只统计 Ollama —— TTS/游戏/出图占的显存它看不见，
 * 主人反馈"和实际无法匹配上"。nvidia-smi 拿整机视角，让 0 个也能看出显存去哪了。
 */
function gpuInfo() {
  try {
    const q = (args) => {
      const r = spawnSync('nvidia-smi', args, { timeout: 2500, encoding: 'utf8' });
      return String((r && r.stdout) || '').trim();
    };
    const head = q(['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']).split('\n')[0] || '';
    const [used, total] = head.split(',').map((x) => parseInt(String(x).trim(), 10));
    const procs = q(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'])
      .split('\n').filter(Boolean).slice(0, 12).map((l) => {
        const [pid, name, mem] = l.split(',').map((x) => String(x).trim());
        return { pid: pid || '', name: String(name || '').replace(/^.*[\\/]/, ''), mem: Number(mem) || 0 };
      });
    if (!Number.isFinite(used) || !used) return { ok: false, used: 0, total: total || 0, procs: [] };
    return { ok: true, used, total: total || 0, procs };
  } catch { return { ok: false, used: 0, total: 0, procs: [] }; }
}

// ── 判定模型管理（主人 2026-10-27：让别人也能选模型用）──
// 模型包发布在自家仓库的 GitHub Releases（models-v1），不依赖 HuggingFace 直连；
// 解压结构与 settings-host.js 的 localModelDirOf 约定一致：{DSH_HOME|~/.dsh}/models/<dirName>/onnx/model_quantized.onnx
const MODELS_ROOT = join(
  (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || homedir(),
  'models',
);
const MODEL_REGISTRY = [
  {
    id: 'bge-small-zh', dirName: 'bge-small-zh', name: 'bge-small-zh-v1.5',
    desc: '智能回复判定 · 默认（快，省资源）', sizeApprox: '23 MB',
    url: 'https://github.com/wuwo1979/dsh-qqbot-muu/releases/download/models-v1/bge-small-zh-v1.5-q8.zip',
    fallbackUrl: 'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/',
    files: ['onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json'],
    check: 'onnx/model_quantized.onnx',
  },
  {
    id: 'bge-base-zh', dirName: 'bge-base-zh', name: 'bge-base-zh-v1.5',
    desc: '智能回复判定 · 更准（约 98MB，判定更稳）', sizeApprox: '98 MB',
    url: 'https://github.com/wuwo1979/dsh-qqbot-muu/releases/download/models-v1/bge-base-zh-v1.5-q8.zip',
    fallbackUrl: 'https://hf-mirror.com/Xenova/bge-base-zh-v1.5/resolve/main/',
    files: ['onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json'],
    check: 'onnx/model_quantized.onnx',
  },
  {
    // [qqbot-mod] 2026-10-27：单会话页的模型下拉一直有 bge-large-zh，这张管理卡却只有两个 ——
    //   选了 large 的人永远装不上。large 没有打包 zip，走逐文件直下（hf-mirror 优先）。
    id: 'bge-large-zh', dirName: 'bge-large-zh', name: 'bge-large-zh-v1.5',
    desc: '智能回复判定 · 最准（大，慢，机器好再选）', sizeApprox: '≈330 MB',
    bases: [
      'https://hf-mirror.com/Xenova/bge-large-zh-v1.5/resolve/main/',
      'https://huggingface.co/Xenova/bge-large-zh-v1.5/resolve/main/',
    ],
    files: ['onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json'],
    check: 'onnx/model_quantized.onnx',
  },
];
const MODEL_BUSY = { id: '', phase: '', err: '' };   // 当前下载/解压任务（同时只允许一个）
const ACTIVE_PHASES = new Set(['排队中', '下载中', '解压中']);   // 终态（完成/失败）不挡新操作

function modelStatusList() {
  return MODEL_REGISTRY.map((m) => {
    const dir = join(MODELS_ROOT, m.dirName);
    const installed = existsSync(join(dir, m.check));
    const sizeMb = (() => { try { return Math.round(dirSizeMb(dir)); } catch { return 0; } })();
    const isMine = MODEL_BUSY.id === m.id;
    const phase = isMine && ACTIVE_PHASES.has(MODEL_BUSY.phase) ? MODEL_BUSY.phase : '';
    return {
      id: m.id, dirName: m.dirName, name: m.name, desc: m.desc,
      sizeApprox: m.sizeApprox, installed,
      sizeMb: installed ? sizeMb : 0,
      busy: phase,
      err: isMine && MODEL_BUSY.phase === '失败' ? MODEL_BUSY.err : '',
    };
  });
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p); else total += s.size;
    }
  };
  walk(dir);
  return total / 1048576;
}

/** 下载（跟随重定向）到目标文件 */
function httpDownload(url, dest, redirects = 0) {
  const mod = url.startsWith('http://') ? require('node:http') : null;
  return new Promise((resolve, reject) => {
    import('node:https').then(({ default: https }) => {
      const req = https.get(url, { headers: { 'user-agent': 'dsh-qqbot-muu', accept: '*/*' } }, (resp) => {
        const code = resp.statusCode || 0;
        if (code >= 300 && code < 400 && resp.headers.location && redirects < 6) {
          resp.resume();
          return httpDownload(new URL(resp.headers.location, url).toString(), dest, redirects + 1).then(resolve, reject);
        }
        if (code !== 200) { resp.resume(); return reject(new Error(`HTTP ${code}`)); }
        const ws = createWriteStream(dest);
        resp.pipe(ws);
        ws.on('finish', () => ws.close(() => resolve(dest)));
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(600000, () => req.destroy(new Error('下载超时(10分钟)')));
    }, reject);
  });
}

async function modelInstall(m) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  // [qqbot-mod] 无 zip 的模型（bge-large-zh）：逐文件从 bases 直下，不经过打包/解压
  if (!m.url && Array.isArray(m.bases) && m.bases.length) {
    const dst0 = join(MODELS_ROOT, m.dirName);
    if (fs.existsSync(join(dst0, m.check))) throw new Error('已安装，先卸载再下载');
    MODEL_BUSY.phase = '下载中';
    for (const rel of m.files) {
      const dest = join(dst0, rel);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let lastErr = '';
      let ok = false;
      for (const base of m.bases) {
        try { await httpDownload(base + rel, dest); ok = true; break; }
        catch (e) { lastErr = String((e && e.message) || e); }
      }
      if (!ok) throw new Error(`${rel} 下载失败: ${lastErr}`);
    }
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'muu-model-'));
  try {
    MODEL_BUSY.phase = '下载中';
    const zip = path.join(work, 'model.zip');
    let url = m.url;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await httpDownload(url, zip); break; }
      catch (e) {
        if (attempt === 0 && m.fallbackUrl && url !== m.fallbackUrl) { url = m.fallbackUrl; continue; }
        throw e;
      }
    }
    MODEL_BUSY.phase = '解压中';
    const exDir = path.join(work, 'x');
    fs.mkdirSync(exDir, { recursive: true });
    // 优先 bsdtar（Win10+ 自带，支持 zip），失败再试 PowerShell Expand-Archive
    let r = spawnSync('tar', ['-xf', zip, '-C', exDir], { timeout: 180000 });
    if (r.status !== 0) {
      r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${exDir}' -Force`], { timeout: 180000 });
    }
    if (r.status !== 0) throw new Error('解压失败：' + String(r.stderr || r.stdout || '').slice(0, 200));
    // 找到含 config.json 的模型根目录（zip 里可能带一层目录）
    const findRoot = (d) => {
      if (fs.existsSync(path.join(d, 'config.json'))) return d;
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) { const hit = findRoot(p); if (hit) return hit; }
      }
      return '';
    };
    const root = findRoot(exDir);
    if (!root) throw new Error('zip 里没有 config.json（结构不对）');
    const dst = join(MODELS_ROOT, m.dirName);
    if (fs.existsSync(join(dst, m.check))) throw new Error('已安装，先卸载再下载');
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(root, dst, { recursive: true });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); try { req.destroy(); } catch { /* ignore */ } return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const t = Buffer.concat(chunks).toString('utf8').trim();
        resolve(t ? JSON.parse(t) : {});
      } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
    req.on('error', reject);
  });
}

export async function run(env = {}) {
  const { ctx, dataRoot, logger } = env;

  const attach = (serverCtx, from) => {
    try {
      const ws = serverCtx && serverCtx.webServer;
      if (!ws || typeof ws.register !== 'function') {
        logger?.warn?.('[llm-panel] 宿主没有 webServer，浮窗本地模型页不可用');
        return;
      }
      const dispose = ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/llm-status',
        handler: async (req, res) => {
          const send = (code, obj) => {
            try {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(obj));
            } catch { /* ignore */ }
          };
          try {
            const cfg = loadLlmConfig(dataRoot) || {};
            const residency = cfg.residency || {};
            const snap = await snapshot(cfg.baseUrl);
            const up = snap.loaded !== undefined;   // ps 失败时 loaded 是 []，但 ok 才可靠
            let ollamaUp = false;
            try { ollamaUp = (await ps(cfg.baseUrl)).ok; } catch { ollamaUp = false; }
            send(200, {
              ok: true,
              ollamaUp,
              model: cfg.model || '',
              gameModel: cfg.gameModel || '',
              whoAnswers: cfg.whoAnswers || '',
              residency: {
                enabled: residency.enabled !== false,
                idleUnloadSec: Number(residency.idleUnloadSec ?? 60),
                pinnedKeepAlive: residency.pinnedKeepAlive || '10m',
              },
              ...snap,
              gpu: gpuInfo(),   // [qqbot-mod] gpu-probe：整机显存视角
            });
          } catch (e) {
            send(500, { ok: false, error: String((e && e.message) || e) });
          }
        },
      });
      logger?.info?.(`[llm-panel] llm-status 已挂载 (${from})`);
      return dispose;
    } catch (e) {
      logger?.warn?.(`[llm-panel] 挂载失败: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  const attachControl = (serverCtx, from) => {
    try {
      const ws = serverCtx && serverCtx.webServer;
      if (!ws || typeof ws.register !== 'function') return;
      const dispose = ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/llm-control',
        handler: async (req, res) => {
          const send = (code, obj) => {
            try {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(obj));
            } catch { /* ignore */ }
          };
          try {
            if (req.method !== 'POST') { send(405, { ok: false, error: '只支持 POST' }); return; }
            const body = await readJsonBody(req);
            const action = String(body.action || '').trim();
            const cfg = loadLlmConfig(dataRoot) || {};
            const base = cfg.baseUrl;
            const minutes = Math.min(Math.max(Number(body.minutes) || 30, 1), 720);
            const ttlMs = minutes * 60 * 1000;

            if (action === 'load') {
              const model = String(body.model || cfg.model || '').trim();
              if (!model) { send(400, { ok: false, error: '没有可唤醒的模型（配置里 model 为空）' }); return; }
              const r = await ensureLoaded({ baseUrl: base, model });
              if (r.ok) pin(MANUAL_PIN, ttlMs, `浮窗手动唤醒 ${model}`);
              send(200, { ok: r.ok, action, model, minutes, error: r.error || '', pins: listPins() });
              return;
            }
            if (action === 'extend') {
              pin(MANUAL_PIN, ttlMs, '浮窗手动延长');
              send(200, { ok: true, action, minutes, pins: listPins() });
              return;
            }
            if (action === 'unload') {
              unpin(MANUAL_PIN);
              const r = await unload({ baseUrl: base });
              send(200, { ok: r.ok, action, unloaded: r.unloaded, pins: listPins() });
              return;
            }
            if (action === 'reset') {
              unpin(MANUAL_PIN);
              const r = await unload({ baseUrl: base });
              send(200, { ok: true, action, unloaded: r.unloaded, pins: listPins() });
              return;
            }
            send(400, { ok: false, error: `未知 action: ${action || '(空)'}` });
          } catch (e) {
            send(500, { ok: false, error: String((e && e.message) || e) });
          }
        },
      });
      logger?.info?.(`[llm-panel] llm-control 已挂载 (${from})`);
      return dispose;
    } catch (e) {
      logger?.warn?.(`[llm-panel] control 挂载失败: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  // ── 判定模型管理：列表 / 下载 / 卸载（主人 2026-10-27）──
  const attachModels = (serverCtx, from) => {
    try {
      const ws = serverCtx && serverCtx.webServer;
      if (!ws || typeof ws.register !== 'function') return;
      const dispose = ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/models-manage',
        handler: async (req, res) => {
          const send = (code, obj) => {
            try {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(obj));
            } catch { /* ignore */ }
          };
          try {
            if (req.method === 'GET') {
              send(200, { ok: true, root: MODELS_ROOT, models: modelStatusList() });
              return;
            }
            if (req.method !== 'POST') { send(405, { ok: false, error: '只支持 GET/POST' }); return; }
            const body = await readJsonBody(req);
            const action = String(body.action || '').trim();
            const m = MODEL_REGISTRY.find((x) => x.id === String(body.id || '').trim());
            if (!m) { send(400, { ok: false, error: '未知模型 id' }); return; }
            const dst = join(MODELS_ROOT, m.dirName);
            if (action === 'download') {
              const busyActive = MODEL_BUSY.id && ACTIVE_PHASES.has(MODEL_BUSY.phase);
              if (busyActive) { send(409, { ok: false, error: `已有任务在进行：${MODEL_BUSY.id}（${MODEL_BUSY.phase}）` }); return; }
              if (MODEL_BUSY.id) { MODEL_BUSY.id = ''; MODEL_BUSY.phase = ''; MODEL_BUSY.err = ''; }   // 终态（完成/失败）直接复位，不挡操作
              if (existsSync(join(dst, m.check))) { send(200, { ok: true, action, id: m.id, already: true, models: modelStatusList() }); return; }
              MODEL_BUSY.id = m.id; MODEL_BUSY.phase = '排队中'; MODEL_BUSY.err = '';
              send(200, { ok: true, action, id: m.id, started: true, models: modelStatusList() });
              // 后台跑，不占请求；进度靠轮询 GET
              modelInstall(m)
                .then(() => { MODEL_BUSY.phase = '完成'; })
                .catch((e) => { MODEL_BUSY.err = String((e && e.message) || e); MODEL_BUSY.phase = '失败'; })
                .finally(() => { setTimeout(() => { if (MODEL_BUSY.id === m.id) { MODEL_BUSY.id = ''; MODEL_BUSY.phase = ''; } }, 4000); });
              return;
            }
            if (action === 'remove') {
              if (MODEL_BUSY.id === m.id && ACTIVE_PHASES.has(MODEL_BUSY.phase)) { send(409, { ok: false, error: '该模型正在下载中' }); return; }
              // 防呆：只允许删注册表里的模型目录，且必须真的在 models 根下
              const resolved = join(MODELS_ROOT, m.dirName);
              if (!resolved.startsWith(MODELS_ROOT) || !MODEL_REGISTRY.some((x) => x.dirName === m.dirName)) {
                send(400, { ok: false, error: '路径不允许' }); return;
              }
              if (!existsSync(resolved)) { send(200, { ok: true, action, id: m.id, gone: true, models: modelStatusList() }); return; }
              rmSync(resolved, { recursive: true, force: true });
              send(200, { ok: true, action, id: m.id, models: modelStatusList() });
              return;
            }
            send(400, { ok: false, error: `未知 action: ${action || '(空)'}` });
          } catch (e) {
            send(500, { ok: false, error: String((e && e.message) || e) });
          }
        },
      });
      logger?.info?.(`[llm-panel] models-manage 已挂载 (${from})`);
      return dispose;
    } catch (e) {
      logger?.warn?.(`[llm-panel] models 挂载失败: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  // 与 memory-panel 同款挂载序列：延后 inject 等宿主 webServer 就绪
  if (ctx && typeof ctx.inject === 'function') {
    const delay = Number(env.injectDelayMs);
    setTimeout(() => {
      try {
        ctx.inject(['webServer'], (serverCtx) => { attach(serverCtx, 'inject'); attachControl(serverCtx, 'inject'); attachModels(serverCtx, 'inject'); });
      } catch (e) {
        logger?.warn?.(`[llm-panel] inject 失败，尝试直接挂载: ${e instanceof Error ? e.message : String(e)}`);
        attach(ctx, 'direct'); attachControl(ctx, 'direct'); attachModels(ctx, 'direct');
      }
    }, Number.isFinite(delay) && delay >= 0 ? delay : 1500);
    return { mounted: 'scheduled-inject' };
  }
  attach(ctx, 'direct'); attachControl(ctx, 'direct'); attachModels(ctx, 'direct');
  return { mounted: 'direct' };
}
