/**
 * memory-maintain.mjs — 记忆库一次性体检/清理（只动重复与脏正文，不删真实记忆）
 *
 * 为什么需要（2026-10-23 实测坐实的两个真问题）：
 *   ① 老记忆的正文里带着 `<@OPENID>` 平台标记（cleanMemText 上线前写进去的）：
 *      注入上下文白占长度，问"你还记得…"时模型还会以为在被人 @。
 *      现在读取侧已经会洗，但库里存着脏数据迟早还会被别处读到 → 这里一次性抹干净。
 *   ② 同一条消息存了两遍（并发 remember 的竞态，已在写入侧修掉）：
 *      重复条目会白占 topK 名额，所以这里按"归一化正文"归并，保留 hits 高的那条。
 *
 * 用法：
 *   node qqbot-mod\scripts\memory-maintain.mjs               # 只体检，不写
 *   node qqbot-mod\scripts\memory-maintain.mjs --apply       # 真改（改前自动 VACUUM INTO 备份）
 *   node qqbot-mod\scripts\memory-maintain.mjs --apply --root D:/data
 *
 * 安全：任何异常都以非 0 退出；--apply 会先备份到 `{root}/.qqbot/memory.db.bak-<ts>`。
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, cleanMemText, dbFile, memoryBackend } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory.mjs';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const rootIdx = argv.indexOf('--root');
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : (process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot');

function log(...a) { console.log(...a); }

const be = typeof memoryBackend === 'function' ? memoryBackend() : memoryBackend;
if (!be || be.backend !== 'sqlite') {
  log('后端不是 sqlite（' + JSON.stringify(be) + '）→ 无需清理，退出');
  process.exit(0);
}

const file = dbFile(ROOT);
if (!existsSync(file)) {
  log('库文件不存在: ' + file);
  process.exit(1);
}
log('库: ' + file + '  (' + statSync(file).size + ' 字节)');

const h = openDb(ROOT);
const rows = h.db.prepare('SELECT id, scope, text, hits, ts FROM mem ORDER BY ts ASC').all();
log('总条数: ' + rows.length);

// ── ① 正文清洗计划 ──
const updates = [];
for (const r of rows) {
  const cleaned = cleanMemText(r.text);
  if (cleaned && cleaned !== r.text) updates.push({ id: r.id, from: r.text, to: cleaned });
}

// ── ② 重复归并计划（同一 scope 内归一化正文相同 → 留 hits 高/新的）──
const groups = new Map();
for (const r of rows) {
  const key = r.scope + '\u0001' + cleanMemText(r.text);
  const g = groups.get(key);
  if (!g) groups.set(key, [r]);
  else g.push(r);
}
const deletes = [];
let dupGroups = 0;
for (const [, g] of groups) {
  if (g.length < 2) continue;
  dupGroups += 1;
  const keep = g.reduce((a, b) => {
    const ha = Number(a.hits) || 0;
    const hb = Number(b.hits) || 0;
    if (hb !== ha) return hb > ha ? b : a;
    return Number(b.ts) > Number(a.ts) ? b : a;
  });
  for (const r of g) if (r.id !== keep.id) deletes.push({ id: r.id, text: r.text });
}

log('\n── 体检结果 ──');
log('正文需要洗掉 @标记 的: ' + updates.length);
log('重复条目组: ' + dupGroups + '（可删 ' + deletes.length + ' 条）');
for (const u of updates.slice(0, 5)) log('  洗: ' + JSON.stringify(u.from.slice(0, 50)) + ' → ' + JSON.stringify(u.to.slice(0, 50)));
for (const d of deletes.slice(0, 5)) log('  删: ' + JSON.stringify(String(d.text).slice(0, 50)));

if (!apply) {
  log('\n（只体检，未改动。真改加 --apply）');
  process.exit(0);
}

// ── 备份 ──
const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const bak = join(ROOT, '.qqbot', 'memory.db.bak-' + stamp);
try {
  h.db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
  log('\n已备份: ' + bak);
} catch (e) {
  log('\n备份失败，放弃改动: ' + (e && e.message));
  process.exit(1);
}

// ── 执行 ──
let nUpd = 0;
let nDel = 0;
h.db.exec('BEGIN');
try {
  const up = h.db.prepare('UPDATE mem SET text = ? WHERE id = ?');
  for (const u of updates) { up.run(u.to, u.id); nUpd += 1; }
  const del = h.db.prepare('DELETE FROM mem WHERE id = ?');
  for (const d of deletes) { del.run(d.id); nDel += 1; }
  // FTS 跟着更新（有就同步，没有就算了）
  try {
    const upFts = h.db.prepare('UPDATE mem_fts SET text = ? WHERE id = ?');
    for (const u of updates) upFts.run(u.to, u.id);
    const delFts = h.db.prepare('DELETE FROM mem_fts WHERE id = ?');
    for (const d of deletes) delFts.run(d.id);
  } catch { /* 没有 FTS 表 */ }
  h.db.exec('COMMIT');
} catch (e) {
  try { h.db.exec('ROLLBACK'); } catch { /* ignore */ }
  log('执行失败已回滚: ' + (e && e.message));
  process.exit(1);
}

const after = h.db.prepare('SELECT COUNT(*) AS n FROM mem').get();
log('完成：清洗 ' + nUpd + ' 条，删除重复 ' + nDel + " 条，现存 " + (after && after.n) + ' 条');
process.exit(0);
