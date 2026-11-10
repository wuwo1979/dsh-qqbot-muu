/**
 * lib/pet-outfits.mjs — 宠物形象 / 服装皮肤注册表
 *
 * 两套形态互不干扰：xiaolan（小蓝，2D 立绘）与 muu（普通大肥鱼，像素/卡通）。
 * 每套形态下挂若干 outfit（皮肤），资产由 assets/pet-outfits/manifest.json 描述，
 * 实拍图由 qqbot-mod/scripts/build-pet-outfits.py 从既有立绘本地派生。
 *
 * 约定：
 *   · 形态 form 只能是 manifest 里的 key，切形态时两个桌面宠物互斥（既有逻辑）；
 *   · 皮肤只是「同一形态下的配色/资产集」，切换不写人格、不影响另一形态；
 *   · 资产路径 assets/pet-outfits/<form>/<outfit>/pose/<pose>.png，preview 同名目录；
 *   · 偏好落盘 data/pet-outfits.json，按 form 分开存，互不覆盖。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..'); // .qqbot-extensions/lib → repo

const _cache = new Map(); // file → { mtimeMs, manifest }

export function assetsRoot() {
  const env = String(process.env.QQBOT_ASSETS_ROOT || '').trim();
  if (env) return join(env, 'pet-outfits');
  return join(REPO, 'assets', 'pet-outfits');
}

export function manifestFile() {
  return join(assetsRoot(), 'manifest.json');
}

export function loadManifest() {
  const file = manifestFile();
  if (!existsSync(file)) return null;
  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { /* ignore */ }
  const hit = _cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.manifest;
  try {
    const manifest = JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
    _cache.set(file, { mtimeMs, manifest });
    return manifest;
  } catch { return null; }
}

export function forms() {
  const m = loadManifest();
  return m ? Object.keys(m.forms || {}) : [];
}

export function formInfo(form) {
  const m = loadManifest();
  return (m && m.forms && m.forms[String(form)]) || null;
}

export function outfitsOf(form) {
  const f = formInfo(form);
  return Array.isArray(f?.outfits) ? f.outfits : [];
}

export function outfitInfo(form, outfit) {
  return outfitsOf(form).find((x) => String(x.id) === String(outfit)) || null;
}

export function defaultOutfit(form) {
  const f = formInfo(form);
  return String(f?.defaultOutfit || 'default');
}

export function prefFile(dataRoot) {
  return join(String(dataRoot || ''), '.qqbot-extensions', 'data', 'pet-outfits.json');
}

function readPref(dataRoot) {
  try {
    const f = prefFile(dataRoot);
    if (!existsSync(f)) return {};
    return JSON.parse(String(readFileSync(f, 'utf8')).replace(/^\uFEFF/, '')) || {};
  } catch { return {}; }
}

/** 当前形态选中的皮肤；文件损坏/皮肤不存在都回落 default */
export function currentOutfit(dataRoot, form) {
  const pref = readPref(dataRoot)?.[String(form)];
  const id = String(pref?.outfit || '');
  return outfitInfo(form, id) ? id : defaultOutfit(form);
}

export function setOutfit(dataRoot, form, outfit) {
  if (!formInfo(form)) return { ok: false, reason: `未知形态：${form}` };
  if (!outfitInfo(form, outfit)) return { ok: false, reason: `形态 ${form} 没有皮肤：${outfit}` };
  const pref = readPref(dataRoot);
  pref[String(form)] = { outfit: String(outfit), at: Date.now() };
  try {
    mkdirSync(dirname(prefFile(dataRoot)), { recursive: true });
    writeFileSync(prefFile(dataRoot), JSON.stringify(pref, null, 2), 'utf8');
    return { ok: true, outfit: String(outfit) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function posesOf(form) {
  const f = formInfo(form);
  return Array.isArray(f?.poses) ? f.poses : [];
}

/** 形态只支持一个姿势（大肥鱼）时，请求别的姿势就退回第一个可用姿势 */
export function poseFallback(form, pose) {
  const list = posesOf(form);
  if (!list.length) return String(pose || '');
  return list.includes(String(pose)) ? String(pose) : list[0];
}

function poseBase(form, pose) {
  const f = formInfo(form);
  if (!f) return '';
  const name = f.poseFiles?.[pose] || (pose + '.png');
  return join(REPO, String(f.sourceDir || '').replace(/^\/+/, ''), name);
}

/**
 * 某个形态+皮肤+姿势的真实文件：
 *   优先 assets/pet-outfits/<form>/<outfit>/pose/<pose>.png，
 *   没生成过就回落原始立绘（保证 default/新皮肤未构建时也不崩）。
 */
export function posePath(form, outfit, pose) {
  const id = outfitInfo(form, outfit) ? String(outfit) : defaultOutfit(form);
  const wanted = poseFallback(form, pose);
  const p = join(assetsRoot(), String(form), id, 'pose', wanted + '.png');
  return existsSync(p) ? p : poseBase(form, wanted);
}

export function previewPath(form, outfit) {
  const id = outfitInfo(form, outfit) ? String(outfit) : defaultOutfit(form);
  return join(assetsRoot(), String(form), id, 'preview.png');
}

/** 给宠物页/调试用的清单：每个皮肤一行，带是否已生成资产 */
export function summary(dataRoot) {
  const out = [];
  for (const form of forms()) {
    const f = formInfo(form) || {};
    const active = currentOutfit(dataRoot, form);
    for (const o of outfitsOf(form)) {
      out.push({
        form,
        formName: f.displayName || form,
        id: o.id,
        name: o.name || o.id,
        active: o.id === active,
        accent: o.palette?.accent || '#7fd7ff',
        preview: previewPath(form, o.id),
        built: existsSync(previewPath(form, o.id)),
      });
    }
  }
  return out;
}

export default {
  assetsRoot, manifestFile, loadManifest, forms, formInfo, outfitsOf, outfitInfo,
  defaultOutfit, currentOutfit, setOutfit, posePath, previewPath, summary, prefFile,
  posesOf, poseFallback,
};
