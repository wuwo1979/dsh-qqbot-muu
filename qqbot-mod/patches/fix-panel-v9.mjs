// fix-panel-v9.mjs —— 浮窗三处（主人 2026-10-27 反馈）
//   1) 「💠 联系方式」页的「⭐ 特别关心（群 / 人）」整块去掉（改回只在聊天页设）
//   2) 切页兜底升级：document 级捕获监听 + 渲染失败时的"应急切页页"（保证永远能切走）
//   3) 面板头部加一个构建号徽标，方便判断页面是不是旧的（需要 Ctrl+F5）
// 用法：node qqbot-mod/patches/fix-panel-v9.mjs [--check|--apply]
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const CLIENT = pluginPath('client/qqbot-settings.js');
const BUILD = '1027f';
const OPS = [];

// ① 去掉联系方式页的特别关心整块
const OLD_BLOCK_START = `        // [qqbot-mod] tier-unify：⭐ 特别关心（群 / 人）放一块，两类都能在这里 × 掉`;
const OLD_BLOCK_END = `        h += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:10px 0 2px">📇 QQ 联系方式</div>'`;
OPS.push({
  label: '联系方式页去掉特别关心块',
  fromTo: true,
  start: OLD_BLOCK_START,
  end: OLD_BLOCK_END,
  neu: OLD_BLOCK_END,
});

// ② 切页兜底：document 级捕获 + 应急页
const OLD_DELEG = `        // [qqbot-mod] panel-v8 tab-delegate：标签点击走一次性事件委托，bindBodyEvents 挂了也能切页
        try {
          if (!panel._dkTabDelegate) {
            panel._dkTabDelegate = true
            panel.addEventListener('click', function (ev) {
              var t = ev.target
              var btn = (t && t.closest) ? t.closest('.dk-tab button') : null
              if (!btn || !panel.contains(btn)) return
              var want = btn.getAttribute('data-t')
              if (!want || want === state.tab) return
              state.tab = want; state.msg = ''
              if (want === 'out') { try { loadOutMode() } catch (e) {} try { loadContact() } catch (e) {} }
              if (want === 'bili') { try { loadBiliLog() } catch (e) {} try { loadDrawInfo() } catch (e) {} }
              try { paintBody() } catch (e) {}
            })
          }
        } catch (eTD) {}`;
const NEW_DELEG = `        // [qqbot-mod] panel-v9 tab-delegate：document 级捕获监听（面板重渲染也不丢）+ 渲染失败给"应急切页页"
        try {
          if (!window.__dkTabDeleg) {
            window.__dkTabDeleg = true
            document.addEventListener('click', function (ev) {
              var t = ev.target
              if (!t || !t.closest) return
              var host = document.querySelector('#qqs-dock-panel')
              if (!host || !host.contains(t)) return
              var em = t.closest('[data-emt]')
              var btn = t.closest('.dk-tab button')
              var want = em ? em.getAttribute('data-emt') : (btn ? btn.getAttribute('data-t') : '')
              if (!want) return
              if (want === state.tab && !em) return
              state.tab = want; state.msg = ''
              try { if (want === 'out') { loadOutMode(); loadContact() } } catch (eO) {}
              try { if (want === 'bili') { loadBiliLog(); loadDrawInfo() } } catch (eB) {}
              try {
                paintBody()
              } catch (eP) {
                try { dkEmergencyTab(want, (eP && eP.message) || String(eP)) } catch (eE) {}
              }
            }, true)
          }
        } catch (eTD) {}
        // [qqbot-mod] panel-v9：构建号徽标（看不到这个号 = 页面还是旧的，Ctrl+F5）
        try {
          panel.setAttribute('data-qqs-build', '${BUILD}')
          var _hh = panel.querySelector('.dk-h')
          if (_hh && !_hh.querySelector('.qqs-build')) {
            var _bs = document.createElement('span')
            _bs.className = 'qqs-build'
            _bs.textContent = ' ${BUILD}'
            _bs.title = '浮窗客户端构建号（改完客户端要 Ctrl+F5 才会换）'
            _bs.style.cssText = 'font-size:9px;color:#bbb;margin-left:4px;font-weight:400'
            _hh.appendChild(_bs)
          }
        } catch (eBD) {}`;
OPS.push({ label: '切页兜底升级 + 构建号', old: OLD_DELEG, neu: NEW_DELEG });

// ③ 应急切页页（放在 paintBodyInner 之前，供 catch 调用）
const OLD_PAINT = `      function paintBodyInner() {`;
const NEW_PAINT = `      // [qqbot-mod] panel-v9：渲染炸了也给一排按钮，保证永远能切走
      function dkEmergencyTab(want, err) {
        var box = panel.querySelector('.dk-b')
        var tabs = [['chat', '💬 聊天'], ['memory', '🧠 记忆'], ['llm', '🖥 本地模型'], ['out', '💠 联系方式'], ['bili', '📺 B站'], ['games', '🎮 游戏'], ['send', '📇 群组']]
        var html = '<div class="dk-empty" style="line-height:1.9;white-space:normal">'
          + '<b>「' + esc(String(want || '')) + '」这块渲染出错了</b>（数据还在，不是丢了）<br>'
          + '<span style="color:#c92a2a;font-size:11px">' + esc(String(err || '').slice(0, 300)) + '</span>'
          + '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px">'
          + tabs.map(function (t) { return '<button class="dk-btn" data-emt="' + t[0] + '">' + t[1] + '</button>' }).join('')
          + '</div></div>'
        if (box) box.innerHTML = html
        else { try { panel.innerHTML = '<div class="dk-h"></div><div class="dk-b">' + html + '</div>'; dkEmergencyTab(want, err) } catch (e) {} }
      }
      function paintBodyInner() {`;
OPS.push({ label: '加应急切页页', old: OLD_PAINT, neu: NEW_PAINT });

const mode = process.argv.includes('--apply') ? 'apply' : 'check';
announce('浮窗 v9（去特别关心块 / 切页兜底 / 构建号）');
let src = readFileSync(CLIENT, 'utf8');
const crlf = src.includes('\r\n');
src = src.replace(/\r\n/g, '\n');
let hit = 0;
const miss = [];
for (const op of OPS) {
  const neu = op.neu.replace(/\$\{BUILD\}/g, BUILD);
  if (op.fromTo) {
    if (!src.includes(op.start)) { console.log('  = 已是新版：' + op.label); continue; }
    const i = src.indexOf(op.start);
    const j = src.indexOf(op.end, i);
    if (j < 0) { console.log('  ✗ 找不到块结尾：' + op.label); miss.push(op.label); continue; }
    src = src.slice(0, i) + neu + src.slice(j + op.end.length);
    hit++; console.log('  ✔ ' + op.label);
    continue;
  }
  if (src.includes(neu.slice(0, 220))) { console.log('  = 已是新版：' + op.label); continue; }
  if (!src.includes(op.old)) { console.log('  ✗ 找不到锚点：' + op.label); miss.push(op.label); continue; }
  src = src.replace(op.old, neu);
  hit++; console.log('  ✔ ' + op.label);
}
if (!hit) { console.log(miss.length ? '有锚点没命中' : '无需写入'); process.exit(miss.length ? 2 : 0); }
if (mode === 'check') { console.log(`\n[--check] ${hit} 处需要写入（加 --apply 生效）`); process.exit(0); }
copyFileSync(CLIENT, CLIENT + '.orig-muu-v9');
writeFileSync(CLIENT, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');
try {
  execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'pipe' });
  console.log(`\n✔ 已写入 ${CLIENT}（${src.length} 字符，语法通过）`);
} catch (e) {
  copyFileSync(CLIENT + '.orig-muu-v9', CLIENT);
  console.log('✗ 语法检查失败，已回滚：' + String(e.stderr || e.message).slice(0, 400));
  process.exit(3);
}
