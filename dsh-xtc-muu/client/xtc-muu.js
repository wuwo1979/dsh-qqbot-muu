/* xtc-muu — browser half（手写 __ModuleLoader__ 包，无需构建）
 * 在设置里新增「小天才」整页 + 会话页签「小天才」，展示链路可用性 / 小朋友联系人 / 最近消息 / 印象卡。
 * 数据来自宿主同源路由 /api/xtc-muu/*。
 *
 * 与微信面板隔离：本面板只读 /api/xtc-muu/*，绝不碰 /api/wechat-muu/*，数据与微信完全分开。
 */
window.__ModuleLoader__.load({
  id: 'dsh-xtc-muu',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var API = '/api/xtc-muu'

    // 颜色全部走 CSS 变量 + 亮色回退，跟随宿主主题
    var C = {
      text: 'var(--dsw-alias-text-1, #1f2329)',
      text2: 'var(--dsw-alias-text-2, #4e5560)',
      text3: 'var(--dsw-alias-text-3, #8a919c)',
      border: 'var(--dsw-alias-border-1, #e5e6eb)',
      card: 'var(--dsw-alias-bg-2, #ffffff)',
      card2: 'var(--dsw-alias-bg-3, #f7f8fa)',
      primary: '#7c6cf0',
      ok: '#1f9e4f',
      warn: '#d97706',
      bad: '#e5484d',
    }

    var wrap = { padding: '4px 2px', fontSize: 13, color: C.text }
    var cardStyle = { border: '1px solid ' + C.border, borderRadius: 10, padding: '12px 14px', background: C.card, marginBottom: 10 }
    var rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    var pillStyle = function (on) {
      return {
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999,
        fontSize: 12, border: '1px solid ' + C.border, background: C.card2, color: C.text2,
      }
    }
    var dot = function (color) {
      return { width: 7, height: 7, borderRadius: 999, background: color, display: 'inline-block' }
    }
    var btn = {
      border: '1px solid ' + C.border, background: C.card, color: C.text, borderRadius: 6,
      padding: '3px 12px', fontSize: 12, cursor: 'pointer', font: 'inherit',
    }
    var btnPrimary = Object.assign({}, btn, { background: 'rgba(124,108,240,.10)', borderColor: 'rgba(124,108,240,.35)', color: C.primary, fontWeight: 600 })

    function ago(ts) {
      if (!ts) return '—'
      var s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
      if (s < 60) return s + ' 秒前'
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
      return Math.floor(s / 86400) + ' 天前'
    }
    function clock(ts) {
      var d = new Date(ts || 0)
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    function useStatus(interval) {
      var pair = useState(null)
      var data = pair[0]; var setData = pair[1]
      var errPair = useState(null)
      var err = errPair[0]; var setErr = errPair[1]
      var load = useCallback(function () {
        fetch(API + '/status', { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (j) { setData(j); setErr(null) })
          .catch(function (e) { setErr(String(e && e.message || e)) })
      }, [])
      useEffect(function () {
        load()
        var t = setInterval(load, interval || 8000)
        return function () { clearInterval(t) }
      }, [load, interval])
      return { data: data, err: err, reload: load }
    }

    function Pill(props) {
      return h('span', { style: pillStyle() }, h('span', { style: dot(props.tone || C.text3) }), props.label, props.value ? h('b', { style: { fontWeight: 600 } }, props.value) : null)
    }

    function StatusPanel(props) {
      var st = useStatus(props.interval || 8000)
      var d = st.data || {}
      var s = d.status || {}
      var bridge = d.bridge || {}
      var today = d.today || { in: 0, out: 0 }
      var recent = d.recent || []
      var contacts = d.contacts || []
      var linkOk = Boolean(s.link)

      var convPair = useState('')
      var conv = convPair[0]; var setConv = convPair[1]
      var txtPair = useState('')
      var txt = txtPair[0]; var setTxt = txtPair[1]
      var sendingPair = useState('')
      var sending = sendingPair[0]; var setSending = sendingPair[1]

      useEffect(function () {
        if (!conv && contacts.length) setConv(contacts[0].xtcId)
      }, [contacts.length, conv])

      function doSend() {
        if (!conv || !txt.trim()) return
        setSending('发送中…')
        fetch(API + '/send', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: conv, text: txt }),
        }).then(function (r) { return r.json() }).then(function (j) {
          setSending(j.ok ? '已发送' : '失败')
          if (j.ok) setTxt('')
          st.reload()
          setTimeout(function () { setSending('') }, 1500)
        }).catch(function (e) { setSending('失败：' + e.message) })
      }

      return h('div', { style: wrap },
        h('div', { style: Object.assign({}, rowStyle, { marginBottom: 10 }) },
          h('div', { style: { fontWeight: 600, fontSize: 14 } }, '小天才（小朋友）'),
          h('div', { style: { flex: 1 } }),
          h('button', { style: btn, onClick: st.reload }, '刷新')
        ),

        // 链路可用性（核心：一眼看出小天才通道通不通）
        h('div', { style: Object.assign({}, cardStyle, rowStyle) },
          h(Pill, { tone: linkOk ? C.ok : C.bad, label: '小天才链路 ', value: linkOk ? '正常' : '不可用' }),
          h(Pill, { tone: bridge.ok ? C.ok : C.bad, label: '桥接 ', value: bridge.ok ? '正常' : '断开' }),
          h(Pill, { tone: bridge.transportOk ? C.ok : C.warn, label: '传输 ', value: bridge.transportOk ? (bridge.transport || 'ok') : '未就绪' }),
          h(Pill, { tone: C.primary, label: '会话 ', value: String(s.sessionCount || 0) }),
          h(Pill, { tone: C.ok, label: '今日收 ', value: String(today['in'] || 0) }),
          h(Pill, { tone: C.text2, label: '今日发 ', value: String(today.out || 0) }),
          h(Pill, { tone: C.text3, label: '回复 ', value: String(s.replied || 0) })
        ),

        h('div', { style: { color: C.text3, fontSize: 12, marginBottom: 8 } },
          '最近轮询 ' + ago(s.lastPollAt) + (s.lastError ? ' · 错误：' + s.lastError : ' · 正常')),

        st.err ? h('div', { style: Object.assign({}, cardStyle, { color: C.bad }) }, '状态读取失败：', st.err) : null,

        h('div', { style: cardStyle },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '小朋友（联系人）'),
          contacts.length === 0
            ? h('div', { style: { color: C.text3 } }, '还没登记小朋友的小天才账号——在 xtc-bridge/people.json 填上她的 xtcId。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              contacts.map(function (p, i) {
                return h('div', { key: i, style: Object.assign({}, rowStyle, { justifyContent: 'space-between' }) },
                  h('div', null,
                    h('span', { style: { fontWeight: 500 } }, p.name || p.xtcId),
                    h('span', { style: { color: C.text3, marginLeft: 8, fontSize: 12 } }, p.xtcId)
                  ),
                  h('span', { style: { fontSize: 12, color: p.isChild ? C.warn : C.primary } }, p.isChild ? '儿童' : (p.relation || '联系人'))
                )
              })
            )
        ),

        // 小朋友的印象卡（来自 xtc-bridge 人物库 facts，xtc_persona_note 写入）
        h('div', { style: cardStyle },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '小朋友的印象卡'),
          (function () {
            var withFacts = contacts.filter(function (p) { return (p.facts || []).length })
            if (!withFacts.length) {
              return h('div', { style: { color: C.text3 } },
                '还没有记住关于小朋友的事——和她聊几句，小蓝会用 xtc_persona_note 把喜好/习惯记到这里。')
            }
            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              withFacts.map(function (p, i) {
                return h('div', { key: i },
                  h('div', null,
                    h('span', { style: { fontWeight: 600 } }, p.name || p.xtcId),
                    p.relation ? h('span', { style: { color: C.text3, fontSize: 12, marginLeft: 8 } }, p.relation) : null
                  ),
                  h('div', { style: { color: C.text2, fontSize: 12, marginTop: 2 } },
                    p.facts.slice(-8).map(function (f, k) { return h('div', { key: k }, '· ' + f) }))
                )
              }))
          })()
        ),

        h('div', { style: cardStyle },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '最近消息'),
          recent.length === 0
            ? h('div', { style: { color: C.text3 } }, '暂无（重启后新消息会出现在这里）')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              recent.map(function (m, i) {
                var mine = m.dir === 'out'
                return h('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                  h('span', { style: { color: C.text3, fontSize: 12, minWidth: 72 } }, clock(m.at)),
                  h('span', { style: { color: mine ? C.primary : C.text2, fontSize: 12, minWidth: 44 } }, m.who || (mine ? '我' : '对方')),
                  h('span', { style: { color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    String(m.text || '').slice(0, 60))
                )
              })
            )
        ),

        h('div', { style: cardStyle },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '手动发一条（代聊/调试）'),
          h('div', { style: Object.assign({}, rowStyle, { marginBottom: 8 }) },
            h('select', {
              value: conv, onChange: function (e) { setConv(e.target.value) },
              style: { padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.card, color: C.text, maxWidth: 320 },
            }, contacts.map(function (p, i) { return h('option', { key: i, value: p.xtcId }, p.name || p.xtcId) }))
          ),
          h('textarea', {
            value: txt, rows: 2, onChange: function (e) { setTxt(e.target.value) },
            placeholder: '要对小朋友说的话…',
            style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid ' + C.border, background: C.card2, color: C.text, font: 'inherit', resize: 'vertical' },
          }),
          h('div', { style: Object.assign({}, rowStyle, { marginTop: 8 }) },
            h('button', { style: btnPrimary, onClick: doSend, disabled: Boolean(sending) }, '发送'),
            h('span', { style: { color: C.text3, fontSize: 12 } }, sending)
          )
        ),

        h('div', { style: cardStyle },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '通道信息'),
          h('div', { style: { color: C.text3, fontSize: 12 } },
            '人设 ' + String(s.personaChars || 0) + ' 字 · 预设 ' + String(s.preset || '-') + ' · 儿童模式 开 · 目录 ' + String(s.cwd || '-'))
        )
      )
    }

    function ExtPanel() {
      return h('div', { style: { padding: 12 } }, h(StatusPanel, { interval: 6000 }))
    }

    function apply(ctx) {
      var slots = ctx && ctx.slots
      if (!slots) { console.warn('[xtc-muu] slots unavailable'); return }
      try {
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'xtc-muu', order: 34, label: '小天才' },
            function () { return h(StatusPanel, { interval: 10000 }) })
        })
      } catch (e) { console.warn('[xtc-muu] settings.section 注册失败', e) }
      try {
        slots.inject('conversation.view', function () {
          return slots.register(
            { name: 'conversation.view', id: 'xtc-muu-view', order: 83, label: '小天才' },
            ExtPanel)
        })
      } catch (e) { console.warn('[xtc-muu] conversation.view 注册失败', e) }
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
