/**
 * fix-ui-source.mjs — 面板「最近判定」顶部加一行大字：上一句到底是谁说的
 *
 * 主人要的是"能一眼看出这句话来自本地还是云端"。原来只有一排彩色小字，
 * 得逐条看。这里在统计行上面插一条：`上一句来自 ⚡本地小模型 · 564ms 零 token · 13:07`
 * ——纯前端渲染，不经过模型，**不花任何 token**。
 *
 *   node qqbot-mod/patches/fix-ui-source.mjs --check | --apply | --revert
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pluginPath } from './plugin-dir.mjs';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;
const Q = String.fromCharCode(39);

const FILE = pluginPath('client/qqbot-settings.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/qqbot-settings.js.orig-uisource';

const ANCHOR = '          if (mixEl) {';
const MARK = '_srcLine';

const INSERT = [
  '          var _newest = null',
  '          rows.forEach(function (r) { if (!_newest || Number(r.ts) >= Number(_newest.ts)) _newest = r })',
  '          var _srcLine = ' + Q + Q,
  '          if (_newest) {',
  '            var _nl = _newest.by === ' + Q + 'local' + Q,
  '            var _ng = _newest.by === ' + Q + 'gag' + Q,
  '            var _ns = _newest.by === ' + Q + 'skip' + Q,
  '            var _nc = _nl ? ' + Q + '#2f9e44' + Q + ' : (_ng ? ' + Q + '#f08c00' + Q + ' : (_ns ? ' + Q + '#868e96' + Q + ' : ' + Q + '#1c7ed6' + Q + '))',
  '            var _nw = _nl ? ' + Q + '⚡ 本地小模型' + Q + ' : (_ng ? ' + Q + '🎯 死梗直答' + Q + ' : (_ns ? ' + Q + '⏭ 跳过(没进云端)' + Q + ' : ' + Q + '☁️ 云端大模型' + Q + '))',
  '            var _nt = new Date(Number(_newest.ts) || Date.now())',
  '            var _nh = (' + Q + '0' + Q + ' + _nt.getHours()).slice(-2) + ' + Q + ':' + Q + ' + (' + Q + '0' + Q + ' + _nt.getMinutes()).slice(-2)',
  '            var _extra = _nl ? (' + Q + ' · ' + Q + ' + (_newest.ms || 0) + ' + Q + 'ms · 零 token' + Q + ') : (_ng ? ' + Q + ' · 零 token' + Q + ' : (_ns ? ' + Q + ' · 省了一整轮云端' + Q + ' : ' + Q + ' · 花 token' + Q + '))',
  '            _srcLine = ' + Q + '<div style="font-size:13px;padding:6px 9px;background:#f1f3f5;border-left:3px solid ' + Q + ' + _nc + ' + Q + ';border-radius:4px;margin-bottom:6px">上一句来自 <b style="color:' + Q + ' + _nc + ' + Q + '">' + Q + ' + _nw + ' + Q + '</b>' + Q + ' + _extra + ' + Q + '<span style="color:#adb5bd;font-size:11px"> · ' + Q + ' + _nh + ' + Q + '</span></div>' + Q,
  '          }',
];

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--revert')
    ? 'revert'
    : 'check';

let src = readFileSync(FILE, 'utf8');
const norm = (s) => s.split(CR).join('').split(LF).join(EOL);

const has = src.includes(MARK);
const can = src.includes(ANCHOR);

if (mode === 'check') {
  console.log('目标文件: ' + FILE);
  console.log((has ? '= 已应用' : can ? '+ 可打' : '! 未匹配') + '  UI-SOURCE');
  process.exit(has || can ? 0 : 1);
}

if (mode === 'revert') {
  if (!has) {
    console.log('= 没有可回滚的改动');
    process.exit(0);
  }
  const block = norm(INSERT.join(LF) + LF);
  if (src.includes(block)) {
    src = src.split(block).join('');
    writeFileSync(FILE, src, 'utf8');
    console.log('✓ 已回滚 UI-SOURCE');
    process.exit(0);
  }
  console.log('! 回滚失败：找不到已插入的块');
  process.exit(1);
}

if (has) {
  console.log('= 已应用，无需重复');
  process.exit(0);
}
if (!can) {
  console.log('! 未匹配：找不到 `if (mixEl) {`');
  process.exit(1);
}
if (!existsSync(BAK)) writeFileSync(BAK, src, 'utf8');

// 1) 插 _srcLine 计算块
src = src.split(norm(ANCHOR)).join(norm(INSERT.join(LF) + LF + ANCHOR));

// 2) 统计行前面接上 _srcLine
const MIX = 'mixEl.innerHTML = ' + Q + '<span style="color:#2f9e44">⚡ 本地模型 ' + Q;
if (!src.includes(MIX)) {
  console.log('! 未匹配：找不到 mixEl 赋值行');
  process.exit(1);
}
src = src.split(MIX).join('mixEl.innerHTML = _srcLine + ' + Q + '<span style="color:#2f9e44">⚡ 本地模型 ' + Q);

writeFileSync(FILE, src, 'utf8');
const after = readFileSync(FILE, 'utf8');
const ok = after.includes(MARK) && after.includes('mixEl.innerHTML = _srcLine +');
console.log('✓ UI-SOURCE：' + (ok ? '读回一致' : '读回不一致！'));
process.exit(ok ? 0 : 1);
