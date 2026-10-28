/**
 * tools/storyboard.mjs — 工具 `storyboard`：多画面「小剧场」→ 一段 mp4
 *
 * 为什么先做这个而不是"真运动视频"：
 *   6GB 显存跑 AnimateDiff/SVD 会又慢又糊（见 06-绘画与视频.md §六）。
 *   把 N 张图串成一段带淡入的 mp4，观感接近"分镜小动画"，成本只有几次出图。
 *
 * 链路：panels[] →（中文翻英文）→ 逐张出图 → ffmpeg 拼 mp4 → caps.video 直发
 * ffmpeg 用 imageio-ffmpeg 自带的二进制（pip 装的，不需要系统装 ffmpeg）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, draw, translatePrompt } from '../lib/draw-core.mjs';

export const name = 'storyboard';

export const description =
  '把 2~5 个画面串成一小段视频（先出图再拼 mp4）并发到当前会话。只在有人明确要"画个故事/做个视频/来段动画"时用。';

export const inputSchema = {
  panels: {
    type: 'array',
    items: { type: 'string' },
    required: true,
    description: '2~5 个画面的描述（中文即可），按顺序播放',
  },
  secondsPer: { type: 'number', description: '每个画面停留秒数，默认 1.6' },
  size: { type: 'string', enum: ['square', 'wide', 'tall'], description: '画幅，默认 square' },
};

const SIZES = {
  square: { width: 512, height: 512 },
  wide: { width: 640, height: 384 },
  tall: { width: 384, height: 640 },
};

/** 找 imageio-ffmpeg 自带的 ffmpeg.exe */
export function findFfmpeg() {
  const env = String(process.env.QQBOT_FFMPEG || '').trim();
  if (env && existsSync(env)) return env;
  const base = 'F:/qqbot/.venv-draw/Lib/site-packages/imageio_ffmpeg/binaries';
  try {
    if (existsSync(base)) {
      const hit = readdirSync(base).filter((f) => /^ffmpeg.*\.exe$/i.test(f)).sort().pop();
      if (hit) return join(base, hit);
    }
  } catch {
    /* ignore */
  }
  return '';
}

function runFfmpeg(exe, args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, reason: 'ffmpeg-timeout' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      finish({ ok: false, reason: 'ffmpeg-spawn: ' + (e && e.message ? e.message : String(e)) });
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      finish({ ok: code === 0, reason: code === 0 ? '' : 'ffmpeg-exit-' + code });
    });
  });
}

/**
 * 生成 concat 清单（每张图 + 停留时长；末张重复一次，否则最后一张会被吃掉）
 *
 * ⚠️ 引号必须是**单引号**：ffmpeg 的 concat demuxer 只认单引号，
 *    用双引号它会把引号当文件名的一部分 → `Impossible to open '"F:/…png"'`。
 */
export function concatList(paths, secondsPer) {
  const d = Math.max(0.4, Number(secondsPer) || 1.6);
  const q = (p) => "'" + String(p).replace(/\\/g, '/').replace(/'/g, "'" + String.fromCharCode(92) + "''") + "'";
  const lines = [];
  for (const p of paths) {
    lines.push('file ' + q(p));
    lines.push('duration ' + d.toFixed(2));
  }
  lines.push('file ' + q(paths[paths.length - 1]));
  return lines.join(String.fromCharCode(10));
}

/**
 * 拼 mp4。
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, reason?:string}>}
 */
export async function toVideo(paths, outPath, opts = {}) {
  const exe = opts.ffmpeg || findFfmpeg();
  if (!exe) return { ok: false, reason: 'no-ffmpeg（pip install imageio-ffmpeg）' };
  if (!Array.isArray(paths) || paths.length === 0) return { ok: false, reason: 'no-images' };
  const listFile = String(outPath).replace(/\.mp4$/i, '') + '.txt';
  try {
    writeFileSync(listFile, concatList(paths, opts.secondsPer), 'utf8');
  } catch (e) {
    return { ok: false, reason: 'write-list: ' + (e && e.message ? e.message : String(e)) };
  }
  const size = SIZES[String(opts.size || 'square')] || SIZES.square;
  // 偶数宽高 + yuv420p：QQ/微信那类播放器只认这个组合
  const w = size.width % 2 === 0 ? size.width : size.width - 1;
  const h = size.height % 2 === 0 ? size.height : size.height - 1;
  const vf = 'scale=' + w + ':' + h + ',format=yuv420p';
  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-vf', vf,
    '-r', '24',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    String(outPath),
  ];
  const r = await runFfmpeg(exe, args, opts.timeoutMs || 90000);
  try {
    rmSync(listFile, { force: true });
  } catch {
    /* ignore */
  }
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, path: String(outPath), bytes: 0 };
}

async function sendVideo(env, path) {
  const caps = env?.caps;
  if (!caps) return { sent: false, why: '没有 caps（宿主没给能力包）' };
  try {
    if (typeof caps.video === 'function') {
      const r = await caps.video(path);
      if (r !== false) return { sent: true, how: 'caps.video' };
    }
  } catch (e) {
    return { sent: false, why: 'caps.video 抛错: ' + (e && e.message ? e.message : String(e)) };
  }
  try {
    if (typeof caps.media === 'function') {
      const r = await caps.media('video', path);
      if (r !== false) return { sent: true, how: "caps.media('video')" };
    }
  } catch (e) {
    return { sent: false, why: 'caps.media 抛错: ' + (e && e.message ? e.message : String(e)) };
  }
  return { sent: false, why: 'caps.video 返回 false（sender/目标缺失或上传失败）' };
}

export async function run(args, env) {
  const root = String(env?.caps?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot');
  const cfg = loadConfig(root);
  if (cfg.enabled === false) return { ok: false, error: '画画功能关着（draw-config.json 的 enabled=false）' };

  const panels = Array.isArray(args?.panels) ? args.panels.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (panels.length < 2) return { ok: false, error: '至少要 2 个画面（panels）' };
  if (panels.length > 5) return { ok: false, error: '最多 5 个画面（太多了又慢又糊）' };

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    return { ok: false, error: '没有 ffmpeg（imageio-ffmpeg 没装）', hint: 'python -m pip install imageio-ffmpeg' };
  }

  const sizeKey = String(args?.size || 'square');
  const size = SIZES[sizeKey] || SIZES.square;
  const t0 = Date.now();
  const images = [];
  const fails = [];
  for (let i = 0; i < panels.length; i += 1) {
    const zh = panels[i];
    let prompt = zh;
    const isZh = /[\u4e00-\u9fa5]/.test(zh);
    try {
      const tr = await translatePrompt(zh, cfg);
      if (tr.ok && tr.prompt) prompt = tr.prompt;
      else if (isZh) {
        fails.push('第' + (i + 1) + '个画面翻译失败');
        continue;
      }
    } catch {
      /* 用原文 */
    }
    const r = await draw(prompt, { width: size.width, height: size.height }, cfg);
    if (!r.ok) {
      fails.push('第' + (i + 1) + '个画面出图失败: ' + (r.reason || '?'));
      continue;
    }
    images.push(r.path);
  }

  if (images.length < 2) {
    return { ok: false, error: '能用的画面不够 2 张，先别拼视频', detail: fails.slice(0, 3), images };
  }

  let dir = join(String(root), '.qqbot', 'video');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const out = join(dir, 'story-' + Date.now() + '.mp4');
  const v = await toVideo(images, out, { ffmpeg, size: sizeKey, secondsPer: args?.secondsPer });
  if (!v.ok) return { ok: false, error: '拼视频失败：' + v.reason, images };

  const sent = await sendVideo(env, v.path);
  let bytes = 0;
  try {
    bytes = existsSync(v.path) ? statSync(v.path).size : 0;
  } catch {
    bytes = 0;
  }
  const secs = (images.length * (Math.max(0.4, Number(args?.secondsPer) || 1.6))).toFixed(1);
  return {
    ok: true,
    sent: sent.sent,
    path: v.path,
    images,
    frames: images.length,
    seconds: secs,
    ms: Date.now() - t0,
    bytes,
    msg: sent.sent
      ? '小剧场视频已经发到群里了（' + images.length + ' 个画面，约 ' + secs + ' 秒）—— 别再重复描述画面，随口说一句就行'
      : '视频做好了但没发出去（' + sent.why + '），文件在 ' + v.path,
  };
}

export default { name, description, inputSchema, run, expose: 'all' };
