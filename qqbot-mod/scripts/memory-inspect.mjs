#!/usr/bin/env node
/**
 * memory-inspect.mjs — 查看 / 添加 / 删除小蓝的长期记忆（不用进 QQ）
 *
 * 用法：
 *   node memory-inspect.mjs                      列出所有群/私聊的记忆（按时间倒序）
 *   node memory-inspect.mjs --scope group:xxx    只看某个群
 *   node memory-inspect.mjs --stats              只看统计
 *   node memory-inspect.mjs --add "妈妈不吃香菜"  --kind preference --subj 妈妈
 *   node memory-inspect.mjs --forget m_xxxxxx    删掉一条
 *   node memory-inspect.mjs --drop-scope group:xxx   清空某个 scope（会二次确认）
 *
 * 默认读 F:\qqbot\dshqqbot（可用 QQBOT_MEMORY_DATA_ROOT 或 --root 覆盖）。
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CORE = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-core.mjs';
const argv = process.argv.slice(2);
const argOf = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d; };
const has = (k) => argv.includes(k);

const ROOT = argOf('--root') || String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim() || 'F:/qqbot/dshqqbot';

const M = await import(CORE);
const cfg = M.loadConfig(ROOT);
const dir = join(ROOT, '.qqbot', 'memory');

console.log(`数据根: ${ROOT}`);
console.log(`记忆目录: ${dir}`);
console.log(`配置: topK=${cfg.recallTopK} minCos=${cfg.recallMinCos} cap=${cfg.cap} 自动沉淀=${cfg.capture !== false}`);
console.log('');

if (!existsSync(dir)) {
  console.log('记忆目录还不存在 —— 说明还没重启过宿主，或者还没有消息入站。');
  process.exit(0);
}

// ── forget ──
if (has('--forget')) {
  const id = argOf('--forget');
  const ok = M.forgetAnywhere(ROOT, id, cfg);
  console.log(ok ? `✅ 已删除 ${id}` : `❌ 没找到 ${id}`);
  process.exit(ok ? 0 : 1);
}

// ── drop-scope ──
if (has('--drop-scope')) {
  const scope = argOf('--drop-scope');
  const f = M.memoryFile(ROOT, scope);
  if (!existsSync(f)) { console.log(`❌ 没有这个 scope 的文件: ${f}`); process.exit(1); }
  const n = readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  if (!has('--yes')) {
    console.log(`⚠️ 这会删掉 ${n} 条记忆（${scope}）。确认请加 --yes`);
    process.exit(2);
  }
  unlinkSync(f);
  console.log(`✅ 已清空 ${scope}（${n} 条）`);
  process.exit(0);
}

// ── add ──
if (has('--add')) {
  const text = argOf('--add');
  if (!text) { console.log('❌ --add 后面要跟记忆内容'); process.exit(1); }
  const r = M.pushInbox(ROOT, { text, kind: argOf('--kind', 'fact'), subj: argOf('--subj') });
  console.log(r.ok
    ? `✅ 已放进收件箱（下一条 QQ 消息进来时并进那个群的作用域）`
    : `❌ 没写进去: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}

// ── stats ──
const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('_'));
const inbox = existsSync(join(dir, '_inbox.jsonl')) ? readFileSync(join(dir, '_inbox.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;

if (has('--stats') || files.length === 0) {
  console.log(`记忆文件: ${files.length} 个，收件箱待并入: ${inbox} 条`);
  for (const f of files) {
    const scope = f.replace(/\.jsonl$/, '');
    const st = M.stats(ROOT, scope, cfg);
    console.log(`  ${scope.padEnd(28)} ${String(st.total).padStart(5)} 条  ${JSON.stringify(st.byKind)}`);
  }
  process.exit(0);
}

// ── list ──
const scopeFilter = argOf('--scope');
const limit = Number(argOf('--limit', '40')) || 40;
const items = M.listAll(ROOT, { limit, scopeFilter });
console.log(`共 ${files.length} 个 scope，列出最近 ${items.length} 条${scopeFilter ? `（筛选 ${scopeFilter}）` : ''}：\n`);
const pad = (s, n) => { const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0); return String(s) + ' '.repeat(Math.max(0, n - w)); };
for (const it of items) {
  const d = new Date(it.ts || 0);
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  console.log(`${stamp}  ${pad(it.scope, 26)} ${pad('(' + (it.kind || '?') + ')', 13)} ${it.text}`);
  console.log(`${' '.repeat(12)}  id=${it.id}  hits=${it.hits}`);
}
console.log('');
console.log('删一条: node memory-inspect.mjs --forget <id>');
