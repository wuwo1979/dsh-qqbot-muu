/**
 * ui-theme-v2.mjs — 浮窗 UI 视觉层重做（设计令牌 + 深色跟随 + 记忆页卡片化）
 *
 * 背景：原来的浮窗是「白底 + 紫色渐变」的通用后台风——层次是清楚的，
 *       但配色靠一堆散落的 #7c6cf0 / #f0ecff 硬编码，深色系统下会刺眼，
 *       记忆页更是一列灰字 + 半透明盒子，信息密度高但读不出结构。
 *
 * 这一版做三件事：
 *   1. 引入一层设计令牌（CSS 变量）：中性色阶 + 单一强调色 + 圆角/阴影/描边刻度，
 *      并且 follow 系统深色；组件只引用令牌，以后换肤改十几行就够。
 *   2. 组件层重画：分段式 tab、更矮的按钮层级（普通 / ok / no）、输入框内阴影、
 *      聊天气泡收敛圆角、细滚动条、focus ring。
 *   3. 记忆页卡片化：KPI 卡片改用 .q-card，栏目标题用 <details class="q-sec">，
 *      并新增「🧬 归纳与认知稳定度」区块（接 memory-hippo 的 gists/beliefs/stability）。
 *
 * 幂等：所有写入都带 marker，重复执行只会替换自己那一段。
 *
 * 用法：
 *   node patches/ui-theme-v2.mjs --check
 *   node patches/ui-theme-v2.mjs --apply
 *   node patches/ui-theme-v2.mjs --revert
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pluginPath, announce } from './plugin-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const APPLY = args.includes('--apply');
const REVERT = args.includes('--revert');

const LIVE = pluginPath('client/qqbot-settings.js');
const SRC = join(HERE, 'add-memory-panel.mjs');
const MARK_A = '/* >>> ui-theme-v2 >>> */';
const MARK_B = '/* <<< ui-theme-v2 <<< */';
const CALL_MARK = 'try { ensureDockCss4() } catch (e) {}';

// ── 设计令牌 + 组件层（一段 CSS，注入到 head）───────────────────────────
const CSS4 = String.raw`
/* ========== 设计令牌 ========== */
#qqs-dock-panel{
  --q-font:-apple-system,BlinkMacSystemFont,'Segoe UI Variable','Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  --q-bg:#fbfbfd;
  --q-surface:#ffffff;
  --q-surface-2:#f3f4f7;
  --q-sunken:#eff1f5;
  --q-line:#e5e8ee;
  --q-line-soft:#eef0f4;
  --q-text:#14161b;
  --q-text-2:#586070;
  --q-dim:#8b919f;
  --q-accent:#2f6ef0;
  --q-accent-2:#17b0c4;
  --q-accent-soft:rgba(47,110,240,.10);
  --q-ok:#12854c;   --q-ok-soft:rgba(18,133,76,.12);
  --q-warn:#ad6f00; --q-warn-soft:rgba(173,111,0,.13);
  --q-bad:#cf3b34;  --q-bad-soft:rgba(207,59,52,.12);
  --q-r:18px; --q-r2:12px; --q-r3:9px;
  --q-sh:0 24px 56px -18px rgba(16,20,32,.26),0 1px 3px rgba(16,20,32,.05);
  --q-ring:0 0 0 3px rgba(47,110,240,.16);
}
@media (prefers-color-scheme:dark){
  #qqs-dock-panel{
    --q-bg:#15171d; --q-surface:#1c1f27; --q-surface-2:#23262f; --q-sunken:#191c23;
    --q-line:#2c3039; --q-line-soft:#24272f;
    --q-text:#e9ebf0; --q-text-2:#a7aebc; --q-dim:#787f8d;
    --q-accent:#6b9dff; --q-accent-2:#37c8d6; --q-accent-soft:rgba(107,157,255,.14);
    --q-ok:#45d193; --q-ok-soft:rgba(69,209,147,.15);
    --q-warn:#e0a53c; --q-warn-soft:rgba(224,165,60,.16);
    --q-bad:#f0736c; --q-bad-soft:rgba(240,115,108,.15);
    --q-sh:0 28px 64px -22px rgba(0,0,0,.72),0 1px 3px rgba(0,0,0,.4);
    --q-ring:0 0 0 3px rgba(107,157,255,.26);
  }
}

/* ========== 面板壳 ========== */
#qqs-dock-panel{
  font-family:var(--q-font);
  color:var(--q-text);
  background:var(--q-bg);
  border:1px solid var(--q-line);
  border-radius:var(--q-r);
  box-shadow:var(--q-sh);
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
#qqs-dock-panel .dk-h{
  padding:12px 16px;
  gap:9px;
  font-size:13.5px;
  font-weight:650;
  letter-spacing:.2px;
  color:var(--q-text);
  background:linear-gradient(180deg,var(--q-surface),var(--q-bg));
  border-bottom:1px solid var(--q-line);
  backdrop-filter:none;
}
#qqs-dock-panel .dk-h::before{
  content:"";
  width:3px;height:15px;border-radius:2px;
  background:linear-gradient(180deg,var(--q-accent),var(--q-accent-2));
  flex:none;
}
#qqs-dock-panel .dk-b{padding:12px 14px;font-size:13px;color:var(--q-text)}
#qqs-dock-panel .dk-b{scrollbar-width:thin;scrollbar-color:var(--q-line) transparent}
#qqs-dock-panel .dk-b::-webkit-scrollbar{width:8px;height:8px}
#qqs-dock-panel .dk-b::-webkit-scrollbar-thumb{
  background:var(--q-line);border-radius:8px;border:2px solid transparent;background-clip:content-box;
}
#qqs-dock-panel .dk-b::-webkit-scrollbar-thumb:hover{background:var(--q-dim);background-clip:content-box}

/* ========== 分段式 tab ========== */
#qqs-dock-panel .dk-tab{
  display:inline-flex;gap:2px;padding:3px;margin:0 0 12px;
  background:var(--q-surface-2);border:1px solid var(--q-line-soft);border-radius:var(--q-r2);
}
#qqs-dock-panel .dk-tab button{
  border:0;border-radius:var(--q-r3);padding:6px 13px;
  color:var(--q-text-2);font-weight:500;font-size:13px;
  transition:background .14s,color .14s,box-shadow .14s;
}
#qqs-dock-panel .dk-tab button:hover{background:rgba(128,140,166,.12);color:var(--q-text)}
#qqs-dock-panel .dk-tab button.on{
  background:var(--q-surface);color:var(--q-text);font-weight:650;
  border-bottom-color:transparent;
  box-shadow:0 1px 2px rgba(16,20,32,.10),0 0 0 1px var(--q-line);
}

/* ========== 按钮：一档实心 + 两档语义 ========== */
#qqs-dock-panel .dk-btn{
  border:1px solid var(--q-line);
  background:var(--q-surface);
  color:var(--q-text);
  border-radius:var(--q-r3);
  padding:6px 12px;font-weight:550;
  transition:background .14s,border-color .14s,box-shadow .14s,transform .08s;
}
#qqs-dock-panel .dk-btn:hover{background:var(--q-surface-2)}
#qqs-dock-panel .dk-btn:active{transform:translateY(1px)}
#qqs-dock-panel .dk-btn:disabled{opacity:.45;background:var(--q-surface)}
#qqs-dock-panel .dk-btn.ok{background:var(--q-ok-soft);color:var(--q-ok);border-color:var(--q-ok-soft)}
#qqs-dock-panel .dk-btn.no{background:var(--q-bad-soft);color:var(--q-bad);border-color:var(--q-bad-soft)}
#qqs-dock-panel .dk-btn:focus-visible,
#qqs-dock-panel .dk-send:focus-visible,
#qqs-dock-panel input:focus-visible,
#qqs-dock-panel select:focus-visible,
#qqs-dock-panel textarea:focus-visible{outline:none;box-shadow:var(--q-ring)}

/* ========== 输入 ========== */
#qqs-dock-panel select.qqs-sel,
#qqs-dock-panel input.qqs-txt,
#qqs-dock-panel textarea.qqs-txt{
  color:var(--q-text);background:var(--q-surface);
  border:1px solid var(--q-line);border-radius:var(--q-r3);
  padding:6px 9px;
}
#qqs-dock-panel .dk-composer{
  border:1px solid var(--q-line);border-radius:var(--q-r2);
  background:var(--q-surface);box-shadow:none;
}
#qqs-dock-panel .dk-composer:focus-within{border-color:var(--q-accent);box-shadow:var(--q-ring)}
#qqs-dock-panel .dk-composer textarea{color:var(--q-text)}
#qqs-dock-panel .dk-cbar .dk-send{
  background:linear-gradient(180deg,var(--q-accent),var(--q-accent));
  color:#fff;border:none;border-radius:var(--q-r3);
  padding:5px 16px;font-weight:600;
  box-shadow:0 2px 8px var(--q-accent-soft);
}
#qqs-dock-panel .dk-cbar .dk-send:hover{filter:brightness(1.05)}

/* ========== 聊天区 ========== */
#qqs-dock-panel .dk-chat-box{
  border-radius:var(--q-r2);border-color:var(--q-line-soft);
  background:var(--q-sunken);box-shadow:inset 0 1px 2px rgba(16,20,32,.04);
}
#qqs-dock-panel .dk-crow.in .dk-cbubble{
  background:var(--q-surface);border:1px solid var(--q-line-soft);color:var(--q-text);
  border-radius:4px var(--q-r2) var(--q-r2) var(--q-r2);
  box-shadow:0 1px 2px rgba(16,20,32,.05);
}
#qqs-dock-panel .dk-crow.out .dk-cbubble{
  background:linear-gradient(180deg,var(--q-accent),var(--q-accent));
  color:#fff;border-radius:var(--q-r2) 4px var(--q-r2) var(--q-r2);
  box-shadow:0 2px 8px var(--q-accent-soft);
}
#qqs-dock-panel .dk-cmeta{color:var(--q-dim)}
#qqs-dock-panel .dk-chat-top,
#qqs-dock-panel .dk-chat-bottom{color:var(--q-dim)}
#qqs-dock-panel .dk-msg{color:var(--q-text-2);font-size:12px}
#qqs-dock-panel .dk-empty{color:var(--q-dim);font-size:12px;padding:22px 0}
#qqs-dock-panel .dk-list{border:1px solid var(--q-line-soft);border-radius:var(--q-r2);padding:4px;background:var(--q-surface)}
#qqs-dock-panel .dk-item{border-bottom:1px solid var(--q-line-soft);color:var(--q-text)}
#qqs-dock-panel .dk-item:hover{background:var(--q-surface-2)}
#qqs-dock-panel .dk-at-pop{background:var(--q-surface);border-color:var(--q-line);box-shadow:0 10px 28px rgba(16,20,32,.18)}
#qqs-dock-panel .dk-at-item{color:var(--q-text)}
#qqs-dock-panel .dk-at-item.on,
#qqs-dock-panel .dk-at-item:hover{background:var(--q-accent-soft);color:var(--q-accent)}
#qqs-dock-panel .dk-jump-latest{background:var(--q-surface);color:var(--q-text);border:1px solid var(--q-line);box-shadow:var(--q-sh)}

/* ========== 记忆页：卡片 / 栏目 / 指标 ========== */
#qqs-dock-panel .q-cards{display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 8px}
#qqs-dock-panel .q-card{
  flex:1;min-width:78px;
  background:var(--q-surface);border:1px solid var(--q-line-soft);
  border-radius:var(--q-r2);padding:8px 10px;
}
#qqs-dock-panel .q-card .q-num{display:block;font-size:19px;font-weight:700;line-height:1.2;letter-spacing:-.2px}
#qqs-dock-panel .q-card .q-cap{display:block;font-size:11px;font-style:normal;color:var(--q-dim);margin-top:2px}
#qqs-dock-panel .q-sec{
  background:var(--q-surface);border:1px solid var(--q-line-soft);
  border-radius:var(--q-r2);padding:8px 11px;margin:7px 0;
}
#qqs-dock-panel .q-sec > summary{
  cursor:pointer;font-size:12.5px;font-weight:650;color:var(--q-text);
  list-style:none;display:flex;align-items:center;gap:6px;
}
#qqs-dock-panel .q-sec > summary::-webkit-details-marker{display:none}
#qqs-dock-panel .q-sec > summary::before{
  content:"";width:5px;height:5px;border-right:1.5px solid var(--q-dim);border-bottom:1.5px solid var(--q-dim);
  transform:rotate(-45deg);transition:transform .15s;flex:none;
}
#qqs-dock-panel .q-sec[open] > summary::before{transform:rotate(45deg)}
#qqs-dock-panel .q-sec .q-note{font-weight:400;color:var(--q-dim);font-size:11px}
#qqs-dock-panel .q-meter{margin:2px 0 8px}
#qqs-dock-panel .q-meter-t{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:var(--q-text-2);margin:0 0 5px}
#qqs-dock-panel .q-track{height:7px;border-radius:7px;background:var(--q-sunken);overflow:hidden}
#qqs-dock-panel .q-track > i{display:block;height:100%;border-radius:7px;background:var(--q-accent);transition:width .3s}
#qqs-dock-panel .q-track > i.ok{background:var(--q-ok)}
#qqs-dock-panel .q-track > i.warn{background:var(--q-warn)}
#qqs-dock-panel .q-track > i.bad{background:var(--q-bad)}
#qqs-dock-panel .q-pill{
  display:inline-flex;align-items:center;gap:4px;
  font-size:11px;font-weight:600;padding:1px 8px;border-radius:20px;
  background:var(--q-sunken);color:var(--q-text-2);
}
#qqs-dock-panel .q-pill.ok{background:var(--q-ok-soft);color:var(--q-ok)}
#qqs-dock-panel .q-pill.warn{background:var(--q-warn-soft);color:var(--q-warn)}
#qqs-dock-panel .q-pill.bad{background:var(--q-bad-soft);color:var(--q-bad)}
#qqs-dock-panel .q-list{display:flex;flex-direction:column;gap:3px;margin:6px 0 2px}
#qqs-dock-panel .q-row{
  display:flex;align-items:center;gap:8px;font-size:11.5px;
  padding:4px 7px;border-radius:var(--q-r3);background:var(--q-sunken);
}
#qqs-dock-panel .q-row .q-k{flex:1;color:var(--q-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#qqs-dock-panel .q-row .q-v{font-weight:650;color:var(--q-text);font-variant-numeric:tabular-nums}
#qqs-dock-panel .q-row .q-d{font-weight:600;font-variant-numeric:tabular-nums}
#qqs-dock-panel .q-row .q-d.ok{color:var(--q-ok)}
#qqs-dock-panel .q-row .q-d.warn{color:var(--q-warn)}
#qqs-dock-panel .q-row .q-d.bad{color:var(--q-bad)}
#qqs-dock-panel .q-hint{font-size:11px;color:var(--q-dim);line-height:1.6;margin:4px 0 0}

@media (prefers-reduced-motion:reduce){
  #qqs-dock-panel, #qqs-dock-panel *{animation:none!important;transition:none!important}
}
`;

const BLOCK = `
${MARK_A}
function ensureDockCss4() { try { if (!document.getElementById('qqs-dock-css4')) { var st = document.createElement('style'); st.id = 'qqs-dock-css4'; st.textContent = DOCK_CSS4; document.head.appendChild(st) } } catch (e) {} };
var DOCK_CSS4 = ${JSON.stringify(CSS4)};
${MARK_B}`;

// ── 记忆页：把硬编码浅色换成令牌 + 卡片化 ───────────────────────────────
const REPLACEMENTS = [
  [
    'memChip 卡片',
    `        return '<div style="flex:1;min-width:64px;background:#fff;border:1px solid #eee6ff;border-radius:10px;padding:6px 8px">'
          + '<div style="font-size:18px;font-weight:700;color:' + color + '">' + (Number(n) || 0) + '</div>'
          + '<div style="font-size:11px;color:#888">' + label + '</div></div>'`,
    `        return '<div class="q-card">'
          + '<b class="q-num" style="color:' + color + '">' + (Number(n) || 0) + '</b>'
          + '<i class="q-cap">' + label + '</i></div>'`,
  ],
  [
    'memBar 进度条',
    `        return '<div style="display:flex;align-items:center;gap:6px;margin:2px 0;font-size:11px;color:#666">'
          + '<span style="width:30px;flex:none">' + label + '</span>'
          + '<span style="flex:1;height:6px;background:#f0ecff;border-radius:6px;overflow:hidden"><i style="display:block;height:100%;width:' + n + '%;background:' + color + ';border-radius:6px"></i></span>'
          + '<b style="width:26px;text-align:right;color:#555">' + n + '</b></div>'`,
    `        return '<div style="display:flex;align-items:center;gap:6px;margin:2px 0;font-size:11px;color:var(--q-text-2)">'
          + '<span style="width:30px;flex:none">' + label + '</span>'
          + '<span class="q-track" style="flex:1"><i style="width:' + n + '%;background:' + color + '"></i></span>'
          + '<b style="width:26px;text-align:right;color:var(--q-text);font-variant-numeric:tabular-nums">' + n + '</b></div>'`,
  ],
  [
    'memSection 折叠块',
    `        return '<details' + (open ? ' open' : '') + ' style="background:#fbfaff;border:1px solid #f0ecff;border-radius:12px;padding:6px 10px;margin:6px 0">'
          + '<summary style="cursor:pointer;font-size:12px;font-weight:700;color:#5b4b8a">' + title
          + (note ? '<span style="font-weight:400;color:#aaa;margin-left:6px">' + note + '</span>' : '') + '</summary>'
          + '<div style="margin-top:6px">' + inner + '</div></details>'`,
    `        return '<details class="q-sec"' + (open ? ' open' : '') + '>'
          + '<summary>' + title
          + (note ? '<span class="q-note">' + note + '</span>' : '') + '</summary>'
          + '<div style="margin-top:7px">' + inner + '</div></details>'`,
  ],
  [
    '顶部提示文字',
    `        h += '<div style="font-size:10px;color:#aaa;margin:0 0 4px">共 '`,
    `        h += '<div class="q-hint" style="margin:0 0 6px">共 '`,
  ],
];

// ── 新增：归纳与认知稳定度（接 memory-hippo）───────────────────────────
const HIPPO_ANCHOR = "        h += memSection('🧠 记忆分身（本地模型整理）', agInner)";
const HIPPO_BLOCK = `        // 🧬 归纳与认知稳定度（类海马体：回放巩固 + 人格漂移护栏）
        // 数据来自 lib/memory-hippo.mjs：gists=归纳片段数，beliefs=信念条目数，
        // stability=100*(1-加权漂移)，越接近 100 说明"对她的认知"没被少数几次对话带跑。
        var hpS = d.hippo || {}
        var drS = d.drift || {}
        var hpRows = (drS.rows || hpS.drift || [])
        var stab = Number(drS.stability != null ? drS.stability : hpS.stability)
        if (!isFinite(stab)) stab = 100
        var alarmN = Number(drS.alarm != null ? drS.alarm : hpS.alarm) || 0
        var lvCls = alarmN > 0 ? 'bad' : (stab >= 82 ? 'ok' : 'warn')
        var lvTxt = alarmN > 0 ? '偏离偏大' : (stab >= 82 ? '稳定' : '需要留意')
        var hpInner = '<div class="q-cards">'
          + '<div class="q-card"><b class="q-num">' + (Number(hpS.gists) || 0) + '</b><i class="q-cap">归纳片段</i></div>'
          + '<div class="q-card"><b class="q-num">' + (Number(hpS.links) || 0) + '</b><i class="q-cap">记忆链接</i></div>'
          + '<div class="q-card"><b class="q-num">' + (Number(hpS.beliefs) || 0) + '</b><i class="q-cap">信念条目</i></div>'
          + '</div>'
          + '<div class="q-meter"><div class="q-meter-t"><span>认知稳定度</span>'
          + '<b class="q-pill ' + lvCls + '">' + Math.round(stab) + ' · ' + lvTxt + '</b></div>'
          + '<div class="q-track"><i class="' + lvCls + '" style="width:' + Math.max(0, Math.min(100, stab)) + '%"></i></div></div>'
        if (hpRows.length) {
          hpInner += '<div class="q-list">'
          for (var hi = 0; hi < Math.min(6, hpRows.length); hi += 1) {
            var hr = hpRows[hi] || {}
            var hv = Number(hr.drift) || 0
            var hc = Math.abs(hv) >= 0.45 ? 'bad' : (Math.abs(hv) >= 0.25 ? 'warn' : 'ok')
            hpInner += '<div class="q-row"><span class="q-k">' + esc(String(hr.key || '')) + '</span>'
              + '<span class="q-v">' + (Number(hr.value) || 0).toFixed(2) + '</span>'
              + '<b class="q-d ' + hc + '">' + (hv > 0 ? '+' : '') + hv.toFixed(2) + '</b></div>'
          }
          hpInner += '</div>'
        } else {
          hpInner += '<div class="q-hint">还没有信念条目 · 多聊几轮（每 12 轮会回放巩固一次）后才会沉淀出来</div>'
        }
        hpInner += '<div class="q-hint">'
          + (Number(hpS.lastReplay) ? '上次回放：' + esc(fmtMemAgo(hpS.lastReplay)) + (hpS.lastReplayDetail ? ' · ' + esc(hpS.lastReplayDetail) : '')
            : '还没有回放过（每 12 轮对话自动跑，或在记忆页手动触发）')
          + '</div>'
        h += memSection('🧬 归纳与认知稳定度', hpInner)
`;

function readOr(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

function stripBlock(src) {
  const a = src.indexOf(MARK_A);
  const b = src.indexOf(MARK_B);
  if (a < 0 || b < 0 || b < a) return src;
  // 连同插入时补的那一个换行一起吃掉，否则重复 --apply 会一行行堆空行
  let start = a;
  if (src[start - 1] === '\n') start -= 1;
  if (src[start - 1] === '\r') start -= 1;
  return src.slice(0, start) + src.slice(b + MARK_B.length);
}

/** 对单个文件做全部改写，返回 { src, hits } */
function patchOne(src, { isClient }) {
  let s = src;
  const hits = [];
  // 线上文件是 CRLF、补丁源码是 LF：所有插入/匹配文本都按目标文件的换行符重排，
  // 否则 indexOf 永远差一个 \r（第一版就栽在这）。
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  const fit = (t) => (nl === '\n' ? t : t.replace(/\r?\n/g, nl));
  const has = (t) => s.includes(fit(t));

  if (isClient) {
    // 1) CSS 块：先去旧，再插到 startQqDock 之前
    s = stripBlock(s);
    const at = s.indexOf('    function startQqDock(sessionsSvc) {');
    if (at >= 0) {
      s = s.slice(0, at) + fit(BLOCK.trim()) + nl + s.slice(at);
      hits.push('CSS4 块');
    } else {
      hits.push('CSS4 块（跳过：没找到 startQqDock）');
    }
    // 2) 调用点
    const callAnchor = 'try { ensureDockCss3() } catch (e) {}';
    if (s.includes(callAnchor) && !s.includes(CALL_MARK)) {
      s = s.replace(callAnchor, callAnchor + nl + CALL_MARK);
      hits.push('CSS4 调用');
    } else if (s.includes(CALL_MARK)) {
      hits.push('CSS4 调用（已存在）');
    }
  }

  // 3) 记忆页样式令牌化
  for (const [label, a, b] of REPLACEMENTS) {
    if (s.includes(fit(a))) {
      s = s.replace(fit(a), () => fit(b));
      hits.push(label);
    } else if (has(b)) {
      hits.push(label + '（已是新版）');
    } else {
      hits.push(label + '（跳过：锚点缺失）');
    }
  }

  // 4) 归纳与稳定度区块
  if (!s.includes('归纳与认知稳定度')) {
    if (has(HIPPO_ANCHOR)) {
      s = s.replace(fit(HIPPO_ANCHOR), () => fit(HIPPO_BLOCK) + fit(HIPPO_ANCHOR));
      hits.push('归纳区块');
    } else {
      hits.push('归纳区块（跳过：锚点缺失）');
    }
  } else {
    hits.push('归纳区块（已存在）');
  }
  return { src: s, hits };
}

const targets = [
  { path: LIVE, isClient: true, backup: '.orig-theme2' },
  { path: SRC, isClient: false, backup: '.orig-theme2' },
].filter((t) => existsSync(t.path));

if (!targets.length) {
  console.log('没找到目标文件（先跑 add-memory-panel.mjs --apply 把记忆页装上）');
  process.exit(1);
}

announce('ui-theme-v2');
for (const t of targets) {
  const src = readOr(t.path);
  if (!src) continue;
  if (REVERT) {
    const out = stripBlock(src);
    if (CHECK) {
      console.log(`[check] ${t.path}\n  会移除 CSS4 块：${out !== src ? '有' : '无'}`);
      continue;
    }
    writeFileSync(t.path, out, 'utf8');
    console.log(`[revert] ${t.path}`);
    continue;
  }
  const { src: out, hits } = patchOne(src, t);
  const changed = out !== src;
  console.log(`\n${CHECK ? '[check]' : '[apply]'} ${t.path}`);
  for (const h of hits) console.log('  · ' + h);
  console.log('  变化：' + (changed ? '有' : '无'));
  if (!CHECK && changed) {
    try {
      if (!existsSync(t.path + t.backup)) copyFileSync(t.path, t.path + t.backup);
    } catch { /* 备份失败不阻塞 */ }
    writeFileSync(t.path, out, 'utf8');
  }
}

if (!CHECK && !REVERT) {
  console.log('\n下一步：重启浮窗（或刷新客户端）看到新样式；记忆页的「🧬 归纳与认知稳定度」需要 memory-hippo 有数据才会亮。');
}
