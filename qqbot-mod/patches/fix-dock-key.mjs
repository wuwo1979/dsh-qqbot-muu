#!/usr/bin/env node
/**
 * fix-dock-key.mjs — 把悬浮球坐标的存储键换成 v2，让浏览器里那份旧坐标一次性作废
 *
 * 背景：fix-dock-pos.mjs 已经把"没有坐标时落到右下角"修好了，但它是**尊重已保存坐标**的。
 *   若浏览器 localStorage 里存着一个左上角附近的值（旧版本首次渲染存的 (0,0) 或你拖动留下的），
 *   球就会继续待在那儿 —— 现象就是"改了没反应"。
 *   换键 = 旧值不再被读取，下一次渲染走新的默认位置；之后拖动会存到 v2。
 *
 * 用法：node fix-dock-key.mjs [--check|--revert]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { pluginPath } from './plugin-dir.mjs';
const F = pluginPath('client/qqbot-settings.js');
const ORIG = F + '.orig-key';

const pairs = [
  ["localStorage.getItem('qqs-dock-pos')", "localStorage.getItem('qqs-dock-pos-v2')"],
  ["localStorage.setItem('qqs-dock-pos',", "localStorage.setItem('qqs-dock-pos-v2',"],
];

const argv = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);

if (!existsSync(F)) { log(`✗ 文件不存在: ${F}`); process.exit(1); }
if (argv.has('--revert')) {
  if (!existsSync(ORIG)) { log('✗ 没有备份'); process.exit(1); }
  copyFileSync(ORIG, F); log('已还原'); process.exit(0);
}

let src = readFileSync(F, 'utf8');
if (src.includes("'qqs-dock-pos-v2'")) { log('= 已经换过键了，跳过。'); process.exit(0); }

let n = 0;
for (const [a, b] of pairs) {
  if (!src.includes(a)) { log(`  ✗ 未匹配: ${a}`); continue; }
  src = src.split(a).join(b);
  n += 1;
  log(`  ✓ ${b}`);
}
if (n === 0) { log('✗ 一处都没匹配上，不敢写'); process.exit(1); }
if (argv.has('--check')) { log('\n(--check) 未写入'); process.exit(0); }

if (!existsSync(ORIG)) { copyFileSync(F, ORIG); log(`备份: ${ORIG}`); }
writeFileSync(F, src, 'utf8');
log('写入完成，语法自检…');
try {
  execFileSync(process.execPath, ['--check', F], { stdio: 'inherit' });
  log('语法 OK');
} catch {
  copyFileSync(ORIG, F);
  log('✗ 语法失败 → 已回滚');
  process.exit(1);
}
log('\n好了。Ctrl+Shift+R 强刷页面，球应该出现在右下角。');
