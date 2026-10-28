#!/usr/bin/env node
/**
 * fix-games-ui.mjs —— 让浮窗「游戏」卡片认识到新增的三种「要模型」的游戏。
 *
 * 背景：2026-10-26 给 game-lib 加了 soup（海龟汤）/ story（故事接龙）/ quiz（你问我答），
 * 这三种开局会把本地小模型叫醒（pin 12 分钟），收摊或 15 分钟没动静就卸掉显存。
 * 卡片上的说明还写着「规则本地裁决零 token」，容易让人以为所有游戏都不碰模型。
 *
 * 用法：
 *   node qqbot-mod/patches/fix-games-ui.mjs --check
 *   node qqbot-mod/patches/fix-games-ui.mjs --apply
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const REL = 'client/qqbot-settings.js';
const TAG = '[qqbot-mod] games-ui';

const OPS = [
  {
    label: '游戏提示文案',
    old: `          + '对局状态落盘，15 分钟没动静自动收摊。会话里也可以让她开局/收摊（走 game 工具）。</div>'`,
    neu: `          + '海龟汤 / 故事接龙 / 你问我答 会临时叫醒本地小模型，收摊或 15 分钟没动静就放掉显存。'
          + '对局状态落盘，15 分钟没动静自动收摊。会话里也可以让她开局/收摊（走 game 工具）。</div>'`,
  },
  {
    label: '游戏口令列表',
    old: `群里直接说「玩猜数字 / 玩成语接龙 / 玩21点 / 玩石头剪刀布 / 真心话 / 掷骰子」就能开局`,
    neu: `群里直接说「玩猜数字 / 玩成语接龙 / 玩21点 / 玩石头剪刀布 / 玩海龟汤 / 玩故事接龙 / 玩你问我答 / 真心话 / 掷骰子」就能开局`,
  },
];

function main() {
  const apply = process.argv.includes('--apply');
  const file = pluginPath(REL);
  announce('fix-games-ui');
  if (!existsSync(file)) { console.error(`✗ 找不到 ${file}`); process.exit(1); }

  let src = readFileSync(file, 'utf8');
  const crlf = src.includes('\r\n');
  if (crlf) src = src.replace(/\r\n/g, '\n');

  if (src.includes(TAG) || src.includes('海龟汤 / 故事接龙 / 你问我答')) {
    console.log('= 已是最新，无需写入');
    return;
  }

  let out = src;
  let hit = 0;
  for (const op of OPS) {
    if (!out.includes(op.old)) { console.log(`! 未命中：${op.label}`); continue; }
    out = out.replace(op.old, op.neu);
    hit += 1;
    console.log(`✓ ${op.label}`);
  }
  if (!hit) { console.error('✗ 没有任何改动'); process.exit(2); }

  if (!apply) { console.log('\n（--check 模式，未写入；加 --apply 落地）'); return; }

  copyFileSync(file, `${file}.orig-muu`);
  const text = crlf ? out.replace(/\n/g, '\r\n') : out;
  writeFileSync(file, text, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`\n✔ 已写入 ${REL}（备份 .orig-muu）`);
  } catch (e) {
    writeFileSync(file, src, 'utf8');
    console.error(`✗ 语法检查失败，已回滚：${e.message}`);
    process.exit(1);
  }
}

main();
