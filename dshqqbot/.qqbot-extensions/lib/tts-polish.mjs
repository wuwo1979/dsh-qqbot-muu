/**
 * tts-polish.mjs — 让合成音"像人说话"，而不是"逐句朗诵"
 *
 * 用户反馈的原话是「音色不错但没人味，闭音过重，不够连贯，太过于抑扬顿挫」。
 * 注意最后那句：问题不是起伏不够，而是**起伏过头**。拆开是三个成因：
 *
 *   1) tts-core 的 jitterProsody 给每句独立随机 ±rate/pitch。句与句之间语速
 *      语调乱跳，听感就是"一句一句念"。真人说话是**缓慢漂移**的，不是跳变。
 *   2) edge-tts 在句号处会明显降调。文本里句号越密，"一顿一顿"越重。
 *   3) 整段一次性合成，句间没有换气，长句连着往前冲。
 *
 * 对策（按层）：
 *   · 段落层：按句切成 ≤~40 字的段，段间插**确定性静音**（90~280ms，按标点
 *     类型分级）。呼吸只发生在段与段之间，段内参数完全不动。
 *   · 参数层：全篇用同一个 rate/pitch（降速到温柔档），**不做逐句抖动**。
 *   · 文本层：过密句号降级为逗号、省略号转长停顿、英文/数字规范化。
 *   · 波形层：PCM 拼接后首尾各做 6ms 淡入淡出（防爆音）。
 *   · 音色层：ffmpeg 后处理 —— 高通去闷、5kHz 轻削压掉"闭音过重"的齿音与
 *     爆破、轻压缩贴耳、响度归一到 -16 LUFS。
 *
 * 为什么在 Node 里拼 PCM 而不是用 ffmpeg concat：
 *   本机子进程不能管道捕获 stdio（spawn 用 pipe 会 EPERM），所以每段先落到
 *   临时 raw 文件，再在内存里拼 Buffer。插静音就是补零，比拼 ffmpeg 命令
 *   短得多，也不用为每个停顿生成静音文件。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { synthesize } from './tts-core.mjs';

const SR = 24000;            // edge-tts 输出采样率
const BYTES_PER_SAMPLE = 2;  // s16le

// ── ffmpeg ──────────────────────────────────────────────────────────────
export function findFfmpeg() {
  const env = String(process.env.QQBOT_FFMPEG || '').trim();
  if (env && existsSync(env)) return env;
  const base = 'F:/qqbot/.venv-draw/Lib/site-packages/imageio_ffmpeg/binaries';
  try {
    if (existsSync(base)) {
      const hit = readdirSync(base).filter((f) => /^ffmpeg.*\.exe$/i.test(f)).sort().pop();
      if (hit) return join(base, hit);
    }
  } catch { /* ignore */ }
  return '';
}

function run(exe, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      return finish({ ok: false, error: String(e?.message || e) });
    }
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); finish({ ok: false, error: String(e?.message || e) }); });
    child.on('exit', (code) => { clearTimeout(t); finish({ ok: code === 0, code }); });
  });
}

// ── 文本层 ──────────────────────────────────────────────────────────────
/**
 * 中文口语化规整。只做"不改语义、但影响朗读节奏"的事：
 *   · 连续句号折叠；过短的句号连缀降级成逗号（少一次降调）
 *   · 省略号/破折号保留，交给分段逻辑换成停顿
 *   · 英文缩写与纯数字给个读法提示
 *   · 括号注释按长度决定念不念（短的当插入语，长的丢掉）
 */
export function polishText(text) {
  let t = String(text ?? '');
  if (!t.trim()) return '';

  // 1) 全角空格、零宽字符、重复空白
  t = t.replace(/[\u200b-\u200f\ufeff]/g, '').replace(/[\u3000\s]+/g, ' ').trim();

  // 2) 长括号注释念出来很怪：>10 字直接丢，短的转成插入语
  t = t.replace(/[（(【\[]([^）)】\]]{0,40}?)[）)】\]]/g, (m, inner) => {
    const s = String(inner || '').trim();
    if (!s) return '';
    if (/^[\u4e00-\u9fa5，、！？]{1,10}$/.test(s)) return `，${s}，`;
    return ' ';
  });

  // 3) 标点折叠
  t = t.replace(/([！？!?])\1+/g, '$1');
  t = t.replace(/[，,]{2,}/g, '，');
  t = t.replace(/…{2,}/g, '…');
  t = t.replace(/([。.])\1+/g, '$1');

  // 4) 英文缩写 → 中文读法（edge 读 "AI" 还行，但 "e.g." / "vs" 会念字母串）
  t = t.replace(/\be\.g\./gi, '例如').replace(/\bi\.e\./gi, '也就是')
    .replace(/\bvs\.?\b/gi, '对比').replace(/&/g, '和');

  // 5) 数字与单位之间留空，避免"3 个"被读成"三个"
  t = t.replace(/(\d)([年月日时分秒个只条块米克斤元人岁天次])/g, '$1 $2');

  // 6) 句号连缀降级：两个都很短的句子之间改用逗号，少一次降调
  //    （人说话很少"短句。短句。短句"地蹦，更多是一口气带过去）
  t = t.replace(/([\u4e00-\u9fa5]{1,6})。([\u4e00-\u9fa5]{1,6})。/g, '$1，$2。');

  t = t.replace(/\s+([，,。！？!?…；;])/g, '$1');
  t = t.replace(/[，,]\s*([。！？!?…；;])/g, '$1');
  return t.trim();
}

const PAUSE = {
  '。': 170, '！': 150, '？': 165, '!': 150, '?': 165,
  '…': 280, '；': 130, ';': 130, '，': 88, ',': 88,
  '、': 62, '：': 110, ':': 110,
};

/**
 * 切段 + 给每段定停顿。返回 [{ text, pauseMs }]
 * 段太长（>40 字）就按逗号再切，避免一口气念不完。
 */
export function planBreath(text, opts = {}) {
  const maxLen = Number(opts.maxLen) > 0 ? Number(opts.maxLen) : 40;
  const t = polishText(text);
  if (!t) return [];

  // 按句末标点切，但保留标点用于判断停顿类型
  const rough = [];
  let buf = '';
  for (const ch of t) {
    buf += ch;
    if ('。！？!?…；;'.includes(ch)) {
      rough.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) rough.push(buf);

  const out = [];
  for (const seg of rough) {
    const s = seg.trim();
    if (!s) continue;
    const pieces = s.length <= maxLen ? [s] : splitLong(s, maxLen);
    for (const p of pieces) {
      const last = p.trim().slice(-1);
      const pauseMs = PAUSE[last] ?? 90;
      out.push({ text: p.trim(), pauseMs });
    }
  }
  // 末段不需要收尾停顿
  if (out.length) out[out.length - 1].pauseMs = 0;
  return out;
}

function splitLong(s, maxLen) {
  const parts = [];
  let buf = '';
  for (const ch of s) {
    buf += ch;
    if (buf.length >= maxLen && '，,、：:'.includes(ch)) {
      parts.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) {
    // 太长的尾巴硬切，尽量在标点处
    let rest = buf;
    while (rest.length > maxLen * 1.6) {
      parts.push(rest.slice(0, maxLen));
      rest = rest.slice(maxLen);
    }
    if (rest.trim()) parts.push(rest);
  }
  return parts.filter((x) => x.trim());
}

// ── 参数层 ──────────────────────────────────────────────────────────────
/**
 * 温柔档的参数。关键在**不做逐句抖动**：一个参数贯穿全篇，
 * 句间的变化只来自停顿，这才是"平稳地说完一段话"。
 */
export function warmProsody(opts = {}) {
  const baseRate = Number(opts.ratePct);       // 允许直接指定
  const rate = Number.isFinite(baseRate)
    ? (baseRate >= 0 ? `+${baseRate}%` : `${baseRate}%`)
    : (opts.rate || '-6%');
  const basePitch = Number(opts.pitchHz);
  const pitch = Number.isFinite(basePitch)
    ? (basePitch >= 0 ? `+${basePitch}Hz` : `${basePitch}Hz`)
    : (opts.pitch || '-1Hz');
  return { rate, pitch };
}

/**
 * ffmpeg 后处理链。
 *   highpass 78Hz      —— 去掉胸腔轰鸣与房间低频，人声更"近"
 *   eq 5200Hz -2.6dB   —— 这一段最刺耳，是"闭音过重"的主要来源
 *   eq 240Hz  +1.2dB   —— 补回一点厚度，别削得太薄
 *   acompressor        —— 轻压缩，把气声抬起来，贴耳感
 *   loudnorm -16LUFS   —— 和 BGM 混音时不用再手动对电平
 */
export function postFilter(opts = {}) {
  const lufs = Number.isFinite(Number(opts.lufs)) ? Number(opts.lufs) : -16;
  return [
    'highpass=f=78',
    'equalizer=f=5200:t=q:w=1.6:g=-2.6',
    'equalizer=f=240:t=q:w=1.0:g=1.2',
    'acompressor=threshold=-18dB:ratio=2.2:attack=8:release=170',
    `loudnorm=I=${lufs}:TP=-1.5:LRA=9`,
  ].join(',');
}

// ── 波形层 ──────────────────────────────────────────────────────────────
function silence(ms) {
  const n = Math.round((SR * ms) / 1000) * BYTES_PER_SAMPLE;
  return Buffer.alloc(Math.max(0, n));
}

/**
 * 裁掉一段 PCM 末尾的静音，只留 keepMs。
 *
 * 为什么必须裁：edge-tts 在每个句号后自己会吐掉约 600~800ms 静音，我再补
 * 170ms 就变成近 1 秒的空档，听感是"说一句、停一下、再说一句"——这正是
 * 用户说的不连贯。句间停顿必须由我们自己定，就得先把自带的静音削平。
 */
function trimTailSilence(buf, threshold = 340, keepMs = 45) {
  const n = Math.floor(buf.length / BYTES_PER_SAMPLE);
  if (n <= 0) return buf;
  let end = n - 1;
  while (end > 0) {
    if (Math.abs(buf.readInt16LE(end * BYTES_PER_SAMPLE)) > threshold) break;
    end -= 1;
  }
  const keep = Math.round((SR * keepMs) / 1000);
  const cut = Math.min(n, end + 1 + keep) * BYTES_PER_SAMPLE;
  return cut < buf.length ? buf.subarray(0, cut) : buf;
}

/** 裁掉开头的静音，只留 keepMs。 */
function trimHeadSilence(buf, threshold = 340, keepMs = 30) {
  const n = Math.floor(buf.length / BYTES_PER_SAMPLE);
  if (n <= 0) return buf;
  let start = 0;
  while (start < n) {
    if (Math.abs(buf.readInt16LE(start * BYTES_PER_SAMPLE)) > threshold) break;
    start += 1;
  }
  const keep = Math.round((SR * keepMs) / 1000);
  const from = Math.max(0, start - keep) * BYTES_PER_SAMPLE;
  return from > 0 ? buf.subarray(from) : buf;
}

/** s16le 首尾各做 fadeMs 的线性淡入淡出，避免起止爆音。 */
function applyFade(buf, fadeMs = 6) {
  const n = Math.min(Math.round((SR * fadeMs) / 1000), Math.floor(buf.length / BYTES_PER_SAMPLE / 2));
  if (n <= 0) return buf;
  const out = Buffer.from(buf);
  for (let i = 0; i < n; i += 1) {
    const g = i / n;
    const head = i * BYTES_PER_SAMPLE;
    const tail = out.length - (i + 1) * BYTES_PER_SAMPLE;
    const vh = out.readInt16LE(head);
    const vt = out.readInt16LE(tail);
    out.writeInt16LE(Math.round(vh * g), head);
    out.writeInt16LE(Math.round(vt * g), tail);
  }
  return out;
}

// ── 合成（带退避重试）──────────────────────────────────────────────────
/**
 * edge-tts 会间歇性 `exit 2 / 0 bytes`（限流或瞬时抖动）。tts-core 内部只
 * 重试一次，分段合成时任何一段失败都会让整条音频退化，所以这里再包一层，
 * 失败后指数退避重来。全部失败才把错误上抛。
 */
async function synthWithRetry(text, opts, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await synthesize(text, opts);
    if (r.ok) return r;
    last = r;
    if (i < tries - 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, 420 * (i + 1)));
    }
  }
  return last || { ok: false, error: 'unknown' };
}

// ── 主入口 ──────────────────────────────────────────────────────────────
/**
 * @param {string} text
 * @param {object} opts
 *   voice, dataRoot, ffmpeg,
 *   rate / pitch（字符串）或 ratePct / pitchHz（数字）
 *   maxLen        单段上限字数（默认 40）
 *   breath        段间停顿缩放（默认 1.0；0 = 不插静音）
 *   post          是否做 ffmpeg 后处理（默认 true）
 *   lufs          目标响度（默认 -16）
 * @returns {Promise<{ok:true,path:string,ms:number,seconds:number,parts:number,rate:string,pitch:string,bytes:number}
 *                  | {ok:false,error:string}>}
 */
export async function synthesizeWarm(text, opts = {}) {
  const started = Date.now();
  const parts = planBreath(text, opts);
  if (!parts.length) return { ok: false, error: 'empty text' };

  const { rate, pitch } = warmProsody(opts);
  const breath = Number.isFinite(Number(opts.breath)) ? Number(opts.breath) : 1.0;

  // 逐段合成：同一个 rate/pitch，不抖动
  const segs = [];
  for (let i = 0; i < parts.length; i += 1) {
    const r = await synthWithRetry(parts[i].text, {
      ...opts,
      rate, pitch,
      jitter: false,
      speak: false,
      keep: 200,
    });
    if (!r.ok) {
      // 任何一段失败就整体回退成"一次合成"，宁可没呼吸也不能没声音
      const whole = await synthWithRetry(
        parts.map((p) => p.text).join(''),
        { ...opts, rate, pitch, jitter: false },
        2,
      );
      return whole.ok
        ? { ...whole, parts: 1, fallback: 'single-pass', rate, pitch, seconds: Number((whole.ms / 1000).toFixed(2)) }
        : { ok: false, error: 'seg ' + (i + 1) + ': ' + r.error + ' / whole: ' + whole.error };
    }
    segs.push({ path: r.path, pauseMs: parts[i].pauseMs, text: parts[i].text });
  }

  const ffmpeg = String(opts.ffmpeg || findFfmpeg());
  // 只有一段、或者没有 ffmpeg、或者明确关掉后处理 → 直接给原始单段
  if (segs.length === 1 || !ffmpeg || opts.post === false) {
    const one = segs.length === 1 ? segs[0] : null;
    if (one) {
      return {
        ok: true, path: one.path, ms: 0, bytes: 0,
        parts: 1, rate, pitch, engine: 'edge', post: false,
        ms_elapsed: Date.now() - started,
      };
    }
  }

  // 临时目录不要用系统 Temp：本机 ffmpeg 往 %TEMP% 写会被拒（exit -13，
  // 表现成 "ffmpeg-decode-failed"）。放在 dataRoot/tmp 下才稳定可写。
  const baseTmp = String(opts.tmpDir || '').trim()
    || (opts.dataRoot ? join(String(opts.dataRoot), 'tmp') : '')
    || tmpdir();
  let dir;
  try {
    mkdirSync(baseTmp, { recursive: true });
    dir = mkdtempSync(join(baseTmp, 'qqs-tts-'));
  } catch (e) {
    return { ok: true, path: segs[0].path, parts: 1, rate, pitch, post: false, warn: 'tmpdir: ' + (e?.message || e) };
  }

  const chunks = [];
  const dbg = String(process.env.QQBOT_TTS_DEBUG || '') === '1';
  for (let i = 0; i < segs.length; i += 1) {
    const rawPath = join(dir, `s${i}.raw`);
    const conv = await run(ffmpeg, ['-y', '-i', segs[i].path, '-f', 's16le', '-ac', '1', '-ar', String(SR), '-loglevel', 'error', rawPath]);
    if (dbg) {
      console.error('[tts-polish] decode', i, 'ok=' + conv.ok, 'code=' + conv.code, 'err=' + (conv.error || '-'),
        'exists=' + existsSync(rawPath), 'raw=' + rawPath, 'in=' + segs[i].path);
    }
    if (!conv.ok || !existsSync(rawPath)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: true, path: segs[0].path, parts: 1, rate, pitch, post: false, warn: 'ffmpeg-decode-failed' };
    }
    chunks.push(trimTailSilence(trimHeadSilence(readFileSync(rawPath))));
    const pause = Math.round(segs[i].pauseMs * breath);
    if (i < segs.length - 1 && pause > 0) chunks.push(silence(pause));
  }

  const pcm = applyFade(Buffer.concat(chunks), Number(opts.fadeMs) > 0 ? Number(opts.fadeMs) : 6);
  const rawAll = join(dir, 'all.raw');
  writeFileSync(rawAll, pcm);

  const wantMp3 = String(opts.format || 'mp3').toLowerCase() !== 'wav';
  const outPath = opts.outPath
    ? String(opts.outPath)
    : join(dir, wantMp3 ? 'warm.mp3' : 'warm.wav');

  const af = opts.post === false ? '' : postFilter(opts);
  const encArgs = ['-y', '-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', rawAll];
  if (af) encArgs.push('-af', af);
  if (wantMp3) encArgs.push('-c:a', 'libmp3lame', '-b:a', '64k');
  encArgs.push('-loglevel', 'error', outPath);

  const enc = await run(ffmpeg, encArgs, 90000);
  if (!enc.ok || !existsSync(outPath)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: true, path: segs[0].path, parts: 1, rate, pitch, post: false, warn: 'ffmpeg-encode-failed' };
  }

  const seconds = Number((pcm.length / BYTES_PER_SAMPLE / SR).toFixed(2));
  return {
    ok: true,
    path: outPath,
    ms: Math.round(seconds * 1000),
    seconds,
    parts: segs.length,
    rate,
    pitch,
    post: !!af,
    bytes: pcm.length,
    engine: 'edge',
    ms_elapsed: Date.now() - started,
  };
}

export default { synthesizeWarm, polishText, planBreath, warmProsody, postFilter, findFfmpeg };
