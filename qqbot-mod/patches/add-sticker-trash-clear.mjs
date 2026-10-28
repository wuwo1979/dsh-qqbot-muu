/**
 * add-sticker-trash-clear.mjs — 给浮窗「表情包图库 · 回收站」加「清空回收站」按钮
 *
 * 只改 AppData 里正在跑的 client/qqbot-settings.js，不动 dist。
 * 数据/动作来自 hooks/sticker-trash.mjs 挂的 /api/qqbot-settings/stickers/trash-purge。
 *
 * 用法：
 *   node patches/add-sticker-trash-clear.mjs --check
 *   node patches/add-sticker-trash-clear.mjs --apply
 *   node patches/add-sticker-trash-clear.mjs --update
 *   node patches/add-sticker-trash-clear.mjs --revert
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const FILE = pluginPath('client/qqbot-settings.js');
const BACKUP = FILE + '.orig-stickertrash';
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const APPLY = args.includes('--apply');
const UPDATE = args.includes('--update');
const REVERT = args.includes('--revert');

const MARK = 'qqs-sticker-trash-clear';
const ANCHOR = "          layer === 'trash' ? h('button', { onClick: function () { batch('restore') }";

const NEW_LINES = [
  "          layer === 'trash' ? h('button', { title: '\u5f7b\u5e95\u5220\u9664\u56de\u6536\u7ad9\u91cc\u7684\u6240\u6709\u8868\u60c5\uff08\u4e0d\u53ef\u6062\u590d\uff09', onClick: function () {",
  "              // " + MARK + "\uff1a\u63a5 hooks/sticker-trash.mjs",
  "              if (!window.confirm('\u5f7b\u5e95\u5220\u9664\u56de\u6536\u7ad9\u91cc\u7684\u6240\u6709\u8868\u60c5\uff1f\u5220\u9664\u540e\u65e0\u6cd5\u6062\u590d')) return",
  "              fetch('/api/qqbot-settings/stickers/trash-purge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataDir: DD || undefined }) })",
  "                .then(function (r) { return r.json() })",
  "                .then(function (d) { setMsg(d && d.ok ? ('\u5df2\u5f7b\u5e95\u6e05\u9664 ' + (d.purged || 0) + ' \u5f20 \u2713') : ('\u6e05\u7406\u5931\u8d25:' + ((d && d.error) || '\u672a\u77e5'))); load() })",
  "                .catch(function (e) { setMsg('\u6e05\u7406\u5931\u8d25:' + e.message) })",
  "            }, style: { font: 'inherit', cursor: 'pointer', padding: '4px 12px', borderRadius: 9, border: '1px solid #e5484d99', background: 'rgba(229,72,77,.12)', color: '#b42318', fontWeight: 700, fontSize: 13 } }, '\u6e05\u7a7a\u56de\u6536\u7ad9') : null,",
].join('\n');

let src = readFileSync(FILE, 'utf8');

if (REVERT) {
  if (!existsSync(BACKUP)) { console.log('没有备份，无法回滚'); process.exit(1); }
  copyFileSync(BACKUP, FILE);
  console.log('已回滚到补丁前版本');
  process.exit(0);
}

if (CHECK) {
  console.log(src.includes(MARK) ? '已应用' : (src.includes(ANCHOR) ? '可应用：锚点存在' : '不可应用：锚点不存在'));
  process.exit(0);
}

if (!APPLY && !UPDATE) { console.log('用法: --check | --apply | --update | --revert'); process.exit(0); }

if (!src.includes(ANCHOR)) { console.error('锚点不存在，插件结构可能变了'); process.exit(1); }

const eol = src.includes('\r\n') ? '\r\n' : '\n';
const inserted = NEW_LINES.replace(/\n/g, eol);

if (src.includes(MARK)) {
  // update：删掉旧块再插
  src = src.replace(/\r?\n          layer === 'trash' \? h\('button', \{ title: '彻底删除回收站里的所有表情（不可恢复）'[\s\S]*?'清空回收站'\) : null,/, '');
}

const idx = src.indexOf(ANCHOR);
const lineEnd = src.indexOf('\n', idx);
if (lineEnd < 0) { console.error('锚点行没有换行，放弃'); process.exit(1); }
const before = src.slice(0, lineEnd);
const after = src.slice(lineEnd);
const next = before + eol + inserted + after;

if (!existsSync(BACKUP)) copyFileSync(FILE, BACKUP);
writeFileSync(FILE, next, 'utf8');

try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'pipe' });
  console.log('补丁已写入并通过 node --check');
  announce(FILE);
} catch (e) {
  copyFileSync(BACKUP, FILE);
  console.error('语法检查失败，已自动还原：', String(e.stderr || e.message).slice(0, 500));
  process.exit(1);
}
