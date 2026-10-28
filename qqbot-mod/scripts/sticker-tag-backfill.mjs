#!/usr/bin/env node
/**
 * sticker-tag-backfill.mjs — 给存量表情包补本地视觉标签
 *
 * 用途：插件只在"新图入库"时自动打标；历史候选区全是未打标状态。
 * 这里用同一个 CLI（sticker-vision-cli.mjs → 本机 Ollama qwen2.5vl:3b）逐张补：
 *   node qqbot-mod/scripts/sticker-tag-backfill.mjs --limit 10
 *   node qqbot-mod/scripts/sticker-tag-backfill.mjs --dry
 *
 * 只处理 candidate / library；trash / negative 不碰。逐张串行（避免抢显存）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = process.argv.find((a) => a.startsWith('--dir='))?.slice(6) || 'F:/qqbot/dshqqbot/表情包';
const CLI = 'F:/qqbot/qqbot-mod/scripts/sticker-vision-cli.mjs';
/** 取 `--limit=3` 或 `--limit 3` 两种写法 */
function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : '';
}
const LIMIT = Number(argValue('--limit')) || 999;
const DRY = process.argv.includes('--dry');

function resolveStorePath() {
  const rel = join('node_modules', '@zaofan', 'dsh-qqbot', 'dist', 'features', 'sticker-store.js');
  const roots = [process.cwd()];
  const appdata = process.env.APPDATA || '';
  if (appdata) {
    const base = join(appdata, 'dsh-desktop', 'harness', 'profiles');
    try { for (const p of readdirSync(base)) roots.push(join(base, p)); } catch { /* ignore */ }
  }
  for (const r of roots) {
    const p = join(r, rel);
    if (existsSync(p)) return p;
  }
  return '';
}

function parseSummary(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let tags = [];
  let desc = '';
  for (const l of lines) {
    if (/^【标签】/.test(l)) {
      tags = l.replace(/^【标签】[:：]?\s*/, '').split(/[,，、\s]+/).filter(Boolean).slice(0, 8);
    } else if (/^【描述】/.test(l)) {
      desc = l.replace(/^【描述】[:：]?\s*/, '');
    }
  }
  if (!desc) desc = lines.filter((l) => !/^【标签】/.test(l)).join(' ').slice(0, 200);
  return { tags, desc };
}

const storePath = resolveStorePath();
if (!storePath) { console.error('找不到插件里的 sticker-store.js'); process.exit(1); }
const mod = await import(pathToFileURL(storePath).href);
const logger = { info() {}, warn: (m) => console.warn(m), debug() {} };
mod.configureStickerStore(DIR, logger);
const store = mod.getStickerStore(DIR);

const todo = [...store.items.values()]
  .filter((it) => (it.layer === 'candidate' || it.layer === 'library') && (!it.tags || !it.tags.length))
  .slice(0, LIMIT);

console.log(`待打标 ${todo.length} 张（库 ${DIR}）${DRY ? ' · dry-run' : ''}`);
let ok = 0, fail = 0, skip = 0;
for (const [i, it] of todo.entries()) {
  const file = store.filePathOf(it);
  if (!file || !existsSync(file)) { skip++; console.log(`- [${i + 1}] ${it.id} 文件缺失，跳过`); continue; }
  if (DRY) { console.log(`- [${i + 1}] ${it.id} ${file}`); continue; }
  const t0 = Date.now();
  try {
    const out = execFileSync(process.execPath, [CLI, file], { encoding: 'utf8', timeout: 120000 });
    const j = JSON.parse(out);
    const { tags, desc } = parseSummary(j?.result?.summary || '');
    if (!tags.length && !desc) { fail++; console.log(`- [${i + 1}] ${it.id} 模型没给出标签/描述`); continue; }
    store.setDescTags(it.id, tags, desc || '（本地视觉未给出描述）');
    ok++;
    console.log(`- [${i + 1}/${todo.length}] ${it.id} ${Date.now() - t0}ms → ${tags.join('/')} | ${desc.slice(0, 60)}`);
  } catch (e) {
    fail++;
    console.log(`- [${i + 1}] ${it.id} 失败：${String(e.stderr || e.message).slice(0, 200)}`);
  }
}
try { store.flush?.(); } catch { /* ignore */ }
console.log(`\n完成：成功 ${ok}，失败 ${fail}，跳过 ${skip}`);
