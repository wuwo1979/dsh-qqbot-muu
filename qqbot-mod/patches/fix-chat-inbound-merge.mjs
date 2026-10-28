// 修聊天页不全：route 内 `root` 未定义导致入站台账合并整段抛错被吞；
// 并把 [印象]/[旧识] 注入块一起剥掉。
// 用法：node qqbot-mod/patches/fix-chat-inbound-merge.mjs --check|--apply|--revert
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN } from './plugin-dir.mjs';
const FILE = join(PLUGIN, 'settings-host.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/settings-host.js.orig-chatinbound';
const arg = process.argv[2] || '--check';
let src = readFileSync(FILE, 'utf8');
const MARK = 'const _mb = (function () { try { return join(resolveMemoryRoot(bot), \'.qqbot\', \'msg-content.jsonl\'); } catch (_e) { return \'\'; } })();';
const OLD_ROOT = "const _mb = root ? join(root, '.qqbot', 'msg-content.jsonl') : '';";
const OLD_TAG = "for (const tag of ['记忆', '设定']) {";

if (arg === '--revert') {
  if (!existsSync(BAK)) { console.error('没有备份:', BAK); process.exit(1); }
  writeFileSync(FILE, readFileSync(BAK, 'utf8'), 'utf8');
  console.log('已还原');
  process.exit(0);
}
const hasRoot = src.includes(MARK);
const hasOld = src.includes(OLD_ROOT);
if (arg === '--check') {
  console.log(hasRoot ? '已应用' : (hasOld ? '可打' : '根锚点未匹配'));
  process.exit(hasRoot || hasOld ? 0 : 1);
}
if (hasRoot && !hasOld) { console.log('已经应用过，跳过'); process.exit(0); }
if (!hasOld) { console.error('根锚点未匹配:', OLD_ROOT); process.exit(1); }
copyFileSync(FILE, BAK);
src = src.replace(OLD_ROOT, MARK);
// [印象]/[旧识] 没有闭合标签，按行剥（只影响聊天展示）
const OLD_RET = "            return t.trim();";
const NEW_RET = "            t = t.replace(/\\n?\\[(印象|旧识)\\][^\\n]*/g, '');\n            return t.trim();";
if (src.includes(OLD_RET) && !src.includes("\\[(印象|旧识)\\]")) src = src.replace(OLD_RET, NEW_RET);
writeFileSync(FILE, src, 'utf8');
console.log('已应用。备份:', BAK);
