// fix-contact-comment.mjs —— 联系方式页的 B 站记录里，把「评论未公开 / 评论失败」标清楚
// 用法：node qqbot-mod/patches/fix-contact-comment.mjs [--check|--apply]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { pluginPath, announce } from './plugin-dir.mjs';

const REL = 'client/qqbot-settings.js';
const MARK = '[qqbot-mod] contact-comment';

const OLD = `            : r.type === 'comment' ? '💬' : r.type === 'dynamic' ? '📰' : '·'`;
const NEW = `            : r.type === 'comment' ? '💬' : r.type === 'comment-shadowed' ? '💬' : r.type === 'comment-failed' ? '💬' : r.type === 'dynamic' ? '📰' : '·'
          var bad = (r.type === 'comment-shadowed' || r.type === 'comment-failed' || r.ok === false)`;

const OLD2 = `            + (r.ok === false ? ' <span style="color:#c92a2a;font-size:10px">失败</span>' : '')`;
const NEW2 = `            + (bad ? ' <span style="color:#c92a2a;font-size:10px">' + (r.type === 'comment-shadowed' ? '未公开' : '失败') + '</span>' : '')`;

function main() {
  const apply = process.argv.includes('--apply');
  announce('联系方式页评论记录标记');
  const file = pluginPath(REL);
  if (!existsSync(file)) throw new Error('找不到 ' + file);
  let src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (src.includes(MARK)) {
    console.log('  = 已是最新，无需写入');
    return;
  }
  if (!src.includes(OLD)) throw new Error('锚点一没找到（' + OLD.slice(0, 40) + '…）');
  if (!src.includes(OLD2)) throw new Error('锚点二没找到（' + OLD2.slice(0, 40) + '…）');
  src = src.replace(OLD, NEW).replace(OLD2, NEW2 + ' /* ' + MARK + ' */');
  if (!apply) {
    console.log('  ! 需要写入（--apply 才会落盘）');
    return;
  }
  copyFileSync(file, file + '.orig-muu');
  writeFileSync(file, src.replace(/\n/g, '\r\n'), 'utf8');
  console.log('  ✔ 写入 ' + REL);
}

main();
