// fix-tier-unify.mjs —— 特别关心：群 + 私聊 归到一处，聊天页一键设/取消（主人 2026-10-27 要求）
//   1) 聊天页头部按钮：群 / 私聊 都能一键设/取消（原来只认群）
//   2) 「💠 联系方式」页顶部加一块「⭐ 特别关心（群 / 人）」，两类放一起、可 × 移除
// 用法：node qqbot-mod/patches/fix-tier-unify.mjs [--check|--apply]
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const CLIENT = pluginPath('client/qqbot-settings.js');
const MARK = '[qqbot-mod] tier-unify';

const OPS = [];

// ── 1. 按钮文案改成通用 ────────────────────────────────────────────────
OPS.push({
  label: '按钮文案通用化',
  old: `+ '<button class="dk-btn" id="dk-chat-grouptier" style="display:none" title="当前群一键设/取消特别关心（即时生效）">☆ 特别关心</button>'`,
  neu: `+ '<button class="dk-btn" id="dk-chat-grouptier" style="display:none" title="当前会话一键设/取消特别关心（群或私聊，即时生效）">☆ 特别关心</button>'`,
});

// ── 2. 状态同步：群 / 私聊 共用 ───────────────────────────────────────
const OLD_SYNC = `        var syncGroupTierBtn = function () {
          var gt = panel.querySelector('#dk-chat-grouptier')
          if (!gt) return
          var isGroup = state.sendScope !== 'c2c' && !!state.gid
          gt.style.display = isGroup ? '' : 'none'
          if (!isGroup) return
          var pri = ((state.memPanel || {}).tiers || {}).priority || []
          var on = pri.indexOf(String(state.gid)) >= 0 || pri.indexOf('group:' + state.gid) >= 0
          gt.textContent = on ? '⭐ 已特别关心' : '☆ 特别关心'
          gt.style.color = on ? '#e8590c' : ''
        }`;
const NEW_SYNC = `        // [qqbot-mod] tier-unify：群 + 私聊 共用一套判断（私聊看 priorityPeople）
        var tierTargetOf = function () {
          var isC2c = state.sendScope === 'c2c'
          var id = isC2c ? String(state.sendTo || '') : String(state.gid || '')
          var tiers = (state.memPanel || {}).tiers || {}
          var list = isC2c ? (tiers.priorityPeople || []) : (tiers.priority || [])
          var on = !!id && (list.indexOf(id) >= 0 || list.indexOf((isC2c ? 'c2c:' : 'group:') + id) >= 0)
          return { kind: isC2c ? 'person' : 'group', id: id, on: on }
        }
        var syncGroupTierBtn = function () {
          var gt = panel.querySelector('#dk-chat-grouptier')
          if (!gt) return
          var t = tierTargetOf()
          gt.style.display = t.id ? '' : 'none'
          if (!t.id) return
          gt.textContent = t.on ? '⭐ 已特别关心' : '☆ 特别关心'
          gt.style.color = t.on ? '#e8590c' : ''
          gt.title = (t.kind === 'person' ? '这个人' : '这个群') + '一键设/取消特别关心（即时生效）'
        }`;
OPS.push({ label: '状态同步支持私聊', old: OLD_SYNC, neu: NEW_SYNC });

// ── 3. 点击：按 kind 分派 set-tier / set-person-tier ───────────────────
const OLD_CLICK = `        var gtBtn = panel.querySelector('#dk-chat-grouptier')
        if (gtBtn) gtBtn.onclick = function () {
          if (!state.gid) { state.msg = '先选一个群'; paintBody(); return }
          var pri = ((state.memPanel || {}).tiers || {}).priority || []
          var on = pri.indexOf(String(state.gid)) >= 0 || pri.indexOf('group:' + state.gid) >= 0
          gtBtn.disabled = true
          memPost({ action: 'set-tier', ids: [state.gid], tier: on ? 'normal' : 'priority' }).then(function (r) {
            gtBtn.disabled = false
            if (!r || !r.ok) { state.msg = '设置失败：' + ((r && r.error) || '接口没有返回'); paintBody(); return }
            if (r.tiers) state.memPanel = Object.assign({}, state.memPanel || {}, { tiers: r.tiers })
            else loadMemoryPanel(true)
            state.msg = on ? '已取消该群的特别关心' : '已设为特别关心群'
            paintBody()
          })
        }`;
const NEW_CLICK = `        var gtBtn = panel.querySelector('#dk-chat-grouptier')
        if (gtBtn) gtBtn.onclick = function () {
          var t = tierTargetOf()
          if (!t.id) { state.msg = t.kind === 'person' ? '先在下面选一个私聊对象' : '先选一个群'; paintBody(); return }
          gtBtn.disabled = true
          var payload = t.kind === 'person'
            ? { action: 'set-person-tier', ids: [t.id], tier: t.on ? 'clear' : 'priority' }
            : { action: 'set-tier', ids: [t.id], tier: t.on ? 'normal' : 'priority' }
          memPost(payload).then(function (r) {
            gtBtn.disabled = false
            if (!r || !r.ok) { state.msg = '设置失败：' + ((r && r.error) || '接口没有返回'); paintBody(); return }
            if (r.tiers) state.memPanel = Object.assign({}, state.memPanel || {}, { tiers: r.tiers })
            else loadMemoryPanel(true)
            state.msg = t.kind === 'person'
              ? (t.on ? '已取消这个人的特别关心' : '已把这个人设为特别关心')
              : (t.on ? '已取消该群的特别关心' : '已设为特别关心群')
            paintBody()
          })
        }`;
OPS.push({ label: '点击分派群/人', old: OLD_CLICK, neu: NEW_CLICK });

// ── 4. 联系方式页：群和人的特别关心放一起 ─────────────────────────────
const OLD_CONTACT_HEAD = `        h += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:10px 0 2px">📇 QQ 联系方式</div>'`;
const NEW_CONTACT_HEAD = `        // [qqbot-mod] tier-unify：⭐ 特别关心（群 / 人）放一块，两类都能在这里 × 掉
        var _pg = (q.groups || []).filter(function (x) { return x.priority })
        var _pp = (q.people || []).filter(function (x) { return x.priority })
        h += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:10px 0 2px;gap:8px;align-items:center">'
          + '<span>⭐ 特别关心（群 / 人）</span>'
          + '<span class="dk-msg" style="font-size:10px;color:#999">在「💬 聊天」页点 ☆ 也能直接加/取消</span></div>'
        if (!_pg.length && !_pp.length) {
          h += '<div style="font-size:11px;color:#999">还没有特别关心。去聊天页，把正在看的群或人选上 ⭐ 就行。</div>'
        } else {
          h += '<div id="dk-tier-unified" style="display:flex;flex-wrap:wrap;gap:4px;font-size:11px">'
          _pg.forEach(function (g) {
            h += '<span class="dk-tier-chip">⭐ ' + esc(g.name || g.id)
              + ' <span style="color:#aaa;font-size:10px">群</span>'
              + ' <a href="javascript:void 0" data-udel="1" data-kind="group" data-id="' + esc(String(g.id || '')) + '" style="color:#c92a2a;text-decoration:none">×</a></span>'
          })
          _pp.forEach(function (p) {
            h += '<span class="dk-tier-chip">⭐ ' + esc(p.name || p.id || '（未命名）')
              + ' <span style="color:#aaa;font-size:10px">人</span>'
              + ' <a href="javascript:void 0" data-udel="1" data-kind="person" data-id="' + esc(String(p.id || '')) + '" style="color:#c92a2a;text-decoration:none">×</a></span>'
          })
          h += '</div>'
        }
        h += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:10px 0 2px">📇 QQ 联系方式</div>'`;
OPS.push({ label: '联系方式页合并特别关心', old: OLD_CONTACT_HEAD, neu: NEW_CONTACT_HEAD });

// ── 5. 联系方式页 × 移除的处理器 ──────────────────────────────────────
const OLD_FN = `      function contactHtml() {`;
const NEW_FN = `      // [qqbot-mod] tier-unify：联系方式页 × 掉一条特别关心
      function dkTierUnifiedDel(kind, id) {
        if (!id) return
        var payload = kind === 'person'
          ? { action: 'set-person-tier', ids: [id], tier: 'clear' }
          : { action: 'set-tier', ids: [id], tier: 'clear' }
        memPost(payload).then(function (r) {
          if (r && r.ok) { if (r.tiers) state.memPanel = Object.assign({}, state.memPanel || {}, { tiers: r.tiers }); loadContact() }
          else state.msg = '取消失败：' + ((r && r.error) || '接口没有返回')
          paintBody()
        })
      }
      function dkBindTierUnified() {
        var box = panel.querySelector('#dk-tier-unified')
        if (!box || box._dkU) return
        box._dkU = 1
        box.addEventListener('click', function (ev) {
          var a = ev.target && ev.target.closest ? ev.target.closest('[data-udel="1"]') : null
          if (!a) return
          ev.preventDefault()
          dkTierUnifiedDel(a.getAttribute('data-kind') || 'group', a.getAttribute('data-id') || '')
        })
      }
      function contactHtml() {`;
OPS.push({ label: '加 × 移除处理器', old: OLD_FN, neu: NEW_FN });

// ── 6. bindContact 里绑上 × 处理器 ────────────────────────────────────
OPS.push({
  label: 'bindContact 绑定 × 处理器',
  old: `      function bindContact() {\n        var rb = panel.querySelector('#dk-contact-reload')`,
  neu: `      function bindContact() {\n        try { dkBindTierUnified() } catch (eU) {}\n        var rb = panel.querySelector('#dk-contact-reload')`,
});

const mode = process.argv.includes('--apply') ? 'apply' : 'check';
announce('特别关心：群 + 私聊 归一处');
let src = readFileSync(CLIENT, 'utf8');
const crlf = src.includes('\r\n');
src = src.replace(/\r\n/g, '\n');
let hit = 0;
let changed = false;
for (const op of OPS) {
  if (src.includes(op.neu)) { console.log('  = 已是新版：' + op.label); continue; }
  if (!src.includes(op.old)) {
    if (op.optional) { console.log('  - 跳过：' + op.label); continue; }
    console.log('  ✗ 找不到锚点：' + op.label); process.exitCode = 2; continue;
  }
  src = src.replace(op.old, op.neu);
  hit++; changed = true;
  console.log('  ✔ ' + op.label);
}
// 联系方式页渲染完顺手绑定一次（挂在 loadContact 的成功回调里，找不到就跳过）
const bindAnchor = `      function loadContact(refresh) {`;
if (src.includes(bindAnchor) && !src.includes('dkBindTierUnified();\n')) {
  const idx = src.indexOf(bindAnchor);
  const tail = src.indexOf('\n      }', idx);
  if (tail > 0) {
    const seg = src.slice(idx, tail);
    if (!seg.includes('dkBindTierUnified')) {
      src = src.slice(0, tail) + '\n        try { dkBindTierUnified() } catch (eU) {}' + src.slice(tail);
      hit++; changed = true;
      console.log('  ✔ loadContact 成功回调里绑定 × 处理器');
    }
  }
}
if (!changed) { console.log('无需写入'); process.exit(process.exitCode || 0); }
if (mode === 'check') { console.log(`\n[--check] ${hit} 处需要写入（加 --apply 生效）`); process.exit(process.exitCode || 0); }
copyFileSync(CLIENT, CLIENT + '.orig-muu-tierunify');
writeFileSync(CLIENT, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');
try {
  execFileSync(process.execPath, ['--check', CLIENT], { stdio: 'pipe' });
  console.log(`\n✔ 已写入 ${CLIENT}（${src.length} 字符，语法检查通过）`);
} catch (e) {
  copyFileSync(CLIENT + '.orig-muu-tierunify', CLIENT);
  console.log('✗ 语法检查失败，已回滚：' + String(e.stderr || e.message).slice(0, 400));
  process.exit(3);
}
