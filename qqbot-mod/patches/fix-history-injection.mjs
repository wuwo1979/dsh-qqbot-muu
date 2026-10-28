/**
 * fix-history-injection.mjs — 让聊天台账不再吞下扩展注入块
 *
 * 问题（2026-10-23 实证）：
 *   入站扩展 aa-memory-recall 用 ctx.rewrite() 把 `[记忆]…[/记忆] [印象]…[/印象]`
 *   拼到 ctx.message.content；插件 transport/inbound.js 随后用同一个 content 调
 *   appendMsgHistory → 注入块被永久写进 .qqbot/msg-history/*.jsonl，再被镜像进
 *   memory.db 的 chat 表。于是「记忆自己污染记忆」。
 *
 * 修法：
 *   ① 改 dist/features/msg-history.js 的 appendMsgHistory：落盘前剥掉所有注入块；
 *   ② --apply 时顺带做一次性清洗：msg-history 的 .jsonl + memory.db 的 chat 表。
 *
 * 用法：
 *   node patches/fix-history-injection.mjs --check
 *   node patches/fix-history-injection.mjs --apply
 *   node patches/fix-history-injection.mjs --revert
 *   node patches/fix-history-injection.mjs --clean-only     # 只清洗历史，不改代码
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const FILE = pluginPath('dist/features/msg-history.js');
const BACKUP = FILE + '.orig-inject';
const DATA_ROOT = process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const APPLY = args.includes('--apply');
const REVERT = args.includes('--revert');
const CLEAN_ONLY = args.includes('--clean-only');

const ANCHOR = "        x: String(rec.x ?? '').replace(/\\s+/gu, ' ').trim().slice(0, TEXT_MAX),";
const MARK = 'qqs-clean-injected';

// 与 .qqbot-extensions/lib/text-clean.mjs 同源（patch 跑在独立进程，不能直接 import 扩展）
const RE = [
  ['\\[记忆\\]', '\\[\\/记忆\\]'],
  ['\\[信条\\]', '\\[\\/信条\\]'],
  ['\\[设定\\]', '\\[\\/设定\\]'],
  ['\\[印象\\]', '\\[\\/印象\\]'],
  ['\\[旧识\\]', '\\[\\/旧识\\]'],
  ['\\[性格观察\\]', '\\[\\/性格观察\\]'],
  ['\\[成长\\]', '\\[\\/成长\\]'],
  ['\\[关系\\]', '\\[\\/关系\\]'],
  ['\\[状态\\]', '\\[\\/状态\\]'],
  ['\\[B站\\]', '\\[\\/B站\\]'],
];
const LEGACY_TAGS = ['记忆', '信条', '设定', '印象', '旧识', '性格观察', '成长', '关系', '状态', 'B站'];
function cleanInjected(s) {
  let t = String(s == null ? '' : s);
  for (const [a, b] of RE) {
    t = t.replace(new RegExp(a + '[\\s\\S]*?' + b, 'gu'), ' ');
  }
  // 旧版注入没有闭合标签、且被 TEXT_MAX 截断：块总是追加在尾部 ⇒ 从残留标签切到结尾
  for (const tag of LEGACY_TAGS) t = t.replace(new RegExp('\\s*\\[' + tag + '\\][\\s\\S]*$', 'u'), '');
  t = t.replace(/\n?\[别重复\][^\n]*/gu, ' ');
  return t.replace(/[ \t]{2,}/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();
}

function buildLine() {
  return (
    "        x: (function (v) { var t = String(v ?? '');" +
    " t = t.replace(/\\[记忆\\][\\s\\S]*?\\[\\/记忆\\]/gu, ' ')" +
    ".replace(/\\[信条\\][\\s\\S]*?\\[\\/信条\\]/gu, ' ')" +
    ".replace(/\\[设定\\][\\s\\S]*?\\[\\/设定\\]/gu, ' ')" +
    ".replace(/\\[印象\\][\\s\\S]*?\\[\\/印象\\]/gu, ' ')" +
    ".replace(/\\[旧识\\][\\s\\S]*?\\[\\/旧识\\]/gu, ' ')" +
    ".replace(/\\[性格观察\\][\\s\\S]*?\\[\\/性格观察\\]/gu, ' ')" +
    ".replace(/\\[成长\\][\\s\\S]*?\\[\\/成长\\]/gu, ' ')" +
    ".replace(/\\[关系\\][\\s\\S]*?\\[\\/关系\\]/gu, ' ')" +
    ".replace(/\\[状态\\][\\s\\S]*?\\[\\/状态\\]/gu, ' ')" +
    ".replace(/\\[B站\\][\\s\\S]*?\\[\\/B站\\]/gu, ' ')" +
    ".replace(/\\n?\\[别重复\\][^\\n]*/gu, ' ');" +
    " return t.replace(/\\s+/gu, ' ').trim().slice(0, TEXT_MAX); })(rec.x)," +
    " // " + MARK
  );
}

// ── 一次性清洗：msg-history ──────────────────────────────────────────────
function cleanHistoryFiles(root, logger = console) {
  const base = join(root, '.qqbot', 'msg-history');
  if (!existsSync(base)) return { files: 0, rows: 0 };
  let files = 0;
  let rows = 0;
  const stamp = Date.now();
  for (const dirName of readdirSync(base)) {
    const dir = join(base, dirName);
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { /* ignore */ }
    if (!isDir) continue;
    for (const f of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const p = join(dir, f);
      let text = '';
      try { text = readFileSync(p, 'utf8'); } catch { continue; }
      let changed = 0;
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) { out.push(line); continue; }
        try {
          const r = JSON.parse(line);
          const before = String(r.x || '');
          const after = cleanInjected(before);
          if (after !== before) { r.x = after; changed += 1; }
          out.push(JSON.stringify(r));
        } catch { out.push(line); }
      }
      if (changed > 0) {
        try {
          copyFileSync(p, p + '.bak-' + stamp);
          writeFileSync(p, out.join('\n'), 'utf8');
          files += 1;
          rows += changed;
          logger.log(`  [history] ${dirName}/${f}: 清洗 ${changed} 条`);
        } catch (e) {
          logger.log(`  [history] ${dirName}/${f}: 写入失败 ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }
  return { files, rows };
}

// ── 一次性清洗：memory.db chat 表 ────────────────────────────────────────
async function cleanChatTableAsync(root, logger = console) {
  const dbFile = join(root, '.qqbot', 'memory.db');
  if (!existsSync(dbFile)) return { rows: 0, skipped: '无 memory.db' };
  let mod;
  try { mod = await import('node:sqlite'); } catch { return { rows: 0, skipped: 'node:sqlite 不可用' }; }
  const { DatabaseSync } = mod;
  let db;
  try { db = new DatabaseSync(dbFile); } catch (e) { return { rows: 0, skipped: e.message }; }
  let changed = 0;
  try {
    const rows = db.prepare(
      "SELECT rowid AS rid, text FROM chat WHERE text LIKE '%[记忆]%' OR text LIKE '%[信条]%' OR text LIKE '%[印象]%' OR text LIKE '%[旧识]%' OR text LIKE '%[关系]%' OR text LIKE '%[设定]%' OR text LIKE '%[状态]%' OR text LIKE '%[B站]%'",
    ).all();
    const upd = db.prepare('UPDATE chat SET text = ? WHERE rowid = ?');
    for (const r of rows) {
      const after = cleanInjected(r.text);
      if (after !== r.text) { upd.run(after, r.rid); changed += 1; }
    }
    if (changed > 0) logger.log(`  [chat] memory.db chat 表清洗 ${changed} 条`);
  } catch (e) {
    logger.log(`  [chat] 清洗失败(已跳过): ${e instanceof Error ? e.message : e}`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return { rows: changed };
}

async function doClean(logger = console) {
  const h = cleanHistoryFiles(DATA_ROOT, logger);
  const c = await cleanChatTableAsync(DATA_ROOT, logger);
  logger.log(`[clean] msg-history: ${h.files} 个文件 / ${h.rows} 行；chat 表: ${c.rows} 行 ${c.skipped ? '（' + c.skipped + '）' : ''}`);
  return { history: h, chat: c };
}

// ── 主流程 ───────────────────────────────────────────────────────────────
const src = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';

if (REVERT) {
  if (!existsSync(BACKUP)) { console.error('没有备份，无法回滚'); process.exit(1); }
  copyFileSync(BACKUP, FILE);
  console.log('已回滚 msg-history.js');
  process.exit(0);
}

if (CLEAN_ONLY) {
  await doClean();
  process.exit(0);
}

if (CHECK) {
  console.log(src.includes(MARK) ? '已应用' : (src.includes(ANCHOR) ? '可应用：锚点存在' : '不可应用：锚点不存在（插件结构可能变了）'));
  process.exit(0);
}

if (!APPLY) {
  console.log('用法: --check | --apply | --revert | --clean-only');
  process.exit(0);
}

if (!src.includes(ANCHOR) && !src.includes(MARK)) {
  console.error('锚点不存在，插件结构可能变了；未做任何修改');
  process.exit(1);
}

let next = src;
if (!src.includes(MARK)) {
  next = src.replace(ANCHOR, () => buildLine());
}

if (!existsSync(BACKUP)) copyFileSync(FILE, BACKUP);
writeFileSync(FILE, next, 'utf8');

try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'pipe' });
  console.log('补丁已写入 msg-history.js 并通过 node --check');
  announce('msg-history');
} catch (e) {
  copyFileSync(BACKUP, FILE);
  console.error('语法检查失败，已自动还原：', String(e.stderr || e.message).slice(0, 600));
  process.exit(1);
}

await doClean();
