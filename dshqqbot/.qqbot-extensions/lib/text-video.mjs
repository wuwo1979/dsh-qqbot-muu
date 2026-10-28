/**
 * text-video.mjs — 文字动效分镜（本地 PIL 逐帧渲染）
 *
 * 为什么单独一条链路：
 *   现在出图质量靠模型撞运气，而「文字 + 代码 + 简单动效」是可控的美术方向：
 *   打字机、渐入、上浮、代码框、水下颗粒，全部 CPU 渲染，不占显存、不花钱。
 *
 * 约定：
 *   · 每屏一个帧目录 panels/<idx>/frames/0001.png …（24fps）
 *   · frames/result.json 是唯一的结果通道（沙箱不允许读子进程 stdout）
 *   · 渲染脚本 `qqbot-mod/scripts/text_render.py`，解释器复用 draw-config.json 的 pythonBin
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function defaultScriptPath() {
  const env = String(process.env.QQBOT_TEXT_RENDER || '').trim();
  if (env) return env;
  // lib → .qqbot-extensions → dshqqbot → 项目根
  return join(HERE, '..', '..', '..', 'qqbot-mod', 'scripts', 'text_render.py');
}

export function resolvePython(cfg = {}) {
  const p = String(cfg.pythonBin || '').trim();
  if (p && existsSync(p)) return p;
  return 'python';
}

const _probe = new Map();

/** 探一下「python + PIL + 脚本」在不在（结果缓存，避免每屏都探） */
export async function available(cfg = {}) {
  const py = resolvePython(cfg);
  const script = String(cfg.textScript || defaultScriptPath());
  const key = py + '|' + script;
  if (_probe.has(key)) return _probe.get(key);
  let out;
  if (!existsSync(script)) {
    out = { ok: false, reason: '找不到渲染脚本：' + script };
  } else {
    const r = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(py, ['-c', 'import PIL, json; print("ok")'], { stdio: 'ignore', windowsHide: true });
      } catch (e) {
        return resolve({ ok: false, reason: 'python-spawn: ' + ((e && e.message) || String(e)) });
      }
      const t = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, reason: 'python-timeout' });
      }, 15000);
      child.on('error', (e) => {
        clearTimeout(t);
        resolve({ ok: false, reason: 'python: ' + ((e && e.message) || String(e)) });
      });
      child.on('exit', (code) => {
        clearTimeout(t);
        resolve(code === 0 ? { ok: true } : { ok: false, reason: 'python-exit-' + code });
      });
    });
    out = r.ok ? { ok: true, python: py, script } : { ok: false, reason: r.reason + '（Pillow 没装？）', python: py, script };
  }
  _probe.set(key, out);
  return out;
}

/**
 * 渲染一屏的文字动效帧。
 * @param {{outDir:string,text:string,title?:string,width?:number,height?:number,fps?:number,
 *          durationSec:number,style?:string,bgImage?:string,accent?:string,seed?:number,
 *          pythonBin?:string,textScript?:string,timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, dir?:string, frames?:number, fps?:number, width?:number, height?:number, reason?:string}>}
 */
export async function renderFrames(opts = {}) {
  const py = resolvePython(opts);
  const script = String(opts.textScript || defaultScriptPath());
  const outDir = String(opts.outDir || '').trim();
  if (!outDir) return { ok: false, reason: 'no-outdir' };
  const text = String(opts.text || '').trim();
  if (!text) return { ok: false, reason: 'empty-text' };
  if (!existsSync(script)) return { ok: false, reason: 'no-script: ' + script };

  const fps = Math.max(8, Math.min(60, Number(opts.fps) || 24));
  const duration = Math.max(0.8, Math.min(30, Number(opts.durationSec) || 4));
  mkdirSync(outDir, { recursive: true });
  const textFile = join(outDir, 'narration.txt');
  try {
    writeFileSync(textFile, text, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'write-text: ' + ((e && e.message) || String(e)) };
  }
  const args = [
    script,
    '--out', outDir,
    '--text-file', textFile,
    '--w', String(Math.max(320, Math.min(1920, Number(opts.width) || 1280))),
    '--h', String(Math.max(320, Math.min(1920, Number(opts.height) || 720))),
    '--fps', String(fps),
    '--duration', String(duration.toFixed(2)),
    '--style', String(opts.style || 'typewriter'),
    '--accent', String(opts.accent || '#7fd7ff'),
    '--seed', String(Number(opts.seed) || 0),
  ];
  if (opts.title) args.push('--title', String(opts.title));
  if (Number.isFinite(Number(opts.charOffset)) && Number(opts.charOffset) > 0) {
    args.push('--char-offset', String(Number(opts.charOffset)));
  }
  if (opts.bgImage) args.push('--bg', String(opts.bgImage));
  // 小蓝（程序化 RGBA 帧序列）：右下角常驻，不说话也在动
  if (opts.charDir) {
    args.push('--char-dir', String(opts.charDir));
    args.push('--char-size', String(Math.max(80, Math.min(720, Number(opts.charSize) || 300))));
  }
  // 图卡：把这一屏的配图裁成小卡片，右上角滑进来（文字屏也能有一点画面）
  if (opts.card) {
    args.push('--card', String(opts.card));
    args.push('--card-at', String(Number(opts.cardAt) || 0.35));
  }

  const timeoutMs = Math.max(20000, Number(opts.timeoutMs) || 180000);
  const res = await new Promise((resolve) => {
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

  const resultFile = join(outDir, 'result.json');
  let j = null;
  try {
    j = JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch { /* 读不到就看退出码 */ }
  if (j && j.ok === true && Number(j.frames) > 0 && existsSync(join(outDir, '0001.png'))) {
    return {
      ok: true,
      dir: outDir.replace(/\\/g, '/'),
      frames: Number(j.frames),
      fps: Number(j.fps) || fps,
      width: Number(j.w) || Number(opts.width) || 1280,
      height: Number(j.h) || Number(opts.height) || 720,
    };
  }
  return { ok: false, reason: (j && j.error) ? String(j.error).slice(0, 240) : (res.reason || 'unknown') };
}

/** 一屏帧里的第一张（当封面 / 剪映素材） */
export function firstFrame(dir) {
  const p = join(String(dir || ''), '0001.png');
  return existsSync(p) ? p : '';
}
