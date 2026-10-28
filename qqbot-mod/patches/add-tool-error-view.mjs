// add-tool-error-view.mjs —— 面板里显示「最近工具报错」（配合 fix-tool-errors.mjs：失败不再发群）
//
//   S1 settings-host.js 加 GET /api/qqbot-settings/tool-errors?limit=10
//   C1 客户端 extCardHtml() 里在「最近判定」块后面加「🛠 最近工具报错」块
//   C2 客户端加 loadToolErrors()/bindToolErrCard()，并绑刷新按钮
//
// 备注：为了让本脚本自身不含反斜杠/双引号（write 工具会转义），
//       生成的客户端代码只用单引号 + 无引号 HTML 属性 + DOM API 设样式。
//
// 用法：
//   node patches/add-tool-error-view.mjs --check
//   node patches/add-tool-error-view.mjs --apply
//   node patches/add-tool-error-view.mjs --revert

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN, IS_LIVE, announce } from './plugin-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const Q = String.fromCharCode(39);

const SERVER = join(PLUGIN, 'settings-host.js');
const CLIENT = join(PLUGIN, 'client', 'qqbot-settings.js');
const BACKUP_S = join(HERE, '..', 'backups', 'settings-host.js.orig-toolerr');
const BACKUP_C = join(HERE, '..', 'backups', 'qqbot-settings.js.orig-toolerr');
const MARK = '[qqbot-mod] tool-errors-view';

const args = new Set(process.argv.slice(2));
const MODE = args.has('--apply') ? 'apply' : args.has('--revert') ? 'revert' : 'check';

function eolOf(src) {
  return src.indexOf(CR + LF) >= 0 ? CR + LF : LF;
}
function norm(src) {
  return src.split(CR).join('').split(LF).join(LF);
}
function L(arr) {
  return arr.join(LF);
}
function q(s) {
  return Q + s + Q;
}

function buildRoute() {
  return L([
    '  // ' + MARK + '：工具失败不上群，只在这里看（数据由 dist/transport/tool-presenter.js 写入）',
    "  route(ctx, 'GET', '/api/qqbot-settings/tool-errors', async (req, res) => {",
    '    try {',
    "      const u = new URL(req.url ?? '/', 'http://x');",
    '      const limit = Math.max(1, Math.min(50, Number(u.searchParams.get(' + q('limit') + ') || 10) || 10));',
    '      const bot = nsBot(NSQ(u));',
    '      const root = resolveMemoryRoot(bot);',
    "      const p = root ? join(root, '.qqbot', 'tool-errors.jsonl') : '';",
    '      let rows = [];',
    '      if (p && existsSync(p)) {',
    "        const lines = readFileSync(p, 'utf8').split(String.fromCharCode(10)).filter(Boolean).slice(-limit);",
    '        rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);',
    '      }',
    '      rows.reverse();',
    "      return writeJson(res, 200, { ok: true, root: root || '', path: p, count: rows.length, rows });",
    '    } catch (e) {',
    "      return writeJson(res, 200, { ok: false, error: String((e && e.message) || e), rows: [] });",
    '    }',
    '  });',
  ]);
}

function buildClientCard() {
  return L([
    '  // ' + MARK + '：最近工具报错（这些不再发到群里；属性不加引号，样式在 bindToolErrCard 里设）',
    '  html += ' + q('<div id=dk-tool-card>') + '',
    '    + ' + q('<div><b>🛠 最近工具报错（只在面板看，不发群）</b> ') + '',
    '    + ' + q('<button class=dk-btn id=dk-tool-reflog>🔄 刷新</button></div>') + '',
    '    + ' + q('<div id=dk-tool-recent>（加载中…）</div>') + '',
    '    + ' + q('</div>') + '',
  ]);
}

function buildLoadFn() {
  return L([
    '  // ' + MARK + '：读工具报错（只渲染文本，不走 innerHTML）',
    '  function loadToolErrors() {',
    '    var box = panel ? panel.querySelector(' + q('#dk-tool-recent') + ') : null',
    '    if (!box) return',
    "    api('tool-errors', 'limit=10').then(function (d) {",
    '      var rows = (d && d.rows) || []',
    '      while (box.firstChild) box.removeChild(box.firstChild)',
    '      if (!rows.length) { box.textContent = ' + q('这条目标还没有工具报错 ✓') + '; return }',
    '      rows.forEach(function (r) {',
    "        var line = document.createElement('div')",
    '        line.style.padding = ' + q('2px 0') + '',
    "        var t = document.createElement('span')",
    "        t.style.color = '#868e96'",
    '        t.textContent = chatTime(r.ts) + ' + q(' '),
    "        var n = document.createElement('b')",
    "        n.style.color = '#c92a2a'",
    '        n.textContent = String(r.tool || ' + q('') + ') + ' + q(' · ') + ' + String(r.name || ' + q('') + ') + ' + q(':') + ' + String(r.code || ' + q('') + ')',
    '        line.appendChild(t)',
    '        line.appendChild(n)',
    '        if (r.message) {',
    "          var m = document.createElement('span')",
    "          m.style.color = '#868e96'",
    '          m.textContent = ' + q(' ') + ' + String(r.message).slice(0, 60)',
    '          line.appendChild(m)',
    '        }',
    '        box.appendChild(line)',
    '      })',
    '    }).catch(function (e) {',
    "      if (box) box.textContent = '读取失败：' + e",
    '    })',
    '  }',
    '  function bindToolErrCard() {',
    "    var card = panel ? panel.querySelector('#dk-tool-card') : null",
    '    if (card) card.style.cssText = ' + q('margin:6px 0;padding:8px 10px;background:#fff4f4;border:1px solid #ffc9c9;border-radius:8px;font-size:12px') + '',
    "    var b = panel ? panel.querySelector('#dk-tool-reflog') : null",
    '    if (b) {',
    "      b.style.cssText = 'font-size:11px;padding:1px 8px;margin-left:6px'",
    '      b.onclick = function () { loadToolErrors() }',
    '    }',
    "    var box = panel ? panel.querySelector('#dk-tool-recent') : null",
    "    if (box) box.style.cssText = 'color:#555;line-height:1.6;max-height:140px;overflow:auto;margin-top:4px'",
    '    loadToolErrors()',
    '  }',
  ]);
}

function runFile(file, plan, backup, label) {
  if (!existsSync(file)) {
    console.error('找不到 ' + file);
    process.exit(1);
  }
  if (MODE === 'revert') {
    if (!existsSync(backup)) {
      console.error('没有备份，无法回滚：' + backup);
      process.exit(1);
    }
    copyFileSync(backup, file);
    console.log('已回滚 ' + file);
    return;
  }
  const raw = readFileSync(file, 'utf8');
  const eol = eolOf(raw);
  const src = raw.split(CR).join('').split(LF).join(eol);

  announce(label, IS_LIVE);
  let out = src;
  let bad = 0;
  for (const p of plan) {
    const [o, n, name, occ] = p;
    if (!o) {
      console.log('  · ' + name);
      continue;
    }
    const count = src.split(o).length - 1;
    const want = Number.isInteger(occ) ? occ : null;
    if (want === null && count !== 1) {
      console.log('  ✗ 锚点不唯一（' + count + '）：' + name);
      bad += 1;
      continue;
    }
    if (want !== null && count <= want) {
      console.log('  ✗ 锚点出现次数不足（' + count + ' <= ' + want + '）：' + name);
      bad += 1;
      continue;
    }
    if (MODE === 'apply') {
      if (want === null) out = out.replace(o, n);
      else {
        let from = -1;
        for (let k = 0; k <= want; k += 1) from = out.indexOf(o, from + 1);
        out = out.slice(0, from) + n + out.slice(from + o.length);
      }
      console.log('  ✓ ' + name);
    } else {
      console.log('  ○ 可打：' + name);
    }
  }

  if (MODE === 'check') {
    console.log(bad ? '存在未匹配锚点' : '检查完成（加 --apply 落盘）');
    if (bad) process.exit(1);
    return;
  }
  if (bad) {
    console.error('有锚点没匹配，放弃写入 ' + file);
    process.exit(1);
  }
  if (MODE === 'apply') {
    if (!existsSync(backup)) {
      copyFileSync(file, backup);
      console.log('已备份 → ' + backup);
    }
    writeFileSync(file, out, 'utf8');
    console.log('已写入 ' + file + '（' + out.length + ' 字符）');
  }
}

// ---- 服务端 ----
{
  const raw = existsSync(SERVER) ? readFileSync(SERVER, 'utf8') : '';
  const plan = [];
  if (raw.includes('tool-errors')) plan.push(['', null, '服务端路由（已存在）']);
  else {
    const anchor = "  route(ctx, 'GET', '/api/qqbot-settings/memory',";
    plan.push([anchor, buildRoute() + LF + anchor, 'settings-host 加 /tool-errors 路由']);
  }
  runFile(SERVER, plan, BACKUP_S, 'settings-host.js');
}

// ---- 客户端 ----
{
  const raw = existsSync(CLIENT) ? readFileSync(CLIENT, 'utf8') : '';
  const plan = [];
  const anchorCard = '        return html';
  const anchorCardBlock = L([
    '        html += ' + q('<div id=dk-tool-card>'),
    '          + ' + q('<div><b>🛠 最近工具报错（只在面板看，不发群）</b> '),
    '          + ' + q('<button class=dk-btn id=dk-tool-reflog>🔄 刷新</button></div>'),
    '          + ' + q('<div id=dk-tool-recent>（加载中…）</div>'),
    '          + ' + q('</div>'),
    '        return html',
  ]);
  const anchorFn = '  function applyModelDir(dir) {';
  const anchorBind = '      bindExtCard()   // ★ 本机新增(2026-10-23): 本地代答 / 语音 面板卡片 —— U4 读配置 / 保存 / 显示服务状态';
  if (raw.includes('dk-tool-recent')) plan.push(['', null, '卡片（已存在）']);
  else plan.push([anchorCard, anchorCardBlock, 'extCardHtml 里加「最近工具报错」卡片', 0]);
  if (raw.includes('function loadToolErrors()')) plan.push(['', null, 'loadToolErrors（已存在）']);
  else plan.push([anchorFn, buildLoadFn() + LF + anchorFn, '加 loadToolErrors/bindToolErrCard']);
  if (raw.includes('bindToolErrCard()')) plan.push(['', null, '调用（已存在）']);
  else plan.push([anchorBind, anchorBind + LF + '      bindToolErrCard()', '加载完追加 bindToolErrCard()']);
  runFile(CLIENT, plan, BACKUP_C, 'client/qqbot-settings.js');
}
