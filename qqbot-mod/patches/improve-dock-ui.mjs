/**
 * improve-dock-ui.mjs —— 悬浮窗（主界面）视觉优化补丁
 *
 * 只加一层 CSS（DOCK_CSS3），不动任何逻辑/ID/事件：
 *   · 面板：柔和渐变底、双层阴影、18px 圆角、展开微动效
 *   · 头部：吸顶 + 毛玻璃 + 抓取光标（原本就能拖）
 *   · 标签页：从"下划线"改成轻量分段胶囊，点按反馈更清楚
 *   · 聊天区：更柔的底色、气泡圆角/阴影、输入框聚焦光环
 *   · 按钮/发送：hover/active/focus-visible 状态补齐
 *   · 尊重 prefers-reduced-motion
 *
 * 为什么是补丁而不是改扩展：浮窗是插件本体 client/qqbot-settings.js，
 * 插件升级会换目录；本脚本用 patches/plugin-dir.mjs 找当前活的那份。
 *
 * 用法：
 *   node patches/improve-dock-ui.mjs --check   只检查（默认）
 *   node patches/improve-dock-ui.mjs --apply   应用（备份 .orig-dockui）
 *   node patches/improve-dock-ui.mjs --update  已应用过时，只换 CSS（不动其他补丁）
 *   node patches/improve-dock-ui.mjs --revert  回滚
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { pluginPath, announce, IS_LIVE } from './plugin-dir.mjs';

const FILE = pluginPath('client/qqbot-settings.js');
const BAK = FILE + '.orig-dockui';
const MARK = 'qqs-dock-css3';

const CSS3 = `
#qqs-dock-panel{
  border-radius:18px;
  border:1px solid rgba(124,108,240,.20);
  background:linear-gradient(180deg,#ffffff 0%,#fcfbff 100%);
  box-shadow:0 18px 50px rgba(64,48,140,.18),0 3px 10px rgba(64,48,140,.07);
  animation:qqs-dock-in .16s ease-out;
}
@keyframes qqs-dock-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
#qqs-dock-panel .dk-h{
  position:sticky;top:0;z-index:6;
  padding:11px 16px;
  background:linear-gradient(90deg,rgba(124,108,240,.14),rgba(255,255,255,.82) 52%,rgba(94,199,242,.12));
  border-bottom:1px solid rgba(124,108,240,.15);
  backdrop-filter:blur(10px);
  cursor:grab;
}
#qqs-dock-panel .dk-h:active{cursor:grabbing}
#qqs-dock-panel .dk-b{scrollbar-width:thin;scrollbar-color:#d5d9e3 transparent}
#qqs-dock-panel .dk-b::-webkit-scrollbar{width:8px;height:8px}
#qqs-dock-panel .dk-b::-webkit-scrollbar-thumb{background:#d5d9e3;border-radius:8px;border:2px solid transparent;background-clip:content-box}
#qqs-dock-panel .dk-b::-webkit-scrollbar-thumb:hover{background:#bcc3d0;background-clip:content-box}
#qqs-dock-panel .dk-tab{
  gap:4px;padding:3px;margin:0 0 12px;
  background:#f4f1ff;border:1px solid #ece7ff;border-radius:11px;
}
#qqs-dock-panel .dk-tab button{
  border:0;border-radius:8px;padding:6px 14px;color:#6b6480;
  transition:background .15s,color .15s,box-shadow .15s;
}
#qqs-dock-panel .dk-tab button:hover{background:rgba(255,255,255,.65);color:#4a3a9f}
#qqs-dock-panel .dk-tab button.on{
  background:#fff;color:#4a3a9f;border-bottom-color:transparent;
  box-shadow:0 1px 4px rgba(74,58,159,.16);
}
#qqs-dock-panel .dk-chat-box{
  border-radius:14px;border-color:#e6e9f2;
  background:linear-gradient(180deg,#f7f8fb,#f1f3f8);
  box-shadow:inset 0 1px 2px rgba(30,40,80,.05);
  padding-bottom:36px;
}
#qqs-dock-panel .dk-cbubble{box-shadow:0 1px 3px rgba(20,30,60,.09)}
#qqs-dock-panel .dk-crow.in .dk-cbubble{border-radius:4px 12px 12px 12px}
#qqs-dock-panel .dk-crow.out .dk-cbubble{border-radius:12px 4px 12px 12px;box-shadow:0 2px 8px rgba(61,125,245,.22)}
#qqs-dock-panel .dk-composer{border-radius:12px;transition:border-color .15s,box-shadow .15s}
#qqs-dock-panel .dk-composer:focus-within{
  border-color:#a99bf5;box-shadow:0 0 0 3px rgba(124,108,240,.14);
}
#qqs-dock-panel .dk-btn{transition:background .15s,border-color .15s,transform .08s,box-shadow .15s}
#qqs-dock-panel .dk-btn:hover{background:#e9e2ff;border-color:#c9b8ff}
#qqs-dock-panel .dk-btn:active{transform:translateY(1px)}
#qqs-dock-panel .dk-btn:focus-visible,
#qqs-dock-panel .dk-send:focus-visible,
#qqs-dock-panel input:focus-visible,
#qqs-dock-panel select:focus-visible,
#qqs-dock-panel textarea:focus-visible{outline:2px solid #8f7cf4;outline-offset:1px}
#qqs-dock-panel .dk-cbar .dk-send{
  box-shadow:0 3px 10px rgba(61,125,245,.28);
  transition:filter .15s,box-shadow .15s,transform .08s;
}
#qqs-dock-panel .dk-cbar .dk-send:hover{filter:brightness(1.04);box-shadow:0 4px 14px rgba(61,125,245,.36)}
#qqs-dock-panel .dk-cbar .dk-send:active{transform:translateY(1px)}
#qqs-dock-ball{box-shadow:0 8px 24px rgba(90,70,220,.42)}
#qqs-dock-ball:hover{box-shadow:0 10px 28px rgba(90,70,220,.5)}
#qqs-dock-panel .dk-list{border-radius:12px;border-color:#eee9ff}
#qqs-dock-panel .dk-item:hover{background:#faf8ff}
#qqs-dock-panel .dk-jump-latest{
  bottom:100px;padding:4px 11px;font-size:11px;border-radius:13px;
  box-shadow:0 4px 14px rgba(30,60,140,.28);
}
@media (prefers-reduced-motion: reduce){
  #qqs-dock-panel{animation:none}
  #qqs-dock-panel .dk-btn,#qqs-dock-panel .dk-cbar .dk-send{transition:none}
}
`;

const ENSURE = `var DOCK_CSS3 = ${JSON.stringify(CSS3)};
function ensureDockCss3() { try { if (!document.getElementById('${MARK}')) { var st = document.createElement('style'); st.id = '${MARK}'; st.textContent = DOCK_CSS3; document.head.appendChild(st) } } catch (e) {} };
`;

const ANCHOR = 'function ensureDockCss2() {';
const CALL = 'try { ensureDockCss2() } catch (e) {}';
const CALL_NEW = CALL + '\ntry { ensureDockCss3() } catch (e) {}';

function main() {
  announce('dock-ui');
  if (!existsSync(FILE)) { console.error('找不到 client/qqbot-settings.js'); process.exit(1); }
  const mode = process.argv.includes('--apply') ? 'apply'
    : process.argv.includes('--update') ? 'update'
    : process.argv.includes('--revert') ? 'revert' : 'check';

  if (mode === 'revert') {
    if (!existsSync(BAK)) { console.log('没有备份，无法回滚'); process.exit(1); }
    copyFileSync(BAK, FILE);
    unlinkSync(BAK);
    console.log('已回滚 client/qqbot-settings.js（并删除 .orig-dockui）');
    return;
  }

  const src = readFileSync(FILE, 'utf8');

  // 已应用过、只想换 CSS：只替换 DOCK_CSS3 这一个字符串，不碰其它补丁
  if (mode === 'update') {
    if (!src.includes(MARK)) { console.error('还没应用过，请先 --apply'); process.exit(1); }
    const startMark = 'var DOCK_CSS3 = "';
    const a = src.indexOf(startMark);
    const b = a < 0 ? -1 : src.indexOf('";', a);
    if (a < 0 || b < 0) { console.error('找不到 DOCK_CSS3 定义，无法更新'); process.exit(1); }
    const out = src.slice(0, a) + `var DOCK_CSS3 = ${JSON.stringify(CSS3)};` + src.slice(b + 2);
    if (!existsSync(BAK)) copyFileSync(FILE, BAK);
    writeFileSync(FILE, out, 'utf8');
    console.log('已更新 DOCK_CSS3（其它补丁保持不变）');
    return;
  }

  if (src.includes(MARK)) {
    console.log('= 已经应用过（含 qqs-dock-css3），如需换 CSS 请用 --update');
    return;
  }
  if (!src.includes(ANCHOR)) { console.error('锚点 1 不存在，插件结构可能变了'); process.exit(1); }
  if (!src.includes(CALL)) { console.error('锚点 2 不存在，插件结构可能变了'); process.exit(1); }

  if (mode === 'check') {
    console.log('可应用：锚点齐全，尚未打补丁');
    return;
  }

  if (!existsSync(BAK)) copyFileSync(FILE, BAK);
  let out = src.replace(ANCHOR, ENSURE + ANCHOR);
  out = out.replace(CALL, CALL_NEW);
  writeFileSync(FILE, out, 'utf8');
  console.log('已应用悬浮窗 UI 补丁（备份 .orig-dockui）');
  if (!IS_LIVE) console.log('⚠️ 当前不是 harness 活目录，线上可能看不到变化');
}

main();
