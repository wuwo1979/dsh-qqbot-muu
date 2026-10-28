      function biliCardHtml() {
        return '<div class="dk-card" style="margin-top:10px;padding:10px;border:1px solid #e9ecef;border-radius:8px;background:#fff">'
          + '<div style="font-weight:700;font-size:13px;margin-bottom:6px">🎬 B 站管理（<我的B站号名>）</div>'
          + '<div id="dk-bili-state" style="font-size:11px;color:#666;margin-bottom:6px">加载中…</div>'
          + '<div id="dk-bili-list" style="font-size:12px;line-height:1.7"></div>'
          + '<button id="dk-bili-refresh" class="qqs-btn" style="margin-top:6px">刷新</button>'
          + '<span style="font-size:11px;color:#999;margin-left:6px">通过=自动投稿；驳回=丢弃；只在这里审核</span>'
          + '</div>'
      }
      function bindBiliCard() {
        var list = document.querySelector('#dk-bili-list')
        var state = document.querySelector('#dk-bili-state')
        if (!list || !state) return
        async function load() {
          state.textContent = '加载中…'
          try {
            var d = await api('bili')
            if (!d || d.ok === false) { state.textContent = '读取失败：' + ((d && d.error) || '?'); return }
            var jobs = d.jobs || []
            state.textContent = '共 ' + jobs.length + ' 个任务 · 记录 ' + ((d.records && d.records.length) || 0) + ' 条'
            list.innerHTML = jobs.length ? jobs.map(function (j) {
              return '<div style="padding:4px 0;border-bottom:1px dashed #eee">'
                + '<b>' + esc(j.title || j.id) + '</b> <span style="color:#888">' + esc(j.status || '') + '</span>'
                + (j.durationSec ? ' · ' + j.durationSec + 's' : '')
                + (j.published && j.published.bvid ? ' · BV' + esc(String(j.published.bvid).replace(/^BV/, '')) : '')
                + '<div style="margin-top:3px">'
                + '<button class="qqs-btn" data-bact="approve" data-bid="' + esc(j.id) + '">通过</button> '
                + '<button class="qqs-btn" data-bact="reject" data-bid="' + esc(j.id) + '">驳回</button>'
                + '</div></div>'
            }).join('') : '<div style="color:#999">还没有任务</div>'
            list.querySelectorAll('[data-bact]').forEach(function (b) {
              b.onclick = async function () {
                var act = b.getAttribute('data-bact'), id = b.getAttribute('data-bid')
                if (act === 'approve' && !confirm('通过并自动投稿到 B 站？')) return
                b.disabled = true
                try {
                  var r = await apiPost('bili', { action: act, jobId: id })
                  alert((r && r.ok ? '完成' : '失败') + (r && r.msg ? '：' + r.msg : (r && r.error ? '：' + r.error : '')))
                } catch (e) { alert('失败：' + ((e && e.message) || e)) }
                load()
              }
            })
          } catch (e) { state.textContent = '读取失败：' + ((e && e.message) || e) }
        }
        var rf = document.querySelector('#dk-bili-refresh')
        if (rf) rf.onclick = load
        load()
      }
