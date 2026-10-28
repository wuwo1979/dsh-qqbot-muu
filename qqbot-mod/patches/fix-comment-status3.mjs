// fix-comment-status3.mjs —— 评论复查 v3：台账 rpid 逐条判 + 顺带翻最近视频的最新评论，找出我没记账的
// 用法：node qqbot-mod/patches/fix-comment-status3.mjs [--check|--apply]
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const HOST = pluginPath('settings-host.js');
const START = `  // [qqbot-mod] comment-status v2`;
const END = `      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });`;

const NEW = `  // [qqbot-mod] comment-status v3：台账 rpid 逐条以"匿名能不能翻到"判定 + 扫最近视频最新评论补漏
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

      // ① 本地台账
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

      const vids = [];
      const pushVid = (b) => { const v = String(b || '').trim(); if (/^BV[0-9A-Za-z]{8,14}$/.test(v) && vids.indexOf(v) < 0) vids.push(v); };
      try { const lv = api.readLastVideo(root); if (lv && lv.bvid) pushVid(lv.bvid); } catch (e) {}
      for (const r of recs) { if (vids.length >= 4) break; pushVid(r.bvid); }

      const aidOf = new Map();
      for (const bvid of vids) {
        try {
          const m = await api.fetchVideoMeta(root, bvid);
          if (m && m.ok) aidOf.set(bvid, { aid: Number(m.aid || 0), title: String(m.title || '') });
        } catch (e) {}
      }

      // ② 台账 rpid 逐条判定（匿名翻 3 页 = 真判据）
      const rows = [];
      const seen = new Set();
      for (const r of recs) {
        if (rows.length >= limit) break;
        if (seen.has(r.rpid)) continue;
        seen.add(r.rpid);
        const meta = aidOf.get(r.bvid) || { aid: 0, title: '' };
        const item = { bvid: r.bvid, title: meta.title, rpid: r.rpid, text: r.text, at: r.at || null, aid: meta.aid, status: 'unknown', hint: '', href: 'https://www.bilibili.com/video/' + r.bvid };
        if (!meta.aid) { item.status = 'unknown'; item.hint = '拿不到 aid（视频可能已删）'; rows.push(item); continue; }
        let anon = null;
        try { anon = await api.locateComment(root, { aid: meta.aid, rpid: r.rpid, anon: true, pages: 3 }); } catch (e) {}
        if (anon && anon.ok && anon.found) {
          item.status = 'public'; item.state = anon.state; item.attr = anon.attr;
          item.hint = '匿名能翻到 = 真公开'; item.via = anon.via;
        } else {
          let self = null;
          try { self = await api.locateComment(root, { aid: meta.aid, rpid: r.rpid, anon: false, pages: 2 }); } catch (e) {}
          if (self && self.ok && self.found) {
            const folded = Math.floor(Number(self.attr || 0) / 2 ** 38) % 2 === 1;
            item.status = folded ? 'review' : 'hidden';
            item.state = self.state; item.attr = self.attr;
            item.hint = folded ? '被折叠：只有自己看得见' : '登录可见、匿名不可见（审核/降权）';
          } else if (r.type === 'comment-failed') { item.status = 'failed'; item.hint = '当时就没发出去'; }
          else { item.status = 'gone'; item.hint = '两边都翻不到：可能已删'; }
        }
        rows.push(item);
      }

      // ③ 补漏：翻每个候选视频"最新 20 条"，把属于我的、台账里没有的也列出来
      const extras = [];
      for (const bvid of vids) {
        const meta = aidOf.get(bvid); if (!meta || !meta.aid) continue;
        let r = null;
        try { r = await api.comments(root, { aid: meta.aid, limit: 20, sort: 'latest' }); } catch (e) {}
        const list = (r && r.ok && (r.replies || [])) || [];
        for (const c of list) {
          const mine = (myMid && String(c.mid) === myMid) || c.isSelf === true;
          if (!mine) continue;
          const rpid = String(c.rpid || '');
          if (!rpid || seen.has(rpid)) continue;
          seen.add(rpid);
          extras.push({
            bvid, title: meta.title, rpid, aid: meta.aid,
            text: String(c.text || ''), at: (Number(c.time || 0) || 0) * 1000 || null,
            state: Number(c.state ?? 0), attr: Number(c.attr ?? 0),
            status: 'public', hint: '线上最新评论里翻到（台账没记）', via: 'live-latest',
            href: 'https://www.bilibili.com/video/' + bvid,
          });
        }
      }

      const all = [...extras, ...rows].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
      writeJson(res, 200, { ok: true, root, myMid, checkedAt: Date.now(), videos: vids, liveCount: extras.length, rows: all });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });`;

const mode = process.argv.includes('--apply') ? 'apply' : 'check';
announce('评论复查 v3');
let src = readFileSync(HOST, 'utf8');
const crlf = src.includes('\r\n');
src = src.replace(/\r\n/g, '\n');
if (src.includes('comment-status v3')) { console.log('= 已是 v3'); process.exit(0); }
const i = src.indexOf(START);
if (i < 0) { console.log('✗ 找不到 v2 起点'); process.exit(2); }
const j = src.indexOf(END, i);
if (j < 0) { console.log('✗ 找不到 v2 终点'); process.exit(2); }
src = src.slice(0, i) + NEW + src.slice(j + END.length);
console.log('  ✔ 已替换为 v3');
if (mode === 'check') { console.log('[--check] 需要写入'); process.exit(0); }
copyFileSync(HOST, HOST + '.orig-muu-cst3');
writeFileSync(HOST, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');
try {
  execFileSync(process.execPath, ['--check', HOST], { stdio: 'pipe' });
  console.log('✔ 已写入（语法通过）');
} catch (e) {
  copyFileSync(HOST + '.orig-muu-cst3', HOST);
  console.log('✗ 语法失败，已回滚：' + String(e.stderr || e.message).slice(0, 300));
  process.exit(3);
}
