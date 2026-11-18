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
 * tools/safe_fs.mjs — 文件留底 / 回溯 / 回收
 *
 * ★ 规矩（2026-11-11 主人要求，写进工具描述里给我自己看）：
 *   动任何已有文件之前（覆盖、删除、批量改写、迁移），**先 backup**，再动手。
 *   快照不可变、可 list、可 restore、可 prune（省空间）。
 *
 * action:
 *   backup  要 paths（数组或逗号分隔）+ 可选 reason/scope
 *   list    看最近的快照（limit）
 *   show    看一个快照的细节（id）
 *   restore 恢复（id；可选 to / force）
 *   rm      删一个快照（id），回收空间
 *   prune   批量清理（days / maxBytes / dryRun）
 *   stats   占用统计
 */
import * as SafeFS from '../lib/safe-fs.mjs';

export const name = 'safe_fs';
export const description =
  '文件操作留底：动手改/删文件前先 backup 存原件，之后可以 list 看、restore 写回、rm/prune 清掉省空间。backup 要 paths；restore/rm/show 要 id。';

export const inputSchema = {
  action: {
    type: 'string',
    required: true,
    enum: ['backup', 'list', 'show', 'restore', 'rm', 'prune', 'stats'],
    description: 'backup=留底(要 paths)；list=看快照；show/restore/rm=按 id；prune=批量清理；stats=占用统计',
  },
  paths: { type: 'array', items: { type: 'string' }, description: 'backup 用：要留底的绝对路径（文件或目录）' },
  reason: { type: 'string', description: 'backup 用：为什么留底（会显示在列表里）' },
  scope: { type: 'string', description: 'backup 用：哪个会话/任务触发的（可选）' },
  id: { type: 'string', description: 'show/restore/rm 用：快照 id' },
  to: { type: 'string', description: 'restore 用：恢复到哪个目录（默认写回原位）' },
  force: { type: 'boolean', description: 'restore 用：确认覆盖现有文件' },
  limit: { type: 'number', description: 'list 条数，默认 10' },
  days: { type: 'number', description: 'prune 用：保留天数，默认 14' },
  maxBytes: { type: 'number', description: 'prune 用：总占用上限，默认 3GB' },
  dryRun: { type: 'boolean', description: 'prune 用：只看会删什么，不真删' },
};

function dataRootOf(env) {
  return String((env && (env.caps && env.caps.dataRoot)) || process.env.QQBOT_MEMORY_DATA_ROOT || __repoRoot() + "/dshqqbot");
}

function human(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function normPaths(args) {
  const raw = args.paths;
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  return String(raw || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

export async function run(args = {}, env = {}) {
  const dataRoot = dataRootOf(env);
  const action = String(args.action || 'list');
  try {
    if (action === 'backup') {
      const paths = normPaths(args);
      if (!paths.length) return { ok: false, error: '没给 paths' };
      const r = SafeFS.backup(dataRoot, paths, { reason: args.reason, scope: args.scope });
      if (!r.ok) return { ok: false, error: r.reason };
      return {
        ok: true,
        id: r.id,
        dir: r.dir,
        files: r.items.filter((it) => !it.missing).length,
        bytes: r.totalBytes,
        msg: `留底完成：${r.id}（${r.items.filter((it) => !it.missing).length} 个，${human(r.totalBytes)}）`,
      };
    }
    if (action === 'list') {
      const rows = SafeFS.list(dataRoot, { limit: Number(args.limit) || 10 });
      return {
        ok: true,
        count: rows.length,
        rows,
        msg: rows.length
          ? rows.map((r) => `${r.id} · ${r.when} · ${r.files} 个文件 · ${human(r.bytes)}${r.reason ? ' · ' + r.reason : ''}`).join('\n')
          : '还没有快照',
      };
    }
    if (action === 'show') {
      const r = SafeFS.show(dataRoot, args.id);
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true, snap: r, msg: `${r.id} · ${r.when} · ${human(r.totalBytes)}\n` + (r.items || []).map((it) => `- ${it.src}${it.missing ? '（原文件已不存在）' : ''}`).join('\n') };
    }
    if (action === 'restore') {
      const r = SafeFS.restore(dataRoot, args.id, { to: args.to || '', force: Boolean(args.force) });
      if (!r.ok && r.reason === 'before-restore') {
        return { ok: false, needForce: true, targets: r.targets, msg: '要覆盖这些文件才能恢复：\n' + (r.targets || []).join('\n') + '\n确认的话再来一次 force=true（我会先把现在的版本再留一次底）' };
      }
      if (!r.ok) return { ok: false, error: r.reason || '恢复失败', restored: r.restored };
      return { ok: true, restored: r.restored, msg: '恢复完成：\n' + r.restored.map((d) => `- ${d.src}${d.ok ? ' ✓' : ' ✗ ' + (d.reason || '')}`).join('\n') };
    }
    if (action === 'rm') {
      const r = SafeFS.remove(dataRoot, args.id);
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true, id: r.id, freed: r.freed, msg: `删掉了 ${r.id}，回收 ${human(r.freed)}` };
    }
    if (action === 'prune') {
      const r = SafeFS.prune(dataRoot, { days: Number(args.days) || 14, maxBytes: Number(args.maxBytes) || undefined, dryRun: Boolean(args.dryRun) });
      if (!r.ok) return { ok: false, error: r.reason };
      return { ok: true, ...r, msg: `${r.dryRun ? '预计' : '已'}清理 ${r.dropped} 个快照，回收 ${human(r.freed)}，保留 ${r.kept} 个` };
    }
    const st = SafeFS.stats(dataRoot);
    return { ok: true, ...st, msg: `${st.count} 个快照，共 ${human(st.bytes)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default { name, description, inputSchema, run, expose: 'all' };
