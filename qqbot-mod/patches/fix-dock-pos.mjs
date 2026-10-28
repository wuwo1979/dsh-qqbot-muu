#!/usr/bin/env node
/**
 * fix-dock-pos.mjs — 修「悬浮球默认落在左上角」的问题（qqbot 客户端 bundle）
 *
 * 现象（用户截图确认）：紫色 🛡 球压在左上角 "DeepSeek HARNESS" 上，展开面板看不到。
 *
 * 根因：client/qqbot-settings.js 里
 *     var _x = ... Number(pos.x) || 0
 *     var _y = ... Number(pos.y) || 0
 *     wrap.style.left=_x; top=_y; right='auto'; bottom='auto'
 *   CSS 原本是 right:18px; bottom:190px，但这两行用 left/top 覆盖了它。
 *   首次使用（localStorage 无 qqs-dock-pos）时 pos 是空对象 → 两个坐标都变成 0 → 球跑到 (0,0)。
 *   而 (0,0) 恰好被顶栏盖住，面板展开也跑出可视区 ⇒ 看起来"没有悬浮球"。
 *
 * 修法：没有可信历史坐标时，退回 CSS 的本意（右下角）；并且把 (0,0) 这种无意义坐标也当"没有"。
 *
 * 用法：node fix-dock-pos.mjs [--check|--revert]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { pluginPath } from './plugin-dir.mjs';
const F = pluginPath('client/qqbot-settings.js');
const ORIG = F + '.orig';

const FROM = `      var _bw = 60, _bh = 60
      var _x = Math.max(0, Math.min(Math.max(0, window.innerWidth - _bw), Number(pos.x) || 0))
      var _y = Math.max(0, Math.min(Math.max(0, window.innerHeight - _bh), Number(pos.y) || 0))`;

const FROM_ALT = `var _bw = 60, _bh = 60
  var _x = Math.max(0, Math.min(Math.max(0, window.innerWidth - _bw), Number(pos.x) || 0))
  var _y = Math.max(0, Math.min(Math.max(0, window.innerHeight - _bh), Number(pos.y) || 0))`;

// 用「按行匹配」更稳：不依赖缩进
const LINES_MATCH = [
  'var _bw = 60, _bh = 60',
  'var _x = Math.max(0, Math.min(Math.max(0, window.innerWidth - _bw), Number(pos.x) || 0))',
  'var _y = Math.max(0, Math.min(Math.max(0, window.innerHeight - _bh), Number(pos.y) || 0))',
];

const NEW_BODY = [
  '  // ★ 本机修复(2026-10-22)：没有可信历史坐标时，退回 CSS 本意的右下角；',
  '  //   原来 Number(pos.x)||0 会把首装实例丢到 (0,0)，被顶栏盖住 ⇒ 看起来"没有悬浮球"。',
  '  var _bw = 60, _bh = 60',
  '  var _sx = Number(pos.x), _sy = Number(pos.y)',
  '  var _useSaved = isFinite(_sx) && isFinite(_sy) && !(_sx === 0 && _sy === 0)',
  '  var _defX = Math.max(0, (window.innerWidth || 1200) - _bw - 18)',
  '  var _defY = Math.max(0, (window.innerHeight || 800) - _bh - 190)',
  '  var _x = Math.max(0, Math.min(Math.max(0, window.innerWidth - _bw), _useSaved ? _sx : _defX))',
  '  var _y = Math.max(0, Math.min(Math.max(0, window.innerHeight - _bh), _useSaved ? _sy : _defY))',
];

const argv = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);

if (!existsSync(F)) { log(`✗ 文件不存在: ${F}`); process.exit(1); }

if (argv.has('--revert')) {
  if (!existsSync(ORIG)) { log('✗ 没有备份'); process.exit(1); }
  copyFileSync(ORIG, F);
  log(`已还原: ${F}`);
  process.exit(0);
}

const src = readFileSync(F, 'utf8');
if (src.includes('★ 本机修复(2026-10-22)')) { log('= 已经修过了，跳过。'); process.exit(0); }

// 逐行定位：找连续三行的特征
const lines = src.split('\n');
let at = -1;
for (let i = 0; i + 2 < lines.length; i++) {
  const a = lines[i].trim(), b = lines[i + 1].trim(), c = lines[i + 2].trim();
  if (a === LINES_MATCH[0] && b === LINES_MATCH[1] && c === LINES_MATCH[2]) { at = i; break; }
}
if (at < 0) { log('✗ 没找到目标三行（版本不同），不敢乱改'); process.exit(1); }
log(`  ✓ 命中位于第 ${at + 1} 行`);

if (argv.has('--check')) { log('\n(--check) 未写入。'); process.exit(0); }

if (!existsSync(ORIG)) { copyFileSync(F, ORIG); log(`备份: ${ORIG}`); }

lines.splice(at, 3, ...NEW_BODY);
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

log(`
修好了。接下来**刷新页面**（Ctrl+F5 强制刷新，浏览器会按新的 rev 重新拉 client.js）。
若强刷后还是老位置：重启一次 DSH Desktop（rev 哈希在启动页里）。
回滚: node fix-dock-pos.mjs --revert
`);
