#!/usr/bin/env node
/**
 * fix-tier-v2.mjs —— 特别关心 v2（2026-10-25 主人要求）
 *
 * 问题：
 *   1) 原来的「特别关心」输入框只收 openid，chips 也印着 openid 片段 —— 主人不想看到 openid；
 *   2) 想让"群号 / QQ 号"能加，但 QQ 官方机器人接口只给 openid，本地没有 号→openid 的映射；
 *   3) 想在聊天板块里对某个人直接「加/移除特别关心」；
 *   4) 聊天板块按钮多、挤占内容。
 *
 * 做法：
 *   · UI 只显示名字（群名来自 .qqbot/groups.json，人名来自 msg-history 台账的 n），查不到才退化成 #后四位；
 *   · 输入框按「群名 / 昵称 / openid」任意一种解析（后端 resolveTierTargets），解析失败给出人话提示；
 *   · 候选区直接点 ⭐ 加入/取消，聊天每条消息旁也有 ⭐；
 *   · 新增 DOCK_CSS8：收紧聊天行、给 ⭐ 与候选 chip 上样式。
 *
 * 用法：node qqbot-mod/patches/fix-tier-v2.mjs [--check|--apply]
 *   --check  只报告锚点命中情况（默认）
 *   --apply  写盘（写前备份 <file>.orig-muu，写后 node --check，失败回滚）
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PLUGIN } from './plugin-dir.mjs';

const CLIENT = PLUGIN + '/client/qqbot-settings.js';
const HOST = PLUGIN + '/settings-host.js';

const MARK = '[qqbot-mod] tier-v2';

// ── 1. host：chatLogItems 的 item 带上 sid（聊天行 ⭐ 需要知道是谁），并把"n 就是 openid"的行改成中性称呼
const HOST_OLD = `        out.push({
          seq: 0,
          time: t,
          dir: dir2,
          sender: String(o.n || o.s || (dir2 === 'out' ? '' : '群友')),`;
const HOST_NEW = `        out.push({
          seq: 0,
          time: t,
          dir: dir2,
          // ${MARK}：带上发送者 id，聊天行才能一键加「特别关心」；昵称兜底但不把 openid 当名字用
          sid: String(o.s || ''),
          sender: (function (_n, _s) {
            if (!_n || _n === _s || /^[0-9A-Fa-f]{32}$/.test(_n)) return dir2 === 'out' ? '' : '群友'
            return _n
          })(String(o.n || ''), String(o.s || '')),`;

// ── 2. client：CSS8（聊天密度 + ⭐ + 候选 chip）
const CSS_ANCHOR = 'try { ensureDockCss7() } catch (e) {}';
const CSS_NEW = `${CSS_ANCHOR}
// ${MARK}：聊天板块密度 + 特别关心 ⭐ / 候选 chip（主人：按钮太多把内容挤没了）
var DOCK_CSS8 = "#qqs-dock-panel .dk-crow{padding:5px 8px;gap:6px}\\n" +
  "#qqs-dock-panel .dk-cbubble{font-size:12.5px;line-height:1.55}\\n" +
  "#qqs-dock-panel .dk-cmeta{font-size:10px;gap:4px;flex-wrap:wrap}\\n" +
  "#qqs-dock-panel .dk-ava{width:26px;height:26px;line-height:26px;font-size:15px}\\n" +
  "#qqs-dock-panel .dk-star{cursor:pointer;text-decoration:none;color:#adb5bd;font-size:12px;margin-left:2px;user-select:none}\\n" +
  "#qqs-dock-panel .dk-star.on{color:#f08c00}\\n" +
  "#qqs-dock-panel .dk-tier-chip{display:inline-block;margin:2px 4px 2px 0;font-size:10px;border:1px solid #ffd8a8;background:#fff8f0;border-radius:8px;padding:1px 6px}\\n" +
  "#qqs-dock-panel .dk-tier-chip a{text-decoration:none;cursor:pointer}\\n" +
  "#qqs-dock-panel .dk-tier-cand{display:inline-block;margin:2px 4px 2px 0;font-size:10px;border:1px dashed #ffe0b2;border-radius:8px;padding:1px 6px;cursor:pointer;user-select:none}\\n" +
  "#qqs-dock-panel .dk-tier-cand.on{border-style:solid;border-color:#ffc078;background:#fff4e6;color:#e8590c}"
function ensureDockCss8() {
  if (document.getElementById('qqs-dock-css8')) return
  var st = document.createElement('style')
  st.id = 'qqs-dock-css8'
  st.textContent = DOCK_CSS8
  ;(document.head || document.documentElement).appendChild(st)
}
try { ensureDockCss8() } catch (e) {}`;

// ── 3. client：特别关心 UI（名字化 + 候选 + 说明）
const UI_START = '// [qqbot-mod] tier-manual（2026-10-25 主人：印象卡/群聊要能设特别关心，名单可自行添加）';
const UI_END = '} catch (eTM) {}';
const UI_NEW = `// ${MARK}：特别关心只露名字，不露 openid；群名 / 昵称 / openid 都能加，候选点一下就行
        try {
          var _priG2 = (tiers.priority || []).map(function (x) { return String(x).replace(/^group:/, '') })
          var _priP2 = (tiers.priorityPeople || []).map(function (x) { return String(x).replace(/^c2c:/, '') })
          var _tnG = ((d.tierNames || {}).group) || {}
          var _tnP = ((d.tierNames || {}).person) || {}
          var _candG = ((d.tierCandidates || {}).groups) || []
          var _candP = ((d.tierCandidates || {}).people) || []
          var _nmOf = function (kind, id) {
            var sid = String(id).replace(/^(group:|c2c:)/, '')
            var m = kind === 'group' ? _tnG[sid] : _tnP[sid]
            return m || ('#' + sid.slice(-4))
          }
          var _chip2 = function (id, kind) {
            return '<span class="dk-tier-chip">' + esc(_nmOf(kind, id))
              + ' <a data-tier-del="' + esc(String(id)) + '" data-kind="' + kind + '" style="color:#c92a2a">×</a></span>'
          }
          var _sInner = '<div style="font-size:11px;color:#555;line-height:1.9">'
          _sInner += '<div><b style="color:#e8590c">特别关心的群</b>：'
            + (_priG2.length ? _priG2.map(function (g) { return _chip2(g, 'group') }).join('') : '<span style="color:#999">（空）</span>') + '</div>'
          _sInner += '<div><b style="color:#e8590c">特别关心的人</b>：'
            + (_priP2.length ? _priP2.map(function (p) { return _chip2(p, 'person') }).join('') : '<span style="color:#999">（空）</span>') + '</div>'
          _sInner += '<div style="margin-top:4px">加群：<input id="dk-tier-group" placeholder="群名，例如 相亲相爱一家人" style="font-size:11px;width:52%">'
            + ' <button class="dk-btn" id="dk-tier-add-group" style="padding:0 6px;height:20px;font-size:10px">＋ 加入</button></div>'
          _sInner += '<div>加人：<input id="dk-tier-person" placeholder="昵称，例如 爸爸" style="font-size:11px;width:52%">'
            + ' <button class="dk-btn" id="dk-tier-add-person" style="padding:0 6px;height:20px;font-size:10px">＋ 加入</button></div>'
          if (_candG.length) {
            _sInner += '<div style="margin-top:3px;color:#666">见过的群（点一下加/取消）：</div>'
            _sInner += _candG.map(function (g) {
              return '<span class="dk-tier-cand' + (g.on ? ' on' : '') + '" data-person-star="' + esc(g.id) + '" data-kind="group">'
                + (g.on ? '★ ' : '☆ ') + esc(g.name) + '</span>'
            }).join('')
          }
          if (_candP.length) {
            _sInner += '<div style="margin-top:3px;color:#666">说过话的人（点一下加/取消）：</div>'
            _sInner += _candP.map(function (p) {
              return '<span class="dk-tier-cand' + (p.on ? ' on' : '') + '" data-person-star="' + esc(p.id) + '" data-kind="person">'
                + (p.on ? '★ ' : '☆ ') + esc(p.name) + '</span>'
            }).join('')
          }
          _sInner += '<div style="font-size:10px;color:#aaa;margin-top:3px">'
            + '群号 / QQ 号官方接口不给（只给 openid），所以这里按<b>群名 / 昵称</b>认人；聊天板块每条消息旁的 ☆ 也能直接加。'
            + '<span id="dk-tier-hint" style="color:#2f9e44"></span></div>'
          h += memSection('⭐ 特别关心', _sInner, '即时生效', true)
        } catch (eTM) {}`;

// ── 4. client：事件（按名字加 + 委托处理候选/聊天行 ⭐）
const EV_START = '// [qqbot-mod] tier-manual：自行添加 / 移除特别关心（群 + 人）';
const EV_END = '} catch (eTB) {}';
const EV_NEW = `// ${MARK}：按名字加、候选与聊天行 ⭐ 用事件委托（重渲染不丢绑定）
        try {
          var _tierAsk = function (action, payload) {
            var body = { action: action }
            for (var k in payload) body[k] = payload[k]
            return memPost(body)
          }
          var _afterTier = function (r, okText) {
            var hint = panel.querySelector('#dk-tier-hint')
            if (!r || !r.ok) {
              state.memErr = '没加成：' + ((r && (r.reason || r.error)) || '接口没有返回')
              paintBody()
              return false
            }
            if (hint) hint.textContent = okText || '已保存'
            loadMemoryPanel(true)
            return true
          }
          var _addG2 = panel.querySelector('#dk-tier-add-group')
          if (_addG2) _addG2.onclick = function () {
            var el = panel.querySelector('#dk-tier-group')
            var txt = String((el && el.value) || '').trim()
            if (!txt) { state.memErr = '先填群名（或者从下面的候选里点）'; paintBody(); return }
            _tierAsk('add-tier-by-name', { kind: 'group', text: txt }).then(function (r) { _afterTier(r, '已加入群名单') })
          }
          var _addP2 = panel.querySelector('#dk-tier-add-person')
          if (_addP2) _addP2.onclick = function () {
            var el = panel.querySelector('#dk-tier-person')
            var txt = String((el && el.value) || '').trim()
            if (!txt) { state.memErr = '先填昵称（或者从下面的候选里点）'; paintBody(); return }
            _tierAsk('add-tier-by-name', { kind: 'person', text: txt }).then(function (r) { _afterTier(r, '已加入人名单') })
          }
          if (!panel._tierV2Bound) {
            panel._tierV2Bound = 1
            panel.addEventListener('click', function (ev) {
              var t = ev.target
              var node = t
              for (var i = 0; i < 6 && node && node !== panel; i++) {
                if (node.getAttribute) {
                  var del = node.getAttribute('data-tier-del')
                  if (del) {
                    var kind = node.getAttribute('data-kind') || 'group'
                    ev.preventDefault()
                    _tierAsk(kind === 'person' ? 'set-person-tier' : 'set-tier', { ids: [del], tier: 'clear' })
                      .then(function (r) { _afterTier(r, '已移除') })
                    return
                  }
                  var star = node.getAttribute('data-person-star') || node.getAttribute('data-chat-star')
                  if (star) {
                    var k2 = node.getAttribute('data-kind') || (node.getAttribute('data-chat-star') ? 'person' : 'group')
                    var on = node.getAttribute('data-on') === '1'
                      || node.className.indexOf(' on') >= 0
                      || node.textContent.indexOf('★') >= 0
                    ev.preventDefault()
                    _tierAsk(k2 === 'group' ? 'set-tier' : 'set-person-tier', { ids: [star], tier: on ? 'clear' : 'priority' })
                      .then(function (r) {
                        if (!r || !r.ok) { _afterTier(r); return }
                        var hint = panel.querySelector('#dk-tier-hint')
                        if (hint) hint.textContent = on ? '已取消特别关心' : '已设为特别关心'
                        if (node.getAttribute('data-chat-star')) {
                          node.textContent = on ? '☆' : '★'
                          node.className = 'dk-star' + (on ? '' : ' on')
                        } else {
                          node.className = 'dk-tier-cand' + (on ? '' : ' on')
                          node.textContent = (on ? '☆ ' : '★ ') + String(node.textContent || '').replace(/^[★☆]\s*/, '')
                        }
                      })
                    return
                  }
                }
                node = node.parentNode
              }
            })
          }
        } catch (eTB) {}`;

// ── 5. client：聊天行加 ⭐
const ROW_OLD = `          var meta = '<span>' + esc(who) + '</span>'`;
const ROW_NEW = `          var meta = '<span>' + esc(who) + '</span>'
            // ${MARK}：这条是谁说的 → 一键加/取消「特别关心」
            + (!isOut && it.sid
              ? '<a class="dk-star" data-chat-star="' + esc(String(it.sid)) + '" data-kind="person" data-on="0" title="特别关心（加/取消）">☆</a>'
              : '')`;

const OPS = [
  { name: 'host-item-sid', file: HOST, kind: 'replace', old: HOST_OLD, neu: HOST_NEW },
  { name: 'css8', file: CLIENT, kind: 'replace', old: CSS_ANCHOR, neu: CSS_NEW },
  { name: 'tier-ui', file: CLIENT, kind: 'block', start: UI_START, end: UI_END, neu: UI_NEW },
  { name: 'tier-events', file: CLIENT, kind: 'block', start: EV_START, end: EV_END, neu: EV_NEW },
  {
    name: 'ev-cleanup',
    file: CLIENT,
    kind: 'replace',
    old: `              var t = ev.target
              var pick = function (n) { return n && n.getAttribute ? n.getAttribute(n.__x || '') : null }
              void pick
              var node = t`,
    neu: `              var t = ev.target
              var node = t`,
  },
  { name: 'chat-row-star', file: CLIENT, kind: 'replace', old: ROW_OLD, neu: ROW_NEW },
];

function norm(s) {
  return String(s).replace(/\r\n/g, '\n');
}
function denorm(s, crlf) {
  return crlf ? String(s).replace(/\n/g, '\r\n') : String(s);
}

function plan(files) {
  const byFile = new Map();
  const report = [];
  for (const op of OPS) {
    if (!byFile.has(op.file)) {
      const raw = readFileSync(op.file, 'utf8');
      byFile.set(op.file, { raw, crlf: raw.includes('\r\n'), src: norm(raw), changed: false });
    }
    const st = byFile.get(op.file);
    if (op.kind === 'replace') {
      if (st.src.includes(op.neu)) { report.push({ op: op.name, hit: true, note: '已是新版' }); continue }
      if (!st.src.includes(op.old)) { report.push({ op: op.name, hit: false, note: '锚点未命中' }); continue }
      st.src = st.src.replace(op.old, () => op.neu);
      st.changed = true;
      report.push({ op: op.name, hit: true, note: '替换' });
      continue;
    }
    // block：找到 start 行 → 该行所在 try { ... } 的结束 catch 行
    if (st.src.includes(op.neu)) { report.push({ op: op.name, hit: true, note: '已是新版' }); continue }
    if (!st.src.includes(op.start) && st.src.includes(MARK)) {
      report.push({ op: op.name, hit: true, note: '已是新版（标记在）' });
      continue;
    }
    const i0 = st.src.indexOf(op.start);
    if (i0 < 0) { report.push({ op: op.name, hit: false, note: '起始锚点未命中' }); continue; }
    const i1 = st.src.indexOf(op.end, i0);
    if (i1 < 0) { report.push({ op: op.name, hit: false, note: '结束锚点未命中' }); continue; }
    const tail = i1 + op.end.length;
    st.src = st.src.slice(0, i0) + op.neu + st.src.slice(tail);
    st.changed = true;
    report.push({ op: op.name, hit: true, note: '整块替换' });
  }
  return { byFile, report };
}

function main() {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const { byFile, report } = plan();

  for (const f of [CLIENT, HOST]) console.log('目标:', f);
  for (const r of report) console.log(`  ${r.hit ? '✔' : '✘'} ${r.op}  ${r.note}`);

  const need = [...byFile.entries()].filter(([, st]) => st.changed);
  if (!need.length) { console.log('\n结果: 已是最新，无需写入'); return; }

  if (!apply) {
    console.log(`\n结果: 需要写入 ${need.length} 个文件（加 --apply 落盘）`);
    return;
  }

  for (const [file, st] of need) {
    const bak = file + '.orig-muu';
    if (!existsSync(bak) || force) copyFileSync(file, bak);
    const out = denorm(st.src, st.crlf);
    writeFileSync(file, out, 'utf8');
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      console.log(`✔ 已写入 ${file}（备份 ${bak}）`);
    } catch (e) {
      writeFileSync(file, st.raw, 'utf8');
      console.error(`✘ 语法检查失败，已回滚 ${file}\n${String(e.stderr || e.message).slice(0, 800)}`);
      process.exitCode = 1;
    }
  }
}

main();
