/**
 * fix-ui-skip.mjs —— 判定卡片要认得「跳过」这一类
 *
 * 背景：入站扩展现在会把"空包"（无正文/无附件/没人 @）直接 annihilate，日志里记
 *   {"by":"skip","why":"empty-packet"}。但面板的彩色卡片只认 local/gag/cloud 三种，
 *   skip 会被算进"☁️ 云端大模型"，看着像是云端被调用了 —— 与实际相反（恰恰是省了一整轮）。
 *
 * 修法：加第四类「⏭ 跳过(不花token)」，灰色；统计行也单列一项。
 *
 * 用法：node fix-ui-skip.mjs --check|--apply|--revert（apply 需 danger-full-access）
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;

import { PLUGIN } from './plugin-dir.mjs';
const FILE = join(PLUGIN, 'client', 'qqbot-settings.js');
const BACKUP_DIR = 'F:/qqbot/qqbot-mod/backups';
const BACKUP = join(BACKUP_DIR, 'qqbot-settings.js.orig-uiskip');

const mode = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--revert') ? 'revert'
    : 'check';

if (!existsSync(FILE)) { console.error('找不到 ' + FILE); process.exit(1); }

const raw = readFileSync(FILE, 'utf8');
const src = raw.split(CR).join('').split(LF).join(EOL);

const PAIRS = [
  // ① 统计桶
  [
    `          var cnt = { local: 0, gag: 0, cloud: 0 }`,
    `          var cnt = { local: 0, gag: 0, cloud: 0, skip: 0 }`,
  ],
  // ② 计数分支
  [
    `          rows.forEach(function (r) { if (r.by === 'local') cnt.local += 1; else if (r.by === 'gag') cnt.gag += 1; else cnt.cloud += 1 })`,
    `          rows.forEach(function (r) { if (r.by === 'local') cnt.local += 1; else if (r.by === 'gag') cnt.gag += 1; else if (r.by === 'skip') cnt.skip += 1; else cnt.cloud += 1 })`,
  ],
  // ③ 统计行多一格
  [
    `              + '<span style="color:#ced4da;margin:0 8px">|</span><span style="color:#1c7ed6">☁️ 云端大模型 ' + cnt.cloud + '</span>'`,
    `              + '<span style="color:#ced4da;margin:0 8px">|</span><span style="color:#1c7ed6">☁️ 云端大模型 ' + cnt.cloud + '</span>'\n              + '<span style="color:#ced4da;margin:0 8px">|</span><span style="color:#868e96">⏭ 跳过 ' + cnt.skip + '</span>'`,
  ],
  // ④ 每行判定
  [
    `            var isGag = r.by === 'gag'`,
    `            var isGag = r.by === 'gag'\n            var isSkip = r.by === 'skip'`,
  ],
  [
    `            var col = isLocal ? '#2f9e44' : (isGag ? '#f08c00' : '#1c7ed6')`,
    `            var col = isLocal ? '#2f9e44' : (isGag ? '#f08c00' : (isSkip ? '#868e96' : '#1c7ed6'))`,
  ],
  [
    `            var who = isLocal ? '⚡ 本地模型' : (isGag ? '🎯 死梗直答' : '☁️ 云端大模型')`,
    `            var who = isLocal ? '⚡ 本地模型' : (isGag ? '🎯 死梗直答' : (isSkip ? '⏭ 跳过(不花token)' : '☁️ 云端大模型'))`,
  ],
];

const MARK = '⏭ 跳过';
const applied = src.indexOf(MARK) >= 0;

if (mode === 'check') {
  console.log('文件: ' + FILE + ' (' + raw.length + ' 字符)');
  if (applied) { console.log('UI-SKIP: 已应用'); process.exit(0); }
  const hit = PAIRS.filter(([o]) => src.indexOf(o) >= 0).length;
  console.log('UI-SKIP: ' + (hit === PAIRS.length ? '可打(' + hit + '/' + PAIRS.length + ')' : '未匹配(' + hit + '/' + PAIRS.length + ')'));
  process.exit(hit === PAIRS.length ? 0 : 2);
}

if (mode === 'revert') {
  if (!applied) { console.log('未应用，无需回滚'); process.exit(0); }
  let out = src;
  for (const [o, n] of PAIRS) out = out.split(n).join(o);
  writeFileSync(FILE, out, 'utf8');
  console.log('已回滚 (' + src.length + ' → ' + out.length + ')');
  process.exit(0);
}

if (applied) { console.log('已应用，跳过'); process.exit(0); }

const missing = PAIRS.filter(([o]) => src.indexOf(o) < 0);
if (missing.length) {
  console.error('有 ' + missing.length + ' 处锚点没匹配上，放弃（避免打一半）');
  for (const [o] of missing) console.error('  缺: ' + o.trim().slice(0, 80));
  process.exit(2);
}

try {
  mkdirSync(BACKUP_DIR, { recursive: true });
  if (!existsSync(BACKUP)) { copyFileSync(FILE, BACKUP); console.log('备份 → ' + BACKUP); }
} catch (e) {
  console.error('备份失败（权限？需要 danger-full-access）: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

let out = src;
for (const [o, n] of PAIRS) out = out.split(o).join(n);
writeFileSync(FILE, out, 'utf8');
console.log('已打补丁 (' + src.length + ' → ' + out.length + ' 字符)');
