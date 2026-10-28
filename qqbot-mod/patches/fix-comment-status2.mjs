// fix-comment-status2.mjs —— 评论复查第二版：别再只看本地台账，直接去 B 站翻"我自己的评论"
//   host 路由仍是 GET /api/qqbot-settings/bili-comment-status
//   逻辑：候选视频 = 台账 bvid ∪ bili-last-video ∪ 最近任务 → 每站匿名翻 1~3 页 → 取 mid=我 的评论
//         → 状态一律以"匿名能不能看到"为准；台账里那些翻不到的再单独标出来
// 用法：node qqbot-mod/patches/fix-comment-status2.mjs [--check|--apply]
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const HOST = pluginPath('settings-host.js');
const START = `  // [qqbot-mod] comment-status：近 N 条评论的线上可见性（匿名视角才是真判据）`;
const END = `      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });`;

const NEW_ROUTE = `  // [qqbot-mod] comment-status v2：直接翻 B 站评论区，按"匿名能不能看到"给结论
  route(ctx, 'GET', '/api/qqbot-settings/bili-comment-status', async (req, res) => {
    try {
      const uq = new URL(req.url, 'http://x').searchParams;
      const ns = String(uq.get('ns') || '');
      const limit = Math.max(1, Math.min(20, Number(uq.get('limit') || 8)));
      const bot = nsBot(ns);
      const root = resolveMemoryRoot(bot);
      let api = null;
      try {
        const extRoot = join(String(bot.cwd || 'F:/qqbot'), 'dshqqbot', '.qqbot-extensions', 'lib', 'bili-api.mjs').replace(/\\\\/g, '/');
        api = await import('file:///' + extRoot);
      } catch (e) { api = null; }
      if (!api) return writeJson(res, 200, { ok: false, error: '找不到 bili-api.mjs' });

      const me = api.loadCookie(root);
      const myMid = String((me && me.cookies && me.cookies.DedeUserID) || '');

      // ① 本地台账：拿 bvid 与 rpid
      const files = [join(root, '.qqbot', 'bili-ops', 'records.jsonl'), join(root, '..', 'data', 'bili-ops', 'records.jsonl')];
      const recs = [];
      for (const fp of files) {
        if (!existsSync(fp)) continue;
        for (const ln of readFileSync(fp, 'utf8').split('\\n').filter(Boolean).slice(-600)) {
          try {
            const o = JSON.parse(ln);
            if (!o || !o.rpid) continue;
            recs.push({ at: Number(o.at || o.ts || 0), type: String(o.type || ''), rpid: String(o.rpid), bvid: String(o.bvid || ''), text: String(o.text || '') });
          } catch (e) {}
        }
      }
      recs.sort((a, b) => b.at - a.at);

      // ② 候选视频（最多 4 个）
      const vids = [];
      const pushVid = (b) => { const v = String(b || '').trim(); if (/^BV[0-9A-Za-z]{8,14}$/.test(v) && vids.indexOf(v) < 0) vids.push(v); };
      try { const lv = api.readLastVideo(root); if (lv && lv.bvid) pushVid(lv.bvid); } catch (e) {}
      for (const r of recs) { if (vids.length >= 4) break; pushVid(r.bvid); }

      // ③ 逐个视频翻评论区（匿名），只留我自己的
      const live = [];
      for (const bvid of vids) {
        let aid = 0, title = '';
        try { const m = await api.fetchVideoMeta(root, bvid); if (m && m.ok) { aid = Number(m.aid || 0); title = String(m.title || ''); } } catch (e) {}
        if (!aid) continue;
        for (let page = 0; page < 3; page += 1) {
          let r = null;
          try { r = await api.comments(root, { aid, limit: 20, page }); } catch (e) { r = null; }
          const list = (r && (r.list || r.items || (r.comments && r.comments.list))) || [];
          if (!list.length) break;
          for (const c of list) {
            const mid = String(c.mid || c.member?.mid || '');
            const uname = String((c.member && c.member.uname) || '');
            const isMine = (myMid && mid === myMid) || (!myMid && /小鲸鱼|MuU|muu/i.test(uname));
            if (!isMine) continue;
            live.push({
              bvid, title, aid,
              rpid: String(c.rpid || c.rpid_str || ''),
              text: String((c.content && c.content.message) || ''),
              at: Number(c.ctime || 0) * 1000,
              state: Number(c.state ?? 0),
              attr: Number(c.attr ?? 0),
              status: 'public',
              hint: '匿名能翻到 = 真发出来了',
              via: 'live-anon#' + (page + 1),
            });
          }
        }
      }

      // ④ 台账里有、线上没翻到的（可能被折叠/在审核/已删）
      const seen = new Set(live.map((x) => x.rpid));
      const missing = [];
      for (const r of recs) {
        if (missing.length >= limit) break;
        if (seen.has(r.rpid)) continue;
        missing.push({
          bvid: r.bvid, rpid: r.rpid, text: r.text, at: r.at,
          status: r.type === 'comment-failed' ? 'failed' : 'review',
          hint: r.type === 'comment-failed' ? '当时就没发出去' : '线上翻不到（折叠/审核/已删）；登录态能看到就是"只有自己可见"',
          via: 'ledger',
        });
      }

      const rows = [...live, ...missing].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
      writeJson(res, 200, { ok: true, root, myMid, checkedAt: Date.now(), videos: vids, liveCount: live.length, rows });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
`;

const mode = process.argv.includes('--apply') ? 'apply' : 'check';
announce('评论复查 v2（直接翻线上）');
let src = readFileSync(HOST, 'utf8');
const crlf = src.includes('\r\n');
src = src.replace(/\r\n/g, '\n');
if (src.includes('comment-status v2')) { console.log('= 已是 v2'); process.exit(0); }
const i = src.indexOf(START);
if (i < 0) { console.log('✗ 找不到 v1 路由起点'); process.exit(2); }
const j = src.indexOf(END, i);
if (j < 0) { console.log('✗ 找不到 v1 路由终点'); process.exit(2); }
const before = src.length;
src = src.slice(0, i) + NEW_ROUTE + src.slice(j + END.length);
console.log(`  ✔ 替换 v1 路由（${before} → ${src.length} 字符）`);
if (mode === 'check') { console.log('\n[--check] 需要写入（加 --apply 生效）'); process.exit(0); }
copyFileSync(HOST, HOST + '.orig-muu-cst2');
writeFileSync(HOST, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');
try {
  execFileSync(process.execPath, ['--check', HOST], { stdio: 'pipe' });
  console.log(`✔ 已写入 ${HOST}（语法通过）`);
} catch (e) {
  copyFileSync(HOST + '.orig-muu-cst2', HOST);
  console.log('✗ 语法检查失败，已回滚：' + String(e.stderr || e.message).slice(0, 300));
  process.exit(3);
}
