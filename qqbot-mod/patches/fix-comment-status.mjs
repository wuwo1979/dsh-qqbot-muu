// fix-comment-status.mjs —— B 站评论「到底发出去没有」：近 5 条评论的线上状态复查
//   host: GET /api/qqbot-settings/bili-comment-status?limit=5[&refresh=1&ns=]
//   client: B 站管理页「💬 我的评论」块 + 🔄 复查
// 用法：node qqbot-mod/patches/fix-comment-status.mjs [--check|--apply]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { pluginPath, announce } from './plugin-dir.mjs';

const CLIENT = 'client/qqbot-settings.js';
const HOST = 'settings-host.js';
const MARK = '[qqbot-mod] comment-status';

const HOST_ROUTE = `
  // [qqbot-mod] comment-status：近 N 条评论的线上可见性（匿名视角才是真判据）
  route(ctx, 'GET', '/api/qqbot-settings/bili-comment-status', async (req, res) => {
    try {
      const uq = new URL(req.url, 'http://x').searchParams;
      const ns = String(uq.get('ns') || '');
      const force = String(uq.get('refresh') || '') === '1';
      const limit = Math.max(1, Math.min(10, Number(uq.get('limit') || 5)));
      const bot = nsBot(ns);
      const root = resolveMemoryRoot(bot);
      const files = [join(root, '.qqbot', 'bili-ops', 'records.jsonl'), join(root, '..', 'data', 'bili-ops', 'records.jsonl')];
      const rows = [];
      for (const fp of files) {
        if (!existsSync(fp)) continue;
        const lines = readFileSync(fp, 'utf8').split('\\n').filter(Boolean).slice(-400);
        for (const ln of lines) {
          try {
            const o = JSON.parse(ln);
            if (!o || !o.type || !String(o.type).startsWith('comment')) continue;
            if (!o.rpid) continue;
            rows.push({ at: Number(o.at || o.ts || 0), type: o.type, rpid: String(o.rpid), bvid: String(o.bvid || ''), text: String(o.text || ''), state: o.state, attr: o.attr });
          } catch (e) {}
        }
      }
      rows.sort((a, b) => b.at - a.at);
      const seen = new Set();
      const picked = [];
      for (const r of rows) {
        if (seen.has(r.rpid)) continue;
        seen.add(r.rpid);
        picked.push(r);
        if (picked.length >= limit) break;
      }
      let api = null;
      try {
        const extRoot = join(String(bot.cwd || 'F:/qqbot'), 'dshqqbot', '.qqbot-extensions', 'lib', 'bili-api.mjs').replace(/\\\\/g, '/');
        api = await import('file:///' + extRoot);
      } catch (e) { api = null; }
      const out = [];
      for (const r of picked) {
        const item = Object.assign({}, r, { status: 'unknown', hint: '' });
        if (api && typeof api.locateComment === 'function') {
          let aid = 0;
          try {
            if (typeof api.fetchVideoMeta === 'function' && r.bvid) {
              const m = await api.fetchVideoMeta(root, r.bvid);
              if (m && m.ok) aid = Number(m.aid || 0);
            }
            if (!aid && typeof api.resolveVideoRef === 'function') {
              const v = await api.resolveVideoRef(root, r.bvid);
              aid = (v && (v.aid || (v.video && v.video.aid))) || 0;
            }
          } catch (e) {}
          if (!aid) {
            item.status = 'unknown';
            item.hint = '拿不到 aid（视频可能已删或在审核），无法复查';
            item.checkedAt = Date.now();
            out.push(item);
            continue;
          }
          let anon = null;
          try { anon = await api.locateComment(root, { aid, rpid: r.rpid, anon: true, pages: 3 }); } catch (e) { anon = { ok: false }; }
          if (anon && anon.ok && anon.found) {
            item.status = 'public';
            item.state = anon.state;
            item.attr = anon.attr;
            item.hint = '匿名视角能看到 = 真发出去了';
          } else {
            let self = null;
            try { self = await api.locateComment(root, { aid, rpid: r.rpid, anon: false, pages: 2 }); } catch (e) { self = null; }
            if (self && self.ok && self.found) {
              const folded = Math.floor(Number(self.attr || 0) / 2 ** 38) % 2 === 1;
              item.status = folded ? 'review' : 'hidden';
              item.state = self.state;
              item.attr = self.attr;
              item.hint = folded ? '被折叠：只有自己看得见' : '登录态能看到、匿名看不到（多半在审核）';
            } else if (r.type === 'comment-failed') {
              item.status = 'failed';
              item.hint = '当时就没发出去';
            } else {
              item.status = 'gone';
              item.hint = '两边都找不到：可能已被删';
            }
          }
        } else {
          item.hint = '没找到 bili-api.mjs，只能显示本地记录';
        }
        item.checkedAt = Date.now();
        out.push(item);
      }
      writeJson(res, 200, { ok: true, root, checkedAt: Date.now(), refreshed: force, rows: out });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
`;

const CLIENT_UI = `
        // [qqbot-mod] comment-status：我的评论（近 5 条）+ 复查
        body += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:10px 0 2px;gap:8px;align-items:center">'
          + '<span>💬 我的评论（近 5 条）</span>'
          + '<button class="dk-btn" id="dk-cst-refresh" style="font-size:11px;padding:1px 8px">🔄 复查</button>'
          + '<span class="dk-msg" id="dk-cst-hint" style="font-size:10px;color:#999">' + esc(state.commentStatus ? ('上次检查 ' + new Date(Number(state.commentStatus.checkedAt) || 0).toLocaleTimeString()) : '还没查过') + '</span></div>'
        body += '<div id="dk-cst-box" style="font-size:11px;line-height:1.7">' + commentStatusHtml() + '</div>'
`;

const CLIENT_FNS = `
      function commentStatusHtml() {
        var d = state.commentStatus
        if (!d) return '<div style="color:#999">点「🔄 复查」看最近 5 条评论到底发出去没有（匿名视角为准）</div>'
        if (d.error) return '<div style="color:#c92a2a">' + esc(String(d.error)) + '</div>'
        var rows = d.rows || []
        if (!rows.length) return '<div style="color:#999">本地台账里还没有评论记录</div>'
        var map = {
          public: ['✅', '#2f9e44', '公开'],
          review: ['⏳', '#e8590c', '折叠/审核'],
          hidden: ['⚠️', '#e8590c', '仅自己可见'],
          gone: ['❌', '#c92a2a', '看不到'],
          failed: ['❌', '#c92a2a', '没发出'],
          unknown: ['·', '#999', '未知']
        }
        return rows.map(function (r) {
          var m = map[r.status] || map.unknown
          var t = new Date(Number(r.at) || 0)
          var ds = isNaN(t.getTime()) ? '' : ((t.getMonth() + 1) + '/' + t.getDate())
          return '<div style="border-bottom:1px dashed #f0ecff;padding:3px 0">'
            + '<span style="color:#888">' + ds + '</span> '
            + '<b style="color:' + m[1] + '">' + m[0] + ' ' + m[2] + '</b>'
            + ' · <span style="color:#666">' + esc(String(r.text || '').slice(0, 34)) + '</span>'
            + (r.bvid ? ' · <a href="https://www.bilibili.com/video/' + esc(r.bvid) + '" target="_blank" style="color:#1971c2">' + esc(r.bvid) + '</a>' : '')
            + '<div style="color:#aaa;font-size:10px">rpid ' + esc(r.rpid) + (r.attr ? (' · attr ' + esc(String(r.attr))) : '') + (r.hint ? (' · ' + esc(r.hint)) : '') + '</div>'
            + '</div>'
        }).join('')
      }
      function loadCommentStatus(force) {
        var box = panel && panel.querySelector('#dk-cst-box')
        if (box) box.innerHTML = '<div style="color:#999">' + (force ? '正在匿名复查最近 5 条…（每条翻 3 页，10~30 秒）' : '读取…') + '</div>'
        api('bili-comment-status', { ns: state.ns || undefined, limit: 5, refresh: force ? 1 : 0 }).then(function (d) {
          state.commentStatus = (d && d.ok) ? d : { rows: [], checkedAt: Date.now(), error: (d && d.error) || '接口没有返回' }
          var b2 = panel && panel.querySelector('#dk-cst-box')
          if (b2) b2.innerHTML = commentStatusHtml()
          var hint = panel && panel.querySelector('#dk-cst-hint')
          if (hint) hint.textContent = '上次检查 ' + new Date().toLocaleTimeString()
        }).catch(function (e) {
          var b3 = panel && panel.querySelector('#dk-cst-box')
          if (b3) b3.innerHTML = '<div style="color:#c92a2a">' + esc(String((e && e.message) || e)) + '</div>'
        })
      }
`;

const ops = [
  {
    rel: HOST,
    label: 'host 加 bili-comment-status 路由',
    guard: '/api/qqbot-settings/bili-comment-status',
    run(src) {
      const anchor = "route(ctx, ['GET', 'POST'], '/api/qqbot-settings/timers'";
      const i = src.indexOf(anchor);
      if (i < 0) throw new Error('找不到 timers 路由锚点');
      const lineStart = src.lastIndexOf('\n', i) + 1;
      return src.slice(0, lineStart) + HOST_ROUTE + '\n' + src.slice(lineStart);
    },
  },
  {
    rel: CLIENT,
    label: 'B站管理页加「💬 我的评论」块',
    guard: 'id="dk-cst-box"',
    run(src) {
      const anchor = "} else if (state.tab === 'bili') {\n          body += biliCardHtml()";
      const i = src.indexOf(anchor);
      if (i < 0) throw new Error('找不到 bili tab 锚点');
      const at = i + anchor.length;
      return src.slice(0, at) + '\n' + CLIENT_UI + src.slice(at);
    },
  },
  {
    rel: CLIENT,
    label: '加 commentStatusHtml / loadCommentStatus',
    guard: 'function commentStatusHtml',
    run(src) {
      const anchor = '      function biliRecordsRender(records) {';
      if (!src.includes(anchor)) throw new Error('找不到 biliRecordsRender 锚点');
      return src.replace(anchor, CLIENT_FNS + '\n' + anchor);
    },
  },
  {
    rel: CLIENT,
    label: 'bindBiliCard 里挂上复查按钮',
    guard: 'dk-cst-refresh',
    run(src) {
      const anchor = '      function bindBiliCard() {';
      if (!src.includes(anchor)) throw new Error('找不到 bindBiliCard');
      return src.replace(anchor, anchor + `
        var _cstB = panel && panel.querySelector('#dk-cst-refresh')
        if (_cstB) _cstB.onclick = function () { loadCommentStatus(true) }
        if (!state.commentStatus) { try { loadCommentStatus(false) } catch (eCS) {} }`);
    },
  },
];

function main() {
  const apply = process.argv.includes('--apply');
  announce('B 站评论状态复查');
  const cache = new Map();
  let changed = 0;
  for (const op of ops) {
    const file = pluginPath(op.rel);
    if (!cache.has(file)) cache.set(file, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    const src = cache.get(file);
    if (src.includes(op.guard)) { console.log('  = 已是新版：' + op.label); continue; }
    const out = op.run(src);
    cache.set(file, out);
    changed += 1;
    console.log('  ' + (apply ? '✔' : '!') + ' ' + op.label);
  }
  if (!apply) { console.log(changed ? '  ! ' + changed + ' 处需要写入' : '  = 已是最新'); return; }
  if (!changed) { console.log('  = 已是最新，无需写入'); return; }
  for (const [file, src] of cache) {
    if (!existsSync(file)) continue;
    copyFileSync(file, file + '.orig-muu');
    writeFileSync(file, src.replace(/\n/g, '\r\n'), 'utf8');
    console.log('  ✔ 写入 ' + String(file).split('node_modules').pop() + '（' + MARK + '）');
  }
}

main();
