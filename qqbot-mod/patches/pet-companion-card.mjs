#!/usr/bin/env node
/**
 * pet-companion-card.mjs —— 浮窗「🎮 游戏」标签 →「🐋 陪玩」，桌宠双形态面板（v2 2026-10-31）。
 *
 * v2（双形态）：主人定的规矩 —— DS 桌宠有「🐋 小蓝」和「🐟 普通大肥鱼(MuU)」两个形态，
 * 同一时刻桌面只显示一只（display 互斥，切换自动重启 helper 换角）。
 *   · 形态切换条：两颗按钮，点了 POST {action:'switch-form'}（hooks/pet-panel.mjs → lib/pet-anim.mjs）
 *   · 动作按钮按当前形态动态渲染（GET 返回 anims；小蓝 6 项 / 大肥鱼 6 项语义映射）
 *   · 视频预览走 pet-panel.mjs 的服务端代理 /api/qqbot-settings/pet-media（免 token，宿主侧注入）
 *   · 桌宠总开关按钮（pet-display on/off，2026-11-01 主人要求）
 *   （旧「群口令」链路已废弃，2026-10-31 主人拍板：动作只在浮窗/网页桌宠触发）
 *
 * 用法（先还原原版客户端再重打）：
 *   copy <gen>\client\qqbot-settings.js.orig-pet → qqbot-settings.js
 *   node qqbot-mod/patches/pet-companion-card.mjs --check
 *   node qqbot-mod/patches/pet-companion-card.mjs --apply
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const REL = 'client/qqbot-settings.js';
// 幂等标记：必须是 PET_FUNCS 里真实存在的文本（此前 TAG 与写入文本不一致，导致重跑时
// 函数体没更新、插入却重复了一遍 —— 2026-11-01 修）
const TAG = '（补丁 pet-companion';
const MARKER_PREFIX = '      // ── 🐋 陪玩·桌宠';

// ── 桌宠面板：HTML 生成 + 绑定（插入到 bindGamesCard 之前） ──
const PET_FUNCS = `      // ── 🐋 陪玩·桌宠双形态（补丁 pet-companion v2 2026-10-31） ──
      // 数据来自 hooks/pet-panel.mjs（/api/qqbot-settings/pet-anim）：
      //   GET  → {form, forms:[{id,label,emoji,petId,active}], anims:[{name,label}], petOn}
      //   POST → {action:'switch-form',target} / {action:'random'} / {name} / {action:'pet-display',on}
      // 视频素材走 dsh-pet 的 /dsh-pet-7340/thumb/<petId>/<动画名>.webm（要 ?token=，从地址栏取）。
      var PET_STATE = { form: 'xiaolan', forms: [], anims: [] }
      function petMediaUrl(formId, name) {
        // 2026-11-01：改走 pet-panel.mjs 的服务端代理（不依赖地址栏 token ——
        // 以前直连 dsh-pet /thumb 取不到 token 时视频永远空白，这就是「完全不显示」的根因）
        return '/api/qqbot-settings/pet-media?form=' + encodeURIComponent(formId) + '&name=' + encodeURIComponent(name)
      }
      function petCompanionHtml() {
        var html = '<div class="dk-row" style="font-weight:700;font-size:13px;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0 2px">'
          + '<span>🐋 桌宠·多形态</span>'
          + '<span class="q-pill ok">零模型 · 纯动作</span>'
          + '<button class="dk-btn" id="dk-pet-toggle" style="font-size:12px;padding:2px 10px;margin-left:auto">⏻ 关闭桌宠</button>'
          + '</div>'
        html += '<div id="dk-pet-box"><div class="dk-msg" style="font-size:11px;color:#888">桌宠面板加载中…（宿主没启动时会提示原因，不会一直空着）</div></div>'
        html += '<div class="dk-msg" style="font-size:11px;color:#888;line-height:1.6;margin:4px 0 0">点动作按钮 = 桌面上的桌宠立刻做这个动作；右上按钮整体开关桌宠；手机/平板也能用网页版（见浮窗页脚地址）。</div>'
        html += '<div id="dk-invite" style="margin:8px 0 2px"><div class="dk-msg" style="font-size:11px;color:#888">邀请信息加载中…</div></div>'
        return html
      }
      function petRender() {
        var box = panel && panel.querySelector('#dk-pet-box')
        if (!box) return
        var f = PET_STATE.form || 'xiaolan'
        var off = PET_STATE.petOn === false
        var tabs = ''
        for (var i = 0; i < PET_STATE.forms.length; i++) {
          var x = PET_STATE.forms[i]
          tabs += '<button class="dk-btn" data-pet-form="' + esc(x.id) + '" style="font-size:12px;padding:2px 10px'
            + (x.active ? ';font-weight:700' : '') + '">' + esc(x.emoji + ' ' + x.label) + (x.active ? '（当前）' : '') + '</button>'
        }
        var btns = ''
        for (var j = 0; j < PET_STATE.anims.length; j++) {
          var a = PET_STATE.anims[j]
          btns += '<button class="dk-btn" data-pet="' + esc(a.name) + '" style="font-size:12px;padding:2px 10px">' + esc(a.label) + '</button>'
        }
        var video0 = (PET_STATE.anims[0] || {}).name || ''
        box.innerHTML = '<div class="dk-row" style="gap:6px;flex-wrap:wrap;margin:4px 0"><span style="font-size:11px;color:#888">形态：</span>' + tabs + '</div>'
          + (off ? '<div class="dk-msg" style="font-size:11px;color:#b8860b;margin:4px 0">桌宠当前处于关闭状态（右上按钮可重新开启；点形态/动作会自动把它叫回来）</div>' : '')
          + '<div class="dk-row" style="gap:10px;align-items:flex-start;flex-wrap:wrap;margin:4px 0">'
          + '<video id="dk-pet-video" src="' + petMediaUrl(f, video0) + '" autoplay loop muted playsinline'
          + ' style="width:128px;height:128px;object-fit:contain;border-radius:10px;background:#f2f6ff;flex:none"></video>'
          + '<div style="flex:1;min-width:200px">'
          + '<div class="dk-row" style="gap:6px;flex-wrap:wrap;margin:2px 0">' + btns
          + '<button class="dk-btn" id="dk-pet-random" style="font-size:12px;padding:2px 10px">🎲 逗逗TA</button>'
          + '</div>'
          + '<div class="dk-msg" id="dk-pet-status" style="font-size:11px;color:#888;line-height:1.5;margin:4px 0 0">点按钮 = 桌面上的桌宠立刻做这个动作（不调用任何模型）。左边是动作预览；切形态时桌面会闪一下（窗口重建，正常现象）。</div>'
          + '</div></div>'
        var v0 = box.querySelector('#dk-pet-video')
        if (v0) v0.onended = function () { petPlay(f, video0, true) }
      }
      function petPlay(formId, name, loop) {
        var v = panel && panel.querySelector('#dk-pet-video')
        if (!v || !name) return
        v.loop = !!loop
        v.src = petMediaUrl(formId, name)
        if (v.play) { try { v.play() } catch (ePV) { } }
      }
      function petError(msg) {
        var box = panel && panel.querySelector('#dk-pet-box')
        if (box) box.innerHTML = '<div class="dk-msg" style="font-size:11px;color:#c66;line-height:1.6">🐋 ' + esc(msg)
          + '<br>桌宠动作/预览不可用；启动宿主（DSH Desktop）后本面板自动恢复。</div>'
      }
      // ── 邀请共享（2026-11-01 主人要求：密钥版/免密钥版两个入口，密钥可见可复制）──
      function inviteRender(d) {
        var el = panel && panel.querySelector('#dk-invite')
        if (!el) return
        if (!d || !d.ok) {
          el.innerHTML = '<div class="dk-msg" style="font-size:11px;color:#888">🔗 邀请共享不可用：' + esc((d && d.message) || '网关未部署') + '</div>'
          return
        }
        var free = d.freeMode === true
        var modeBtn = free
          ? '<button class="dk-btn" id="dk-inv-free" style="font-size:12px;padding:2px 10px;background:#fff2f0;border-color:#dba;color:#c66">🔒 关闭免密钥（恢复验码）</button>'
          : '<button class="dk-btn" id="dk-inv-free" style="font-size:12px;padding:2px 10px">🔓 免密钥邀请（限 1 人直进）</button>'
        el.innerHTML = '<div class="dk-msg" style="font-size:12px;font-weight:700;margin:2px 0">🔗 邀请共享桌宠 <span style="font-weight:400;color:#888;font-size:11px">（在线 ' + (d.seatsUsed == null ? '?' : d.seatsUsed) + '/' + esc(String(d.seatsMax == null ? 1 : d.seatsMax)) + ' 人）</span></div>'
          + '<div class="dk-msg" style="font-size:11px;color:#556;line-height:1.7;margin:2px 0;word-break:break-all">链接：<a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.url) + '</a><br>访问码：<b id="dk-inv-key">' + esc(d.key || '（免密钥模式无需访问码）') + '</b></div>'
          + '<div class="dk-row" style="gap:6px;flex-wrap:wrap;margin:4px 0">'
          + '<button class="dk-btn" id="dk-inv-copy" style="font-size:12px;padding:2px 10px">📋 复制有密钥邀请</button>'
          + modeBtn
          + '<button class="dk-btn" id="dk-inv-reset" style="font-size:12px;padding:2px 10px">♻️ 踢掉在线者</button>'
          + '</div>'
          + '<div class="dk-msg" style="font-size:11px;color:#99a;line-height:1.5;margin:2px 0 0">QQ 内打开受限时，请让对方长按链接选「浏览器打开」。免密钥模式下拿到链接即可进，仍限 1 人同时在线；随时可关闭恢复验码。</div>'
        el._data = d
      }
      function inviteRefresh() {
        fetch('/api/qqbot-settings/pet-share').then(function (r) { return r.json() }).then(function (d) { inviteRender(d) }).catch(function (e2) { inviteRender(null) })
      }
      function inviteCopy(d) {
        var t = '来看我的桌宠小蓝～（点右上角用浏览器打开）\\n' + d.url + '\\n访问码：' + (d.key || '（免密钥，直接进）')
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).then(function () { petShareMsg('已复制邀请（链接+访问码），发给对方即可') }, function () { fallbackCopy(t) })
        } else fallbackCopy(t)
      }
      function fallbackCopy(t) {
        try {
          var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select()
          document.execCommand('copy'); document.body.removeChild(ta)
          petShareMsg('已复制邀请（链接+访问码），发给对方即可')
        } catch (e2) { petShareMsg('复制失败，请手动选中链接与访问码') }
      }
      function petShareMsg(t) {
        var el = panel && panel.querySelector('#dk-invite')
        if (!el) return
        var m = el.querySelector('.dk-msg:last-child')
        if (m) { m.textContent = t; m.style.color = '#2c8'; setTimeout(function () { inviteRefresh() }, 2600) }
      }
      function petRefresh() {
        // 2026-11-01：8s 超时 + 4s 自动重试（以前 fetch 挂死就永远卡「加载中」，赶上宿主重启必现）
        var ctl = (typeof AbortController === 'function') ? new AbortController() : null
        var timer = ctl && setTimeout(function () { try { ctl.abort() } catch (eRT) { } }, 8000)
        fetch('/api/qqbot-settings/pet-anim', ctl ? { signal: ctl.signal } : undefined).then(function (r) { return r.json() }).then(function (d) {
          if (timer) clearTimeout(timer)
          if (!d || !d.ok) { petError('桌宠接口没就绪（桌宠插件没跑起来）'); return }
          PET_STATE.form = (d.form && d.form.id) || 'xiaolan'
          PET_STATE.forms = d.forms || []
          PET_STATE.anims = d.anims || []
          PET_STATE.petOn = d.petOn
          var tg = panel && panel.querySelector('#dk-pet-toggle')
          if (tg) tg.textContent = (d.petOn === false) ? '⏻ 开启桌宠' : '⏻ 关闭桌宠'
          petRender()
        }).catch(function () {
          if (timer) clearTimeout(timer)
          var box = panel && panel.querySelector('#dk-pet-box')
          if (box) box.innerHTML = '<div class="dk-msg" style="font-size:11px;color:#b8860b;line-height:1.6">🐋 宿主连接中…（4 秒后自动重试；启动 DSH Desktop 后本面板自动恢复）</div>'
          if (panel) setTimeout(petRefresh, 4000)
        })
      }
      function bindPetCompanion() {
        if (!panel || panel._petBound) return
        panel._petBound = 1
        petRefresh()
        inviteRefresh()
        // 事件委托挂 panel（仿 _modelsBound），body 重绘不丢
        panel.addEventListener('click', function (ev) {
          var t = ev.target
          if (!t || !t.getAttribute) return
          // ── 桌宠总开关（2026-11-01）──
          if (t.id === 'dk-pet-toggle') {
            if (t.disabled) return
            t.disabled = true
            var turningOn = (PET_STATE.petOn === false)
            apiPost('pet-anim', { action: 'pet-display', on: turningOn }, 15000).then(function (d) {
              t.disabled = false
              var stf = panel.querySelector('#dk-pet-status')
              if (stf) stf.textContent = (d && d.ok)
                ? (d.message || (turningOn ? '桌宠已开启' : '桌宠已关闭'))
                : ('✗ ' + ((d && (d.message || d.reason)) || '操作失败'))
              petRefresh()
            }).catch(function () { t.disabled = false })
            return
          }
          var fm = t.getAttribute('data-pet-form')
          if (fm) {
            if (t.disabled) return
            t.disabled = true
            var stf = panel.querySelector('#dk-pet-status')
            apiPost('pet-anim', { action: 'switch-form', target: fm }, 15000).then(function (d) {
              if (t) t.disabled = false
              if (stf) stf.textContent = (d && d.ok)
                ? ('✔ 已切换到 ' + (d.label || fm) + '（桌面换角中…）')
                : ('✗ ' + ((d && (d.message || d.reason)) || '切换失败'))
              petRefresh()
            }).catch(function () { if (t) t.disabled = false })
            return
          }
          // ── 邀请共享按钮（2026-11-01）──
          if (t.id === 'dk-inv-copy') {
            var inv = panel.querySelector('#dk-invite')
            if (inv && inv._data) inviteCopy(inv._data)
            return
          }
          if (t.id === 'dk-inv-free') {
            if (t.disabled) return
            t.disabled = true
            var turningFree = !(panel.querySelector('#dk-invite')._data && panel.querySelector('#dk-invite')._data.freeMode === true)
            apiPost('pet-share', { action: 'free-mode', on: turningFree }, 20000).then(function (d) {
              t.disabled = false
              petShareMsg((d && d.ok) ? (d.message || '已切换') : ('✗ ' + ((d && d.message) || '切换失败')))
              setTimeout(inviteRefresh, 1200)
            }).catch(function () { t.disabled = false })
            return
          }
          if (t.id === 'dk-inv-reset') {
            if (t.disabled) return
            t.disabled = true
            apiPost('pet-share', { action: 'reset-seat' }, 20000).then(function (d) {
              t.disabled = false
              petShareMsg((d && d.ok) ? (d.message || '已重置席位') : ('✗ ' + ((d && d.message) || '重置失败')))
              setTimeout(inviteRefresh, 1200)
            }).catch(function () { t.disabled = false })
            return
          }
          var nm = t.getAttribute('data-pet')
          var rnd = t.id === 'dk-pet-random'
          if (!nm && !rnd) return
          if (t.disabled) return
          t.disabled = true
          var st = panel.querySelector('#dk-pet-status')
          var done = function (d) {
            if (t) t.disabled = false
            if (st) st.textContent = (d && d.ok)
              ? ('✔ 已触发 ' + (d.anim || nm || '随机动作') + '（' + (d.playbackId || '') + '）')
              : ('✗ ' + ((d && (d.message || d.reason)) || '触发失败'))
          }
          var p = rnd ? apiPost('pet-anim', { action: 'random' }, 8000) : apiPost('pet-anim', { name: nm }, 8000)
          p.then(function (d) {
            done(d)
            if (d && d.ok) petPlay(PET_STATE.form, d.anim || nm || '', false)
          }).catch(function () { done(null) })
        })
      }
`;

const OPS = [
  {
    label: '标签改名：🎮 游戏 → 🐋 陪玩',
    old: `+ '<button data-t="games" class="' + (state.tab === 'games' ? 'on' : '') + '">🎮 游戏</button>'`,
    neu: `+ '<button data-t="games" class="' + (state.tab === 'games' ? 'on' : '') + '">🐋 陪玩</button>'`,
  },
  {
    label: '插入函数定义（petCompanionHtml / petRender / petRefresh / bindPetCompanion）',
    old: `      function bindGamesCard() {
        var rf = panel && panel.querySelector('#dk-games-refresh')`,
    neu: PET_FUNCS + `      function bindGamesCard() {
        try { bindPetCompanion() } catch (eP) { console.warn('[qqbot] bindPetCompanion', eP && eP.message) }
        var rf = panel && panel.querySelector('#dk-games-refresh')`,
  },
  {
    label: 'gamesCardHtml 前部插入桌宠面板（对局列表保留在后）',
    old: `        html += '<div style="font-weight:600;font-size:12px;margin:8px 0 2px">进行中的对局</div>'`,
    neu: `        html += petCompanionHtml()
        html += '<div style="font-weight:600;font-size:12px;margin:8px 0 2px">进行中的对局</div>'`,
  },
];

function main() {
  const apply = process.argv.includes('--apply');
  const fileArg = process.argv.includes('--file') ? process.argv[process.argv.indexOf('--file') + 1] : null;
  const file = fileArg || pluginPath(REL);
  announce('pet-companion-card');
  if (!existsSync(file)) { console.error(`✗ 找不到 ${file}`); process.exit(1); }

  let src = readFileSync(file, 'utf8');
  const crlf = src.includes('\r\n');
  if (crlf) src = src.replace(/\r\n/g, '\n');

  let out;
  if (src.includes(TAG)) {
    // ── 升级模式（2026-11-01）：已打过补丁 → 只把函数体整体换成最新版，
    //    并保证 petCompanionHtml() 恰好插入一次、bindPetCompanion 钩子在位。
    const idx = src.indexOf('补丁 pet-companion');
    const startMarker = idx >= 0 ? src.lastIndexOf('\n', idx) + 1 : -1;
    const bindIdx = startMarker >= 0 ? src.indexOf('      function bindGamesCard() {', startMarker) : -1;
    if (bindIdx < 0) { console.error('✗ 找到补丁标记但找不到函数块边界，需人工处理'); process.exit(2); }
    out = src.slice(0, startMarker) + PET_FUNCS + src.slice(bindIdx);
    const INSERT_AT = `        html += '<div style="font-weight:600;font-size:12px;margin:8px 0 2px">进行中的对局</div>'`;
    if (!out.includes('html += petCompanionHtml()')) {
      if (!out.includes(INSERT_AT)) { console.error('✗ 找不到「进行中的对局」锚点'); process.exit(2); }
      out = out.replace(INSERT_AT, `        html += petCompanionHtml()\n` + INSERT_AT);
      console.log('✓ 插入 petCompanionHtml()（此前缺失）');
    } else {
      const n = out.split('html += petCompanionHtml()').length - 1;
      if (n > 1) { console.error(`✗ petCompanionHtml() 出现 ${n} 次（应为 1），先手工去重再跑`); process.exit(2); }
      console.log('= petCompanionHtml() 已在位（1 次）');
    }
    if (!out.includes('try { bindPetCompanion() }')) {
      out = out.replace('      function bindGamesCard() {\n',
        '      function bindGamesCard() {\n        try { bindPetCompanion() } catch (eP) { console.warn(\'[qqbot] bindPetCompanion\', eP && eP.message) }\n');
      console.log('✓ 补上 bindPetCompanion 钩子');
    }
    console.log('= 已是补丁版 → 函数体升级到最新版');
  } else {
    out = src;
    let hit = 0;
    for (const op of OPS) {
      if (!out.includes(op.old)) { console.log(`! 未命中：${op.label}`); continue; }
      out = out.replace(op.old, op.neu);
      hit += 1;
      console.log(`✓ ${op.label}`);
    }
    if (!hit) { console.error('✗ 没有任何改动（锚点全部未命中，客户端可能升级过，需重新核对）'); process.exit(2); }
  }

  if (!apply) { console.log('\n（--check 模式，未写入；加 --apply 落地）'); return; }

  if (!fileArg) copyFileSync(file, `${file}.orig-pet`);
  const text = crlf ? out.replace(/\n/g, '\r\n') : out;
  writeFileSync(file, text, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`\n✔ 已写入 ${REL}（备份 .orig-pet）`);
  } catch (e) {
    writeFileSync(file, src, 'utf8');
    console.error(`✗ 语法检查失败，已回滚：${e.message}`);
    process.exit(1);
  }
}

main();
