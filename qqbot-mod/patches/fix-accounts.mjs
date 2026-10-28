// [qqbot-mod] accounts  —— 浮窗「B 站管理」升级成「账号管理」：B 站 + 抖音 一起管。
// 抖音只做「登录态 + 扫码/说明 + 成片准备」，不做自动投稿（要 a_bogus 签名，硬闯=高危行为）。
// 用法：node qqbot-mod/patches/fix-accounts.mjs [--check|--apply]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pluginPath, announce } from './plugin-dir.mjs'

const CLIENT = pluginPath('client/qqbot-settings.js')
const HOST = pluginPath('settings-host.js')
const MARK = '[qqbot-mod] accounts'

const normalize = (s) => s.replace(/\r\n/g, '\n')
const restore = (s) => s.replace(/\n/g, '\r\n')

function applyOp(src, label, fn) {
  if (src.includes(label)) return { src, hit: false, label }
  const out = fn(src)
  if (out === null) return { src, hit: false, label, missing: true }
  return { src: out, hit: true, label }
}

// ── host 路由 ────────────────────────────────────────────────────────────────
const HOST_ANCHOR = '  // ═══ [[qqbot-mod] panel-v3] ① B 站发布日志：浮窗里能审查"我发了什么" ═══'
const HOST_ROUTES = `  // ═══ [[qqbot-mod] accounts] 账号管理：B 站 + 抖音 一个入口 ═══
  const __qqNsOf = (req) => { try { return new URL(req.url ?? '/', 'http://x').searchParams.get('ns') || NS } catch { return NS } }
  const __qqPlatforms = async (root) => {
    const p = join(root, '.qqbot-extensions', 'lib', 'platforms', 'index.mjs')
    return import('file:///' + p.split(String.fromCharCode(92)).join('/'))
  }
  route(ctx, 'GET', '/api/qqbot-settings/accounts', async (req, res) => {
    try {
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const m = await __qqPlatforms(root)
      const o = await m.overview(root)
      const cfg = (() => { try { return JSON.parse(readFileSync(join(root, '.qqbot-extensions', 'voice-config.json'), 'utf8')) } catch { return {} } })()
      return writeJson(res, 200, { ...o, voice: { provider: cfg.provider || '', model: cfg.model || '', voice: cfg.voice || '' } })
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '账号总览失败：' + String((e && e.message) || e) })
    }
  })
  route(ctx, 'GET', '/api/qqbot-settings/accounts-detail', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x')
      const id = String(u.searchParams.get('id') || '')
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const m = await __qqPlatforms(root)
      const d = await m.detail(root, id)
      return writeJson(res, 200, d)
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '账号详情失败：' + String((e && e.message) || e) })
    }
  })
  route(ctx, 'POST', '/api/qqbot-settings/accounts-cookie', async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const id = String((body && body.id) || '')
      const cookie = String((body && body.cookie) || '')
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const p = join(root, '.qqbot-extensions', 'lib', 'platforms', 'douyin.mjs')
      const dy = await import('file:///' + p.split(String.fromCharCode(92)).join('/'))
      if (id !== 'douyin') return writeJson(res, 200, { ok: false, error: '目前只有抖音需要手工粘 Cookie' })
      const r = dy.saveCookie(root, cookie, String((body && body.note) || ''))
      return writeJson(res, 200, r)
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '保存 Cookie 失败：' + String((e && e.message) || e) })
    }
  })
  route(ctx, 'GET', '/api/qqbot-settings/qr-svg', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x')
      const text = String(u.searchParams.get('text') || '').slice(0, 512)
      if (!text) return writeJson(res, 200, { ok: false, error: '缺 text' })
      const root = resolveMemoryRoot(nsBot(__qqNsOf(req)))
      let mod = null
      try {
        const p = join(root, '.qqbot-extensions', 'lib', 'platforms', 'douyin.mjs')
        mod = await import('file:///' + p.split(String.fromCharCode(92)).join('/'))
      } catch {}
      if (!mod) mod = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/platforms/douyin.mjs')
      const q = await mod.qrSvg(text)
      if (!q || !q.ok) return writeJson(res, 200, { ok: false, error: (q && q.error) || '生成失败' })
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(q.svg)
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '二维码生成失败：' + String((e && e.message) || e) })
    }
  })

`
function hostOp(src) {
  const i = src.indexOf(HOST_ANCHOR)
  if (i < 0) return null
  return src.slice(0, i) + HOST_ROUTES + src.slice(i)
}

// ── client ──────────────────────────────────────────────────────────────────
const TAB_OLD = `+ '<button data-t="bili" class="' + (state.tab === 'bili' ? 'on' : '') + '">🎬 B站管理</button>'`
const TAB_NEW = `+ '<button data-t="bili" class="' + (state.tab === 'bili' ? 'on' : '') + '">🔗 账号管理</button>'`
function tabOp(src) {
  if (!src.includes(TAB_OLD)) return null
  return src.replace(TAB_OLD, TAB_NEW)
}

const CARD_OLD = `'<div style="font-weight:700;font-size:14px">🎬 B 站管理</div>'`
function cardOp(src) {
  const i = src.indexOf(CARD_OLD)
  if (i < 0) return null
  const ret = src.lastIndexOf('return ', i)
  if (ret < 0) return null
  return src.slice(0, ret) + 'return accountsHtml() + ' + src.slice(ret + 'return '.length)
}

const CLIENT_FUNCS = `      // ═══ [[qqbot-mod] accounts] 账号管理 ═══
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
      function accountsHtml() {
        var st = state.accounts
        var rows = (st && st.platforms) || []
        var html = '<div class="dk-card" style="padding:10px;border:1px solid #e9ecef;border-radius:10px;background:#fff;margin-bottom:8px">'
          + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
          + '<div style="font-weight:700;font-size:14px">🔗 账号管理</div>'
          + '<span style="font-size:11px;color:#888">一个入口管所有平台；每个平台能自动化到什么程度都写在下面</span>'
          + '<button id="dk-acct-refresh" class="qqs-btn" style="margin-left:auto">🔄 刷新</button>'
          + '</div>'
        if (!st) {
          html += '<div class="dk-empty" style="margin-top:6px">在读账号状态…</div>'
        } else if (st.ok === false) {
          html += '<div class="dk-empty" style="margin-top:6px">读取失败：' + esc(st.error || '') + '</div>'
        } else {
          rows.forEach(function (p) {
            html += '<div style="margin-top:8px;padding:8px;border:1px solid #f0f2f5;border-radius:8px;background:#fcfcfd">'
              + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px">'
              + '<b>' + esc(p.label || p.platform) + '</b>'
              + acctBadge(p)
              + (p.nickname ? '<span style="color:#475467">' + esc(p.nickname) + '</span>' : '')
              + (p.uid ? '<span style="color:#98a2b3;font-size:11px">UID ' + esc(String(p.uid)) + '</span>' : '')
              + '<span style="margin-left:auto;font-size:11px;color:#98a2b3">' + esc(acctPacing(p)) + '</span>'
              + '</div>'
              + '<div style="font-size:11.5px;color:#667085;margin-top:4px">' + esc(p.hint || '') + '</div>'
              + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">'
              + '<button class="qqs-btn" data-acct-open="' + esc(p.platform) + '">🌐 打开主页</button>'
              + (p.platform === 'douyin'
                ? '<button class="qqs-btn" data-acct-dy="1">📱 扫码 / 说明</button><button class="qqs-btn" data-acct-dy-cookie="1">🍪 粘 Cookie</button>'
                : '<button class="qqs-btn" data-acct-bili-qr="1">📷 扫码重新登录</button>')
              + '</div>'
              + '<div id="dk-acct-extra-' + esc(p.platform) + '"></div>'
              + '</div>'
          })
        }
        html += '</div>'
        return '<div id="dk-acct-host">' + html + '</div>'
      }
      async function loadAccounts(force) {
        // 只在没数据或显式 force 时请求；同一时刻只发一个；数据回来不再触发整页重绘（否则会自己刷自己）
        if (state._acctBusy) return state.accounts
        if (!force && state.accounts && state.accounts.ok !== false) return state.accounts
        state._acctBusy = true
        try {
          var r = await api('accounts', '')
          state.accounts = r || { ok: false, error: '空返回' }
        } catch (e) {
          state.accounts = { ok: false, error: (e && e.message) || String(e) }
        } finally {
          state._acctBusy = false
        }
        if (state.tab === 'bili' && !state._acctPainted) {
          state._acctPainted = true
          try { paintBody() } catch (e2) {}
        } else if (state.tab === 'bili') {
          try { renderAccountsInPlace() } catch (e3) {}
        }
        return state.accounts
      }
      function renderAccountsInPlace() {
        var panel = document.querySelector('#qqs-dock-panel')
        if (!panel) return
        var host = panel.querySelector('#dk-acct-host')
        if (!host) return
        var box = document.createElement('div')
        box.innerHTML = accountsHtml()
        if (box.firstElementChild) host.outerHTML = box.firstElementChild.outerHTML
        try { bindAccounts() } catch (e4) {}
      }
      function bindAccounts() {
        var panel = document.querySelector('#qqs-dock-panel')
        if (!panel) return
        var rf = panel.querySelector('#dk-acct-refresh')
        if (rf) rf.onclick = function () { loadAccounts(true) }
        panel.querySelectorAll('[data-acct-open]').forEach(function (b) {
          b.onclick = function () {
            var id = b.getAttribute('data-acct-open')
            var meta = (state.accounts && state.accounts.meta) || {}
            var url = (meta[id] && (meta[id].homeUrl || meta[id].site)) || ''
            if (url) window.open(url, '_blank')
          }
        })
        var dyBtn = panel.querySelector('[data-acct-dy]')
        if (dyBtn) dyBtn.onclick = async function () {
          var box = panel.querySelector('#dk-acct-extra-douyin')
          if (!box) return
          box.innerHTML = '<div class="dk-empty">读取说明…</div>'
          var r = await api('accounts-detail', 'id=douyin').catch(function (e) { return { ok: false, error: e.message } })
          if (!r || !r.ok) { box.innerHTML = '<div class="dk-empty">读取失败：' + esc((r && r.error) || '') + '</div>'; return }
          var lg = r.login || {}
          var base = (r.status && (r.status.url || lg.url)) || 'https://www.douyin.com/'
          var qrSrc = '/api/qqbot-settings/qr-svg?text=' + encodeURIComponent(base) + '&t=' + Date.now()
          var howto = (lg.howto || []).map(function (s) { return '<li>' + esc(s) + '</li>' }).join('')
          box.innerHTML = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:flex-start">'
            + '<img src="' + qrSrc + '" alt="douyin qr" style="width:220px;height:220px;background:#fff;border:1px solid #eaecf0;border-radius:8px">'
            + '<div style="flex:1;min-width:220px;font-size:12px;color:#475467">'
            + '<div style="margin-bottom:4px">扫码打开官方登录页（手机抖音 App 扫即可）：<a href="' + esc(base) + '" target="_blank">' + esc(base) + '</a></div>'
            + '<ol style="margin:6px 0 6px 18px;padding:0">' + howto + '</ol>'
            + '<div style="color:#b54708;background:#fffaeb;border:1px solid #fedf89;border-radius:6px;padding:6px">' + esc(lg.why || '') + '</div>'
            + '</div></div>'
        }
        var dyCk = panel.querySelector('[data-acct-dy-cookie]')
        if (dyCk) dyCk.onclick = function () {
          var box = panel.querySelector('#dk-acct-extra-douyin')
          if (!box) return
          box.innerHTML = '<div style="margin-top:8px">'
            + '<textarea id="dk-acct-cookie" placeholder="把浏览器里 Cookie 那一整行粘进来（形如 a=1; b=2; …）" style="width:100%;height:70px;font-size:11.5px;border:1px solid #d0d5dd;border-radius:6px;padding:6px"></textarea>'
            + '<div style="display:flex;gap:6px;margin-top:6px"><button id="dk-acct-cookie-save" class="qqs-btn">💾 保存 Cookie</button>'
            + '<span id="dk-acct-cookie-msg" style="font-size:11.5px;color:#667085"></span></div></div>'
          var sv = box.querySelector('#dk-acct-cookie-save')
          if (sv) sv.onclick = async function () {
            var ta = box.querySelector('#dk-acct-cookie')
            var msg = box.querySelector('#dk-acct-cookie-msg')
            var val = (ta && ta.value) || ''
            if (msg) msg.textContent = '保存中…'
            var r = await apiPost('accounts-cookie', { id: 'douyin', cookie: val }).catch(function (e) { return { ok: false, error: e.message } })
            if (msg) msg.textContent = r && r.ok ? '已保存（' + r.bytes + ' 字节' + (r.hasSid ? '，含会话' : '，但没有 sessionid，可能不完整') + '）' : '失败：' + ((r && r.error) || '')
            if (r && r.ok) loadAccounts(true)
          }
        }
        var bq = panel.querySelector('[data-acct-bili-qr]')
        if (bq) bq.onclick = async function () {
          var box = panel.querySelector('#dk-acct-extra-bili')
          if (!box) return
          box.innerHTML = '<div class="dk-empty">申请二维码…</div>'
          var r = await apiPost('bili', { action: 'login-qr-start', jobId: '' }).catch(function (e) { return { ok: false, error: e.message } })
          if (!r || !r.ok) { box.innerHTML = '<div class="dk-empty">失败：' + esc((r && r.error) || '') + '</div>'; return }
          var src = '/api/qqbot-settings/qr-svg?text=' + encodeURIComponent(r.url || '') + '&t=' + Date.now()
          box.innerHTML = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;align-items:flex-start">'
            + '<img src="' + src + '" style="width:200px;height:200px;background:#fff;border:1px solid #eaecf0;border-radius:8px">'
            + '<div style="flex:1;min-width:200px;font-size:12px;color:#475467">用 B 站 App 扫这个码，手机上点确认。<br>'
            + '<button id="dk-acct-bili-poll" class="qqs-btn" style="margin-top:8px">✅ 我已确认，检查登录</button>'
            + '<div id="dk-acct-bili-msg" style="margin-top:6px"></div></div></div>'
          var poll = box.querySelector('#dk-acct-bili-poll')
          if (poll) poll.onclick = async function () {
            var msg = box.querySelector('#dk-acct-bili-msg')
            if (msg) msg.textContent = '检查中…'
            var p = await apiPost('bili', { action: 'login-qr-poll', jobId: '', key: r.key }).catch(function (e) { return { ok: false, error: e.message } })
            if (msg) msg.textContent = p && p.ok && p.state === 'ok' ? '登录成功 ✓' : ((p && (p.error || ('状态：' + p.state))) || '失败')
            if (p && p.ok && p.state === 'ok') loadAccounts(true)
          }
        }
      }
`
function funcsOp(src) {
  const i = src.indexOf('      function biliCardHtml() {')
  if (i < 0) return null
  return src.slice(0, i) + CLIENT_FUNCS + src.slice(i)
}

const HOOK_OLD = `        if (state.tab === 'bili') { try { bindBiliCard() } catch (eB) { console.warn('[qqbot] bindBiliCard', eB && eB.message) } }`
function hookOp(src) {
  if (!src.includes(HOOK_OLD)) return null
  return src.replace(HOOK_OLD, HOOK_OLD + `\n        if (state.tab === 'bili') { try { loadAccounts() } catch (eAC) {} try { bindAccounts() } catch (eAB) {} }`)
}

function run(checkOnly) {
  announce('accounts（账号管理：B站 + 抖音）')
  const targets = [
    { file: HOST, ops: [['host-routes', hostOp]] },
    { file: CLIENT, ops: [['tab', tabOp], ['card', cardOp], ['funcs', funcsOp], ['hook', hookOp]] },
  ]
  let changed = 0
  for (const t of targets) {
    if (!existsSync(t.file)) { console.log(`✗ 找不到 ${t.file}`); continue }
    let src = normalize(readFileSync(t.file, 'utf8'))
    const results = []
    for (const [label, fn] of t.ops) {
      const r = applyOp(src, `${MARK} ${label}`, fn)
      if (r.missing) { console.log(`  ✗ ${label}: 找不到锚点`); results.push(false); continue }
      src = r.src
      console.log(`  ${r.hit ? '✓' : '='} ${label}`)
      if (r.hit) results.push(true)
    }
    if (!results.length) continue
    if (checkOnly) { changed += results.length; continue }
    const backup = `${t.file}.orig-muu`
    copyFileSync(t.file, backup)
    writeFileSync(t.file, restore(src), 'utf8')
    changed += results.length
    console.log(`  → 已写入 ${t.file}（备份 ${backup}）`)
  }
  console.log(changed ? (checkOnly ? `需要写入 ${changed} 处` : `完成，写入 ${changed} 处`) : '= 已是最新，无需写入')
}

run(process.argv.includes('--check'))
