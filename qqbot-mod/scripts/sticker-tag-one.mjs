#!/usr/bin/env node
/**
 * sticker-tag-one.mjs — 给单张表情包补本地视觉标签并写回索引
 *
 * 用法：node sticker-tag-one.mjs "<图库目录>" <表情id>
 * 给 bili 工具 collect 后后台打标用（插件的自动打标只覆盖 QQ 收图链路）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = process.argv[2];
const ID = process.argv[3];
const CLI = join(import.meta.dirname || 'F:/qqbot/qqbot-mod/scripts', 'sticker-vision-cli.mjs');
if (!DIR || !ID) { console.error('用法: node sticker-tag-one.mjs <图库目录> <表情id>'); process.exit(2); }

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
    if (/^【标签】/.test(l)) tags = l.replace(/^【标签】[:：]?\s*/, '').split(/[,，、\s]+/).filter(Boolean).slice(0, 8);
    else if (/^【描述】/.test(l)) desc = l.replace(/^【描述】[:：]?\s*/, '');
  }
  if (!desc) desc = lines.filter((l) => !/^【标签】/.test(l)).join(' ').slice(0, 200);
  return { tags, desc };
}

const storePath = resolveStorePath();
if (!storePath) { console.error('找不到 sticker-store.js'); process.exit(1); }
const mod = await import(pathToFileURL(storePath).href);
mod.configureStickerStore(DIR, { info() {}, warn() {} });
const store = mod.getStickerStore(DIR);
const meta = store.items.get(ID);
if (!meta) { console.error(`没有这个表情：${ID}`); process.exit(1); }
const file = store.filePathOf(meta);
if (!file || !existsSync(file)) { console.error('图片文件不存在'); process.exit(1); }

try {
  const out = execFileSync(process.execPath, [CLI, file], { encoding: 'utf8', timeout: 120000 });
  const { tags, desc } = parseSummary(JSON.parse(out)?.result?.summary || '');
  if (!tags.length && !desc) process.exit(1);
  store.setDescTags(ID, tags, desc || '（本地视觉未给出描述）');
  try { store.flush?.(); } catch { /* ignore */ }
  console.log(`已打标 ${ID}: ${tags.join('/')}`);
} catch (e) {
  console.error(String(e.stderr || e.message).slice(0, 300));
  process.exit(1);
}
