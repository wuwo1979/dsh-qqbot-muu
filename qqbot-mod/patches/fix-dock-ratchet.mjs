#!/usr/bin/env node
/**
 * fix-dock-ratchet.mjs —— 修「切 tab 之后浮窗越变越小」+ tab 按钮太满挤占空间
 *
 * 主人 2026-10-25：
 *   「当前浮窗里聊天板块还是会挤占，可能因为按钮太多了等原因，而且切换按钮后整个浮窗会逐渐缩小」
 *
 * 根因（两个，都是我们自己引入的）：
 *   1) DOCK_CSS6 给 #qqs-dock-panel 加了 box-sizing:border-box，而 bindPanelResize 里的
 *      ResizeObserver 记的是 entries[0].contentRect（内容盒）。layoutPanel 写的是 border-box 高度，
 *      于是每切一次 tab：写 768 → 读回 766 → 下次写 766 → 读回 764 …… 每次少 2px（边框），
 *      切十几次就肉眼可见地缩水。修法：读 offsetWidth/offsetHeight（边框盒），
 *      并且只在"用户自己拖动/拉手柄放大"时才记，内容变化导致的缩小一律忽略。
 *   2) .dk-tab 是横向滚动条（overflow-x:auto）且不换行，按钮一多就要横着划，
 *      视觉上挤在浮窗顶上。修法：CSS7 让 tab 换行（flex-wrap:wrap），按钮缩小一号。
 *
 * 用法：node qqbot-mod/patches/fix-dock-ratchet.mjs [--check|--apply]
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY = join(HERE, 'live-overlay');
/** 目标：当前 live generation 的 client 文件（也可以用 QQBOT_PLUGIN_DIR 覆盖） */
function findClient() {
  const env = String(process.env.QQBOT_PLUGIN_DIR || '').trim();
  if (env) return join(env, 'client', 'qqbot-settings.js');
  const base = join(process.env.APPDATA || '', 'dsh-desktop', 'harness', 'profiles', '.generations', 'live');
  const { readdirSync } = fsSync;
  let best = null;
  for (const d of readdirSync(base)) {
    if (!d.startsWith('zaofan+dsh-qqbot+')) continue;
    const p = join(base, d, 'node_modules', '@zaofan', 'dsh-qqbot', 'client', 'qqbot-settings.js');
    if (existsSync(p)) best = p;
  }
  return best || '';
}
import * as fsSync from 'node:fs';

const APPLY = process.argv.includes('--apply');
const CLIENT = process.env.QQBOT_CLIENT || findClient();
if (!CLIENT) { console.error('找不到 live client 文件（可用 QQBOT_CLIENT 指定）'); process.exit(1); }

const raw = readFileSync(CLIENT, 'utf8');
const crlf = raw.includes('\r\n');
let src = crlf ? raw.replace(/\r\n/g, '\n') : raw;
const orig = src;

const hits = [];
function splice(label, oldText, newText) {
  if (!src.includes(oldText)) { hits.push(`× ${label}: 锚点没找到`); return false; }
  if (src.includes(newText)) { hits.push(`= ${label}: 已是最新`); return false; }
  src = src.replace(oldText, newText);
  hits.push(`✔ ${label}`);
  return true;
}

// ── 1. ResizeObserver 记边框盒，且不因内容缩小而跟着缩 ──
splice(
  'resize-observer',
  `          var ro = new ResizeObserver(function (entries) {
            if (!open || !entries || !entries.length) return
            var r = entries[0].contentRect
            if (!r || r.width < 360 || r.height < 300) return
            manualPanelSize = { w: Math.round(r.width), h: Math.round(r.height) }
            try { localStorage.setItem('qqs-dock-size-v1', JSON.stringify(manualPanelSize)) } catch (e) {}
          })`,
  `          var ro = new ResizeObserver(function (entries) {
            if (!open || !entries || !entries.length) return
            // [qqbot-mod] dock-ratchet（2026-10-25 主人: 切 tab 浮窗越变越小）
            //   原来记 contentRect（内容盒），而 layoutPanel 写的是 border-box 高度，
            //   每切一次 tab 就少 2px 边框，切十几次肉眼可见地缩水。
            //   改：读边框盒；且只在"用户自己拉大/拖手柄"时记，内容变化引起的缩小忽略。
            var _w = panel.offsetWidth, _h = panel.offsetHeight
            if (!_w || !_h || _w < 360 || _h < 300) return
            var _prev = manualPanelSize
            var _grew = !_prev || _w > _prev.w + 2 || _h > _prev.h + 2
            if (!_grew && !state._userResizing) return
            if (_prev && _prev.w === _w && _prev.h === _h) return
            manualPanelSize = { w: _w, h: _h }
            try { localStorage.setItem('qqs-dock-size-v1', JSON.stringify(manualPanelSize)) } catch (e) {}
          })`,
);

// ── 2. 拖手柄期间打标记，松手清掉（此时允许记缩小） ──
splice(
  'grip-pointerdown-flag',
  `            try { grip.setPointerCapture(e.pointerId) } catch (eC) {}`,
  `            try { grip.setPointerCapture(e.pointerId) } catch (eC) {}
            try { state._userResizing = true } catch (eU) {}`,
);
splice(
  'grip-pointerup-flag',
  `              manualPanelSize = { w: Math.round(panel.offsetWidth), h: Math.round(panel.offsetHeight) }`,
  `              try { state._userResizing = false } catch (eU) {}
              manualPanelSize = { w: Math.round(panel.offsetWidth), h: Math.round(panel.offsetHeight) }`,
);

// ── 3. CSS7：tab 换行 + 聊天区严格内部滚动 ──
const CSS7 = [
  '#qqs-dock-panel .dk-tab{display:flex;flex-wrap:wrap;overflow:visible;gap:4px;padding:4px;row-gap:4px}',
  '#qqs-dock-panel .dk-tab button{padding:5px 10px;font-size:12px;flex:0 0 auto}',
  '#qqs-dock-panel .dk-b{min-height:0}',
  '#qqs-dock-panel.dk-full .dk-b{min-height:0}',
  '#qqs-dock-panel .dk-chat-wrap{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
  '#qqs-dock-panel .dk-chat-box{flex:1 1 auto;min-height:90px;overflow-y:auto;overscroll-behavior:contain}',
  '#qqs-dock-panel .dk-composer{flex:none}',
].join('\n');

splice(
  'css7-var',
  `    function startQqDock(sessionsSvc) {`,
  `// [qqbot-mod] dock-css7（2026-10-25 主人: 按钮太多挤占 / 聊天板块挤占）
//   tab 从"横向滚动"改成"换行排"，按钮小一号；聊天区严格在面板内部滚动。
var DOCK_CSS7 = ${JSON.stringify(CSS7)}
function ensureDockCss7() {
  try {
    if (document.getElementById('qqs-dock-css7')) return
    var st = document.createElement('style')
    st.id = 'qqs-dock-css7'
    st.textContent = DOCK_CSS7
    document.head.appendChild(st)
  } catch (e) {}
};
    function startQqDock(sessionsSvc) {`,
);
splice(
  'css7-call',
  `try { ensureDockCss6() } catch (e) {}`,
  `try { ensureDockCss6() } catch (e) {}
try { ensureDockCss7() } catch (e) {}`,
);

console.log(`目标: ${CLIENT}`);
for (const h of hits) console.log(`  ${h}`);
const changed = src !== orig;
console.log(`\n结果: ${changed ? '需要写入' : '已是最新，无需写入'}${APPLY ? '' : '（加 --apply 落盘）'}`);
if (!changed) process.exit(0);
if (!APPLY) { console.log('\n预览 diffless：只影响上面 ✔ 的几处'); process.exit(0); }

const bak = `${CLIENT}.orig-muu`;
try { if (!existsSync(bak)) copyFileSync(CLIENT, bak); } catch { /* ignore */ }
const out = crlf ? src.replace(/\n/g, '\r\n') : src;
writeFileSync(CLIENT, out, 'utf8');
console.log(`✔ 已写入（备份 ${bak}）`);
