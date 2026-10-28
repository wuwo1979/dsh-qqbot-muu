#!/usr/bin/env node
/**
 * fix-dock-top.mjs —— 浮窗再大也别盖住顶部工具条
 *
 * 主人反馈：浮窗打开后（尤其把窗口拖大之后）会压住最顶部的按钮 —— 因为 layoutPanel()
 * 把 top 的下限写成 `pad`（10px），面板可以一路顶到屏幕最上面；高度上限也是
 * `vh - pad*2`，于是"尺寸一变就往顶部工具条上压"。
 *
 * 本补丁（都在 startQqDock 闭包内）：
 *   1. 新增 `var DOCK_TOP_SAFE = 56`：顶部安全区（DSH 顶部工具条高度），面板 top 不许小于它；
 *   2. 高度上限改成 `vh - DOCK_TOP_SAFE - pad`，并把 _pH 夹进上限内（极短视口也不越界）；
 *   3. manualPanelPos / panelAnchor / 贴球自动定位三条分支的 top clamp 与 maxHeight 统一用它；
 *   4. 拖动标题栏时 top 也夹在 DOCK_TOP_SAFE 以上（主人想往上拖也不会压住按钮）；
 *   5. 右下角手柄缩放时，高度上限改成"到视口底部且不越过顶部安全区"。
 *
 * 用法：
 *   node qqbot-mod/patches/fix-dock-top.mjs --check
 *   node qqbot-mod/patches/fix-dock-top.mjs --apply
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLUGIN, GENERATION, announce } from './plugin-dir.mjs';

const APPLY = process.argv.includes('--apply');
const CLIENT = join(PLUGIN, 'client', 'qqbot-settings.js');

announce('fix-dock-top');
console.log(`  目标: ${PLUGIN}${GENERATION ? ` · generation ${GENERATION}` : ''}`);

function splice(src, old, neu, label) {
  // 已打过：新串已在文件里就跳过（注意有些改动是"在 old 前面插一段"，old 依旧存在，
  // 所以不能写成 includes(neu) && !includes(old)，否则旧版会重复插入）
  if (src.includes(neu)) return { src, hit: false, label };
  const n = src.split(old).length - 1;
  if (n === 0) { console.log(`  ! 锚点未命中，跳过：${label}`); return { src, hit: false, label }; }
  if (n > 1) throw new Error(`锚点不唯一（${n} 处）：${label}`);
  console.log(`  ~ ${label}`);
  return { src: src.replace(old, neu), hit: true, label };
}

const raw = readFileSync(CLIENT, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let src = eol === '\r\n' ? raw.split('\r\n').join('\n') : raw;
const before = src;
let s;

// 1) 顶部安全区常量（紧跟 manualPanelSize 声明之后）
s = splice(src,
  `      var manualPanelSize = null\n      try {\n        var _psRaw = localStorage.getItem('qqs-dock-size-v1')`,
  `      var manualPanelSize = null\n      // [qqbot-mod] dock-top-safe（2026-10-25 主人: 浮窗会挤占最顶部按钮）\n      //   面板 top 的下限 = 顶部工具条高度；高度上限也据此收窄，尺寸再怎么变都压不住按钮\n      var DOCK_TOP_SAFE = 56\n      try {\n        var _psRaw = localStorage.getItem('qqs-dock-size-v1')`,
  'DOCK_TOP_SAFE 常量');
src = s.src;

// 2) 高度上限：vh - pad*2 → vh - DOCK_TOP_SAFE - pad
src = splice(src,
  `          var _pMaxH = Math.round(vh - pad * 2)`,
  `          var _pMaxH = Math.round(vh - DOCK_TOP_SAFE - pad)`,
  '高度上限收窄').src;

// 3) _pH 夹进上限（Math.max(360,...) 在极短视口会越界）
src = splice(src,
  `          var _pH = Math.max(360, Math.min(_pMaxH, Math.round((manualPanelSize && manualPanelSize.h) || Math.min(vh * 0.72, 760))))`,
  `          var _pH = Math.min(_pMaxH, Math.max(300, Math.round((manualPanelSize && manualPanelSize.h) || Math.min(vh * 0.72, 760))))`,
  '_pH 夹进上限').src;

// 4) 三处 top clamp：pad → DOCK_TOP_SAFE
src = splice(src,
  `          panel.style.top = Math.max(pad, Math.min(manualPanelPos.y, vh - ph2 - pad)) + 'px'`,
  `          panel.style.top = Math.max(DOCK_TOP_SAFE, Math.min(manualPanelPos.y, vh - ph2 - pad)) + 'px'`,
  'manualPanelPos 分支 top').src;
src = splice(src,
  `          panel.style.top = Math.max(pad, Math.min(panelAnchor.top, vh - 80)) + 'px'`,
  `          panel.style.top = Math.max(DOCK_TOP_SAFE, Math.min(panelAnchor.top, vh - 80)) + 'px'`,
  'panelAnchor 分支 top').src;
src = splice(src,
  `        top = Math.max(pad, Math.min(top, vh - ph - pad))`,
  `        top = Math.max(DOCK_TOP_SAFE, Math.min(top, vh - ph - pad))`,
  '贴球定位 top').src;

// 5) 三处 maxHeight：vh - pad*2 → vh - DOCK_TOP_SAFE - pad
{
  const oldMax = `panel.style.maxHeight = Math.round(vh - pad * 2) + 'px'`;
  const neuMax = `panel.style.maxHeight = Math.round(vh - DOCK_TOP_SAFE - pad) + 'px'`;
  const n = src.split(oldMax).length - 1;
  console.log(`  ~ maxHeight ×${n} 收窄`);
  src = src.split(oldMax).join(neuMax);
}

// 6) 拖动标题栏：top 夹在顶部安全区以下
src = splice(src,
  `            panel.style.left = (ox + dx) + 'px'\n            panel.style.top = (oy + dy) + 'px'`,
  `            var _nx = Math.max(0, Math.min((window.innerWidth || 1200) - 120, ox + dx))\n            var _ny = Math.max(DOCK_TOP_SAFE, Math.min((window.innerHeight || 800) - 80, oy + dy))\n            panel.style.left = _nx + 'px'\n            panel.style.top = _ny + 'px'`,
  '拖动 top clamp').src;

// 7) 手柄缩放：高度不越过顶部安全区
src = splice(src,
  `              var h = Math.max(360, Math.min((window.innerHeight || 800) - 20, h0 + (ev.clientY - sy)))`,
  `              var _top0 = panel.offsetTop || DOCK_TOP_SAFE\n              var _hMax = Math.max(300, (window.innerHeight || 800) - Math.max(DOCK_TOP_SAFE, _top0) - 24)\n              var h = Math.min(_hMax, Math.max(300, h0 + (ev.clientY - sy)))`,
  '手柄缩放高度 clamp').src;

// 8) 尺寸写回时同步收窄（下一次 layoutPanel 才不会把 top 顶上去）
src = splice(src,
  `              manualPanelSize = { w: Math.round(panel.offsetWidth), h: Math.round(panel.offsetHeight) }`,
  `              manualPanelSize = { w: Math.round(panel.offsetWidth), h: Math.round(panel.offsetHeight) }\n              try { panel.style.top = Math.max(DOCK_TOP_SAFE, panel.offsetTop) + 'px' } catch (eTop) {}`,
  '尺寸写回同步 top').src;

if (src === before) { console.log('  = 已是最新，无需写入'); process.exit(0); }
if (!APPLY) { console.log('  需要写入（加 --apply 生效）'); process.exit(0); }

const bak = CLIENT + '.orig-muu';
if (!existsSync(bak)) { copyFileSync(CLIENT, bak); console.log(`    备份: ${CLIENT.replace(PLUGIN, '<plugin>')}.orig-muu`); }
writeFileSync(CLIENT, eol === '\r\n' ? src.split('\n').join('\r\n') : src, 'utf8');
try {
  execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'pipe' });
  console.log('  ✔ client/qqbot-settings.js 已写入（语法检查通过）');
} catch (e) {
  copyFileSync(bak, CLIENT);
  console.error('  ✘ 语法检查失败，已回滚\n' + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
console.log('\n提示：装完要重启宿主（/bot-restart 或重开 DSH Desktop）+ 页面 Ctrl+F5 才生效。');
