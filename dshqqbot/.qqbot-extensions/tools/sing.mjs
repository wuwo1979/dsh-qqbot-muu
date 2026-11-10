/**
 * sing.mjs — 用她自己的嗓子唱一首歌
 *
 * 链路（skills/voice-sing/scripts/sing.py）：
 *   B 站取歌 → demucs 拆人声/伴奏 → RVC 换声（带 faiss index）→ ffmpeg 混音 mp3
 *
 * 两个坑，改之前先读：
 *   1) 本机执行环境**不允许创建管道**（CreatePipe → WinError 5 拒绝访问），
 *      spawn 必须 stdout/stderr 重定向到文件，不能走 pipe。
 *   2) QQ 语音条上限约 5MB / 60s，所以默认只唱 45 秒当语音条发；
 *      要整首就 full=true，改按文件发。
 *
 * 产物固定落在 F:/qqbot/tmp/sing/<slug>/：
 *   cover.mp3   成品
 *   meta.json   台账（原曲链接、音色、音高、时长、大小）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.QQBOT_ROOT || 'F:/qqbot';
const PY = join(ROOT, '.models', 'voice-sing-venv', 'Scripts', 'python.exe');
const SCRIPT = join(ROOT, 'skills', 'voice-sing', 'scripts', 'sing.py');
const SING_ROOT = join(ROOT, 'tmp', 'sing');

function slugify(s) {
  return String(s || 'song').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'song';
}

function runScript(args, logPath, timeoutMs) {
  return new Promise((resolve) => {
    const fd = openSync(logPath, 'w');
    let child;
    try {
      child = spawn(PY, [SCRIPT, ...args], {
        cwd: ROOT,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          OMP_NUM_THREADS: '1',
          MKL_NUM_THREADS: '1',
          HF_HOME: join(ROOT, 'tmp', 'hf-cache'),
          TORCH_HOME: join(ROOT, 'tmp', 'torch-home'),
        },
        stdio: ['ignore', fd, fd], // ★ 不能用 pipe，见文件头注释
      });
    } catch (e) {
      closeSync(fd);
      resolve({ ok: false, code: -1, log: String(e?.message || e) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      try { closeSync(fd); } catch { /* ignore */ }
      resolve({ ok: false, code: -1, log: String(e?.message || e) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { closeSync(fd); } catch { /* ignore */ }
      let log = '';
      try { log = readFileSync(logPath, 'utf8'); } catch { /* ignore */ }
      resolve({ ok: code === 0, code, log });
    });
  });
}

function readMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 直发：优先 caps.voice，退而求其次 caps.media。 */
async function sendNow(caps, path, kind) {
  if (!caps) return { sent: false, why: '没有 caps' };
  try {
    if (typeof caps.voice === 'function') {
      const r = await caps.voice(path);
      if (r === true) return { sent: true, why: 'caps.voice' };
    }
    if (typeof caps.media === 'function') {
      const r = await caps.media(kind || 'voice', path);
      if (r === true) return { sent: true, why: `caps.media(${kind || 'voice'})` };
      return { sent: false, why: `caps.media 返回 ${String(r)}` };
    }
    return { sent: false, why: 'caps 里没有 voice/media' };
  } catch (e) {
    return { sent: false, why: `直发抛错: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export default {
  name: 'sing',
  description:
    '用她自己的嗓子唱一首歌：按歌名在线取歌 → 拆轨 → 换声 → 混音 → 当语音条发出去。'
    + '有人点歌（"唱xx""来一首xx"）就用它。默认只唱 45 秒（语音条限长），full=true 才整首。'
    + 'action=check 只看环境；action=last 看最近唱过什么。',
  inputSchema: {
    action: {
      type: 'string',
      description: 'sing(默认，唱并发出) | check(自检) | last(最近成品)',
    },
    song: { type: 'string', description: 'sing 必填：歌名或关键词，如「茶花开了」' },
    style: { type: 'string', description: '音色：child(默认，童真) | normal' },
    pitch: { type: 'number', description: '可选：覆盖半音，童真默认 +3（甜而不飘；+4 发尖，+2 偏大人）' },
    seconds: { type: 'number', description: '唱多少秒，默认 45，上限 240' },
    full: { type: 'boolean', description: 'true 才整首（按文件发，不走语音条）' },
    send: { type: 'boolean', description: '默认 true 发出去；false 只生成' },
  },

  run: async (args, env) => {
    const log = env?.logger || console;
    const action = String(args?.action || 'sing').trim();

    if (action === 'check') {
      return {
        ok: existsSync(PY) && existsSync(SCRIPT),
        python: existsSync(PY),
        script: existsSync(SCRIPT),
        root: SING_ROOT,
      };
    }

    if (action === 'last') {
      try {
        const dirs = readdirSync(SING_ROOT)
          .map((d) => ({ d, p: join(SING_ROOT, d) }))
          .filter((x) => existsSync(join(x.p, 'cover.mp3')))
          .map((x) => ({ ...x, mtime: statSync(join(x.p, 'cover.mp3')).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 5);
        return { ok: true, items: dirs.map((x) => ({ name: x.d, meta: readMeta(x.p) })) };
      } catch (e) {
        return { ok: false, msg: String(e?.message || e) };
      }
    }

    const song = String(args?.song || '').trim();
    if (!song) return { ok: false, msg: '要唱哪首？给个歌名（sing 的 song 参数）' };

    const full = args?.full === true;
    let seconds = Number(args?.seconds || 45);
    if (!Number.isFinite(seconds) || seconds <= 0) seconds = 45;
    seconds = Math.min(seconds, 240);

    if (!existsSync(PY)) return { ok: false, msg: `唱歌环境没就位：缺 ${PY}` };
    if (!existsSync(SCRIPT)) return { ok: false, msg: `唱歌脚本没就位：缺 ${SCRIPT}` };

    const dir = join(SING_ROOT, slugify(song));
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, 'run.log');

    const argv = ['--song', song, '--out', dir, '--style', String(args?.style || 'child')];
    if (args?.pitch !== undefined && args?.pitch !== null && args?.pitch !== '') {
      argv.push('--pitch', String(args.pitch));
    }
    if (!full) argv.push('--max-seconds', String(seconds));

    log?.info?.(`[sing] 开唱 ${song}（${full ? '整首' : seconds + '秒'}）→ ${dir}`);
    const r = await runScript(argv, logPath, full ? 20 * 60_000 : 8 * 60_000);
    const meta = readMeta(dir);
    if (!r.ok || !meta) {
      const tail = String(r.log || '').split('\n').filter(Boolean).slice(-6).join(' | ');
      return { ok: false, msg: `没唱成（rc=${r.code}）：${tail.slice(0, 400)}` };
    }

    const audio = meta.audio || join(dir, 'cover.mp3');
    const kb = Math.round((meta.bytes || 0) / 1024);
    const out = {
      ok: true,
      song: meta.song,
      url: meta.url,
      seconds: meta.seconds,
      kb,
      audio,
      style: meta.style,
      pitch: meta.pitch,
      elapsedSec: meta.elapsedSec,
      sent: false,
    };

    if (args?.send === false) {
      out.msg = `唱好了：${audio}（${meta.seconds.toFixed(1)}s，${kb}KB），没发`;
      return out;
    }

    // 整首 > 60s 走文件；语音条走 voice
    const kind = full || meta.seconds > 60 ? 'file' : 'voice';
    const direct = await sendNow(env?.caps, audio, kind);
    out.kind = kind;
    out.sent = direct.sent;
    out.via = direct.why;
    out.msg = direct.sent
      ? `唱完发出去了：${meta.song}（${meta.seconds.toFixed(1)}s，${kb}KB，${direct.why}）—— 别再补一句"我发了"`
      : `唱好了但没发出去（${direct.why}）：${audio}`;
    log?.info?.(`[sing] ${direct.sent ? '已发' : '未发'} ${meta.song} ${kb}KB via ${direct.why}`);
    return out;
  },
};
