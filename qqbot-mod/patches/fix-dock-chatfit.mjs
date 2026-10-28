#!/usr/bin/env node
/**
 * fix-dock-chatfit.mjs —— 聊天板块不再被按钮挤占（2026-10-25 主人：浮窗里聊天板块还是会挤占，可能因为按钮太多了）
 *
 * 只加一层 CSS（DOCK_CSS9），不动逻辑：
 *   · 顶部「刷新 + 状态」行压扁；
 *   · 输入区 textarea 定高 40~88px，工具条按钮统一 22px 高、单行不换行（超宽可横向滑）；
 *   · 消息列表拿回剩余高度，右下「↓ 最新」不压住最后一条。
 *
 * 用法：node qqbot-mod/patches/fix-dock-chatfit.mjs [--check|--apply]
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PLUGIN } from './plugin-dir.mjs';

const CLIENT = PLUGIN + '/client/qqbot-settings.js';
const MARK = '[qqbot-mod] chatfit';
const ANCHOR = 'try { ensureDockCss8() } catch (e) {}';

const NEW = `${ANCHOR}
// ${MARK}：聊天板块压缩顶部行与输入区，把高度还给消息列表（主人：按钮太多挤占内容）
var DOCK_CSS9 = "#qqs-dock-panel .dk-chat-head{margin:0 0 4px;gap:4px}\\n" +
  "#qqs-dock-panel .dk-chat-head .dk-btn{height:22px;padding:0 8px;font-size:11px;line-height:22px}\\n" +
  "#qqs-dock-panel .dk-chat-head .dk-msg{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\\n" +
  "#qqs-dock-panel #dk-target-row{margin:0 0 4px}\\n" +
  "#qqs-dock-panel #dk-target-row .qqs-sel{height:24px;font-size:11px}\\n" +
  "#qqs-dock-panel .dk-composer{padding:4px 6px 6px}\\n" +
  "#qqs-dock-panel .dk-composer textarea{min-height:40px;max-height:88px;font-size:12px;line-height:1.5}\\n" +
  "#qqs-dock-panel .dk-cbar{gap:4px;flex-wrap:nowrap;overflow-x:auto;padding-top:3px}\\n" +
  "#qqs-dock-panel .dk-cbar .dk-btn{height:22px;padding:0 6px;font-size:11px;line-height:22px;flex:0 0 auto}\\n" +
  "#qqs-dock-panel .dk-cbar .dk-msg{font-size:10px;flex:0 0 auto}\\n" +
  "#qqs-dock-panel .dk-cbar .dk-send{height:24px;padding:0 10px;font-size:11px;flex:0 0 auto}\\n" +
  "#qqs-dock-panel .dk-chat-box{padding-right:2px}\\n" +
  "#qqs-dock-panel .dk-jump-latest{bottom:6px}"
function ensureDockCss9() {
  if (document.getElementById('qqs-dock-css9')) return
  var st = document.createElement('style')
  st.id = 'qqs-dock-css9'
  st.textContent = DOCK_CSS9
  ;(document.head || document.documentElement).appendChild(st)
}
try { ensureDockCss9() } catch (e) {}`;

function main() {
  const apply = process.argv.includes('--apply');
  const raw = readFileSync(CLIENT, 'utf8');
  const crlf = raw.includes('\r\n');
  let src = raw.replace(/\r\n/g, '\n');
  console.log('目标:', CLIENT);

  if (src.includes(NEW)) {
    console.log(`  ✔ ${MARK}  已是新版`);
    console.log('\n结果: 已是最新，无需写入');
    return;
  }
  if (!src.includes(ANCHOR)) {
    console.log(`  ✘ ${MARK}  锚点未命中（${ANCHOR}）`);
    process.exitCode = 2;
    return;
  }
  src = src.replace(ANCHOR, () => NEW);
  console.log(`  ✔ ${MARK}  插入 CSS9`);

  if (!apply) {
    console.log('\n结果: 需要写入（加 --apply 落盘）');
    return;
  }
  const out = crlf ? src.replace(/\n/g, '\r\n') : src;
  const bak = CLIENT + '.orig-muu';
  if (!existsSync(bak)) copyFileSync(CLIENT, bak);
  writeFileSync(CLIENT, out, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'pipe' });
    console.log(`✔ 已写入（备份 ${bak}）`);
  } catch (e) {
    writeFileSync(CLIENT, raw, 'utf8');
    console.error(`✘ 语法检查失败，已回滚\n${String(e.stderr || e.message).slice(0, 600)}`);
    process.exitCode = 1;
  }
}

main();
