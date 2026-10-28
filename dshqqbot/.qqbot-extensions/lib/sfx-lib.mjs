/**
 * sfx-lib.mjs — 音效库（表情包同构）
 *
 * 目录契约（与表情包一致，便于备份/迁移）：
 *   {dataRoot}/音效/index.json          → { version, items:[{id,kind,ext,layer,tags,name,desc,src,addedAt}] }
 *   {dataRoot}/音效/lib/<layer>/<id>.<ext>
 *
 * 三种入库方式：
 *   1) scanDir()      扫本地目录（文件名拆标签、按关键词猜语义）
 *   2) addFromUrl()   收互联网音效（下载 → 入库 → 打标签）
 *   3) ensureBuiltin() 空库兜底：用 ffmpeg lavfi 现场合成 9 个语义音效（不联网）
 *
 * 检索：2-gram 中文友好打分（和 sticker-resolve 同一套），按 kind 语义挑选。
 * 混音：buildSfxFilter() 产出 adelay + amix 滤镜串，交给 bili-ops 的分段合成。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { extname, join, basename, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';

export const SFX_DIRNAME = '音效';

/** 语义分类：分镜脚本 / 文字动效只认这些词 */
export const KINDS = ['whoosh', 'click', 'pop', 'typing', 'water', 'success', 'fail', 'impact', 'ambient'];
const KIND_ZH = {
  whoosh: '转场 划过 呼呼 风声',
  click: '点击 按键 咔哒',
  pop: '弹出 气泡 啵',
  typing: '打字 键盘 代码',
  water: '水 水下 气泡 波浪',
  success: '成功 完成 提示 对',
  fail: '失败 错误 警告 不对',
  impact: '撞击 重音 打击',
  ambient: '氛围 环境 底噪 循环',
};

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.opus', '.wma']);

export function sfxDir(dataRoot) {
  return join(String(dataRoot || ''), SFX_DIRNAME);
}

export function indexPathOf(dataRoot) {
  return join(sfxDir(dataRoot), 'index.json');
}

const _cache = new Map();

/** 读索引（按 mtime 缓存；坏了返回空，不抛） */
export function loadIndex(dataRoot) {
  const file = indexPathOf(dataRoot);
  if (!existsSync(file)) return { items: [], byId: new Map(), file };
  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { /* ignore */ }
  const hit = _cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  let items = [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    items = Array.isArray(j) ? j : Array.isArray(j.items) ? j.items : [];
  } catch { /* 坏了当空库 */ }
  const byId = new Map();
  for (const it of items) if (it && it.id) byId.set(String(it.id), it);
  const rec = { mtimeMs, items, byId, file };
  _cache.set(file, rec);
  return rec;
}

export function invalidateIndex(dataRoot) {
  _cache.delete(indexPathOf(dataRoot));
}

function saveIndex(dataRoot, items) {
  const dir = sfxDir(dataRoot);
  mkdirSync(dir, { recursive: true });
  const payload = { version: 1, updatedAt: Date.now(), items };
  writeFileSync(indexPathOf(dataRoot), JSON.stringify(payload, null, 2), 'utf8');
  invalidateIndex(dataRoot);
  return payload;
}

export function pathOfItem(dataRoot, item) {
  const ext = String((item && item.ext) || 'wav').replace(/^\./, '');
  return join(sfxDir(dataRoot), 'lib', String((item && item.layer) || 'collected'), `${item.id}.${ext}`);
}

export function pathOfId(dataRoot, id) {
  const it = loadIndex(dataRoot).byId.get(String(id || ''));
  if (!it) return '';
  const p = pathOfItem(dataRoot, it);
  return existsSync(p) ? p : '';
}

/** 文件名 → 标签（去掉扩展名，按 _ - 空格 括号 切） */
export function tagsFromName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  return base
    .split(/[\s_\-—+.,，、（）()【】\[\]#]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x && x.length <= 12);
}

/** 从文本猜语义分类 */
export function guessKind(text) {
  const t = String(text || '').toLowerCase();
  const hits = [];
  for (const k of KINDS) {
    const words = KIND_ZH[k].split(' ');
    let score = 0;
    for (const w of words) if (w && t.includes(w)) score += 1;
    if (t.includes(k)) score += 2;
    if (score) hits.push({ k, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.length ? hits[0].k : '';
}

export function haystackOf(item) {
  const tags = Array.isArray(item && item.tags) ? item.tags : [];
  return [item.name, item.desc, item.kind, ...tags].filter(Boolean).join(' ').trim();
}

function tokens(s) {
  const out = [];
  const text = String(s || '').toLowerCase();
  out.push(...(text.match(/[a-z0-9_]{2,}/g) || []));
  const cjk = text.replace(/[a-z0-9_\s\p{P}]/gu, '');
  for (let i = 0; i + 1 < cjk.length; i += 1) out.push(cjk.slice(i, i + 2));
  return out;
}

/** 关键词打分（0~1）；kind 命中额外加分 */
export function lexicalScore(query, item) {
  const q = tokens(query);
  const h = haystackOf(item).toLowerCase();
  if (!q.length || !h) return 0;
  let hit = 0;
  for (const t of q) if (h.includes(t)) hit += 1;
  return hit / q.length;
}

/** 检索音效（query 空 = 按 kind 列全部） */
export function search(dataRoot, query = '', opts = {}) {
  const kind = String(opts.kind || '');
  const limit = Math.max(1, Number(opts.limit) || 10);
  const items = loadIndex(dataRoot).items.filter((it) => {
    if (kind && String(it.kind || '') !== kind) return false;
    return existsSync(pathOfItem(dataRoot, it));
  });
  const q = String(query || '').trim();
  if (!q) return items.slice(0, limit).map((it) => ({ item: it, score: 1 }));
  return items
    .map((it) => ({ item: it, score: lexicalScore(q, it) + (kind && it.kind === kind ? 0.2 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 按语义挑一个（同 kind 里选；找不到就全局模糊匹配；再不行返回 ''） */
export function pick(dataRoot, kind, opts = {}) {
  const want = String(kind || '');
  const byKind = search(dataRoot, '', { kind: want, limit: 50 });
  const fuzzy = byKind.length ? [] : search(dataRoot, opts.query || KIND_ZH[want] || want, { limit: 20 });
  const pool = (byKind.length ? byKind : fuzzy).map((x) => x.item);
  if (!pool.length) return { path: '', item: null };
  const seed = Number(opts.seed) || 0;
  const it = pool[Math.abs(seed) % pool.length];
  return { path: pathOfItem(dataRoot, it), item: it };
}

function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

function addItem(items, dataRoot, srcFile, meta = {}) {
  const buf = readFileSync(srcFile);
  const ext = (extname(srcFile) || '.wav').toLowerCase();
  const id = 'sfx-' + sha1(buf).slice(0, 10);
  const exists = items.find((x) => x.id === id);
  if (exists) {
    const p = pathOfItem(dataRoot, exists);
    if (existsSync(p)) return { ok: true, item: exists, duplicate: true, path: p };
    items = items.filter((x) => x.id !== id);
  }
  const layer = String(meta.layer || 'collected').replace(/[^A-Za-z0-9_-]/g, '') || 'collected';
  const item = {
    id,
    ext: ext.replace(/^\./, ''),
    layer,
    kind: String(meta.kind || guessKind(meta.name || basename(srcFile)) || ''),
    tags: Array.isArray(meta.tags) && meta.tags.length ? meta.tags.map(String) : tagsFromName(meta.name || basename(srcFile)),
    name: String(meta.name || basename(srcFile).replace(/\.[^.]+$/, '')),
    desc: String(meta.desc || ''),
    src: String(meta.src || ''),
    addedAt: Date.now(),
  };
  items.push(item);
  const dest = pathOfItem(dataRoot, item);
  mkdirSync(join(sfxDir(dataRoot), 'lib', layer), { recursive: true });
  try {
    // 已经在目标位置就不搬（scanDir 源目录 == 库目录时）
    if (String(srcFile).replace(/\\/g, '/') !== dest.replace(/\\/g, '/')) copyFileSync(srcFile, dest);
  } catch {
    items.pop();
    return { ok: false, reason: 'copy-failed' };
  }
  return { ok: true, item, path: dest, duplicate: false };
}

/** 收一个本地文件入库 */
export function addFile(dataRoot, srcFile, meta = {}) {
  const src = String(srcFile || '');
  if (!src || !existsSync(src)) return { ok: false, reason: '文件不存在' };
  const ext = extname(src).toLowerCase();
  if (!AUDIO_EXT.has(ext)) return { ok: false, reason: '不是音频文件: ' + ext };
  const items = [...loadIndex(dataRoot).items];
  const r = addItem(items, dataRoot, src, meta);
  if (!r.ok) return r;
  saveIndex(dataRoot, items);
  return r;
}

/** 扫一个目录入库 */
export function scanDir(dataRoot, opts = {}) {
  const dir = String(opts.dir || '').trim();
  if (!dir || !existsSync(dir)) return { ok: false, reason: '目录不存在: ' + dir };
  const recursive = opts.recursive === true;
  const layer = String(opts.layer || 'collected');
  const files = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let names = [];
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of names) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        if (recursive) walk(p, depth + 1);
      } else if (AUDIO_EXT.has(extname(ent.name).toLowerCase())) {
        files.push(p);
      }
    }
  };
  walk(dir, 0);
  let items = [...loadIndex(dataRoot).items];
  let added = 0;
  let duplicate = 0;
  const failed = [];
  for (const f of files) {
    const name = basename(f);
    const kind = String(opts.kind || guessKind(name) || '');
    const r = addItem(items, dataRoot, f, {
      layer,
      kind,
      name,
      tags: tagsFromName(name),
      src: 'scan:' + relative(dir, f).replace(/\\/g, '/'),
    });
    if (!r.ok) failed.push({ file: name, reason: r.reason });
    else if (r.duplicate) duplicate += 1;
    else added += 1;
  }
  saveIndex(dataRoot, items);
  return { ok: true, dir, scanned: files.length, added, duplicate, failed };
}

/** 从互联网收音效（认 http(s)，限 20MB） */
export async function addFromUrl(dataRoot, url, meta = {}) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, reason: '只认 http(s) 链接' };
  let res;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(Math.max(5000, Number(meta.timeoutMs) || 30000)) });
  } catch (e) {
    return { ok: false, reason: 'download: ' + ((e && e.message) || String(e)) };
  }
  if (!res.ok) return { ok: false, reason: 'http-' + res.status };
  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, reason: 'read: ' + ((e && e.message) || String(e)) };
  }
  if (buf.length < 200) return { ok: false, reason: 'too-small-' + buf.length };
  if (buf.length > 20 * 1024 * 1024) return { ok: false, reason: 'too-large（>20MB）' };
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  const fromCt = ct.includes('mpeg') ? '.mp3' : ct.includes('wav') ? '.wav' : ct.includes('ogg') ? '.ogg'
    : ct.includes('mp4') || ct.includes('m4a') ? '.m4a' : ct.includes('flac') ? '.flac' : '';
  const fromUrl = extname(new URL(u).pathname).toLowerCase();
  const ext = AUDIO_EXT.has(fromUrl) ? fromUrl : (fromCt || '.mp3');
  const tmp = join(tmpdir(), 'qqbot-sfx-' + process.pid + '-' + Date.now() + ext);
  try {
    writeFileSync(tmp, buf);
  } catch (e) {
    return { ok: false, reason: 'write: ' + ((e && e.message) || String(e)) };
  }
  try {
    return addFile(dataRoot, tmp, {
      ...meta,
      src: u,
      name: meta.name || basename(new URL(u).pathname).replace(/\.[^.]+$/, '') || '网络音效',
    });
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── 内置兜底音效（ffmpeg lavfi 现场合成，不联网） ─────────────────────

const BUILTIN = [
  { kind: 'whoosh', name: '转场呼啸', input: 'anoisesrc=color=pink:duration=0.6:amplitude=0.9', af: 'highpass=f=350,lowpass=f=5200,afade=t=in:st=0:d=0.18,afade=t=out:st=0.34:d=0.24,volume=0.55' },
  { kind: 'click', name: '按键咔哒', input: 'aevalsrc=0.45*sin(2*PI*2000*t)*exp(-120*t):d=0.09:s=44100', af: 'volume=0.8' },
  { kind: 'pop', name: '气泡啵', input: 'aevalsrc=0.5*sin(2*PI*900*t)*exp(-45*t):d=0.2:s=44100', af: 'volume=0.7' },
  { kind: 'typing', name: '键盘打字', input: 'aevalsrc=0.28*sin(2*PI*1500*t)*exp(-70*mod(t\\,0.085)):d=1.1:s=44100', af: 'highpass=f=400,volume=0.6' },
  { kind: 'water', name: '水下气泡', input: 'anoisesrc=color=pink:duration=0.9:amplitude=0.5', af: 'lowpass=f=800,tremolo=f=6:d=0.9,volume=0.5' },
  { kind: 'success', name: '完成提示', input: 'aevalsrc=0.3*(sin(2*PI*660*t)+0.7*sin(2*PI*880*t))*exp(-6*t):d=0.55:s=44100', af: 'volume=0.6' },
  { kind: 'fail', name: '失败提示', input: 'aevalsrc=0.32*sin(2*PI*(380-260*t)*t)*exp(-3*t):d=0.6:s=44100', af: 'volume=0.6' },
  { kind: 'impact', name: '重音撞击', input: 'anoisesrc=color=brown:duration=0.4:amplitude=0.9', af: 'lowpass=f=220,afade=t=out:st=0.22:d=0.18,volume=0.8' },
  { kind: 'ambient', name: '水下氛围', input: 'anoisesrc=color=pink:duration=8:amplitude=0.35', af: 'lowpass=f=300,tremolo=f=0.15:d=0.5,volume=0.25' },
  // ── 补三件套（2026-10-24）：短视频里真正撑节奏的不是 UI 音，是这三类 ──
  { kind: 'whoosh', name: '上升转场', input: 'anoisesrc=color=pink:duration=0.9:amplitude=0.6', af: 'highpass=f=500,lowpass=f=7000,treble=g=6,afade=t=in:st=0:d=0.5,afade=t=out:st=0.62:d=0.28,volume=0.5' },
  { kind: 'click', name: '细碎点击', input: 'aevalsrc=0.3*sin(2*PI*2600*t)*exp(-160*t):d=0.05:s=44100', af: 'highpass=f=1200,volume=0.55' },
  { kind: 'impact', name: '低频闷响', input: 'aevalsrc=0.5*sin(2*PI*(90-40*t)*t)*exp(-7*t):d=0.8:s=44100', af: 'lowpass=f=180,volume=0.75' },
];

function run(exe, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (!done) { done = true; resolve(r); }
    };
    let child;
    const logPath = join(tmpdir(), 'qqbot-sfx-ff-' + process.pid + '-' + Date.now() + '.log');
    let fd = -1;
    try { fd = openSync(logPath, 'w'); } catch { fd = -1; }
    const tail = () => {
      try { return readFileSync(logPath, 'utf8').slice(-400).replace(/\s+/g, ' ').trim(); } catch { return ''; }
    };
    const clean = () => {
      try { if (fd >= 0) closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(logPath); } catch { /* ignore */ }
    };
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'ignore', fd >= 0 ? fd : 'ignore'], windowsHide: true });
    } catch (e) {
      clean();
      return finish({ ok: false, reason: 'spawn: ' + ((e && e.message) || String(e)) });
    }
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      clean();
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      clean();
      finish({ ok: false, reason: 'spawn: ' + ((e && e.message) || String(e)) });
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      clean();
      finish({ ok: code === 0, reason: code === 0 ? '' : 'exit-' + code + (tail() ? ': ' + tail() : '') });
    });
  });
}

/**
 * 空库兜底：把 9 个语义音效合成入库（已存在就跳过）。
 * 没有 ffmpeg 时返回 {ok:false}，调用方自行降级（静音成片，不报错）。
 */
export async function ensureBuiltin(dataRoot, opts = {}) {
  const exe = String(opts.ffmpeg || '').trim();
  let items = [...loadIndex(dataRoot).items];
  const need = BUILTIN.filter((b) => !items.some((it) => it.kind === b.kind && it.layer === 'builtin' && existsSync(pathOfItem(dataRoot, it))));
  if (!need.length) return { ok: true, made: 0, total: BUILTIN.length };
  if (!exe || !existsSync(exe)) return { ok: false, reason: 'no-ffmpeg', made: 0 };

  const dir = join(sfxDir(dataRoot), 'lib', 'builtin');
  mkdirSync(dir, { recursive: true });
  let made = 0;
  const failed = [];
  for (const b of BUILTIN) {
    if (!need.includes(b)) continue;
    const tmp = join(dir, `.tmp-${b.kind}-${Date.now()}.wav`);
    const r = await run(exe, ['-y', '-f', 'lavfi', '-i', b.input, '-af', b.af, '-t', '8', '-c:a', 'pcm_s16le', tmp], 45000);
    if (!r.ok) {
      failed.push({ kind: b.kind, reason: r.reason });
      try { unlinkSync(tmp); } catch { /* ignore */ }
      continue;
    }
    const added = addItem(items, dataRoot, tmp, {
      layer: 'builtin', kind: b.kind, name: b.name, tags: KIND_ZH[b.kind].split(' '), src: 'builtin:ffmpeg',
    });
    try { unlinkSync(tmp); } catch { /* ignore */ }
    if (added.ok && !added.duplicate) made += 1;
  }
  saveIndex(dataRoot, items);
  return { ok: made > 0 || need.length === 0, made, total: BUILTIN.length, failed };
}

// ── 响度归一（一次性，跑过就跳过）──────────────────────────────────────
/**
 * 为什么需要：网上收来的音效响度能差 20dB。同一个 gain 下，有的听不见、有的炸麦。
 * 统一到 -18 LUFS（短视频人声下的 SFX 常用档），之后 gain 才有可比性。
 * 用 ffmpeg 单遍 loudnorm 重写文件；失败只记录，不改索引。
 */
export async function normalizeLibrary(dataRoot, opts = {}) {
  const exe = String(opts.ffmpeg || '').trim();
  if (!exe || !existsSync(exe)) return { ok: false, reason: 'no-ffmpeg', done: 0 };
  const force = opts.force === true;
  const items = loadIndex(dataRoot).items.slice();
  const iLufs = String(opts.lufs || '-18');
  let done = 0;
  const failed = [];
  for (const it of items) {
    if (it.norm === true && !force) continue;
    const src = pathOfItem(dataRoot, it);
    if (!existsSync(src)) continue;
    const tmp = src.replace(/(\.[a-z0-9]+)$/i, '.norm$1');
    const r = await run(exe, ['-y', '-i', src, '-af', `loudnorm=I=${iLufs}:TP=-2:LRA=11`, '-c:a',
      String(it.ext) === 'wav' ? 'pcm_s16le' : 'libmp3lame', tmp], 45000);
    if (!r.ok) {
      failed.push({ id: it.id, reason: r.reason });
      try { unlinkSync(tmp); } catch { /* ignore */ }
      continue;
    }
    try {
      renameSync(tmp, src);
      it.norm = true;
      it.lufs = Number(iLufs);
      done += 1;
    } catch (e) {
      failed.push({ id: it.id, reason: 'rename: ' + ((e && e.message) || String(e)) });
    }
  }
  if (done) saveIndex(dataRoot, items);
  return { ok: done > 0 || !items.length, done, failed };
}

// ── 按分镜计划出 cue ──────────────────────────────────────────────────
/**
 * 把 shot-planner 给的语义提示（{kind, at, gain}）翻成"具体文件 + 时间点"。
 * 与旧的 pickSfxCues 差别：
 *   · 走 shot.sfx 的计划（带转场/节拍语义），不是按固定套路硬塞；
 *   · 同一单内不重复同一个文件（除非库太小）；
 *   · 淡入淡出与时长一起返回，混音时不会"啪"地断掉。
 */
export function planCues(dataRoot, shots, opts = {}) {
  const list = Array.isArray(shots) ? shots : [];
  const base = Math.max(0.05, Math.min(1, Number(opts.gain) || 0.3));
  const maxPerShot = Math.max(0, Math.min(3, Number(opts.maxPerPanel) || 2));
  const used = new Set();
  const out = [];
  for (const shot of list) {
    const dur = Math.max(0.8, Number(shot.holdSec) || 2.4);
    const cues = [];
    for (const c of Array.isArray(shot.sfx) ? shot.sfx : []) {
      if (cues.length >= maxPerShot) break;
      const kind = String(c.kind || '');
      let picked = { path: '', item: null };
      for (let attempt = 0; attempt < 3 && !picked.path; attempt += 1) {
        const p = pick(dataRoot, kind, { seed: (shot.index || 1) * 37 + cues.length * 11 + attempt, query: kind });
        if (p.path && !used.has(p.path)) picked = p;
        else if (p.path && attempt === 2) picked = p; // 库太小就允许复用
      }
      if (!picked.path) continue;
      used.add(picked.path);
      const at = Math.max(0, Math.min(dur - 0.15, Number(c.at) || 0));
      cues.push({
        path: picked.path,
        kind,
        atSec: Number(at.toFixed(2)),
        gain: Math.max(0.04, Math.min(1.2, Number(c.gain) || base)),
        fadeIn: 0.01,
        fadeOut: kind === 'impact' ? 0.08 : 0.16,
        durSec: dur,
        item: picked.item,
      });
    }
    out.push({ index: shot.index, cues });
  }
  return out;
}

// ── 混音 ─────────────────────────────────────────────────────────────

/**
 * 给 ffmpeg 的 filter_complex 追加音效。
 * @param {Array<{inputIndex:number, atSec?:number, gain?:number}>} cues
 * @param {{baseLabel:string, baseInputs?:number}} opts baseLabel 例 '[0:a]'
 * @returns {{chains:string[], outLabel:string, inputs:number}} inputs 用于 amix 的输入数
 */
export function buildSfxFilter(cues, opts = {}) {
  const list = (Array.isArray(cues) ? cues : []).filter((c) => c && Number(c.inputIndex) > 0);
  const baseLabel = String(opts.baseLabel || '[0:a]');
  if (!list.length) return { chains: [], outLabel: baseLabel, inputs: 1 };
  const chains = [];
  const labels = [baseLabel];
  list.forEach((c, i) => {
    const at = Math.max(0, Number(c.atSec) || 0);
    const gain = Math.max(0.02, Math.min(1.5, Number(c.gain) || 0.35));
    const ms = Math.round(at * 1000);
    const fadeIn = Math.max(0, Math.min(0.2, Number(c.fadeIn) || 0.008));
    const fadeOut = Math.max(0, Number(c.fadeOut) || 0);
    const lb = `[s${i + 1}]`;
    // afade 去掉硬边：直接 adelay 播一段采样，尾巴是"啪"的一声断掉，很廉价
    const tail = fadeOut > 0 ? `,afade=t=out:st=${Math.max(0.01, (Number(c.durSec) || 0.4) - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}` : '';
    chains.push(
      `[${c.inputIndex}:a]adelay=${ms}|${ms},volume=${gain.toFixed(2)},` +
      `afade=t=in:st=0:d=${fadeIn.toFixed(3)}${tail}${lb}`,
    );
    labels.push(lb);
  });
  const out = labels.join('') + `amix=inputs=${labels.length}:duration=first:dropout_transition=0,` +
    'alimiter=limit=0.94:level=disabled[aout]';
  chains.push(out);
  return { chains, outLabel: '[aout]', inputs: list.length + 1 };
}
