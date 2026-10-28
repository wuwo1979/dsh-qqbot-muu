// 聊天页合并补丁的最后一处：items 原为 const，入站台账合并时 `items = ...` 抛 TypeError，
// 被外层 catch 静默吞掉 → 聊天页永远只有前 20 条（没有入站消息）。改成 let。
// 用法：node qqbot-mod/patches/fix-chat-items-let.mjs --check|--apply|--revert
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN } from './plugin-dir.mjs';
const FILE = join(PLUGIN, 'settings-host.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/settings-host.js.orig-chatitems';
const OLD = '      const items = [];';
const NEW = '      let items = [];';
const arg = process.argv[2] || '--check';
let src = readFileSync(FILE, 'utf8');

if (arg === '--revert') {
  if (!existsSync(BAK)) { console.error('没有备份:', BAK); process.exit(1); }
  writeFileSync(FILE, readFileSync(BAK, 'utf8'), 'utf8');
  console.log('已还原');
  process.exit(0);
}
const hasNew = src.includes('      let items = []');
const hasOld = src.includes(OLD);
if (arg === '--check') {
  console.log(hasNew ? '已应用' : (hasOld ? '可打' : '锚点未匹配'));
  process.exit(hasNew || hasOld ? 0 : 1);
}
if (hasNew && !hasOld) { console.log('已经应用过，跳过'); process.exit(0); }
if (!hasOld) { console.error('锚点未匹配:', OLD); process.exit(1); }
copyFileSync(FILE, BAK);
src = src.replace(OLD, NEW);
writeFileSync(FILE, src, 'utf8');
console.log('已应用。备份:', BAK);
