#!/usr/bin/env node
/**
 * fix-tier-manual.mjs —— 特别关心：能自己加，也能从「眼熟的人」一键加
 *
 * 主人 2026-10-25：希望印象卡/群聊能设「特别关心」，或特别关心里可以自行添加。
 * 现状：群等级段只列"有聊天记录的群"，没法手填；人也没地方设（c2c 本来就是完整档，
 * 但普通群里遇到某个人时不会给完整卡 + 不召回）。
 *
 * 本补丁（纯新增，不改原有行）在记忆页加一段「⭐ 特别关心（自行添加）」：
 *   · 群 openid 输入框 + 「＋ 加入特别关心群」→ POST set-tier (priority)
 *   · 人 openid 输入框 + 「＋ 加入特别关心的人」→ POST set-person-tier (priority)
 *   · 当前名单（群/人）以 chips 列出，点 × 移除
 *   · 「眼熟的人」列表（d.familiarity 里已有画像的人）点 ☆ 一键加入
 * 后端：group-tiers.mjs 的 priorityPeople + hooks/memory-panel.mjs 的 set-person-tier
 * + inbound/aa-memory-recall.mjs 里"普通群遇到特别关心的人 → 按 priority 档"。
 *
 * 用法：
 *   node qqbot-mod/patches/fix-tier-manual.mjs --check
 *   node qqbot-mod/patches/fix-tier-manual.mjs --apply
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLUGIN, GENERATION, announce } from './plugin-dir.mjs';

const APPLY = process.argv.includes('--apply');
const CLIENT = join(PLUGIN, 'client', 'qqbot-settings.js');

announce('fix-tier-manual');
console.log(`  目标: ${PLUGIN}${GENERATION ? ` · generation ${GENERATION}` : ''}`);

const MARK = '[qqbot-mod] tier-manual';
const raw = readFileSync(CLIENT, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
let src = eol === '\r\n' ? raw.split('\r\n').join('\n') : raw;

if (src.includes(MARK)) { console.log('  = 已是最新，无需写入'); process.exit(0); }

// ── A. UI 段：插在「批量回复门槛」段之前（ASCII 锚点，稳） ──
const UI_ANCHOR = '        var scopesAll = d.stats.scopes || []';
if (src.split(UI_ANCHOR).length - 1 !== 1) throw new Error('UI 锚点不唯一或缺失');

const UI = `        // ${MARK}（2026-10-25 主人：印象卡/群聊要能设特别关心，名单可自行添加）
        try {
          var _priG = (tiers.priority || []).slice()
          var _priP = (tiers.priorityPeople || []).slice()
          var _fam = (d.familiarity || []).slice(0, 16)
          var _sInner = '<div style="font-size:11px;color:#555;line-height:1.8">'
            + '<div>特别关心群：<input id="dk-tier-group" placeholder="群 openid（可粘贴 group:xxx）" style="font-size:11px;width:58%">'
            + ' <button class="dk-btn" id="dk-tier-add-group" style="padding:0 6px;height:20px;font-size:10px">＋ 加入</button></div>'
            + '<div>特别关心的人：<input id="dk-tier-person" placeholder="QQ openid（普通群里也按完整档）" style="font-size:11px;width:58%">'
            + ' <button class="dk-btn" id="dk-tier-add-person" style="padding:0 6px;height:20px;font-size:10px">＋ 加入</button></div>'
            + '<div style="font-size:10px;color:#aaa">多个用逗号/空格分隔；群号与 openid 都收（group: 前缀会去掉）。<span id="dk-tier-hint" style="color:#2f9e44"></span></div>'
          function _chip(id, kind, label) {
            return '<span style="display:inline-block;margin:2px 4px 2px 0;font-size:10px;border:1px solid #ffd8a8;background:#fff8f0;border-radius:8px;padding:1px 6px">'
              + esc(label) + ' <a data-tier-del="' + esc(id) + '" data-kind="' + kind + '" style="color:#c92a2a;text-decoration:none;cursor:pointer">×</a></span>'
          }
          _sInner += '<div style="margin-top:4px"><b style="color:#e8590c">群名单</b>：'
            + (_priG.length ? _priG.map(function (g) { var s = String(g); return _chip(s, 'group', s.replace(/^group:/, '').slice(0, 16)) }).join('') : '<span style="color:#999">（空）</span>') + '</div>'
          _sInner += '<div><b style="color:#e8590c">人名单</b>：'
            + (_priP.length ? _priP.map(function (p) { var s = String(p); return _chip(s, 'person', s.slice(0, 12)) }).join('') : '<span style="color:#999">（空）</span>') + '</div>'
          if (_fam.length) {
            _sInner += '<div style="margin-top:4px;color:#666">眼熟的人（点 ☆ 一键加入）：</div>'
            _sInner += _fam.map(function (f) {
              var sid = String(f.senderId || '')
              if (!sid) return ''
              var on = _priP.indexOf(sid) >= 0
              return '<span style="display:inline-block;margin:2px 4px 2px 0;font-size:10px;border:1px dashed #ffe0b2;border-radius:8px;padding:1px 6px">'
                + esc(String(f.note || sid).slice(0, 12))
                + ' <a data-person-star="' + esc(sid) + '" data-to="' + (on ? 'clear' : 'priority') + '" style="text-decoration:none;cursor:pointer;color:' + (on ? '#e8590c' : '#aaa') + '">' + (on ? '★' : '☆') + '</a></span>'
            }).join('')
          }
          _sInner += '</div>'
          h += memSection('⭐ 特别关心（自行添加）', _sInner, '即时生效', true)
        } catch (eTM) {}
`;

src = src.replace(UI_ANCHOR, UI + UI_ANCHOR);

// ── B. 事件绑定：插在批量门槛按钮绑定之前（ASCII 锚点） ──
const H_ANCHOR = "        var btApply = panel.querySelector('#dk-bt-apply')";
if (src.split(H_ANCHOR).length - 1 !== 1) throw new Error('事件锚点不唯一或缺失');

const H = `        // ${MARK}：自行添加 / 移除特别关心（群 + 人）
        try {
          function _tierPost(action, ids, tier) {
            memPost({ action: action, ids: ids, tier: tier }).then(function (r) {
              var hint = panel.querySelector('#dk-tier-hint')
              if (!r || !r.ok) { state.memErr = '设置失败：' + ((r && (r.reason || r.error)) || '接口没有返回'); paintBody(); return }
              if (hint) hint.textContent = '已保存'
              loadMemoryPanel(true)
            })
          }
          var _addG = panel.querySelector('#dk-tier-add-group')
          if (_addG) _addG.onclick = function () {
            var el = panel.querySelector('#dk-tier-group')
            var arr = String((el && el.value) || '').split(/[,，\\s]+/).map(function (x) { return x.replace(/^group:/, '').trim() }).filter(Boolean)
            if (!arr.length) { state.memErr = '先填群 openid'; paintBody(); return }
            _tierPost('set-tier', arr, 'priority')
          }
          var _addP = panel.querySelector('#dk-tier-add-person')
          if (_addP) _addP.onclick = function () {
            var el = panel.querySelector('#dk-tier-person')
            var arr = String((el && el.value) || '').split(/[,，\\s]+/).map(function (x) { return x.replace(/^(c2c:|group:)/, '').trim() }).filter(Boolean)
            if (!arr.length) { state.memErr = '先填 QQ openid'; paintBody(); return }
            _tierPost('set-person-tier', arr, 'priority')
          }
          Array.prototype.forEach.call(panel.querySelectorAll('[data-tier-del]'), function (a) {
            a.onclick = function () {
              var id = a.getAttribute('data-tier-del')
              var kind = a.getAttribute('data-kind') || 'group'
              _tierPost(kind === 'person' ? 'set-person-tier' : 'set-tier', [id], 'clear')
            }
          })
          Array.prototype.forEach.call(panel.querySelectorAll('[data-person-star]'), function (a) {
            a.onclick = function () {
              _tierPost('set-person-tier', [a.getAttribute('data-person-star')], a.getAttribute('data-to') || 'priority')
            }
          })
        } catch (eTB) {}
`;

src = src.replace(H_ANCHOR, H + H_ANCHOR);

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
