/**
 * fix-ui-note.mjs — 面板「最近判定」的说明文字：标明"一条 = 群里一条"
 *
 * 背景：拆包（split-reply）开着时，面板记的是云端原句（1 条），群里实际是 2~3 条，
 * 主人看着就像"面板显示一句、QQ 显示两句，前后矛盾"。现在拆包默认关了，
 * 顺手把这句话写在面板上，避免以后再误会。
 *
 *   node qqbot-mod/patches/fix-ui-note.mjs --check | --apply | --revert
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PLUGIN, pluginPath } from './plugin-dir.mjs';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;
const FILE = pluginPath('client/qqbot-settings.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/qqbot-settings.js.orig-uibubble';

const OLD = '条 —— 本地/死梗 不花 token，云端 花 token</div>';
const NEW = '条 —— 本地/死梗 不花 token，云端 花 token；一条 = 群里一条（连发切片已关）</div>';

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--revert')
    ? 'revert'
    : 'check';

let src = readFileSync(FILE, 'utf8');
const has = src.includes(NEW);
const can = src.includes(OLD);

if (mode === 'check') {
  console.log('目标文件: ' + FILE);
  console.log((has ? '= 已应用' : can ? '+ 可打' : '! 未匹配') + '  UI-NOTE');
  process.exit(has || can ? 0 : 1);
}

if (mode === 'revert') {
  if (!has) {
    console.log('= 没有可回滚的改动');
    process.exit(0);
  }
  src = src.split(NEW).join(OLD);
  writeFileSync(FILE, src, 'utf8');
  console.log('✓ 已回滚 UI-NOTE');
  process.exit(0);
}

if (has) {
  console.log('= 已应用，无需重复');
  process.exit(0);
}
if (!can) {
  console.log('! 未匹配：找不到目标行，可能文件已变');
  process.exit(1);
}
if (!existsSync(BAK)) writeFileSync(BAK, src, 'utf8');
src = src.split(OLD).join(NEW);
writeFileSync(FILE, src, 'utf8');
const after = readFileSync(FILE, 'utf8');
console.log('✓ 已应用 UI-NOTE：' + (after.includes(NEW) ? '读回一致' : '读回不一致！'));
process.exit(after.includes(NEW) ? 0 : 1);
