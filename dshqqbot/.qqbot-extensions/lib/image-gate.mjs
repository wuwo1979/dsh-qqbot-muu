/**
 * image-gate.mjs — 出图质检与重试（把"垃圾图"挡在成片之外）
 *
 * 背景：这套链路里最贵的不是算力，是**观众的耐心**。本地 SD1.5 和免费云端
 * 都会稳定产出几类废图：糊、灰、纯色块、和上一屏几乎一样。模型自己不知道，
 * 剪辑也不该碰运气——所以出图后先过一道可量化的检查（scripts/image_gate.py），
 * 不合格就重roll/换角度，仍不合格就让上层退回文字动效。
 *
 * 为什么用 python 而不是纯 JS：Pillow 已经是这条链路的硬依赖（文字动效、SD 服务
 * 都在用），在 Node 里自己解 PNG/JPEG 只会多一份易错代码，还得为清晰度做卷积。
 *
 * 结果通道：子进程不读 stdout（宿主沙箱不允许管道 stdio），统一写 gate.json。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function defaultGateScript() {
  const env = String(process.env.QQBOT_IMAGE_GATE || '').trim();
  if (env) return env;
  // lib → .qqbot-extensions → dshqqbot → 项目根
  return join(HERE, '..', '..', '..', 'qqbot-mod', 'scripts', 'image_gate.py');
}

export function resolvePython(cfg = {}) {
  const p = String(cfg.pythonBin || '').trim();
  if (p && existsSync(p)) return p;
  return 'python';
}

/** 汉明距离：用来判两张图是不是同一张（dHash） */
export function hamming(a, b) {
  try {
    let x = BigInt('0x' + String(a)) ^ BigInt('0x' + String(b));
    let n = 0;
    while (x) { n += Number(x & 1n); x >>= 1n; }
    return n;
  } catch { return 64; }
}

/** 硬伤（有其中任何一个就不该上片；score 只用于排序） */
export const HARD_ISSUES = new Set(['blur', 'dark', 'blown', 'empty', 'posterized', 'duplicate']);

export function isUsable(item) {
  if (!item || item.ok === false && !item.issues) return false;
  const issues = Array.isArray(item.issues) ? item.issues : [];
  return !issues.some((i) => HARD_ISSUES.has(i));
}

/**
 * 跑一次质检。
 * @param {string[]} paths
 * @param {object} opts { pythonBin, script, timeoutMs, baseline:string[], maxHamming }
 */
export async function gateImages(paths, opts = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).map(String).filter(Boolean);
  if (!list.length) return { ok: false, reason: 'no-images', items: [] };
  const py = resolvePython(opts);
  const script = String(opts.script || defaultGateScript());
  if (!existsSync(script)) return { ok: false, reason: 'no-script: ' + script, items: [] };

  const out = String(opts.outFile || join(dirname(list[0]), 'gate.json'));
  try { mkdirSync(dirname(out), { recursive: true }); } catch { /* ignore */ }
  try { rmSync(out, { force: true }); } catch { /* ignore */ }

  const args = [script, '--out', out, '--maxhamming', String(Math.max(0, Number(opts.maxHamming) || 6))];
  if (Array.isArray(opts.baseline) && opts.baseline.length) args.push('--baseline', writeBaseline(opts.baseline, out));
  args.push(...list);

  const timeoutMs = Math.max(10000, Number(opts.timeoutMs) || 60000);
  const run = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(py, args, { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, reason: 'spawn: ' + ((e && e.message) || String(e)) });
    }
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, reason: 'spawn: ' + ((e && e.message) || String(e)) });
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, reason: code === 0 ? '' : 'exit-' + code });
    });
  });

  let j = null;
  try { j = JSON.parse(readFileSync(out, 'utf8')); } catch { /* 读不到就看退出码 */ }
  if (!j || j.ok !== true) {
    return { ok: false, reason: (j && j.error) || run.reason || 'no-result', items: [] };
  }
  const items = (j.items || []).map((it) => ({ ...it, usable: isUsable(it) }));
  return { ok: true, items, best: j.best || '', bestScore: Number(j.bestScore) || 0, accepted: !!j.accepted };
}

function writeBaseline(list, near) {
  const p = join(dirname(near), '.gate-baseline.json');
  try {
    const prev = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
    const merged = [...new Set([...(Array.isArray(prev) ? prev : []), ...list.map(String)])].slice(-200);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(merged), 'utf8');
    return p;
  } catch {
    // 写不进去（占用/权限）就不传 baseline：本次批内查重仍然生效
    return '';
  }
}

/**
 * 出图 + 质检 + 重 roll 的完整动作。
 *
 * 重试策略（每次都不一样，避免"重试出同一张"）：
 *   1) 原 prompt
 *   2) 原 prompt + 锐化/细节描述（换 seed 由 drawFn 负责）
 *   3) 换构图视角（close-up / wide shot 轮换）
 * 三次都不合格 → 返回 { ok:false }，上层退回文字动效。
 *
 * @param {(prompt:string, opt:object)=>Promise<{ok:boolean,path?:string,reason?:string}>} drawFn
 * @param {string} prompt
 * @param {object} drawOpt 传给 drawFn 的基础参数（width/height/out/initImage/strength…）
 * @param {object} opts { attempts, gate:{...}, baseline, log }
 */
export async function drawGated(drawFn, prompt, drawOpt = {}, opts = {}) {
  const attempts = Math.max(1, Math.min(4, Number(opts.attempts) || 3));
  const variants = [
    '',
    ', ultra detailed, sharp focus, crisp lineart, high resolution',
    ', dynamic composition, dramatic lighting, depth of field',
    ', close-up portrait, shallow depth of field, film grain',
  ];
  const tried = [];
  const baseline = Array.isArray(opts.baseline) ? opts.baseline.slice() : [];
  let best = null;

  for (let i = 0; i < attempts; i += 1) {
    const suffix = variants[Math.min(i, variants.length - 1)];
    const p = suffix && !String(prompt).includes(suffix.trim()) ? prompt + suffix : prompt;
    const out = String(drawOpt.out || '').replace(/(\.[a-z0-9]+)$/i, i ? `-r${i}$1` : '$1');
    let drew;
    try {
      // 第三个参数是出图配置（本地 SD 需要 python 路径/模型档位）；注入的假实现忽略它也无妨
      drew = await drawFn(p, { ...drawOpt, out, seed: Number(drawOpt.seed || 0) + i * 7919 }, opts.drawCfg);
    } catch (e) {
      drew = { ok: false, reason: 'draw: ' + ((e && e.message) || String(e)) };
    }
    if (!drew || !drew.ok || !drew.path) {
      tried.push({ attempt: i + 1, ok: false, reason: drew?.reason || 'no-path' });
      continue;
    }
    const g = await gateImages([drew.path], { ...(opts.gate || {}), baseline, outFile: join(dirname(drew.path), `gate-${i + 1}.json`) });
    const item = (g.items || [])[0] || null;
    tried.push({ attempt: i + 1, ok: !!(g.ok && item && item.usable), path: drew.path, issues: item?.issues || [], score: item?.score || 0, reason: g.ok ? '' : g.reason });
    if (g.ok && item && item.usable && (!best || item.score > best.score)) {
      best = { path: drew.path, score: item.score, dhash: item.dhash, stats: item };
      // 分数够高就不再多花一次出图（省算力也省时间）
      if (item.score >= (Number(opts.goodEnough) || 0.82)) break;
    }
    if (item && item.dhash) baseline.push(item.dhash);
  }

  if (!best) {
    return { ok: false, reason: 'no-usable-image', tried, best: null };
  }
  return { ok: true, path: best.path, score: best.score, dhash: best.dhash, stats: best.stats, tried };
}

export default { gateImages, drawGated, isUsable, hamming, HARD_ISSUES, defaultGateScript, resolvePython };
