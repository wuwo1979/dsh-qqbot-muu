// tmp/fix-fresh-ui.mjs —— 印象卡"保鲜"UI：状态过期标注 + 保鲜行 + 更新按钮 + 单卡 ⚠
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
const C = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/.generations/live/zaofan+dsh-qqbot+1.10.39+a14f9025cf60/node_modules/@zaofan/dsh-qqbot/client/qqbot-settings.js'
const norm = (s) => s.replace(/\r\n/g, '\n')
const denorm = (s) => s.replace(/\n/g, '\r\n')
let s = norm(readFileSync(C, 'utf8'))
let hits = 0

// ① 状态行：优先当前会话 scope，过期就明确标注是"上次状态"
const oldMood = `        if (moods.length) cInner += '<div style="font-size:11px;color:#666;margin-top:4px">🌤 当前状态：' + esc(moods[0].text) + ' <span style="color:#aaa">· ' + esc(fmtMemAgo(moods[0].ts)) + '</span></div>'`
const newMood = `        if (moods.length) {
          var _curMood = moods[0]
          for (var _mi = 0; _mi < moods.length; _mi++) {
            if (String(moods[_mi].scope || '') === String(state.memScope || '')) { _curMood = moods[_mi]; break }
          }
          if (!_curMood.expired && _curMood.scope !== String(state.memScope || '') && moods[0] && moods[0].expired) _curMood = moods[0]
          var _mAge = fmtMemAgo(_curMood.ts)
          cInner += '<div style="font-size:11px;color:#666;margin-top:4px">'
            + (_curMood.expired ? '🌤 上次状态：' + esc(_curMood.text) : '🌤 当前状态：' + esc(_curMood.text))
            + ' <span style="color:#aaa">· ' + esc(_mAge) + '</span>'
            + (_curMood.expired ? ' <span style="color:#e8590c">· 已过期，下次聊完会刷新</span>' : '')
            + '</div>'
        }`
if (!s.includes(oldMood)) { console.log('✗ 心情行锚点未命中'); process.exit(1) }
s = s.replace(oldMood, newMood); hits++

// ② 卡片行加"待更新"标记（用 freshness.cards 按名字对）
const oldCard = `        if (cards.length) cInner += cards.slice(0, 6).map(function (c) {`
const newCard = `        var _fr = d.freshness || {}
        var _frByName = {}
        ;((_fr.cards) || []).forEach(function (x) { if (x && x.name) _frByName[String(x.name).trim()] = x })
        if (cards.length) cInner += cards.slice(0, 6).map(function (c) {`
if (!s.includes(oldCard)) { console.log('✗ 卡片循环锚点未命中'); process.exit(1) }
s = s.replace(oldCard, newCard); hits++

const oldCardLine = `          + '<span style="color:#aaa"> · ' + (isGlobal ? '个人（跨群统一）' : esc(memScopeLabel(c.scope))) + ' · ' + esc(fmtMemAgo(c.ts)) + '</span></div>'`
const newCardLine = `          + '<span style="color:#aaa"> · ' + (isGlobal ? '个人（跨群统一）' : esc(memScopeLabel(c.scope))) + ' · ' + esc(fmtMemAgo(c.ts))
          + (((_frByName[String(c.name || '').trim()] || {}).stale) ? ' · <span style="color:#e8590c">⚠ ' + esc(_frByName[String(c.name || '').trim()].why || '该更新了') + '</span>' : '')
          + '</span></div>'`
if (!s.includes(oldCardLine)) { console.log('✗ 卡片时间行锚点未命中'); process.exit(1) }
s = s.replace(oldCardLine, newCardLine); hits++

// ③ 保鲜行：待更新张数 + 心情年龄 + 一键更新
const oldTail = `        if (!cInner) cInner = '<div style="font-size:11px;color:#999">还没有印象卡</div>'
        h += memSection('🪪 印象卡 / 当下状态', cInner, '', true)`
const newTail = `        if (!cInner) cInner = '<div style="font-size:11px;color:#999">还没有印象卡</div>'
        // 🧠 保鲜行：卡片该不该更新一眼看见（主人 2026-10-27）
        var _staleN = Number(_fr.staleCount || 0)
        var _moodAge = (_fr.mood && Number(_fr.mood.ageMs) >= 0) ? fmtMemAgo(_fr.mood.ts) : '无'
        cInner += '<div class="dk-row" style="margin-top:6px;align-items:center;gap:6px">'
          + '<span style="font-size:11px;color:' + (_staleN ? '#e8590c' : '#2f9e44') + '">🧠 记忆保鲜：'
          + (_staleN ? _staleN + ' 张卡待更新' : '卡都是新的') + '</span>'
          + '<span style="font-size:10.5px;color:#aaa">状态 ' + esc(_moodAge) + '</span>'
          + '<button class="dk-btn" id="dk-fresh-go" style="height:22px;font-size:11px">🔄 更新印象</button>'
          + '<span id="dk-fresh-hint" style="font-size:10.5px;color:#888"></span>'
          + '</div>'
        h += memSection('🪪 印象卡 / 当下状态', cInner, '', true)`
if (!s.includes(oldTail)) { console.log('✗ 保鲜行锚点未命中'); process.exit(1) }
s = s.replace(oldTail, newTail); hits++

// ④ 绑定：点「更新印象」→ fresh-refresh
const oldBind = `      function bindMemoryPanel() {`
const newBind = `      function bindMemoryPanel() {
        try {
          var _fb = panel.querySelector('#dk-fresh-go')
          if (_fb) _fb.onclick = function () {
            var hint = panel.querySelector('#dk-fresh-hint')
            if (hint) hint.textContent = '正在更新…（自我卡立刻好，别人的卡要走本地模型，慢一点）'
            _fb.disabled = true
            memPost({ action: 'fresh-refresh', mode: 'stale', budget: 2 }, function (r) {
              _fb.disabled = false
              if (hint) hint.textContent = r && r.ok ? '已交给后台，稍后刷新看结果 ✓' : ('没成功：' + ((r && r.error) || '未知'))
              setTimeout(function () { loadMemoryPanel(true) }, 2500)
            })
          }
        } catch (eFB) {}`
if (!s.includes(oldBind + '\n')) { console.log('✗ bindMemoryPanel 锚点未命中'); process.exit(1) }
s = s.replace(oldBind, newBind); hits++

copyFileSync(C, C + '.orig-muu-fresh')
writeFileSync(C, denorm(s), 'utf8')
console.log('✓ 命中 ' + hits + ' 处，已写入')
