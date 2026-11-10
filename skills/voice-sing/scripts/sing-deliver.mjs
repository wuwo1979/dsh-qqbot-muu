#!/usr/bin/env node
/**
 * sing-deliver.mjs —— 「唱一首」全链：取歌 → 拆轨 → RVC 童真音色换声 → 混音 → 发到微信。
 *
 * 为什么单独写：微信桥接被 WCX v345 判成只读，/wx/send* 全 503；
 * 直连平板 3001 的 `/api/messages/voice` 实测可用（`{"success":true}`），
 * 所以点歌的最后一公里走 send-direct.mjs，不走桥接。
 *
 * 用法：
 *   node sing-deliver.mjs --song "茶花开了" --conv <wxid|xxx@chatroom>
 *   node sing-deliver.mjs --song "茶花开了" --conv <...> --full        # 整首按文件发
 *   node sing-deliver.mjs --song "茶花开了" --conv <...> --dry         # 只生成不发
 *   node sing-deliver.mjs --song "茶花开了" --conv <...> --pitch 6     # 换半音
 *
 * 默认只唱 45 秒当语音条（微信语音条不支持超长），--full 才整首。
 * 产物固定落 F:/qqbot/media/sing/<slug>-<style>/cover.mp3 + meta.json（本地留档）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, closeSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));           // …/skills/voice-sing/scripts
const REPO = dirname(dirname(dirname(HERE)));                    // F:/qqbot
const VENV_PY = join(REPO, '.models', 'voice-sing-venv', 'Scripts', 'python.exe');
const SING_PY = join(HERE, 'sing.py');
const SEND = join(REPO, 'wechat-bridge', 'send-direct.mjs');
const FFMPEG = join(REPO, '.venv-draw', 'Lib', 'site-packages', 'imageio_ffmpeg',
  'binaries', 'ffmpeg-win-x86_64-v7.1.exe');
const MEDIA = join(REPO, 'media', 'sing');
const TMP = join(REPO, 'tmp', 'sing');
// DSH 若以 Electron 跑，process.execPath 是 GUI 程序；优先用系统 node 跑子脚本
const NODE = existsSync('F:/nodejs/node.exe') ? 'F:/nodejs/node.exe' : process.execPath;
// 语音条必须自己编 silk：平板那头的转码器是坏的（喂 mp3/wav/amr 全是噪音）
const MKSILK = join(HERE, 'mksilk.mjs');

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const slug = (s) => String(s).replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'song';

function run(cmd, args, logPath, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve) => {
    const fd = openSync(logPath, 'a');
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', fd, fd], windowsHide: true });
    } catch (e) {
      closeSync(fd);
      resolve({ code: -1, error: String(e?.message || e) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer); closeSync(fd);
      resolve({ code: -1, error: String(e?.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer); closeSync(fd);
      resolve({ code });
    });
  });
}

/** 从 stdin 拿不到管道（本机 CreatePipe 被禁），所以从日志文件尾部找最后一行 JSON */
function lastJsonLine(logPath) {
  try {
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const t = lines[i].trim();
      if (t.startsWith('{') && t.endsWith('}')) { try { return JSON.parse(t); } catch { /* next */ } }
    }
  } catch { /* ignore */ }
  return null;
}

const main = async () => {
  const song = arg('song', '').trim();
  const conv = arg('conv', '').trim();
  const style = arg('style', 'child');
  const pitch = arg('pitch', '');
  const seconds = arg('seconds', '');
  const dry = has('dry');
  const full = has('full');

  if (!song) { process.stdout.write(JSON.stringify({ ok: false, error: '要 --song <歌名>' }) + '\n'); process.exit(2); }
  if (!dry && !conv) { process.stdout.write(JSON.stringify({ ok: false, error: '要 --conv <wxid 或 群@chatroom>' }) + '\n'); process.exit(2); }

  for (const d of [MEDIA, TMP]) { try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }

  const name = slug(song);
  // 整首和 45 秒片段的成品不能共用目录，否则 --full 会直接拿到缓存的短版发出去
  const tag = full ? 'full' : `${seconds || 45}s`;
  const outDir = join(MEDIA, `${name}-${style}-${tag}`);
  mkdirSync(outDir, { recursive: true });
  const cover = join(outDir, 'cover.mp3');

  // 整首才用满时长；语音条默认 45 秒
  const maxSeconds = seconds || (full ? '' : '45');

  let gen = { cached: false };
  if (existsSync(cover)) {
    gen.cached = true;
  } else {
    const log = join(TMP, `${name}-${style}.log`);
    const args = [SING_PY, '--song', song, '--style', style, '--out', outDir];
    if (maxSeconds) args.push('--max-seconds', String(maxSeconds));
    if (pitch) args.push('--pitch', String(pitch));
    const r = await run(VENV_PY, args, log);
    const meta = lastJsonLine(log);
    if (r.code !== 0 || !existsSync(cover)) {
      process.stdout.write(JSON.stringify({
        ok: false, stage: 'sing', code: r.code, error: r.error || '生成失败', log, meta,
      }) + '\n');
      process.exit(1);
    }
    gen = { cached: false, meta };
  }

  const metaPath = join(outDir, 'meta.json');
  let meta = gen.meta;
  if (!meta) { try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { meta = null; } }

  const result = { ok: true, song, style, cover, seconds: meta?.seconds ?? null, bytes: meta?.bytes ?? null, url: meta?.url || '', cached: gen.cached };

  // 维护一份总索引：主人问「都唱过什么、存哪了」时直接看这个（dry 也记，方便查库存）
  const recordIndex = () => {
    try {
      const idxPath = join(MEDIA, 'index.json');
      let idx = [];
      try { idx = JSON.parse(readFileSync(idxPath, 'utf8')); } catch { idx = []; }
      if (!Array.isArray(idx)) idx = [];
      idx = idx.filter((x) => x && x.dir !== outDir);
      idx.unshift({
        song, style, seconds: result.seconds, bytes: result.bytes,
        cover: result.cover, url: result.url, mode: result.mode || 'dry',
        sent: Boolean(result.sent), conv: result.conv || '',
        dir: outDir, at: new Date().toISOString(),
      });
      writeFileSync(idxPath, JSON.stringify(idx.slice(0, 200), null, 1), 'utf8');
    } catch { /* 索引失败不影响发货 */ }
  };

  if (dry) {
    result.sent = false;
    recordIndex();
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  // 语音条走 --voice（平板 /api/messages/voice）；整首走 --file
  const mode = full ? 'file' : 'voice';
  // child/normal 都走 luomi（见 sing.py 的 STYLES），用来挑 work/conv-<voice>.wav
  const lvoice = 'luomi';
  // 修（2026-11-09）：微信语音条最终会被转成 silk 窄带（8k/16k）。直接喂 44.1k 立体声，
  // 平板转码时重采样容易出「变速变调」——用户听到的就是「乱、基频不对」。
  // 这里先自己压成 16k 单声道再发，转码侧不用再重采样，音准就稳了。
  // 2026-11-09 定稿：平板 /api/messages/voice 那头的转码器是坏的——喂 mp3/wav/amr
  // 出去的语音条在微信里全是噪音（三种格式都实测过）。现在自己编码成微信原生 silk
  // （24k 单声道 PCM → silk-wasm），把 .silk 交给平板，实测能正常播放。采样率别改。
  let sendFile = cover;
  if (mode === 'voice') {
    // 2026-11-09 四调：语音条默认发**清唱**。silk 的码率是写死的（silk-wasm 没有码率参数），
    // 带伴奏时伴奏会抢走大量比特，人声只剩一层沙——用户反复说「还是很沙」就是这个。
    // 所以语音条优先取 RVC 换声后、混音前的干声 work/conv-*.wav；想听完整伴奏就用 --full 发文件。
    let src = cover;
    const wdir = join(outDir, 'work');
    try {
      const cand = readdirSync(wdir).filter((f) => f.startsWith('conv-') && f.endsWith('.wav'));
      if (cand.length) {
        const pick = cand.find((f) => f.includes(lvoice)) || cand[0];
        src = join(wdir, pick);
        result.source = 'vocal-dry';
      }
    } catch { /* 没有 work 目录就退回混音版 */ }
    const pcm = join(outDir, 'cover-wx.pcm');
    const silkFile = join(outDir, 'cover-wx.silk');
    const flog = join(TMP, `${name}-${style}-silk.log`);
    const fr = await run(FFMPEG, ['-y', '-hide_banner', '-i', src,
      // 别下猛药：afftdn 开到 10 会把底噪修成「水声/幽灵感」（用户原话：像死鬼索命）。
      // 现在只 nr=3 削最底嘶声，剩下交给 RVC 本身的音色。
      '-af', 'highpass=f=75,afftdn=nr=3:nf=-55,deesser=i=0.35:m=0.6:f=0.5,'
        + 'equalizer=f=7500:t=q:w=1.2:g=-2,lowpass=f=11500:poles=2,'
        + 'alimiter=limit=0.92:level=false,loudnorm=I=-15:TP=-1.5:LRA=11:print_format=none,aresample=24000',
      '-f', 's16le', '-ar', '24000', '-ac', '1', pcm], flog, 120_000);
    if (fr.code === 0 && existsSync(pcm)) {
      const sr = await run(NODE, [MKSILK, pcm, silkFile, '24000'], flog, 120_000);
      if (sr.code === 0 && existsSync(silkFile)) sendFile = silkFile;
      else result.silkError = lastJsonLine(flog) || 'silk-encode-failed';
    }
  }
  const title = `${song}-童真版.mp3`;
  const log2 = join(TMP, `${name}-${style}-send.log`);
  const sendArgs = [SEND, '--conv', conv, mode === 'voice' ? '--voice' : '--file', sendFile];
  if (mode === 'file') sendArgs.push('--title', title);
  const sr = await run(NODE, sendArgs, log2, 120_000);
  const sj = lastJsonLine(log2);
  result.sent = !!sj?.ok;
  result.mode = mode;
  result.conv = conv;
  if (!result.sent) {
    result.ok = false;
    result.stage = 'send';
    result.sendLog = log2;
    result.sendRaw = sj || null;
  }
  writeFileSync(join(outDir, 'sent.json'), JSON.stringify({ ...result, at: new Date().toISOString() }, null, 1), 'utf8');
  recordIndex();
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
};

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message || e) }) + '\n');
  process.exit(1);
});
