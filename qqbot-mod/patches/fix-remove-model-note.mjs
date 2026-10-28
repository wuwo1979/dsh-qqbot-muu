// 去掉单会话「智能回复」顶部整段模型说明（用户要求）。按索引精确删除，避免误删。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN } from './plugin-dir.mjs';
const FILE = join(PLUGIN, 'client/qqbot-settings.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/qqbot-settings.js.orig-rmmodelnote';
const arg = process.argv[2] || '--check';
let src = readFileSync(FILE, 'utf8');
const MARK = '// [qqbot-mod] 单会话顶部模型说明已移除';
const START = '          // ★ 本机新增(2026-10-23): 本地代答 / 语音 面板卡片';
const END = '不影响任何现有功能</b>。</div>';
const a = src.indexOf(START);
const b = a >= 0 ? src.indexOf(END, a + START.length) : -1;
if (arg === '--revert') {
  if (!existsSync(BAK)) { console.error('没有备份'); process.exit(1); }
  writeFileSync(FILE, readFileSync(BAK, 'utf8'), 'utf8');
  console.log('已还原'); process.exit(0);
}
if (arg === '--check') {
  console.log(src.includes(MARK) ? '已应用' : (a >= 0 && b >= 0 ? '可打' : '锚点未匹配'));
  process.exit(src.includes(MARK) || (a >= 0 && b >= 0) ? 0 : 1);
}
if (src.includes(MARK)) { console.log('已经应用过，跳过'); process.exit(0); }
if (a < 0 || b < 0) { console.error('锚点未匹配', { a, b }); process.exit(1); }
copyFileSync(FILE, BAK);
src = src.slice(0, a) + `          ${MARK}` + src.slice(b + END.length);
writeFileSync(FILE, src, 'utf8');
console.log('已应用。备份:', BAK);
