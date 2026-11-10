/**
 * lib/media-tools.mjs — 面试视频的服务端处理（不把原始大文件塞进模型）
 *
 * 只做三件事：
 *   ① 定位本机 ffmpeg（优先环境变量，其次扩展内 tools/，最后回落到 Python 的 imageio-ffmpeg）
 *   ② 从任意客户端上传的视频里抽 16k 单声道 WAV / 关键帧
 *   ③ 用本机 Windows 语音识别把 WAV 转成文字
 *
 * 约束：
 *   · 全程走磁盘临时文件，不在 Node 里缓存整段视频；
 *   · 子进程都带超时，超时就杀；
 *   · 转写结果只写进调用方指定的 secrets 目录，日志不碰内容。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));   // …/.qqbot-extensions/lib
const EXT_DIR = dirname(HERE);

let cachedFfmpeg = '';

/**
 * 解码子进程/文本文件内容 —— ★ 2026-11-08 乱码修复。
 *
 * 背景：中文 Windows 上 PowerShell 的 stdout/stderr 走 OEM 936(GBK)，
 * Node 按 UTF-8 解码会得到一串 `\uFFFD`（界面/日志里就是 `[�����]`）。
 * 做法：先处理 BOM（UTF-16LE / UTF-8），按 UTF-8 解码；若替换字符占比过高，
 * 再用 `gb18030` 重解一次兜底（也能读回历史旧记录）。
 * @param {Buffer|Uint8Array|string} buf
 * @returns {string}
 */
export function decodeTextBuffer(buf) {
  if (buf === undefined || buf === null) return '';
  if (typeof buf === 'string') return buf.replace(/^\uFEFF/, '');
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!b.length) return '';
  if (b[0] === 0xFF && b[1] === 0xFE) return b.subarray(2).toString('utf16le').replace(/^\uFEFF/, '');
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
  const utf8 = b.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (!bad) return utf8;
  if (bad / Math.max(1, utf8.length) > 0.02) {
    try { return new TextDecoder('gb18030').decode(b); } catch { /* 没 ICU 就不能兜底 */ }
  }
  return utf8;
}

/** 找 ffmpeg：环境变量 → 扩展自带 → imageio-ffmpeg（Python 包） */
export function ffmpegPath() {
  if (cachedFfmpeg) return cachedFfmpeg;
  const env = String(process.env.QQBOT_FFMPEG || '').trim();
  if (env && existsSync(env)) { cachedFfmpeg = env; return cachedFfmpeg; }
  const cands = [
    join(EXT_DIR, 'tools', 'ffmpeg.exe'),
    join(EXT_DIR, 'tools', 'ffmpeg'),
  ];
  for (const p of cands) {
    if (existsSync(p)) { cachedFfmpeg = p; return cachedFfmpeg; }
  }
  for (const py of ['python', 'py']) {
    try {
      const out = execFileSync(py, ['-c', 'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      }).trim();
      if (out && existsSync(out)) { cachedFfmpeg = out; return cachedFfmpeg; }
    } catch { /* try next */ }
  }
  throw new Error('找不到 ffmpeg：可设置 QQBOT_FFMPEG 或安装 imageio-ffmpeg');
}

/**
 * 跑一次 ffmpeg，返回 stderr（ffmpeg 的进度都打在 stderr）。
 * @param {string[]} args
 * @param {{timeoutMs?:number, allowFail?:boolean, maxStderr?:number}} [opts]
 */
export function runFfmpeg(args, opts = {}) {
  const exe = ffmpegPath();
  const timeoutMs = Number(opts.timeoutMs) || 120000;
  const maxStderr = Number(opts.maxStderr) || 6000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let stderrChunks = [];
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
      const joined = Buffer.concat(stderrChunks);
      if (joined.length > maxStderr) stderrChunks = [joined.subarray(joined.length - maxStderr)];
    });
    const errText = () => decodeTextBuffer(Buffer.concat(stderrChunks));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`ffmpeg 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = errText();
      if (code === 0 || opts.allowFail) { resolve({ code, stderr }); return; }
      reject(new Error(`ffmpeg 退出码 ${code}：${stderr.slice(-240)}`));
    });
  });
}

/** 读视频时长（秒）：解析 ffmpeg -i 的 Duration 行，不 decode 整段 */
export async function probeDuration(file, timeoutMs = 30000) {
  const r = await runFfmpeg(['-hide_banner', '-i', file], { timeoutMs, allowFail: true });
  const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(r.stderr || '');
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 抽音频：16k / 单声道 / 16bit PCM，给 Windows 语音识别用 */
export async function extractWav(input, output, opts = {}) {
  const maxSeconds = Number(opts.maxSeconds) || 120;
  await runFfmpeg([
    '-hide_banner', '-y', '-i', input,
    '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16',
    '-t', String(maxSeconds),
    output,
  ], { timeoutMs: Number(opts.timeoutMs) || 120000 });
  return output;
}

/** 抽一帧 JPG，宽度默认 320，保持等比 */
export async function extractFrame(input, output, atSec, opts = {}) {
  const width = Number(opts.width) || 320;
  await runFfmpeg([
    '-hide_banner', '-y',
    '-ss', String(Math.max(0, Number(atSec) || 0)),
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '4',
    output,
  ], { timeoutMs: Number(opts.timeoutMs) || 60000 });
  return output;
}

/**
 * 调本机 Windows 语音识别。
 * @returns {Promise<{ok:boolean,text:string,engine:string,error?:string}>}
 */
export function transcribeWav(wavPath, opts = {}) {
  const script = join(EXT_DIR, 'interview', 'asr-win.ps1');
  const outPath = String(opts.outPath || '');
  const timeoutMs = Number(opts.timeoutMs) || 300000;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-WavPath', wavPath, '-OutPath', outPath,
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, text: '', engine: 'windows-speech', error: String((e && e.message) || e) });
      return;
    }
    let stderrChunks = [];
    child.stderr.on('data', (c) => {
      stderrChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
      const joined = Buffer.concat(stderrChunks);
      if (joined.length > 4000) stderrChunks = [joined.subarray(joined.length - 4000)];
    });
    const errText = () => decodeTextBuffer(Buffer.concat(stderrChunks)).replace(/^\uFEFF/, '').trim();
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, text: '', engine: 'windows-speech', error: '转写超时' });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: '', engine: 'windows-speech', error: String((e && e.message) || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = errText();
        resolve({
          ok: false, text: '', engine: 'windows-speech',
          error: `识别器退出码 ${code}${detail ? '：' + detail.slice(-240) : ''}`,
        });
        return;
      }
      try {
        const raw = decodeTextBuffer(readFileSync(outPath)).replace(/^\uFEFF/, '').trim();
        resolve({ ok: !!raw, text: raw, engine: 'windows-speech', error: raw ? '' : '没有识别到文字' });
      } catch (e) {
        resolve({ ok: false, text: '', engine: 'windows-speech', error: String((e && e.message) || e) });
      }
    });
  });
}
