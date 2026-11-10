/**
 * hooks/interview-panel.mjs — 「面试官」视频通话页 + 本机 TTS / 录音落盘
 *
 * 挂载：
 *   GET  /api/qqbot-settings/interview                 全屏通话页（page.html）
 *   POST /api/qqbot-settings/interview/start           开场 + 规则
 *   POST /api/qqbot-settings/interview/answer          提交一轮回答
 *   POST /api/qqbot-settings/interview/proceed         进入下一题 / 出复盘
 *   POST /api/qqbot-settings/interview/back            回退一步
 *   POST /api/qqbot-settings/interview/end             结束通话
 *   GET  /api/qqbot-settings/interview/state?sid=      恢复状态
 *   GET  /api/qqbot-settings/interview/status          题库/评分表/配置来源自检
 *   POST /api/qqbot-settings/interview/tts             合成一句面试官语音
 *   GET  /api/qqbot-settings/interview/audio?sid&name  播放已合成的语音（支持 Range）
 *   POST /api/qqbot-settings/interview/record          保存本轮用户录音（写 secrets）
 *
 * 隐私：
 *   · 会话、评分、转写 → {secrets}/interview/sessions/<sid>/
 *   · 语音 → 同目录 tts/；用户录音 → 同目录 answers/
 *   · 日志只打会话 id / 状态 / 耗时，绝不打回答内容、录音或 TTS 文本
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync, readdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, dirname, basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import * as core from '../lib/interview-core.mjs';
import * as media from '../lib/media-tools.mjs';
import * as llm from '../lib/local-llm.mjs';
import { synthesize } from '../lib/tts-core.mjs';
import { toLocalFull } from '../lib/timefmt.mjs';

const BASE = '/api/qqbot-settings/interview';
const FILE_DIR = dirname(fileURLToPath(import.meta.url));                 // …/.qqbot-extensions/hooks
const FILE_ROOT = dirname(dirname(FILE_DIR));                             // …（dataRoot）
const FILE_EXT = join(FILE_ROOT, '.qqbot-extensions');

let DATA_ROOT = FILE_ROOT;
let EXT_DIR = FILE_EXT;
let PAGE_PATH = join(FILE_EXT, 'interview', 'page.html');
let LOGGER = console;
let registered = false;

/**
 * 解析扩展资产目录。
 * env.dataRoot 可能配成仓库根（F:/qqbot），而扩展文件实际在 (F:/qqbot/dshqqbot)；
 * 钩子自己就住在扩展目录里，所以「数据根扩展目录缺页面」时回退到文件所在扩展目录，
 * 避免页面 500。
 */
function resolveExtDir() {
  const cand = [join(DATA_ROOT, '.qqbot-extensions'), FILE_EXT];
  for (const dir of cand) {
    try {
      if (existsSync(join(dir, 'interview', 'page.html')) || existsSync(join(dir, 'voice-config.json'))) return dir;
    } catch { /* ignore */ }
  }
  return FILE_EXT;
}

const MAX_BODY = 12 * 1024 * 1024;       // 录音 base64 可能到 8MB，留余量
const MAX_AUDIO = 8 * 1024 * 1024;
const SID_RE = /^[a-f0-9]{24,40}$/;
const AUDIO_RE = /^tts-[a-f0-9]{12}\.(mp3|wav)$/;
const TURN_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MIME_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};
// 视频：任意客户端上传的片段都收（不在服务端假设"本机有摄像头"）
const VIDEO_EXT = {
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
  'video/x-msvideo': 'avi',
};
const MEDIA_ID_RE = /^[a-f0-9]{16,40}$/;
const MEDIA_CHUNK_EXTRA = 256 * 1024;   // 分片请求体上限 = chunkBytes + 余量
const UPLOAD_STALE_MS = 3600000;        // 上传临时文件 1 小时没人动就清掉
const VISION_PROMPT = '这是一段面试视频按时间顺序截取的关键帧。只描述画面中可确认、与表达相关的事实：坐姿与手势、视线是否看镜头、是否有板书或手写内容、屏幕上是否有代码或文字。不要评价外貌、性别、年龄、身份；看不清就写"未看清"，不要编造。60 字以内。';
let _lastUploadCleanupAt = 0;

function safeExt(name, mime, fallback = 'bin') {
  const byMime = VIDEO_EXT[mime] || MIME_EXT[mime];
  if (byMime) return byMime;
  const e = extname(String(name || '')).replace('.', '').toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(e) ? e : fallback;
}

function mediaMetaPath(sid, uploadId) {
  return join(core.mediaDirOf(DATA_ROOT, sid), `${uploadId}.json`);
}

function readMediaMeta(sid, uploadId) {
  try {
    const p = mediaMetaPath(sid, uploadId);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch { return null; }
}

function writeMediaMeta(sid, uploadId, meta) {
  const dir = core.mediaDirOf(DATA_ROOT, sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(mediaMetaPath(sid, uploadId), JSON.stringify(meta, null, 2), 'utf8');
}

/** 清理超期没写完的分片/临时 WAV，防止大文件把磁盘和内存拖住 */
function cleanupStaleUploads(force = false) {
  const now = Date.now();
  if (!force && now - _lastUploadCleanupAt < 600000) return 0;
  _lastUploadCleanupAt = now;
  const base = join(core.interviewRootOf(DATA_ROOT), 'sessions');
  let sids = [];
  try { sids = readdirSync(base); } catch { return 0; }
  let n = 0;
  for (const sid of sids) {
    if (!SID_RE.test(sid)) continue;
    const dir = join(base, sid, 'media');
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.part$|\.wav$|\.txt$/.test(name)) continue;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > UPLOAD_STALE_MS) { unlinkSync(p); n += 1; }
      } catch { /* ignore */ }
    }
  }
  if (n) logInfo('[interview] 已清理超期上传临时文件', String(n));
  return n;
}

function logInfo(msg, ...args) { try { (LOGGER.info || console.log).call(LOGGER, msg, ...args); } catch { /* ignore */ } }
function logWarn(msg, ...args) { try { (LOGGER.warn || console.warn).call(LOGGER, msg, ...args); } catch { /* ignore */ } }

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', (e) => reject(e));
  });
}

/** 原始字节分片：视频按 2MB 一片收，绝不整段进内存 */
function readRawBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('chunk too large'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });
}

function readJsonFile(p, def) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : def; }
  catch { return def; }
}

function loadVoiceConfig() {
  return readJsonFile(join(EXT_DIR, 'voice-config.json'), {});
}

function ttsOpts(cfg, outDir) {
  const vc = loadVoiceConfig();
  const ov = cfg.voice || {};
  const pick = (a, b, d) => (String(a || '').trim() || String(b || '').trim() || d);
  const speed = Number(ov.speed) > 0 ? Number(ov.speed) : (Number(vc.speed) > 0 ? Number(vc.speed) : 1);
  return {
    dataRoot: DATA_ROOT,
    outDir,
    provider: pick(ov.provider, vc.provider, 'edge'),
    voice: pick(ov.voice, vc.voice, 'zh-CN-XiaoyiNeural'),
    model: pick(ov.model, vc.model, ''),
    endpoint: pick(ov.endpoint, vc.endpoint, ''),
    speed,
    rate: vc.rate,
    pitch: vc.pitch,
    rateJitter: 1,
    pitchJitter: 1,
    tailProb: 0.1,
    timeoutMs: Math.max(5000, Math.min(600000, Number(cfg.tts && cfg.tts.timeoutMs) || 120000)),
    vramSoft: vc.vramSoft === true,
  };
}

// 同文本并发请求复用一次合成
const ttsInflight = new Map();

async function synthOnce(sid, text, cfg) {
  const dir = join(core.sessionDirOf(DATA_ROOT, sid), 'tts');
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
  for (const ext of ['.mp3', '.wav']) {
    const p = join(dir, `tts-${hash}${ext}`);
    if (existsSync(p)) {
      return { ok: true, url: `${BASE}/audio?sid=${sid}&name=${encodeURIComponent(basename(p))}`, cached: true, ms: 0 };
    }
  }

  const key = `${sid}:${hash}`;
  if (ttsInflight.has(key)) return ttsInflight.get(key);

  const job = (async () => {
    const t0 = Date.now();
    const r = await synthesize(text, ttsOpts(cfg, dir));
    if (!r || !r.ok || !r.path) {
      return { ok: false, message: String((r && (r.error || r.reason)) || 'TTS 合成失败'), ms: Date.now() - t0 };
    }
    let target = r.path;
    const ext = extname(r.path).toLowerCase() === '.wav' ? '.wav' : '.mp3';
    const want = join(dir, `tts-${hash}${ext}`);
    try {
      if (target !== want) {
        if (existsSync(want)) unlinkSync(want);
        renameSync(target, want);
        target = want;
      }
    } catch { /* 保留原文件，照样能播 */ }
    const name = basename(target);
    if (!/^tts-[a-f0-9]{12}\.(mp3|wav)$/.test(name)) {
      return { ok: false, message: 'TTS 输出文件名不合法', ms: Date.now() - t0 };
    }
    return {
      ok: true,
      url: `${BASE}/audio?sid=${sid}&name=${encodeURIComponent(name)}`,
      name,
      ms: Date.now() - t0,
    };
  })();

  ttsInflight.set(key, job);
  try { return await job; } finally { ttsInflight.delete(key); }
}

/** 找到会话并更新 ttsCalls 计数（只写 sessions/<sid>/session.json） */
function bumpTts(sid) {
  try {
    const s = core.loadSession(DATA_ROOT, sid);
    if (!s) return;
    s.metrics = s.metrics || {};
    s.metrics.ttsCalls = Number(s.metrics.ttsCalls || 0) + 1;
    core.saveSession(DATA_ROOT, s);
  } catch { /* ignore */ }
}

function serveAudio(req, res, urlObj) {
  const sid = String(urlObj.searchParams.get('sid') || '');
  const name = String(urlObj.searchParams.get('name') || '');
  if (!SID_RE.test(sid) || !AUDIO_RE.test(name)) { sendJson(res, { ok: false, message: 'bad audio request' }, 400); return; }
  let dir;
  try { dir = join(core.sessionDirOf(DATA_ROOT, sid), 'tts'); } catch { sendJson(res, { ok: false, message: 'bad sid' }, 400); return; }
  const file = resolve(dir, name);
  if (!resolve(file).startsWith(resolve(dir) + sep) || !existsSync(file)) {
    sendJson(res, { ok: false, message: 'audio not found' }, 404);
    return;
  }
  let data;
  try { data = readFileSync(file); } catch { sendJson(res, { ok: false, message: 'audio read failed' }, 500); return; }
  const type = name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
  const total = data.length;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : total - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end) { res.writeHead(416, { 'content-range': `bytes */${total}` }); res.end(); return; }
      res.writeHead(206, {
        'content-type': type,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${total}`,
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=86400',
      });
      res.end(data.subarray(start, end + 1));
      return;
    }
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(total),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=86400',
  });
  res.end(data);
}

/** 收完分片后的服务端处理：探测时长 → 抽 WAV → 转写 →（可选）抽帧+视觉模型。 */
async function finishMedia(sid, uploadId) {
  const meta = readMediaMeta(sid, uploadId);
  if (!meta) throw new Error('上传记录不存在或已过期');
  const sess = core.loadSession(DATA_ROOT, sid);
  if (!sess) throw new Error('会话不存在');
  const cfg = core.loadConfig(DATA_ROOT);
  const v = cfg.video || {};
  const dir = core.mediaDirOf(DATA_ROOT, sid);
  const part = join(dir, `${uploadId}.part`);
  let size = 0;
  try { size = statSync(part).size; } catch { throw new Error('分片文件不存在'); }
  if (size !== Number(meta.bytes)) {
    const e = new Error(`上传未完成（${size}/${meta.bytes}）`);
    e.code = 'incomplete';
    e.offset = size;
    throw e;
  }
  const original = join(dir, `${uploadId}.${meta.ext || safeExt(meta.name, meta.mime)}`);
  try {
    if (existsSync(original)) unlinkSync(original);
    renameSync(part, original);
  } catch { throw new Error('媒体文件落盘失败'); }
  meta.status = 'processing';
  meta.startedAt = new Date().toISOString();
  writeMediaMeta(sid, uploadId, meta);

  let durationSec = 0;
  try { durationSec = await media.probeDuration(original, 30000); } catch { /* 音频可能读不到时长 */ }
  const maxSec = Number(v.maxSeconds) || 120;
  if (durationSec && durationSec > maxSec + 1) {
    try { unlinkSync(original); } catch { /* ignore */ }
    meta.status = 'rejected';
    meta.error = 'too_long';
    writeMediaMeta(sid, uploadId, meta);
    throw new Error(`媒体时长 ${Math.round(durationSec)}s 超过上限 ${maxSec}s`);
  }

  // 转写：WAV 与识别结果都是临时文件，读完即删；失败不阻断，让页面降级到文字
  const wav = join(dir, `${uploadId}.wav`);
  const txt = join(dir, `${uploadId}.txt`);
  let transcript = '';
  let asrEngine = '';
  let asrError = '';
  try {
    await media.extractWav(original, wav, { maxSeconds: maxSec, timeoutMs: Math.min(120000, Number(v.asrTimeoutMs) || 300000) });
    const tr = await media.transcribeWav(wav, { outPath: txt, timeoutMs: Number(v.asrTimeoutMs) || 300000 });
    transcript = String(tr.text || '');
    asrEngine = String(tr.engine || '');
    if (!tr.ok) asrError = String(tr.error || '转写失败');
  } catch (e) {
    asrError = String((e && e.message) || e);
  } finally {
    for (const p of [wav, txt]) { try { unlinkSync(p); } catch { /* ignore */ } }
  }

  // 按任务选：只转写（丢帧）或关键帧给模型看；抽帧与转写都在服务端
  const analyze = meta.analyze === 'frames' ? 'frames' : 'transcript';
  let frames = [];
  let visionNote = '';
  if (meta.kind === 'video' && analyze === 'frames' && durationSec > 0 && Number(v.maxFrames) > 0) {
    const fdir = join(dir, 'frames');
    mkdirSync(fdir, { recursive: true });
    const n = Math.min(Number(v.maxFrames) || 4, 8);
    for (let i = 0; i < n; i += 1) {
      const name = `${uploadId}-${i}.jpg`;
      try {
        await media.extractFrame(original, join(fdir, name), durationSec * (i + 0.5) / n, { width: 320, timeoutMs: 60000 });
        frames.push(name);
      } catch { /* 单帧失败不影响整段 */ }
    }
    const vm = String(v.visionModel || '');
    if (frames.length && vm) {
      const imgs = [];
      for (const name of frames.slice(0, 4)) {
        try { imgs.push(readFileSync(join(fdir, name)).toString('base64')); } catch { /* ignore */ }
      }
      const r = await llm.chat({
        messages: [{ role: 'user', content: VISION_PROMPT, images: imgs }],
        cfg: llm.loadConfig(DATA_ROOT),
        model: vm,
        timeoutMs: 45000,
        maxTokens: 120,
        temperature: 0.2,
      }).catch(() => null);
      if (r && r.ok) visionNote = String(r.text || '').slice(0, 600);
      else if (r) logWarn('[interview] 视觉模型调用失败', String(r.error || ''));
    }
  }

  // 隐私开关：不留视频 → 原始文件与抽帧当场删；不留转写 → 不落正文
  const keepVideo = !(sess.policy && sess.policy.keepVideo === false);
  const keepTranscript = !(sess.policy && sess.policy.keepTranscript === false);
  if (!keepVideo) {
    try { unlinkSync(original); } catch { /* ignore */ }
    for (const name of frames) { try { unlinkSync(join(dir, 'frames', name)); } catch { /* ignore */ } }
    frames = [];
  }

  const stored = {
    uploadId,
    sid,
    kind: meta.kind,
    status: 'done',
    mime: meta.mime,
    ext: meta.ext,
    name: meta.name,
    bytes: size,
    durationSec: Math.round(durationSec * 10) / 10,
    analyze,
    transcript: keepTranscript ? transcript : '',
    transcriptRedacted: !keepTranscript,
    asrEngine,
    asrError,
    frames,
    visionNote,
    discarded: !keepVideo,
    createdAt: meta.createdAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  writeMediaMeta(sid, uploadId, stored);
  core.recordMedia(DATA_ROOT, sid, stored);
  logInfo('[interview] 媒体处理完成', `sid=${sid.slice(0, 8)}`, `bytes=${size}`, `dur=${stored.durationSec}s`, `asr=${transcript.length}`);
  return { ...stored, transcript };
}

function mount(ctx) {
  const ws = ctx && (ctx.webServer || (ctx.get && ctx.get('webServer')));
  if (!ws || typeof ws.register !== 'function') {
    logWarn('[interview] webServer 不可用，通话页未挂载');
    return;
  }
  if (registered) return;
  registered = true;

  const pagePath = PAGE_PATH;
  const reg = (path, handler) => {
    try { ws.register({ kind: 'exact', path, handler }); }
    catch (e) { logWarn('[interview] 注册路由失败', path, String((e && e.message) || e)); }
  };

  reg(`${BASE}`, (req, res) => {
    try {
      const html = readFileSync(pagePath, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('通话页文件缺失：' + pagePath);
    }
  });

  reg(`${BASE}/status`, (req, res) => {
    try {
      const bank = core.loadQuestionBank(DATA_ROOT);
      const rubric = core.loadRubric(DATA_ROOT);
      const cfg = core.loadConfig(DATA_ROOT);
      const cats = bank.data.categories || [];
      const qTotal = cats.reduce((n, c) => n + (Array.isArray(c.questions) ? c.questions.length : 0), 0);
      const modes = core.loadModes(DATA_ROOT).map((m) => {
        const ids = Array.isArray(m.categoryIds) && m.categoryIds.length ? m.categoryIds : cats.map((c) => c.id);
        const picked = cats.filter((c) => ids.includes(c.id));
        const questions = picked.reduce((n, c) => n + (Array.isArray(c.questions) ? c.questions.length : 0), 0);
        return {
          id: m.id, label: m.label, short: m.short, tagline: m.tagline,
          description: m.description, scored: m.feedback !== 'verdict',
          codeInput: m.codeInput, questions,
        };
      });
      // ★ 2026-11-08：会话列表/「相关检测」里时间停在旧时刻 —— 页面要用服务端**当前时间**做基准，
      //   而不是拿缓存文件或目录 mtime 当“现在”。latestSession 带本地化文本，方便对照。
      const now = Date.now();
      const latest = core.listSessions(DATA_ROOT, 1)[0] || null;
      sendJson(res, {
        ok: true,
        now,
        serverTime: toLocalFull(now),
        serverTimeIso: new Date(now).toISOString(),
        timeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })(),
        latestSession: latest ? {
          sid: latest.sid,
          createdAt: latest.createdAt,
          createdAtText: toLocalFull(latest.createdAt),
          updatedAt: latest.updatedAt,
          updatedAtText: toLocalFull(latest.updatedAt),
          stage: latest.stage,
        } : null,
        dataRoot: DATA_ROOT,
        secretsRoot: core.secretsRootOf(DATA_ROOT),
        bankSource: bank.source,
        bankWarning: bank.warning || '',
        rubricSource: rubric.source,
        rubricWarning: rubric.warning || '',
        categories: cats.length,
        questions: qTotal,
        dimensions: (rubric.data.dimensions || []).length,
        modes,
        materials: core.loadMaterials(DATA_ROOT),
        retention: cfg.retention,
        privacy: cfg.privacy,
        ttsEnabled: cfg.tts ? cfg.tts.enabled !== false : true,
        recordAnswers: cfg.recordAnswers !== false,
        model: cfg.model || '(local default)',
        limits: cfg.limits,
        maxFollowups: cfg.maxFollowups,
        video: {
          enabled: cfg.video ? cfg.video.enabled !== false : true,
          maxBytes: cfg.video ? cfg.video.maxBytes : 0,
          maxSessionBytes: cfg.video ? cfg.video.maxSessionBytes : 0,
          chunkBytes: cfg.video ? cfg.video.chunkBytes : 0,
          maxSeconds: cfg.video ? cfg.video.maxSeconds : 0,
          maxFrames: cfg.video ? cfg.video.maxFrames : 0,
          analyze: cfg.video ? cfg.video.analyze : 'transcript',
          visionModel: cfg.video ? cfg.video.visionModel : '',
          asr: 'windows-speech',
          ffmpeg: (() => { try { return media.ffmpegPath() ? 'ok' : ''; } catch { return ''; } })(),
        },
      });
    } catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/start`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req, 1024 * 1024); } catch { body = {}; }
    try { sendJson(res, core.createSession(DATA_ROOT, { mode: String(body.mode || ''), policy: body.policy || {}, materialId: String(body.materialId || '') })); }
    catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/privacy`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req, 256 * 1024); } catch { sendJson(res, { ok: false, message: '请求体不合法' }); return; }
    try {
      const sid = String(body.sid || '');
      if (!SID_RE.test(sid)) { sendJson(res, { ok: false, message: 'bad sid' }); return; }
      const r = core.applyPolicy(DATA_ROOT, sid, body.policy || {});
      if (r.changed.length) logInfo('[interview] 隐私开关已关闭并删除', r.changed.join('、'));
      sendJson(res, { ok: true, ...r });
    } catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  // 视频帧：浏览器本地截一帧上传，只为留存；不开留存就不落盘
  reg(`${BASE}/frame`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req, 1024 * 1024); } catch { sendJson(res, { ok: false, message: '请求体不合法' }); return; }
    try {
      const sid = String(body.sid || '');
      if (!SID_RE.test(sid)) { sendJson(res, { ok: false, message: 'bad sid' }); return; }
      const s = core.loadSession(DATA_ROOT, sid);
      if (!s) { sendJson(res, { ok: false, message: '会话不存在' }); return; }
      if (s.policy && s.policy.keepVideo === false) {
        sendJson(res, { ok: true, stored: false, message: '视频留存已关闭，帧未写入' });
        return;
      }
      let b64 = String(body.data || '');
      const comma = b64.indexOf(',');
      if (b64.startsWith('data:') && comma > 0) b64 = b64.slice(comma + 1);
      if (!b64) { sendJson(res, { ok: false, message: '空帧' }); return; }
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length || buf.length > 512 * 1024) { sendJson(res, { ok: false, message: '帧大小不合法' }); return; }
      const dir = join(core.sessionDirOf(DATA_ROOT, sid), 'video');
      mkdirSync(dir, { recursive: true });
      const qid = /^[A-Za-z0-9_-]{1,40}$/.test(String(body.qid || '')) ? String(body.qid) : 'misc';
      const existing = readdirSync(dir).filter((f) => /^frame-.*\.jpg$/.test(f)).sort();
      // 每道题最多留 2 张关键帧；整场最多 120 张，超了删最旧
      const sameQ = existing.filter((f) => f.startsWith(`frame-${qid}-`));
      if (sameQ.length >= 2) { sendJson(res, { ok: true, stored: false, message: '该题已保留 2 张关键帧' }); return; }
      while (existing.length >= 120) { try { unlinkSync(join(dir, existing.shift())); } catch { /* ignore */ } }
      const seq = String(Date.now()) + '-' + String(sameQ.length + 1);
      const file = join(dir, `frame-${qid}-${seq}.jpg`);
      writeFileSync(file, buf);
      logInfo('[interview] 视频帧已落盘', basename(file), buf.length);
      sendJson(res, { ok: true, stored: true, key: body.key === true, qid, name: basename(file), bytes: buf.length });
    } catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/answer`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { sendJson(res, { ok: false, message: '请求体不合法' }); return; }
    try {
      const j = await core.submitAnswer(DATA_ROOT, String(body.sid || ''), String(body.text || ''), { audioName: String(body.audioName || ''), mediaId: String(body.mediaId || '') });
      sendJson(res, j);
    } catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/proceed`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req); } catch { sendJson(res, { ok: false, message: '请求体不合法' }); return; }
    try { sendJson(res, core.proceed(DATA_ROOT, String(body.sid || ''))); }
    catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/back`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req); } catch { sendJson(res, { ok: false, message: '请求体不合法' }); return; }
    try { sendJson(res, core.stepBack(DATA_ROOT, String(body.sid || ''))); }
    catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/end`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req); } catch { sendJson(res, { ok: false, message: '请求体不合法' }); return; }
    try { sendJson(res, core.endSession(DATA_ROOT, String(body.sid || ''))); }
    catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/state`, (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const sid = String(u.searchParams.get('sid') || '');
      sendJson(res, core.getState(DATA_ROOT, sid));
    } catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/tts`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req, 1024 * 1024); } catch { sendJson(res, { ok: false, message: '请求体不合法' }); return; }
    try {
      const sid = String(body.sid || '');
      if (!SID_RE.test(sid) || !core.loadSession(DATA_ROOT, sid)) { sendJson(res, { ok: false, message: '会话不存在' }); return; }
      const cfg = core.loadConfig(DATA_ROOT);
      if (!cfg.tts || cfg.tts.enabled === false) { sendJson(res, { ok: false, disabled: true, message: 'TTS 已关闭' }); return; }
      const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, Math.max(1, Number(cfg.tts.maxChars) || 160));
      if (!text) { sendJson(res, { ok: false, message: '空文本' }); return; }
      const r = await synthOnce(sid, text, cfg);
      if (r.ok) bumpTts(sid);
      sendJson(res, r);
    } catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/audio`, (req, res) => {
    try { serveAudio(req, res, new URL(req.url, 'http://127.0.0.1')); }
    catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  reg(`${BASE}/record`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req); } catch { sendJson(res, { ok: false, message: '录音体不合法' }); return; }
    try {
      const sid = String(body.sid || '');
      const turnId = String(body.turnId || '');
      if (!SID_RE.test(sid) || !core.loadSession(DATA_ROOT, sid)) { sendJson(res, { ok: false, message: '会话不存在' }); return; }
      if (!TURN_RE.test(turnId)) { sendJson(res, { ok: false, message: 'turnId 不合法' }); return; }
      const sess = core.loadSession(DATA_ROOT, sid);
      if (sess && sess.policy && sess.policy.keepAudio === false) {
        sendJson(res, { ok: true, stored: false, message: '录音留存已关闭，未写入' });
        return;
      }
      const mime = String(body.mime || '').split(';')[0].trim().toLowerCase();
      const ext = MIME_EXT[mime];
      if (!ext) { sendJson(res, { ok: false, message: '录音格式不支持' }); return; }
      let b64 = String(body.data || '');
      const comma = b64.indexOf(',');
      if (b64.startsWith('data:') && comma > 0) b64 = b64.slice(comma + 1);
      if (!b64) { sendJson(res, { ok: false, message: '空录音' }); return; }
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length || buf.length > MAX_AUDIO) { sendJson(res, { ok: false, message: '录音大小不合法' }); return; }
      const dir = join(core.sessionDirOf(DATA_ROOT, sid), 'answers');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${turnId}.${ext}`);
      writeFileSync(file, buf);
      // 只记文件名和字节数，不记内容
      logInfo('[interview] 录音已落盘', basename(file), buf.length);
      sendJson(res, { ok: true, name: basename(file), bytes: buf.length });
    } catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  // ── 视频/音频输入：任意客户端上传，服务端只收文件与转写结果 ──
  // 1) 申请上传：拿到 uploadId 与分片大小；带 uploadId 时返回已收字节数，可断点续传
  reg(`${BASE}/media/init`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req, 256 * 1024); } catch { sendJson(res, { ok: false, message: '请求体不合法' }); return; }
    try {
      cleanupStaleUploads();
      const sid = String(body.sid || '');
      if (!SID_RE.test(sid)) { sendJson(res, { ok: false, message: 'bad sid' }); return; }
      const s = core.loadSession(DATA_ROOT, sid);
      if (!s) { sendJson(res, { ok: false, message: '会话不存在' }); return; }
      const cfg = core.loadConfig(DATA_ROOT);
      const v = cfg.video || {};
      if (v.enabled === false) { sendJson(res, { ok: false, message: '视频输入已关闭' }); return; }
      const mime = String(body.mime || '').split(';')[0].trim().toLowerCase();
      const name = String(body.name || '').slice(0, 120);
      const kind = mime.startsWith('video/') ? 'video' : (mime.startsWith('audio/') ? 'audio' : '');
      if (!kind) { sendJson(res, { ok: false, message: '只接收视频或音频文件' }); return; }
      const analyze = String(body.analyze || '') === 'frames' ? 'frames' : 'transcript';
      const maxBytes = Number(v.maxBytes) || 48 * 1024 * 1024;
      const maxSessionBytes = Number(v.maxSessionBytes) || 120 * 1024 * 1024;

      // 续传：同一个 uploadId 且已登记未完成 → 直接回报 offset
      const resumeId = String(body.uploadId || '');
      if (MEDIA_ID_RE.test(resumeId)) {
        const old = readMediaMeta(sid, resumeId);
        if (old && old.status !== 'done') {
          const part = join(core.mediaDirOf(DATA_ROOT, sid), `${resumeId}.part`);
          let offset = 0;
          try { offset = statSync(part).size; } catch { offset = 0; }
          sendJson(res, { ok: true, uploadId: resumeId, offset, chunkBytes: Number(v.chunkBytes) || 2 * 1024 * 1024, maxBytes, maxSeconds: Number(v.maxSeconds) || 120, resumed: true });
          return;
        }
      }

      const bytes = Math.floor(Number(body.bytes) || 0);
      if (bytes <= 0) { sendJson(res, { ok: false, message: '缺少文件大小' }); return; }
      if (bytes > maxBytes) { sendJson(res, { ok: false, message: `单个文件上限 ${Math.round(maxBytes / 1048576)}MB` }); return; }
      const used = (s.media || []).reduce((n, m) => n + (Number(m && m.bytes) || 0), 0);
      if (used + bytes > maxSessionBytes) { sendJson(res, { ok: false, message: `本场媒体总量上限 ${Math.round(maxSessionBytes / 1048576)}MB` }); return; }

      const uploadId = randomBytes(16).toString('hex');
      const ext = safeExt(name, mime);
      mkdirSync(core.mediaDirOf(DATA_ROOT, sid), { recursive: true });
      writeMediaMeta(sid, uploadId, {
        uploadId, sid, bytes, mime, name, kind, ext, analyze, status: 'uploading',
        createdAt: new Date().toISOString(),
      });
      sendJson(res, { ok: true, uploadId, offset: 0, chunkBytes: Number(v.chunkBytes) || 2 * 1024 * 1024, maxBytes, maxSeconds: Number(v.maxSeconds) || 120 });
    } catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  // 2) 分片：按服务端 offset 追加写，偏移不一致就回报当前 offset 让客户端重试
  reg(`${BASE}/media/chunk`, async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const sid = String(u.searchParams.get('sid') || '');
      const uploadId = String(u.searchParams.get('uploadId') || '');
      const offset = Number(u.searchParams.get('offset'));
      if (!SID_RE.test(sid) || !MEDIA_ID_RE.test(uploadId)) { sendJson(res, { ok: false, message: 'bad media request' }, 400); return; }
      const meta = readMediaMeta(sid, uploadId);
      if (!meta) { sendJson(res, { ok: false, message: '上传记录不存在或已过期' }, 404); return; }
      const cfg = core.loadConfig(DATA_ROOT);
      const chunkBytes = Number(cfg.video && cfg.video.chunkBytes) || 2 * 1024 * 1024;
      const part = join(core.mediaDirOf(DATA_ROOT, sid), `${uploadId}.part`);
      let cur = 0;
      try { cur = statSync(part).size; } catch { cur = 0; }
      if (!Number.isFinite(offset) || offset !== cur) {
        sendJson(res, { ok: false, offset: cur, message: 'offset 不匹配，请从服务端 offset 续传' }, 409);
        return;
      }
      let buf;
      try { buf = await readRawBody(req, chunkBytes + MEDIA_CHUNK_EXTRA); }
      catch { sendJson(res, { ok: false, offset: cur, message: '分片过大' }, 413); return; }
      const total = Number(meta.bytes) || 0;
      if (cur + buf.length > total) { sendJson(res, { ok: false, offset: cur, message: '分片超出声明大小' }, 413); return; }
      if (buf.length) {
        mkdirSync(core.mediaDirOf(DATA_ROOT, sid), { recursive: true });
        const fd = openSync(part, 'a');
        try { writeSync(fd, buf, 0, buf.length); } finally { closeSync(fd); }
      }
      const next = cur + buf.length;
      sendJson(res, { ok: true, offset: next, complete: next >= total });
    } catch (e) { sendJson(res, { ok: false, message: String((e && e.message) || e) }); }
  });

  // 3) 收尾：探测时长 → 转写 →（可选）抽帧/视觉模型；返回转写让页面填进输入框
  reg(`${BASE}/media/finish`, async (req, res) => {
    let body = {};
    try { body = await readJsonBody(req, 256 * 1024); } catch { sendJson(res, { ok: false, message: '请求体不合法' }); return; }
    try {
      const sid = String(body.sid || '');
      const uploadId = String(body.uploadId || '');
      if (!SID_RE.test(sid) || !MEDIA_ID_RE.test(uploadId)) { sendJson(res, { ok: false, message: 'bad media request' }); return; }
      const r = await finishMedia(sid, uploadId);
      sendJson(res, { ok: true, ...r });
    } catch (e) {
      const code = e && e.code === 'incomplete' ? 409 : 200;
      sendJson(res, { ok: false, offset: e && e.offset, message: String((e && e.message) || e) }, code);
    }
  });

  logInfo('[interview] 已挂载', `${BASE}（页面/TTS/录音/视频输入；数据仅写 secrets）`);
}

export async function run(env = {}) {
  const { ctx } = env;
  DATA_ROOT = String(env.dataRoot || FILE_ROOT);
  EXT_DIR = resolveExtDir();
  PAGE_PATH = join(EXT_DIR, 'interview', 'page.html');
  LOGGER = env.logger || console;
  // 启动时跑一次超期清理（默认 14 天，归档到 secrets/interview/archive/）
  try {
    const r = core.cleanupSessions(DATA_ROOT, { force: true });
    if ((r.archived && r.archived.length) || (r.removed && r.removed.length)) {
      logInfo('[interview] 超期会话已清理', `归档 ${r.archived.length} / 删除 ${r.removed.length}`, `天数=${r.days}`);
    }
  } catch { /* ignore */ }
  // 上传临时文件也清一遍（进程重启后残留的 .part/.wav 不会一直占盘）
  try { cleanupStaleUploads(true); } catch { /* ignore */ }
  if (!ctx) return 'no-ctx';
  try { ctx.inject(['webServer'], (serverCtx) => mount(serverCtx)); }
  catch { /* inject 不可用走兜底 */ }
  try { if (ctx.webServer) mount(ctx); } catch { /* ignore */ }
  return 'ok';
}

export function dispose() {
  registered = false;
  ttsInflight.clear();
}

export default { run, dispose, BASE };
