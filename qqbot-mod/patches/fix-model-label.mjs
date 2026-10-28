#!/usr/bin/env node
/**
 * fix-model-label.mjs — 面板标题「· bge-small-zh-v1.5」是写死的，改成显示实际模型目录名
 *
 * 为什么值得改：换了模型但标题永远是 bge-small-zh-v1.5 —— 用户会以为"没变"。
 *
 * 做法：在那一行前插入一段取 basename 的代码，再把写死的名字换成动态拼接。
 *       为避免反斜杠转义，分隔符用 charCode(92) 取。
 *
 * 用法：node fix-model-label.mjs [--check|--revert]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { pluginPath } from './plugin-dir.mjs';
const F = pluginPath('client/qqbot-settings.js');
const ORIG = F + '.orig-label';
const HARD = ' · bge-small-zh-v1.5</div>';
const MARK = 'lmName';

const INJECT = [
  "            var _mp = String((lm && lm.modelDir) || '')",
  "            var _mi = Math.max(_mp.lastIndexOf('/'), _mp.lastIndexOf(String.fromCharCode(92)))",
  "            var lmName = _mi >= 0 ? _mp.slice(_mi + 1) : _mp",
];

const argv = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);

if (!existsSync(F)) { log(`✗ 文件不存在: ${F}`); process.exit(1); }
if (argv.has('--revert')) {
  if (!existsSync(ORIG)) { log('✗ 没有备份'); process.exit(1); }
  copyFileSync(ORIG, F); log('已还原'); process.exit(0);
}

const src = readFileSync(F, 'utf8');
if (src.includes('var lmName =')) { log('= 已经改过了，跳过。'); process.exit(0); }

const hits = [];
src.split('\n').forEach((l, i) => { if (l.includes(HARD)) hits.push(i + 1); });
if (hits.length !== 1) { log(`✗ 期望正好命中 1 行，实际 ${hits.length} 行：${hits.join(',')}`); process.exit(1); }
log(`  ✓ 命中第 ${hits[0]} 行`);

if (argv.has('--check')) { log('\n(--check) 未写入'); process.exit(0); }
if (!existsSync(ORIG)) { copyFileSync(F, ORIG); log(`备份: ${ORIG}`); }

const lines = src.split('\n');
const idx = hits[0] - 1;
lines[idx] = lines[idx].replace(HARD, "' + (lmName ? ' · ' + lmName : '') + '</div>");
lines.splice(idx, 0, ...INJECT);
writeFileSync(F, lines.join('\n'), 'utf8');

log('写入完成，语法自检…');
try {
  execFileSync(process.execPath, ['--check', F], { stdio: 'inherit' });
  log('语法 OK');
} catch {
  copyFileSync(ORIG, F);
  log('✗ 语法失败 → 已回滚');
  process.exit(1);
}
log('\n好了。刷新页面后，标题会显示实际目录名（例如 · bge-base-zh）。');
