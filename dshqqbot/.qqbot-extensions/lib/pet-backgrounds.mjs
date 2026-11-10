/**
 * lib/pet-backgrounds.mjs — 桌宠背景图注册表（2026-11-08）
 *
 * 背景 = 网页桌宠舞台（#stage）最底下的一层独立图片，和立绘视频层彻底分开：
 *   · 换背景只改 #bg 的 background-image，不碰 <video>、不重设 src、不调 play()；
 *   · 偏好落盘 data/pet-backgrounds.json（{current, dirs}），
 *     与宠物形态（dsh-pet 配置）、皮肤（pet-outfits.json）互不影响。
 *
 * 来源：
 *   1. 内置：assets/pet-backgrounds/manifest.json 登记的图片；
 *   2. 自定义目录：assets/pet-backgrounds/custom/ 以及配置里 dirs 扫描到的图片
 *      （png/jpg/jpeg/webp/gif/svg/avif/bmp，最多下钻 2 层）。
 *
 * 安全：图片接口只接受本模块生成的 id（内置 id 或 base64url 路径），
 * 路径必须落在允许目录内（realpath 校验），不接受任意路径。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..'); // .qqbot-extensions/lib → repo

const IMG_RE = /\.(png|jpg|jpeg|webp|gif|svg|avif|bmp)$/i;
const MAX_SCAN_DEPTH = 2;
export const DEFAULT_BG_ID = 'none';
export const DEFAULT_BG_NAME = '默认渐变';

export const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

export function backgroundsRoot() {
  const own = String(process.env.QQBOT_PET_BG_ROOT || '').trim();
  if (own) return resolve(own);
  const assets = String(process.env.QQBOT_ASSETS_ROOT || '').trim();
  if (assets) return join(resolve(assets), 'pet-backgrounds');
  const inRepo = join(REPO, 'assets', 'pet-backgrounds');
  if (existsSync(inRepo)) return inRepo;
  return join(REPO, '..', 'assets', 'pet-backgrounds');
}

export function manifestFile() {
  return join(backgroundsRoot(), 'manifest.json');
}

export function prefFile(dataRoot) {
  return join(String(dataRoot || ''), '.qqbot-extensions', 'data', 'pet-backgrounds.json');
}

function readPref(dataRoot) {
  try {
    const f = prefFile(dataRoot);
    if (!existsSync(f)) return { current: DEFAULT_BG_ID, dirs: [] };
    const j = JSON.parse(String(readFileSync(f, 'utf8')).replace(/^\uFEFF/, '')) || {};
    return {
      current: typeof j.current === 'string' && j.current ? j.current : DEFAULT_BG_ID,
      dirs: Array.isArray(j.dirs) ? j.dirs.filter((x) => typeof x === 'string' && x.trim()) : [],
    };
  } catch {
    return { current: DEFAULT_BG_ID, dirs: [] };
  }
}

function writePref(dataRoot, pref) {
  const f = prefFile(dataRoot);
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ ...pref, at: Date.now() }, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function builtinManifest() {
  try {
    const j = JSON.parse(String(readFileSync(manifestFile(), 'utf8')).replace(/^\uFEFF/, ''));
    return Array.isArray(j?.backgrounds) ? j.backgrounds : [];
  } catch {
    return [];
  }
}

/** 内置条目：id 形如 builtin:sea-mist */
function builtinEntries() {
  const root = backgroundsRoot();
  const out = [];
  for (const b of builtinManifest()) {
    const id = String(b.id || '').trim();
    const file = String(b.file || '').trim();
    if (!id || !file) continue;
    const p = resolve(root, file);
    if (!isInside(p, root) || !existsSync(p)) continue;
    out.push({ id: `builtin:${id}`, name: String(b.name || id), url: imageUrl(`builtin:${id}`), builtin: true });
  }
  return out;
}

/** 本地文件 → 稳定 id（base64url 绝对路径） */
function encodeFileId(absPath) {
  return `f:${Buffer.from(String(absPath), 'utf8').toString('base64url')}`;
}

function decodeFileId(id) {
  return Buffer.from(String(id).slice(2), 'base64url').toString('utf8');
}

export function imageUrl(id) {
  return `/api/qqbot-settings/pet-background-image?id=${encodeURIComponent(id)}`;
}

function isInside(file, dir) {
  const f = resolve(file);
  const d = resolve(dir);
  return f === d || f.startsWith(d + sep);
}

function realOrSelf(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function scanDir(dir, depth = 0) {
  const out = [];
  let stat = null;
  try { stat = statSync(dir); } catch { return out; }
  if (!stat.isDirectory() || depth > MAX_SCAN_DEPTH) return out;
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      out.push(...scanDir(p, depth + 1));
      continue;
    }
    if (!e.isFile() || !IMG_RE.test(e.name)) continue;
    out.push({ path: p, name: basename(e.name, extname(e.name)) });
  }
  return out;
}

function customEntries(pref) {
  const out = [];
  const dirs = [join(backgroundsRoot(), 'custom'), ...pref.dirs.map((d) => resolve(String(d).trim()))];
  const seenName = new Set();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = scanDir(dir).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const f of files) {
      const id = encodeFileId(f.path);
      let name = f.name;
      if (seenName.has(name)) name = `${name}·${basename(dir)}`;
      seenName.add(name);
      out.push({ id, name, url: imageUrl(id), builtin: false });
    }
  }
  return out;
}

/** 完整清单：默认渐变 + 内置 + 自定义扫描；current 若已失效回落默认 */
export function listBackgrounds(dataRoot) {
  const pref = readPref(dataRoot);
  const entries = [
    { id: DEFAULT_BG_ID, name: DEFAULT_BG_NAME, url: '', builtin: true },
    ...builtinEntries(),
    ...customEntries(pref),
  ];
  const current = entries.some((x) => x.id === pref.current) ? pref.current : DEFAULT_BG_ID;
  const rev = `${current}|${entries.map((x) => x.id).join(',')}|${pref.dirs.join(';')}`;
  return { current, backgrounds: entries, dirs: pref.dirs, rev };
}

export function setBackground(dataRoot, id) {
  const list = listBackgrounds(dataRoot);
  const hit = list.backgrounds.find((x) => x.id === String(id || ''));
  if (!hit) return { ok: false, reason: `没有这个背景：${id}` };
  const r = writePref(dataRoot, { current: hit.id, dirs: list.dirs });
  return r.ok ? { ok: true, background: hit } : r;
}

export function addDir(dataRoot, dir) {
  const p = resolve(String(dir || '').trim());
  let st = null;
  try { st = statSync(p); } catch { return { ok: false, reason: '目录不存在' }; }
  if (!st.isDirectory()) return { ok: false, reason: '不是目录' };
  const list = listBackgrounds(dataRoot);
  if (list.dirs.includes(p)) return { ok: true, dirs: list.dirs };
  const r = writePref(dataRoot, { current: list.current, dirs: [...list.dirs, p] });
  return r.ok ? { ok: true, dirs: [...list.dirs, p] } : r;
}

export function removeDir(dataRoot, dir) {
  const p = resolve(String(dir || '').trim());
  const list = listBackgrounds(dataRoot);
  const dirs = list.dirs.filter((x) => resolve(x) !== p);
  const r = writePref(dataRoot, { current: list.current, dirs });
  return r.ok ? { ok: true, dirs } : r;
}

/** id → 可读文件；只认本模块生成的 id，且路径必须在允许目录内 */
export function resolveImage(id, dataRoot) {
  const key = String(id || '');
  if (!key) return null;
  let abs = null;
  if (key.startsWith('builtin:')) {
    const want = key.slice('builtin:'.length);
    const hit = builtinManifest().find((b) => String(b.id) === want);
    if (!hit) return null;
    abs = resolve(backgroundsRoot(), String(hit.file || ''));
  } else if (key.startsWith('f:')) {
    abs = decodeFileId(key);
  } else {
    return null;
  }
  if (!abs || !IMG_RE.test(abs) || !existsSync(abs)) return null;
  const real = realOrSelf(abs);
  const dirs = [backgroundsRoot(), join(backgroundsRoot(), 'custom'), ...readPref(dataRoot).dirs];
  for (const d of dirs) {
    const rd = realOrSelf(d);
    if (real === rd || real.startsWith(rd + sep)) return real;
  }
  return null;
}

export function contentTypeOf(file) {
  return MIME[extname(String(file)).toLowerCase()] || 'application/octet-stream';
}
