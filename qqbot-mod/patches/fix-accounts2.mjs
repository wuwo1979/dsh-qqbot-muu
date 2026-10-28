// [qqbot-mod] accounts2 —— 账号管理：两平台二维码都常显、不被 flex 压扁；B 站保留并自动出码。
// 用法：node qqbot-mod/patches/fix-accounts2.mjs [--check|--apply]
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { pluginPath, announce } from './plugin-dir.mjs'

const CLIENT = pluginPath('client/qqbot-settings.js')
const norm = (s) => s.replace(/\r\n/g, '\n')
const denorm = (s) => s.replace(/\n/g, '\r\n')

const HEAD = '      function acctBadge(st) {'
const HEAD_END = '      async function loadAccounts(force) {'
const BIND = '      function bindAccounts() {'
const BIND_END = '      function biliCardHtml() {'

const TOP = `      // ═══ [[qqbot-mod] accounts2] 二维码常显 + 固定尺寸（不被 flex 压扁） ═══
      var ACCT_QR_PX = 172
      function acctBadge(st) {
        if (!st) return '<span style="color:#999">…</span>'
        if (st.loggedIn === true) return '<span style="color:#12b76a">● 已登录</span>'
        if (st.cooling || st.reason === 'cooldown') return '<span style="color:#f79009">◐ 冷却中</span>'
        if (st.reason === 'risk') return '<span style="color:#f04438">● 风控中</span>'
        if (st.loggedIn === null) return '<span style="color:#f79009">◐ 状态未知</span>'
        return '<span style="color:#98a2b3">○ 未登录</span>'
      }
      function acctPacing(st) {
        if (!st || !st.paced) return ''
        var p = st.paced
        var parts = []
        if (p.counts) {
          Object.keys(p.counts).forEach(function (k) {
            if (/At$/.test(k)) return
            parts.push(k + ' ' + p.counts[k] + '/' + ((p.caps && p.caps[k]) || 0))
          })
        }
        return parts.length ? parts.join(' · ') : '今天还没动过手'
      }
      function acctQrBox(title, url, tip) {
        if (!url) return ''
        var src = '/api/qqbot-settings/qr-svg?text=' + encodeURIComponent(url)
        return '<div style="flex:0 0 auto;width:' + ACCT_QR_PX + 'px;text-align:center">'
          + '<div style="font-size:11.5px;color:#475467;margin-bottom:4px;font-weight:600">' + esc(title) + '</div>'
          + '<img src="' + src + '" width="' + ACCT_QR_PX + '" height="' + ACCT_QR_PX + '" alt="qr"'
          + ' style="display:block;width:' + ACCT_QR_PX + 'px !important;height:' + ACCT_QR_PX + 'px !important;'
          + 'max-width:none !important;min-width:' + ACCT_QR_PX + 'px;box-sizing:border-box;background:#fff;'
          + 'border:1px solid #eaecf0;border-radius:8px;padding:4px;image-rendering:pixelated">'
          + (tip ? '<div style="font-size:10.5px;color:#98a2b3;margin-top:4px;line-height:1.35">' + esc(tip) + '</div>' : '')
          + '</div>'
      }
      function accountsHtml() {
        var st = state.accounts
        var rows = (st && st.platforms) || []
        var meta = (st && st.meta) || {}
        var byId = {}
        rows.forEach(function (p) { byId[p.platform] = p })
        var html = '<div style="padding:10px;border:1px solid #e9ecef;border-radius:10px;background:#fff;margin-bottom:8px">'
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
          + '<div style="font-weight:700;font-size:14px">🔗 账号管理</div>'
          + '<span style="font-size:11px;color:#888">B 站 + 抖音；二维码常显，点不点都能扫</span>'
          + '<button id="dk-acct-refresh" class="qqs-btn" style="margin-left:auto">🔄 刷新</button>'
          + '</div>'
        if (!st) {
          html += '<div class="dk-empty" style="margin-top:6px">在读账号状态…</div>'
        } else if (st.ok === false) {
          html += '<div class="dk-empty" style="margin-top:6px">读取失败：' + esc(st.error || '') + '</div>'
        } else {
          var b = byId.bili || {}
          var d = byId.douyin || {}
          var dUrl = state.acctDouyinUrl || (meta.douyin && (meta.douyin.site || meta.douyin.homeUrl)) || 'https://www.douyin.com/'
          html += '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;margin-top:8px">'
          // —— B 站 ——
          html += '<div style="flex:1 1 320px;min-width:300px;padding:8px;border:1px solid #f0f2f5;border-radius:8px;background:#fcfcfd">'
            + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px">'
            + '<b>B 站</b>' + acctBadge(b)
            + (b.nickname ? '<span style="color:#475467">' + esc(b.nickname) + '</span>' : '')
            + '<span style="margin-left:auto;font-size:11px;color:#98a2b3">' + esc(acctPacing(b)) + '</span>'
            + '</div>'
            + '<div style="font-size:11.5px;color:#667085;margin:4px 0 6px">' + esc(b.hint || '') + '</div>'
            + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">'
            + (b.loggedIn === true
              ? acctQrBox('已登录（要换号再扫）', state.biliQr && state.biliQr.url, '扫码后手机上点确认')
              : acctQrBox('扫码登录 B 站', state.biliQr && state.biliQr.url, '手机 B 站 App 扫；扫完点下面的按钮'))
            + '<div style="flex:1 1 160px;min-width:150px;font-size:11.5px;color:#475467">'
            + '<button class="qqs-btn" id="dk-acct-bili-check">✅ 我已确认，检查登录</button>'
            + '<div id="dk-acct-bili-msg" style="margin-top:6px;color:#667085"></div>'
            + '<button class="qqs-btn" id="dk-acct-bili-new" style="margin-top:6px">🔄 换一张码</button>'
            + '</div></div></div>'
          // —— 抖音 ——
          html += '<div style="flex:1 1 320px;min-width:300px;padding:8px;border:1px solid #f0f2f5;border-radius:8px;background:#fcfcfd">'
            + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px">'
            + '<b>抖音</b>' + acctBadge(d)
            + (d.nickname ? '<span style="color:#475467">' + esc(d.nickname) + '</span>' : '')
            + '<span style="margin-left:auto;font-size:11px;color:#98a2b3">' + esc(acctPacing(d)) + '</span>'
            + '</div>'
            + '<div style="font-size:11.5px;color:#667085;margin:4px 0 6px">' + esc(d.hint || '') + '</div>'
            + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">'
            + acctQrBox('扫码打开抖音登录页', dUrl, '手机抖音扫这个码 → 登网页 → 再粘 Cookie')
            + '<div style="flex:1 1 170px;min-width:160px;font-size:11.5px;color:#475467">'
            + '<textarea id="dk-acct-cookie" placeholder="把浏览器 Cookie 整行粘这里（a=1; b=2; …）" style="width:100%;height:58px;font-size:11px;border:1px solid #d0d5dd;border-radius:6px;padding:5px"></textarea>'
            + '<button class="qqs-btn" id="dk-acct-cookie-save" style="margin-top:5px">💾 保存抖音 Cookie</button>'
            + '<div id="dk-acct-cookie-msg" style="margin-top:5px;color:#667085"></div>'
            + '<a href="' + esc(meta.douyin && meta.douyin.uploadUrl ? meta.douyin.uploadUrl : 'https://creator.douyin.com/creator-micro/content/upload') + '" target="_blank" style="display:inline-block;margin-top:6px">📤 打开创作者中心上传页</a>'
            + '</div></div>'
            + '<div style="font-size:10.5px;color:#b54708;background:#fffaeb;border:1px solid #fedf89;border-radius:6px;padding:5px;margin-top:6px">'
            + '抖音投稿要 a_bogus 签名 + 设备指纹，硬算等于自报"高危机器人"，所以这里只做登录态与成片准备，不做自动投稿。'
            + '</div></div>'
          html += '</div>'
        }
        html += '</div>'
        return '<div id="dk-acct-host">' + html + '</div>'
      }
`

const BIND_NEW = `      function bindAccounts() {
        var panel = document.querySelector('#qqs-dock-panel')
        if (!panel) return
        var rf = panel.querySelector('#dk-acct-refresh')
        if (rf) rf.onclick = function () { loadAccounts(true) }
        var startBiliQr = async function () {
          try {
            var r = await apiPost('bili', { action: 'login-qr-start', jobId: '' })
            if (r && r.ok) {
              state.biliQr = { key: r.key, url: r.url }
              try { renderAccountsInPlace() } catch (e) {}
              return
            }
          } catch (e) {}
          try { renderAccountsInPlace() } catch (e2) {}
        }
        var newBtn = panel.querySelector('#dk-acct-bili-new')
        if (newBtn) newBtn.onclick = function () { state.biliQr = null; startBiliQr() }
        var chk = panel.querySelector('#dk-acct-bili-check')
        if (chk) chk.onclick = async function () {
          var msg = panel.querySelector('#dk-acct-bili-msg')
          if (!state.biliQr || !state.biliQr.key) { if (msg) msg.textContent = '还没有二维码，点「换一张码」'; return }
          if (msg) msg.textContent = '检查中…'
          var p = await apiPost('bili', { action: 'login-qr-poll', jobId: '', key: state.biliQr.key }).catch(function (e) { return { ok: false, error: e.message } })
          if (msg) msg.textContent = p && p.ok && p.state === 'ok' ? '登录成功 ✓' : ((p && (p.error || ('状态：' + (p.state || '未知')))) || '没成功')
          if (p && p.ok && p.state === 'ok') { state.biliQr = null; loadAccounts(true) }
        }
        var sv = panel.querySelector('#dk-acct-cookie-save')
        if (sv) sv.onclick = async function () {
          var ta = panel.querySelector('#dk-acct-cookie')
          var msg = panel.querySelector('#dk-acct-cookie-msg')
          var val = (ta && ta.value) || ''
          if (msg) msg.textContent = '保存中…'
          var r = await apiPost('accounts-cookie', { id: 'douyin', cookie: val }).catch(function (e) { return { ok: false, error: e.message } })
          if (msg) {
            msg.textContent = r && r.ok
              ? '已保存（' + r.bytes + ' 字节' + (r.hasSid ? '，含会话' : '，但没看到 sessionid，可能不全') + '）'
              : ('失败：' + ((r && r.error) || ''))
          }
          if (r && r.ok) loadAccounts(true)
        }
        // 没登录就自动备一张 B 站码（只备一次，不循环）
        if (!state.biliQr && !state._biliQrTried) {
          var b = null
          try {
            (state.accounts.platforms || []).forEach(function (p) { if (p.platform === 'bili') b = p })
          } catch (e) {}
          if (b && b.loggedIn !== true) { state._biliQrTried = true; startBiliQr() }
        }
      }
`

function sliceBetween(s, a, b) {
  const i = s.indexOf(a)
  const j = s.indexOf(b, i + a.length)
  if (i < 0 || j < 0) return null
  return { i, j, text: s.slice(i, j) }
}

function run(checkOnly) {
  announce('accounts2（两平台二维码常显 + 不被压扁）')
  let s = norm(readFileSync(CLIENT, 'utf8'))
  if (s.includes('[qqbot-mod] accounts2]')) { console.log('= 已是最新，无需写入'); return }

  const r1 = sliceBetween(s, HEAD, HEAD_END)
  const r2 = sliceBetween(s, BIND, BIND_END)
  if (!r1 || !r2) { console.log('✗ 找不到锚点（可能在别处已改过）'); return }
  if (checkOnly) { console.log('需要写入 2 段'); return }

  // 从后往前替换，避免下标漂移
  s = s.slice(0, r2.i) + BIND_NEW + s.slice(r2.j)
  s = s.slice(0, r1.i) + TOP + s.slice(r1.j)
  copyFileSync(CLIENT, CLIENT + '.orig-muu')
  writeFileSync(CLIENT, denorm(s), 'utf8')
  console.log('✓ 已写入 ' + CLIENT)
}

run(process.argv.includes('--check'))
