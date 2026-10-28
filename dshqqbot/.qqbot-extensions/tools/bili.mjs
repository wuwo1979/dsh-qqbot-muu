/**
 * tools/bili.mjs — B 站工具（扫码登录 / 读动态收藏 / 看视频评论 / 发评论 / 存表情）
 *
 * 用户 2026-10-23 定的边界：
 *  · 只在"我 @ 它"或"我设定的时间"操作，不自行乱逛、不乱评论；
 *  · 评论前要看清视频，只发一条、每天有上限；
 *  · 登录失效要留下汇报标记，让下一次对话主动告诉主人。
 *
 * 所有数据落 F:\\qqbot\\dshqqbot（memory-config.dataRoot）：
 *  · bili-cookie.json  Cookie（本地，不外传）
 *  · bili-config.json  定时/评论上限
 *  · .qqbot/bili-login-lost.flag  登录失效汇报标记
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as B from '../lib/bili-api.mjs';
import * as SH from '../lib/bili-share.mjs';

const DATA_ROOT_FALLBACK = 'F:/qqbot/dshqqbot';

function dataRoot() {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  try {
    const cfg = JSON.parse(readFileSync(join(DATA_ROOT_FALLBACK, 'memory-config.json'), 'utf8'));
    return cfg.dataRoot || DATA_ROOT_FALLBACK;
  } catch { return DATA_ROOT_FALLBACK; }
}

function metaDir(root) {
  const d = join(root, '.qqbot');
  try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}

function markLoginLost(root, why) {
  try {
    writeFileSync(join(metaDir(root), 'bili-login-lost.flag'), JSON.stringify({ ts: Date.now(), why: String(why || '') }), 'utf8');
  } catch { /* ignore */ }
}

function clearLoginLost(root) {
  try {
    const p = join(metaDir(root), 'bili-login-lost.flag');
    if (existsSync(p)) writeFileSync(p, '', 'utf8');
  } catch { /* ignore */ }
}

function commentQuota(root, cfg) {
  const p = join(metaDir(root), 'bili-comment-count.json');
  const today = new Date().toISOString().slice(0, 10);
  let state = { date: today, n: 0 };
  try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j.date === today) state = j; } catch { /* ignore */ }
  return {
    state,
    save() { try { writeFileSync(p, JSON.stringify(state), 'utf8'); } catch { /* ignore */ } },
    limit: Number(cfg?.comment?.dailyLimit) > 0 ? Number(cfg.comment.dailyLimit) : 5,
  };
}

/** 找插件包里的 sticker-store.js（同 hooks/sticker-trash.mjs 的做法） */
function resolveStickerStore() {
  const rel = join('node_modules', '@zaofan', 'dsh-qqbot', 'dist', 'features', 'sticker-store.js');
  const roots = [];
  try { roots.push(process.cwd()); } catch { /* ignore */ }
  const appdata = process.env.APPDATA || '';
  if (appdata) {
    const base = join(appdata, 'dsh-desktop', 'harness', 'profiles');
    try {
      for (const p of readdirSync(base)) roots.push(join(base, p));
    } catch { /* ignore */ }
  }
  for (const r of roots) {
    const p = join(r, rel);
    if (existsSync(p)) return p;
  }
  return '';
}

async function captureImages(root, urls, meta, logger) {
  const storePath = resolveStickerStore();
  if (!storePath) return { ok: false, error: '找不到插件内的 sticker-store.js' };
  const mod = await import(pathToFileURL(storePath).href);
  const dir = join(root, '表情包');
  mod.configureStickerStore(dir, logger);
  const store = mod.getStickerStore(dir);
  const out = [];
  for (const u of urls) {
    const r = await store.capture(u, {
      sourceGroup: meta.sourceGroup || 'bili',
      senderId: 'bili',
      senderName: 'B站',
      msgText: meta.msgText || '',
      tags: meta.tags || [],
      desc: meta.desc || '',
      sourceUrl: u,
    });
    out.push({ url: u, status: r.status, id: r.id, error: r.error });
  }
  const fresh = out.filter((x) => x.status === 'new').length;
  const dup = out.filter((x) => x.status === 'dup').length;
  const err = out.filter((x) => x.status === 'error');
  // B 站图片是直接 capture 进库的，不经过插件的"新图自动打标"中间件；
  // 这里后台补一次本地视觉打标（不阻塞工具返回）。
  try {
    const { spawn } = await import('node:child_process');
    const cli = 'F:/qqbot/qqbot-mod/scripts/sticker-tag-one.mjs';
    for (const x of out.filter((y) => y.status === 'new').slice(0, 5)) {
      const file = store.pathOf(x.id);
      if (!file) continue;
      // 宿主 execPath 可能是 Electron 壳：显式带 ELECTRON_RUN_AS_NODE=1 才会按 node 跑脚本
      spawn(process.execPath, [cli, dir, x.id], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }).unref();
    }
  } catch { /* 打标失败不影响入库 */ }
  return {
    ok: fresh > 0 || dup > 0,
    fresh, dup, failed: err.length,
    ids: out.filter((x) => x.status === 'new').map((x) => x.id),
    error: err.length ? err.map((e) => e.error).join('; ') : '',
  };
}

const lines = (arr) => arr.filter(Boolean).join('\n');

/**
 * 追加一条操作记录到 bili-ops/records.jsonl（浮窗「B站管理 → 近期操作」读的就是它）。
 * 2026-10-25 修：动态 post/remove 原来只写 .qqbot/bili-dynamic-log.jsonl，
 * 浮窗根本不读那个文件 —— 主人发了动态在浮窗里查无此事。这里自己落一行，
 * 格式对齐 bili-ops.mjs 的 appendRecord（不 import 那边，避免把整个视频/绘画链拖进来）。
 */
function appendOpRecord(root, rec = {}) {
  try {
    let dir = join(root, '.qqbot', 'bili-ops');
    try {
      const c = JSON.parse(readFileSync(join(root, 'bili-ops-config.json'), 'utf8'));
      const custom = String(c?.storage?.root || '').trim();
      if (custom) dir = custom;
    } catch { /* 用默认 */ }
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const ts = Date.now();
    writeFileSync(join(dir, 'records.jsonl'), JSON.stringify({ ts, at: new Date(ts).toISOString(), ...rec }) + '\n', { flag: 'a' });
  } catch { /* 记录失败不影响主流程 */ }
}

/** 读最近若干条操作记录（只看尾部，读不到就给空数组）。 */
function readOpRecords(root, limit = 100) {
  try {
    let dir = join(root, '.qqbot', 'bili-ops');
    try {
      const c = JSON.parse(readFileSync(join(root, 'bili-ops-config.json'), 'utf8'));
      const custom = String(c?.storage?.root || '').trim();
      if (custom) dir = custom;
    } catch { /* 用默认 */ }
    const fp = join(dir, 'records.jsonl');
    if (!existsSync(fp)) return [];
    const lines = readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const ln of lines.slice(-Math.max(1, limit))) {
      try { out.push(JSON.parse(ln)); } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch { return []; }
}

/** 未登录/失效统一话术；只有"原本有 cookie 但现在失效"才写汇报标记 */
function loginFail(r, root) {
  if (r.needLogin && B.loadCookie(root)) {
    markLoginLost(root, r.error);
    return { ok: false, needLogin: true, msg: '登录已失效，需要重新扫码（已记录汇报标记）。' };
  }
  return { ok: false, needLogin: true, msg: 'B 站还没登录，先 action=login_start 生成二维码。' };
}

async function run(args = {}, env = {}) {
  const root = dataRoot();
  const cfg = B.loadConfig(root);
  const logger = env.logger;
  const action = String(args.action || 'status').trim();

  if (cfg.enabled === false && action !== 'status') return { ok: false, msg: 'B 站能力已在 bili-config.json 里关闭（enabled=false）' };

  // ── 扫码登录 ──
  if (action === 'login_start') {
    // 安全：谁先扫二维码，Cookie 就是谁的号 —— 群里发等于把登录权交给所有人。
    // 只允许私聊里生成（扫码的是主人本人），群聊直接拒绝并说明原因。
    const scope = String(env.caps?.scope || '');
    if (scope.startsWith('group:')) {
      return { ok: false, msg: 'B 站登录二维码只能在私聊里发：群里发出去，谁先扫就登录了谁的号。请私聊我再说一次「登录B站」。' };
    }
    const q = await B.qrGenerate();
    if (!q.ok) return { ok: false, msg: `生成登录二维码失败：${q.error}` };
    try {
      writeFileSync(join(metaDir(root), 'bili-qr.json'), JSON.stringify({ key: q.key, ts: Date.now() }), 'utf8');
    } catch { /* ignore */ }
    const png = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(q.url)}`;
    return {
      ok: true,
      msg: lines([
        'B 站扫码登录已生成，二维码 3 分钟内有效。',
        `请把这张图发给主人：[MEDIA:image|${png}]`,
        '扫完后调用 action=login_poll 查结果。',
        `（备用登录链接：${q.url}）`,
        '⚠️ 二维码里含一次性的登录票据，只发给主人本人，不要发群。',
      ]),
    };
  }

  if (action === 'login_poll') {
    let key = String(args.key || '').trim();
    if (!key) {
      try { key = JSON.parse(readFileSync(join(metaDir(root), 'bili-qr.json'), 'utf8')).key || ''; } catch { /* ignore */ }
    }
    if (!key) return { ok: false, msg: '没有待轮询的二维码，先 action=login_start' };
    const r = await B.qrPoll(key);
    if (!r.ok) return { ok: false, msg: `查询失败：${r.error}` };
    if (r.state === 'wait') return { ok: true, msg: '还没扫码。请主人用 B 站 App 扫二维码。' };
    if (r.state === 'scanned') return { ok: true, msg: '已扫码，等主人在手机上点确认。' };
    if (r.state === 'expired') return { ok: false, msg: '二维码已过期，请重新 action=login_start。' };
    B.saveCookie(root, r.cookies, {});
    const me = await B.nav(root);
    const name = me.ok ? me.data.name : '';
    const mid = me.ok ? me.data.mid : '';
    B.saveCookie(root, r.cookies, { name, mid });
    clearLoginLost(root);
    logger?.info?.(`[bili] 扫码登录成功${name ? `：${name}` : ''}`);
    return { ok: true, msg: `登录成功${name ? `：${name}` : ''}。Cookie 已存到本地，之后可以读动态/收藏、发评论。` };
  }

  // ── 状态 ──
  if (action === 'status') {
    const c = B.loadCookie(root);
    if (!c) return { ok: true, msg: 'B 站未登录。action=login_start 生成二维码。' };
    const me = await B.nav(root);
    if (!me.ok) {
      if (me.needLogin) markLoginLost(root, me.error);
      return { ok: false, needLogin: !!me.needLogin, msg: me.needLogin ? '登录已失效，需要重新扫码（已记录汇报标记）。' : `查询失败：${me.error}` };
    }
    return { ok: true, msg: `已登录：${me.data.name}（UID ${me.data.mid}，Lv${me.data.level ?? '?'}${me.data.vip ? `，${me.data.vip}` : ''}）` };
  }

  // ── 读我的动态 ──
  if (action === 'dynamics') {
    const r = await B.dynamics(root, { limit: args.limit || 5 });
    if (!r.ok) {
      if (r.needLogin) return loginFail(r, root);
      return { ok: false, msg: `读动态失败：${r.error}` };
    }
    if (!r.items.length) return { ok: true, msg: '动态列表是空的。' };
    const text = r.items.map((it, i) => {
      const when = it.time ? new Date(it.time * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
      return lines([
        `${i + 1}. ${it.title || (it.text || '').slice(0, 40) || '(无正文)'}`,
        it.author ? `   来自 ${it.author}${when ? ` · ${when}` : ''}` : '',
        it.bvid ? `   BV：${it.bvid}` : '',
        it.images.length ? `   配图 ${it.images.length} 张` : '',
        it.text && it.title ? `   正文：${it.text.slice(0, 100)}` : '',
      ]);
    }).join('\n');
    let extra = '';
    if (args.collect) {
      const urls = r.items.flatMap((it) => it.images).slice(0, Math.max(1, Math.min(10, args.limit || 5)));
      if (urls.length) {
        const c = await captureImages(root, urls, { sourceGroup: 'bili', desc: 'B站动态配图', tags: ['B站'] }, logger);
        extra = c.ok ? `\n已存 ${c.fresh} 张新图到表情包候选区（重复 ${c.dup} 张）。` : `\n存图失败：${c.error}`;
      }
    }
    return { ok: true, msg: `最近 ${r.items.length} 条动态：\n${text}${extra}` };
  }

  // ── 收藏夹 ──
  if (action === 'favorites') {
    const r = await B.favorites(root, { limit: args.limit || 10 });
    if (!r.ok) {
      if (r.needLogin) return loginFail(r, root);
      return { ok: false, msg: `读收藏夹失败：${r.error}` };
    }
    return { ok: true, msg: r.folders.length ? r.folders.map((f, i) => `${i + 1}. ${f.title}（${f.count} 个，id=${f.id}）`).join('\n') : '没有收藏夹。' };
  }

  if (action === 'fav_items') {
    const r = await B.favItems(root, { mediaId: args.mediaId, limit: args.limit || 10 });
    if (!r.ok) return { ok: false, msg: `读收藏内容失败：${r.error}` };
    return { ok: true, msg: r.items.map((m, i) => `${i + 1}. ${m.title}${m.upper ? `（UP：${m.upper}）` : ''} · BV：${m.bvid}`).join('\n') || '收藏夹是空的。' };
  }

  // ── 视频 / 评论 ──
  if (action === 'comment') {
    const q0 = commentQuota(root, cfg);
    if (q0.state.n >= q0.limit) return { ok: false, msg: `今天的 B 站评论额度已用完（${q0.limit} 条/天），明天再来。` };
    if (!String(args.message || '').trim()) return { ok: false, msg: 'comment 需要 message（评论内容）' };
  }

  /**
   * [qqbot-mod] like 2026-10-28：给视频/评论点赞、取消赞。
   * 视频：给 bvid/link/最近那条；也认 aid。
   * 评论：需要 rpid（+ 视频），action=0 表示取消。
   */
  if (action === 'like' || action === 'like-comment') {
    const want = String(args.like ?? args.action2 ?? '').toLowerCase();
    const off = want === 'off' || want === '0' || want === '取消' || want === 'unlike';
    if (action === 'like-comment') {
      const rpid = String(args.rpid || args.root || '').trim();
      if (!/^\d+$/.test(rpid)) return { ok: false, msg: 'like-comment 需要 rpid（要赞的那条评论 id）' };
      let aid = String(args.aid || '').trim();
      if (!aid) {
        const t = await resolveTarget();
        if (t && t.error) return { ok: false, msg: '找不到视频：' + t.error };
        if (t && t.bvid) {
          const m = await B.video(root, { bvid: t.bvid });
          aid = m && m.ok && m.video ? String(m.video.aid) : '';
        }
      }
      if (!aid) return { ok: false, msg: 'like-comment 需要 aid 或一个能定位的视频（bvid/link/最近那条）' };
      const r = await B.likeComment(root, { aid, rpid, action: off ? 0 : 1 });
      if (!r.ok) return { ok: false, msg: r.error || '点赞失败了', detail: r };
      return { ok: true, msg: `${r.msg}（评论 ${rpid}）`, detail: r };
    }
    // 视频点赞
    let aid = String(args.aid || '').trim();
    let bvid = String(args.bvid || '').trim();
    if (!aid && !bvid) {
      const t = await resolveTarget();
      if (t && t.error) return { ok: false, msg: '找不到视频：' + t.error };
      if (t && t.bvid) bvid = t.bvid;
    }
    if (!aid && !bvid) return { ok: false, msg: 'like 需要 bvid / aid / link，或者先前分享过一条视频' };
    const r = await B.likeVideo(root, { aid, bvid, like: off ? 2 : 1, wait: !!args.wait });
    if (!r.ok) return { ok: false, msg: r.error || '点赞失败了', detail: r };
    appendOpRecord(root, { type: off ? 'unlike' : 'like', bvid: r.bvid || bvid, aid: r.aid, at: Date.now() });
    return { ok: true, msg: `${r.msg}${r.bvid ? `（${r.bvid}）` : ''}`, detail: r };
  }

  // ── 最近记住的那个视频（"评论一下刚才那个"靠它命中，2026-10-26 加） ──
  if (action === 'last') {
    const last = B.readLastVideo(root);
    if (!last || !last.bvid) {
      return { ok: false, msg: '还没记住任何视频。先让我看一眼（video）或分享一次（share），我就记住了。' };
    }
    const when = last.at ? new Date(last.at).toLocaleString('zh-CN', { hour12: false }) : '';
    return {
      ok: true,
      msg: lines([
        `最近记住的视频：${last.title || '（标题没存到）'}`,
        `${last.url || B.videoUrl(last.bvid)}`,
        `BV：${last.bvid}${last.aid ? ` · aid：${last.aid}` : ''}`,
        `记于 ${when}${last.by ? ` · 来自 ${last.by}` : ''}${last.source ? ` · ${last.source}` : ''}`,
      ]),
      last,
    };
  }

  /**
   * 视频从哪来（问题 C）：
   *  1) 主人直接给的：bvid 参数 / link 参数 / 正文里的 BV 号、av 号、b23.tv 短链 —— 优先用给的
   *  2) 都没给就看 .qqbot/bili-last-video.json（最近被分享/被评论/被看过的那条）
   */
  const resolveTarget = async () => {
    const raw = String(args.bvid || args.link || args.url || '').trim();
    let target = raw;
    if (!target) {
      const picked = B.extractVideoRef([args.text, args.message, args.query].filter(Boolean).join(' '));
      if (picked) target = picked.bvid || (picked.avid ? `av${picked.avid}` : '') || picked.short || picked.raw || '';
    }
    if (!target) {
      const last = B.readLastVideo(root);
      if (last && last.bvid) return { bvid: last.bvid, via: 'last', last };
      return null;
    }
    const rv = await B.resolveVideoRef(root, target);
    if (!rv.ok) return { error: rv.error, from: target };
    return { bvid: rv.bvid, via: rv.via, from: target };
  };

  let vid = null;
  if (action === 'video' || action === 'comments' || action === 'comment' || action === 'share') {
    const t = await resolveTarget();
    if (!t) return { ok: false, msg: '这是哪个视频呀？给我 BV 号或链接；或者让我先看一次/分享一次，我记住就能直接说"刚才那个"。' };
    if (t.error) return { ok: false, msg: `找不到这个视频（${t.from}）：${t.error}` };
    vid = await B.video(root, { bvid: t.bvid });
    if (!vid.ok) {
      if (vid.needLogin) return loginFail(vid, root);
      return { ok: false, msg: `读视频失败：${vid.error}` };
    }
    vid.target = t;
    // 看过/分享/评论过的视频都记下来，下次说"刚才那个"能命中
    await B.rememberVideo(root, {
      bvid: vid.video.bvid,
      aid: vid.video.aid,
      title: vid.video.title,
      by: String(env?.caps?.peer?.peerId || ''),
      source: t.via === 'last' ? `tool:${action}` : `tool:${action}:${t.via}`,
    });
  }

  /**
   * 把视频发成一条「链接 + 封面」卡片；发不出去也留档。
   * 只有一条消息 ⇒ 不会一天烧掉两条主动消息额度。
   */
  const doShare = async (v, extra = {}) => {
    const cover = await SH.saveCover(root, v.bvid, v.cover);
    const coverSrc = cover.ok ? cover.path : (v.cover || '');
    const mdV = extra.afterComment && extra.comment ? { ...v, comment: extra.comment } : v;
    const md = SH.buildShareMarkdown(mdV, coverSrc);
    const text = SH.buildShareText(v);
    const peer = env?.caps?.peer || {};
    const sent = await SH.sendShareCard(env, md, text, peer);
    SH.recordShare(root, SH.sharePayloadOf(v, {
      scope: String(peer.scope || ''),
      peerId: String(peer.peerId || ''),
      coverLocal: cover.ok ? cover.path : '',
      coverError: cover.ok ? '' : (cover.error || ''),
      sent: sent.ok,
      via: sent.via,
      ...extra,
    }));
    if (sent.ok) logger?.info?.(`[bili] 已分享 ${v.bvid}（${sent.via}）`);
    return { sent, cover };
  };

  if (action === 'share') {
    const v = vid.video;
    const r = await doShare(v);
    if (!r.sent.ok) {
      return { ok: false, msg: `卡片没发出去（${r.cover.ok ? '封面已存本地' : '封面下载失败：' + (r.cover.error || '?')}），但已留档：${SH.shareLogPath(root)}\n视频：${SH.videoUrlOf(v.bvid)}` };
    }
    return { ok: true, msg: `已把《${v.title}》发成一张卡片（${r.sent.via === 'text' || r.sent.via === 'text-active' ? '卡片没权限，降级成一条文本+链接' : '链接+封面同一条'}），并已留档。\n${vid.video.url || B.videoUrl(v.bvid)}` };
  }

  if (action === 'video') {
    const v = vid.video;
    return {
      ok: true,
      msg: lines([
        `${v.title}`,
        `UP：${v.owner} · 播放 ${v.views} · 点赞 ${v.likes} · 投币 ${v.coins}${v.replies != null ? ` · 评论 ${v.replies}` : ''}`,
        `${v.url || B.videoUrl(v.bvid)}`,
        `BV：${v.bvid} · aid：${v.aid}`,
        `简介：${(v.desc || '').slice(0, 200)}`,
      ]),
      title: v.title,
      url: v.url || B.videoUrl(v.bvid),
      bvid: v.bvid,
      aid: v.aid,
    };
  }

  if (action === 'comments') {
    const r = await B.comments(root, { aid: vid.video.aid, limit: args.limit || 10, sort: args.sort });
    if (!r.ok) return { ok: false, msg: `读评论失败：${r.error}` };
    if (!r.replies.length) return { ok: true, msg: `《${vid.video.title}》还没有评论。` };
    const head = `《${vid.video.title}》共 ${r.total ?? '?'} 条评论，读到 ${r.replies.length} 条：`;
    const body = r.replies
      .map((c, i) => {
        const tags = [];
        if (c.isSelf) tags.push('我发的');
        if (c.state != null && c.state !== 0) tags.push(`state=${c.state} 别人看不见`);
        return `${i + 1}. ${c.user}${tags.length ? `（${tags.join('，')}）` : ''}：${(c.text || '').slice(0, 200)}（赞 ${c.likes}${c.rpid ? ` · rpid ${c.rpid}` : ''}）`;
      })
      .join('\n');
    return { ok: true, msg: `${head}\n${body}`, total: r.total, via: r.via };
  }

  if (action === 'comment') {
    const q = commentQuota(root, cfg);
    if (q.state.n >= q.limit) return { ok: false, msg: `今天的 B 站评论额度已用完（${q.limit} 条/天），明天再来。` };
    const message = String(args.message || '').trim();
    if (!message) return { ok: false, msg: 'comment 需要 message（评论内容）' };
    // 单视频单日 ≤2 条：实测密集连发会让评论进审核通道（匿名看不到）
    const sameVideoToday = readOpRecords(root, 200).filter((x) => x
      && (x.type === 'comment' || x.type === 'comment-shadowed')
      && String(x.bvid || '') === String(vid.video.bvid || '')
      && Number(x.ts || 0) > Date.now() - 86400000).length;
    if (sameVideoToday >= 2) {
      return { ok: false, msg: `这条视频今天已经评过 ${sameVideoToday} 条了，先别连着评（连发容易被折叠）。换个视频或者明天再来。` };
    }
    // 全站单日上限 3 条：2026-10-26 实测，一天里评到第 3、4 条之后就会被标 attr bit38 进审核池
    const allToday = readOpRecords(root, 400).filter((x) => x
      && (x.type === 'comment' || x.type === 'comment-shadowed')
      && Number(x.ts || 0) > Date.now() - 86400000).length;
    if (allToday >= 3) {
      return { ok: false, msg: `今天已经发过 ${allToday} 条评论了，B 站开始把新的往审核里放（匿名看不到就是白评）。明天再评，或者先只看不评。` };
    }
    const rootRpid = String(args.root || args.rootRpid || '').trim();
    const parentRpid = String(args.parent || args.parentRpid || '').trim();
    const r = await B.postComment(root, {
      aid: vid.video.aid,
      bvid: vid.video.bvid,
      watchFirst: args.watchFirst !== false && args.watchFirst !== 'false',
      message,
      root: rootRpid,
      parent: parentRpid,
      verifyMs: args.verifyMs,
    });
    if (r.needLogin) {
      const f = loginFail(r, root);
      return { ok: false, msg: `${f.msg}这条评论没发出去。`, posted: false };
    }
    if (!r.ok) {
      // ① B 站收下了但没公开（匿名视角翻不到）—— 绝不能报成功
      if (r.posted && r.shadowed) {
        appendOpRecord(root, {
          type: 'comment-shadowed', bvid: vid.video.bvid, aid: vid.video.aid,
          rpid: r.rpid || '', state: r.state, attr: r.attr, text: message.slice(0, 200),
        });
        return {
          ok: false,
          posted: true,
          verified: false,
          shadowed: true,
          rpid: r.rpid,
          msg: `这条评论没公开：B 站收下了（rpid ${r.rpid}，state=${r.state ?? '?'}${r.attr ? `，attr=${r.attr}` : ''}），但我用**不带登录的匿名视角翻了 3 页都没看到它**——别人刷新评论区同样看不到。\n${r.hint || ''}\n（不能说"已经评论好了"）`,
        };
      }
      // ② 提交成功但回读没找到
      if (r.posted) {
        return {
          ok: false,
          posted: true,
          verified: false,
          rpid: r.rpid,
          msg: `评论提交了，但我回读评论区没找到它（rpid ${r.rpid || '?'}），不敢说成功。${r.hint ? `\n${r.hint}` : ''}`,
        };
      }
      // ③ 压根没提交成功
      appendOpRecord(root, { type: 'comment-failed', bvid: vid.video.bvid, text: message.slice(0, 200), error: String(r.error || '') });
      return { ok: false, posted: false, msg: `评论没发出去：${r.error}${r.hint ? `\n${r.hint}` : ''}` };
    }

    q.state.n += 1;
    q.save();
    B.rememberVideo(root, {
      bvid: vid.video.bvid, aid: vid.video.aid, title: vid.video.title,
      by: String(env?.caps?.peer?.peerId || ''), source: 'comment', commentRpid: r.rpid,
    });
    appendOpRecord(root, {
      type: 'comment', bvid: vid.video.bvid, aid: vid.video.aid, rpid: r.rpid,
      state: r.state, verified: true, text: message.slice(0, 200),
    });
    logger?.info?.(`[bili] 已评论 ${vid.video.bvid} rpid=${r.rpid}（已回读确认公开）`);
    const done = `已在《${vid.video.title}》发了评论，回读确认公开可见（rpid ${r.rpid}，今天第 ${q.state.n}/${q.limit} 条）。\n${vid.video.url || B.videoUrl(vid.video.bvid)}`;
    // 可选：评论完顺手把视频发成一条卡片（主人 2026-10-24：分享要卡片式，别拆成两条）
    if (args.shareCard === true || args.shareCard === 'true') {
      const s = await doShare(vid.video, { afterComment: true, comment: String(message).slice(0, 80) });
      return {
        ok: true,
        rpid: r.rpid,
        msg: done + (s.sent.ok
          ? '\n顺手把视频分享成一张卡片（链接+封面同一条，只占一条消息）。'
          : '\n卡片没发出去，但已留档，可在浮窗「记忆 → B站分享档」回看。'),
      };
    }
    return { ok: true, rpid: r.rpid, msg: done };
  }

  // ── 存图到表情包 ──
  if (action === 'collect') {
    const urls = Array.isArray(args.urls) ? args.urls.filter(Boolean) : [];
    if (!urls.length) return { ok: false, msg: 'collect 需要 urls（图片直链数组），可先用 dynamics/video 拿到配图地址' };
    const c = await captureImages(root, urls.slice(0, 10), {
      sourceGroup: 'bili',
      desc: String(args.desc || ''),
      tags: ['B站', ...(Array.isArray(args.tags) ? args.tags : [])].slice(0, 6),
    }, logger);
    return c.ok
      ? { ok: true, msg: `已存 ${c.fresh} 张新图到表情包候选区（重复 ${c.dup} 张，失败 ${c.failed} 张）。` }
      : { ok: false, msg: `存图失败：${c.error}` };
  }

  // ── 发/删动态（宣传、公告用；主人明确要求时才发） ──
  if (action === 'post') {
    const text = String(args.text || args.message || '').trim();
    if (!text) return { ok: false, msg: 'post 需要 text（动态正文，≤2000 字）' };
    const r = await B.postDynamic(root, { content: text });
    if (!r.ok) {
      if (r.needLogin) return loginFail(r, root);
      appendOpRecord(root, { type: 'dynamic-failed', text: text.slice(0, 200), error: String(r.error || '') });
      return { ok: false, msg: `发动态失败：${r.error}` };
    }
    try {
      writeFileSync(join(metaDir(root), 'bili-dynamic-log.jsonl'),
        JSON.stringify({ ts: Date.now(), dynamicId: r.dynamicId || '', via: r.via, text: text.slice(0, 200) }) + '\n', { flag: 'a' });
    } catch { /* ignore */ }
    // 浮窗「B站管理 → 近期操作」可见（records.jsonl），2026-10-25 起
    appendOpRecord(root, {
      type: 'dynamic', dynamicId: r.dynamicId || '', via: r.via || '',
      text: text.slice(0, 200), url: `https://t.bilibili.com/${r.dynamicId}`,
    });
    logger?.info?.(`[bili] 已发动态 ${r.dynamicId}`);
    return {
      ok: true,
      msg: `已发动态（${r.via}）：https://t.bilibili.com/${r.dynamicId}\n正文：${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`,
      dynamicId: r.dynamicId,
    };
  }

  if (action === 'remove') {
    const id = String(args.dynamicId || args.key || '').trim();
    if (!id) return { ok: false, msg: 'remove 需要 dynamicId' };
    const r = await B.removeDynamic(root, { dynamicId: id });
    if (!r.ok) {
      if (r.needLogin) return loginFail(r, root);
      appendOpRecord(root, { type: 'dynamic-delete-failed', dynamicId: id, error: String(r.error || '') });
      return { ok: false, msg: `删动态失败：${r.error}` };
    }
    appendOpRecord(root, { type: 'dynamic-delete', dynamicId: id });
    return { ok: true, msg: `已删掉动态 ${id}。` };
  }

  return { ok: false, msg: `未知 action：${action}。可用：status / login_start / login_poll / dynamics / favorites / fav_items / video / comments / comment / last / post / remove / share / collect` };
}

export default {
  name: 'bili',
  expose: 'all',
  description: 'B 站：扫码登录、看我的动态/收藏、读视频与评论、发评论（有每日上限，可 root/parent 回复某条；**发完会回读评论区确认 rpid 可见才报成功**，没公开会照实说）、last（查最近记住的那个视频）、发/删纯文字动态、把视频发成一条「链接+封面」卡片（share，可留档）、把配图存进表情包库。视频可以给 bvid/link，不给就自动用最近分享过的那个。只在主人 @ 或设定时间使用；登录失效会留汇报标记。',
  inputSchema: {
    action: { type: 'string', required: true, description: 'status | login_start | login_poll | dynamics | favorites | fav_items | video | comments | comment | last | post | remove | share | collect | like | like-comment' },
    bvid: { type: 'string', description: 'video/comments/comment/share 可选：BV 号（不给就用 link 参数，或用最近记住的那个视频）' },
    link: { type: 'string', description: 'video/comments/comment/share 可选：视频链接（b23.tv 短链 / 完整 URL / av 号都行）' },
    root: { type: 'string', description: 'comment 可选：回复某条评论时的顶层评论 rpid' },
    parent: { type: 'string', description: 'comment 可选：回复某条回复时的被回复 rpid（回复顶层评论可省略，默认等于 root）' },
    mediaId: { type: 'string', description: 'fav_items 必填：收藏夹 id（favorites 可查）' },
    message: { type: 'string', description: 'comment 必填：评论内容（≤1000 字，像真人，不发广告/引战）' },
    text: { type: 'string', description: 'post 必填：动态正文（≤2000 字）' },
    dynamicId: { type: 'string', description: 'remove 必填：要删的动态 id（post 会返回）' },
    aid: { type: 'string', description: 'like / like-comment 可选：视频 aid（不给就用 bvid/link/最近记住那条）' },
    rpid: { type: 'string', description: 'like-comment 必填：要赞的那条评论的 rpid' },
    like: { type: 'string', description: 'like / like-comment 可选：on（默认）或 off（取消赞）' },
    wait: { type: 'boolean', description: 'like 可选：true 时按 45s~4min 的真人节奏先等一会儿再点（默认只抖 1.5~6s）' },
    shareCard: { type: 'boolean', description: 'comment 可选：评论成功后顺手把视频发成一条卡片（失败也留档）' },
    urls: { type: 'array', description: 'collect 必填：图片直链数组（≤10 张）' },
    limit: { type: 'integer', description: 'dynamics/favorites/fav_items/comments 的条数，默认 5~10' },
    sort: { type: 'string', description: 'comments 可选：latest（默认）/ hot' },
    verifyMs: { type: 'integer', description: 'comment 可选：发完回读校验等多久（毫秒，默认 15000）' },
    collect: { type: 'boolean', description: 'dynamics 可选：顺手把动态配图存进表情包候选区' },
    key: { type: 'string', description: 'login_poll 可选：二维码 key（默认读本地）' },
  },
  run,
};
