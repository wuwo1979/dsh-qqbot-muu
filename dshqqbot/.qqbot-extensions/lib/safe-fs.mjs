import { existsSync as __existsSync } from 'node:fs'
const __repoRoot = (() => {
  let cached = ''
  const norm = (p) => String(p || '').split(String.fromCharCode(92)).join('/')
  return () => {
    if (cached) return cached
    const cands = []
    const env = String(process.env.QQBOT_ROOT || process.env.QQBOT_REPO_ROOT || '').trim()
    if (env) cands.push(norm(env))
    try {
      let here = decodeURIComponent(new URL('.', import.meta.url).pathname)
      if (here[0] === '/' && here[2] === ':') here = here.slice(1)
      here = norm(here).replace(/\/+$/, '')
      let d = here
      for (let i = 0; i < 6; i += 1) {
        if (!d) break
        cands.push(d)
        const k = d.lastIndexOf('/')
        d = k > 0 ? d.slice(0, k) : ''
      }
    } catch { /* noop */ }
    try { cands.push(norm(process.cwd())) } catch { /* noop */ }
    for (const c of cands) {
      try {
        if (c && (__existsSync(c + '/qqbot-mod/muu-shared.mjs') || __existsSync(c + '/dshqqbot'))) { cached = c; return cached }
      } catch { /* noop */ }
    }
    cached = norm(cands.find(Boolean) || '.')
    return cached
  }
})()
/**
 * lib/safe-fs.mjs — 文件操作留底（可回溯 / 可撤回 / 可清理）
 *
 * ★ 2026-11-11 主人需求（原话）：
 *   「对我们 dsh-qqbot-muu 项目，也要有基础的指令刻写到底层，比如操作文件时在一开始保留源文件，
 *    创建新的/留下可回溯/撤回的操作，比如展示保留的文件等，以便后期恢复/下载/删除以节约资源」
 *
 * 规矩（写死在代码里，调用方不必记）：
 *   1. **先留底，再动手**：任何覆盖/删除/批量改写之前，先 backup() 把原件按快照存下来；
 *   2. **快照不可变**：snaps/<id>/ 里只存原始字节 + meta.json，不存加工后的结果；
 *   3. **能看得见**：list() 给出 id / 时间 / 原因 / 文件数 / 占用，方便决定留还是删；
 *   4. **能恢复、能省空间**：restore() 原样写回；rm()/prune() 删快照回收空间。
 *
 * 存储布局（默认 dataRoot = <仓库根>）：
 *   <dataRoot>/.qqbot/safe/index.jsonl      一行一条快照元数据（append-only，删快照时重写）
 *   <dataRoot>/.qqbot/safe/snaps/<id>/…     原件副本（保持相对路径）
 */
import {
  existsSync, mkdirSync, copyFileSync, statSync, readdirSync,
  readFileSync, writeFileSync, rmSync, appendFileSync, renameSync,
} from 'node:fs';
import { join, basename, resolve, sep, dirname } from 'node:path';

const DEFAULT_DAYS = 14;                  // 快照默认保留 14 天
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024 * 1024; // 或总量超过 3GB 时按最旧优先清

function safeRoot(dataRoot) {
  // 2026-11-11：dataRoot 下的 `.qqbot` 是只读的（ACL 限制，mkdir 直接 EPERM），
  // 所以快照库放在 dataRoot 的**上一级**：<workspace>/snapshots。
  // 可用环境变量 QQBOT_SNAPSHOTS 覆盖（想放别的盘就设它）。
  const env = process.env.QQBOT_SNAPSHOTS;
  if (env && String(env).trim()) return resolve(String(env).trim());
  const root = String(dataRoot || __repoRoot() + "/dshqqbot");
  return join(dirname(resolve(root)), 'snapshots');
}
function indexPath(dataRoot) {
  return join(safeRoot(dataRoot), 'index.jsonl');
}
function snapsDir(dataRoot) {
  return join(safeRoot(dataRoot), 'snaps');
}

function ensureDirs(dataRoot) {
  const s = snapsDir(dataRoot);
  if (!existsSync(s)) mkdirSync(s, { recursive: true });
}

function readIndex(dataRoot) {
  const p = indexPath(dataRoot);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

function writeIndex(dataRoot, rows) {
  const p = indexPath(dataRoot);
  const tmp = p + '.tmp';
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  renameSync(tmp, p);
}

function walkSize(abs) {
  try {
    const st = statSync(abs);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let sum = 0;
    for (const name of readdirSync(abs)) sum += walkSize(join(abs, name));
    return sum;
  } catch { return 0; }
}

function copyInto(srcAbs, dstAbs) {
  const st = statSync(srcAbs);
  if (st.isDirectory()) {
    mkdirSync(dstAbs, { recursive: true });
    for (const name of readdirSync(srcAbs)) copyInto(join(srcAbs, name), join(dstAbs, name));
    return;
  }
  mkdirSync(join(dstAbs, '..'), { recursive: true });
  copyFileSync(srcAbs, dstAbs);
}

function rid() {
  return 'snap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * 留底：把 paths 里的文件/目录按原样复制进一个新快照。
 * @param {string} dataRoot
 * @param {string[]} paths 绝对路径（或相对 root 的路径）
 * @param {{ reason?: string, scope?: string, keepNames?: boolean }} [opt]
 */
export function backup(dataRoot, paths = [], opt = {}) {
  try {
    const list = (Array.isArray(paths) ? paths : [paths]).map((p) => resolve(String(p || ''))).filter(Boolean);
    if (!list.length) return { ok: false, reason: '没有要留底的文件' };
    const id = rid();
    const dir = join(snapsDir(dataRoot), id);
    ensureDirs(dataRoot);
    mkdirSync(dir, { recursive: true });
    const items = [];
    for (const src of list) {
      if (!existsSync(src)) { items.push({ src, missing: true, bytes: 0 }); continue; }
      const dst = join(dir, 'files', basename(src));
      copyInto(src, dst);
      items.push({ src, dst, bytes: walkSize(dst), kind: statSync(src).isDirectory() ? 'dir' : 'file' });
    }
    const meta = {
      id,
      at: Date.now(),
      reason: String(opt.reason || '').slice(0, 200),
      scope: String(opt.scope || '').slice(0, 120),
      items,
      totalBytes: items.reduce((n, it) => n + (Number(it.bytes) || 0), 0),
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 1), 'utf8');
    appendFileSync(indexPath(dataRoot), JSON.stringify(meta) + '\n', 'utf8');
    return { ok: true, ...meta, dir };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 看有哪些快照（新的在前） */
export function list(dataRoot, { limit = 20 } = {}) {
  const rows = readIndex(dataRoot);
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  const lim = Math.max(1, Math.min(200, Number(limit) || 20));
  return rows.slice(0, lim).map((r) => ({
    id: r.id,
    at: r.at,
    when: new Date(r.at).toLocaleString('zh-CN'),
    reason: r.reason || '',
    files: (r.items || []).filter((it) => !it.missing).length,
    missing: (r.items || []).filter((it) => it.missing).length,
    bytes: Number(r.totalBytes) || 0,
    sources: (r.items || []).map((it) => it.src).slice(0, 6),
  }));
}

/** 单条快照详情 */
export function show(dataRoot, id) {
  const hit = readIndex(dataRoot).find((r) => r.id === String(id || ''));
  if (!hit) return { ok: false, reason: '没找到这个快照' };
  return { ok: true, ...hit, when: new Date(hit.at).toLocaleString('zh-CN') };
}

/**
 * 恢复：把快照里的原件写回原位（或写到 to 指定的目录）。
 * 覆盖之前会先把"现在的版本"再留一次底，避免恢复本身造成二次丢失。
 */
export function restore(dataRoot, id, { to = '', force = false } = {}) {
  const hit = readIndex(dataRoot).find((r) => r.id === String(id || ''));
  if (!hit) return { ok: false, reason: '没找到这个快照' };
  const existing = (hit.items || []).filter((it) => it.dst && existsSync(it.dst)).map((it) => it.src);
  if (existing.length && !force) {
    return { ok: false, reason: 'before-restore', needForce: true, targets: existing, note: '恢复会覆盖现有的同名文件，确认后再来一次（force=true）' };
  }
  if (existing.length) backup(dataRoot, existing, { reason: '恢复前自动留底 ' + hit.id, scope: hit.scope });
  const done = [];
  for (const it of hit.items || []) {
    if (!it.dst || !existsSync(it.dst)) { done.push({ src: it.src, ok: false, reason: '快照里没有这个文件' }); continue; }
    const dst = to ? join(to, basename(it.src)) : it.src;
    try {
      copyInto(it.dst, dst);
      done.push({ src: it.src, dst, ok: true });
    } catch (e) {
      done.push({ src: it.src, ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: done.every((d) => d.ok), from: hit.id, restored: done };
}

/** 删一个快照，回收空间 */
export function remove(dataRoot, id) {
  try {
    const rows = readIndex(dataRoot);
    const hit = rows.find((r) => r.id === String(id || ''));
    if (!hit) return { ok: false, reason: '没找到这个快照' };
    const dir = join(snapsDir(dataRoot), hit.id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    writeIndex(dataRoot, rows.filter((r) => r.id !== hit.id));
    return { ok: true, id: hit.id, freed: Number(hit.totalBytes) || 0 };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 批量清理：超过 days 天、或总量超过 maxBytes 时从最旧的开始删 */
export function prune(dataRoot, { days = DEFAULT_DAYS, maxBytes = DEFAULT_MAX_BYTES, dryRun = false } = {}) {
  try {
    const rows = readIndex(dataRoot).sort((a, b) => (a.at || 0) - (b.at || 0));
    const now = Date.now();
    const keep = [];
    const drop = [];
    let total = rows.reduce((n, r) => n + (Number(r.totalBytes) || 0), 0);
    for (const r of rows) {
      const tooOld = days > 0 && (now - Number(r.at || 0)) > days * 86400000;
      if (tooOld) { drop.push(r); total -= Number(r.totalBytes) || 0; continue; }
      keep.push(r);
    }
    while (total > maxBytes && keep.length) {
      const r = keep.shift();
      drop.push(r);
      total -= Number(r.totalBytes) || 0;
    }
    if (!dryRun) {
      for (const r of drop) {
        const dir = join(snapsDir(dataRoot), r.id);
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
      writeIndex(dataRoot, keep.sort((a, b) => (a.at || 0) - (b.at || 0)));
    }
    return {
      ok: true,
      dryRun: Boolean(dryRun),
      dropped: drop.length,
      kept: keep.length,
      freed: drop.reduce((n, r) => n + (Number(r.totalBytes) || 0), 0),
      ids: drop.map((r) => r.id),
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 占用统计 */
export function stats(dataRoot) {
  const rows = readIndex(dataRoot);
  return {
    ok: true,
    count: rows.length,
    bytes: rows.reduce((n, r) => n + (Number(r.totalBytes) || 0), 0),
    oldest: rows.length ? Math.min(...rows.map((r) => Number(r.at) || 0)) : 0,
    newest: rows.length ? Math.max(...rows.map((r) => Number(r.at) || 0)) : 0,
  };
}

export default { backup, list, show, restore, remove, prune, stats, safeRoot };
