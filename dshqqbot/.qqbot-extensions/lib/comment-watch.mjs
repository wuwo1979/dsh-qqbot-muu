/**
 * comment-watch.mjs — 评论巡检与自动回复（2026-10-28 主人需求）
 *
 * 「视频雷达」的收尾一环：我们发的视频，别人评论了 → 回复；回复过的不二次回复。
 *
 * 两平台能力不一样（如实分工）：
 *   · B 站：能读（wbi/main）也能发（reply/add + 拟人间隔 + 匿名回读校验），
 *     所以支持 **自动回复**（auto=true 时直接发，失败/未验证留为草稿）。
 *   · 抖音：评论只读（a_bogus 签名），**不做自动发评论**（写接口要设备签名，硬发必风控），
 *     回复走 replyDraft 草稿（浮窗里看/改/标记已发）。
 *
 * 防二次回复：{storage}/comment-replied.json 记 rpid → {kind:'reply'|'draft'|'shadowed'}。
 * 草稿在 auto 巡检时会被升级成真回复（不会永远停在草稿）。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as B from './bili-api.mjs';
import * as douyin from './platforms/douyin.mjs';
import { listJobs, paths as opsPaths, appendRecord, readSecret } from './bili-ops.mjs';
import { cloudChat } from './script-writer.mjs';

// ── 已回复台账（防二次回复的唯一事实源）─────────────────────────────────
function repliedFile(root) {
  return join(opsPaths(root).root, 'comment-replied.json');
}

function loadReplied(root) {
  try {
    const raw = JSON.parse(readFileSync(repliedFile(root), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveReplied(root, store) {
  try {
    writeFileSync(repliedFile(root), JSON.stringify(store));
  } catch { /* 台账写不进也只是可能重复回复，不挡主流程 */ }
}

// ── 自有视频清单 ────────────────────────────────────────────────────────
/** 已发布的 B 站视频（来自 bili-ops 任务台账 status=published） */
export function ownBiliVideos(root, limit = 30) {
  try {
    return listJobs(root, { limit })
      .filter((j) => j.status === 'published' && j.published && (j.published.bvid || j.published.aid))
      .map((j) => ({
        jobId: j.id,
        title: String(j.title || ''),
        // 「一句话内容」：第一屏旁白（截 80 字）——给模型当背景就够了，不塞整篇分镜
        gist: (Array.isArray(j.panels) ? String(j.panels[0]?.narration || '') : '').replace(/\s+/g, ' ').slice(0, 80)
          || String(j.desc || '').replace(/\s+/g, ' ').slice(0, 80),
        bvid: String(j.published.bvid || ''),
        aid: Number(j.published.aid || 0),
        at: Number(j.published.at || 0),
      }));
  } catch {
    return [];
  }
}

// ── 回复文案：以小蓝的性格去**回这个人**，只用云端模型，兜底不空手 ──────
// 主人 2026-10-27 定（第二次修正）：
//  · 输入只留最小集：视频标题 + 一句话内容 + 留言的人 + 他的评论 + 小蓝自己的性格/习惯；
//  · 任务性质变了：是「回这个人的话」，不是「对自己的视频做点评」，所以不塞整篇分镜；
//  · 只用云端 DeepSeek（本地 7B 接不住语境），没 Key 就模板兜底。
const FALLBACKS = [
  '谢谢你来看呀，下次还来玩～',
  '哈哈被你说中了，我在慢慢学',
  '你这么说我好开心，回头聊',
  '收到，这句我记住了',
];

// 读一遍 character.json，拼成一句紧凑的"我是谁"（5 分钟缓存）
let _personaCache = { at: 0, text: '', name: '小蓝', relations: [] };
function personaBrief(root) {
  const now = Date.now();
  if (now - _personaCache.at < 300000 && _personaCache.text) return _personaCache;
  let c = null;
  for (const p of [
    join(String(root || ''), '..', 'qqbot-mod', 'persona', 'character.json'),
    'F:/qqbot/qqbot-mod/persona/character.json',
  ]) {
    try { c = JSON.parse(readFileSync(p, 'utf8')); break; } catch { /* 下一个 */ }
  }
  if (!c) return _personaCache;
  const core = Array.isArray(c.core) ? c.core.slice(0, 3).join('、') : '';
  const tics = Array.isArray(c.speech?.tics) ? c.speech.tics.slice(0, 2).join('、') : '';
  const loves = Array.isArray(c.likes) ? c.likes.slice(0, 2).join('、') : '';
  const hates = Array.isArray(c.dislikes) ? c.dislikes.slice(0, 1).join('') : '';
  const inf = Array.isArray(c.influences) ? c.influences[0] : null;
  const parts = [
    core ? `性格：${core}` : '',
    loves ? `喜欢：${loves}` : '',
    hates ? `受不了：${hates}` : '',
    inf ? `身上有${inf.who}（${inf.role}）的影子：${String(inf.trait || '').slice(0, 24)}` : '',
    tics ? `说话偶尔带「${tics}」` : '',
  ].filter(Boolean);
  const name = String(c.name || '小蓝');
  const aliases = Array.isArray(c.aliases) ? c.aliases.filter(Boolean) : [];
  _personaCache = {
    at: now,
    name,
    relations: Array.isArray(c.relations) ? c.relations : [],
    text: `${name}${aliases.length ? `（也叫${aliases.join('、')}）` : ''}；${parts.join('；')}`.slice(0, 220),
  };
  return _personaCache;
}

async function genReply(root, { platform, title, gist, user, comment, via = 'cloud', selfSupplement = false, myText = '' } = {}) {
  const pb = personaBrief(root);
  const rel = (pb.relations || []).find((r) => r && (r.who === user || r.name === user));
  const where = platform === 'douyin' ? '抖音' : 'B站';
  const sys = [
    `你是「${pb.name}」，一只住在 QQ 群里的鲸鱼娘，说话像真人、有点小脾气。${pb.text}`,
    selfSupplement
      // [qqbot-mod] self-supplement 2026-10-29：主人要在自家评论下补楼 —— 语境完全不同
      ? `你在${where}自己发的视频评论区里留过一条评论，现在你想在那条评论下面**再补充一条回复**（盖楼）：把当时没说完的补上、说说最新进展，或者接住楼里的话。语气还是你平时那样。`
      : `你在${where}发过一条视频，有人在你视频底下留言。你要**回这个人的话**——像在评论区跟人搭一句，不是在介绍或点评自己的视频（最多顺口提一句相关的）。`,
    '15~40 字；可共情/接梗/答问题/反问一句；不要客服腔（「感谢支持」「谢谢关注」），不堆 emoji（最多 1 个）；只输出回复本身。',
  ].join('\n');
  const desc = rel?.role ? `${rel.role}` : '观众';
  const userMsg = [
    title ? `视频：《${String(title).slice(0, 60)}》${gist ? `（一句话内容：${String(gist).slice(0, 60)}）` : ''}` : '',
    // [qqbot-mod] 2026-10-29 收件箱语境：对方是回复「你发过的某条话」，把原文给小蓝看（不是视频标题）
    myText ? `你之前发的（对方就是回这条）：「${String(myText).slice(0, 120)}」` : '',
    `留言的人：${user || '观众'}（${desc}）`,
    `他说：「${String(comment || '').slice(0, 200)}」`,
    '',
    '回他一句（只输出回复本身）。',
  ].filter(Boolean).join('\n');
  const t0 = Date.now();

  // ① 指定通道优先（主人 2026-10-28：要能选本地/云端），失败退另一条，再退模板
  const viaLocal = via === 'local';
  const tryCloud = async () => {
    const sec = readSecret(root);
    if (!sec || !sec.apiKey) return null;
    const r = await cloudChat({
      model: 'deepseek-flash',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
      temperature: 0.85,
      max_tokens: 160,
      stream: false,
    }, { timeoutMs: 45000, tag: 'comment-reply' }, { apiKey: sec.apiKey });
    const text = String((r && r.text) || '').trim().replace(/^["「『]|["」』]$/g, '');
    return r && r.ok && text ? { ok: true, text: text.slice(0, 120), ms: Date.now() - t0, via: 'cloud' } : null;
  };
  const tryLocal = async () => {
    try {
      const L = await import('./local-llm.mjs');
      const r = await L.chat({
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
        temperature: 0.85,
        maxTokens: 160,
        timeoutMs: 60000,
      });
      const text = String((r && r.text) || (r && r.message && r.message.content) || '').trim().replace(/^["「『]|["」』]$/g, '');
      return text ? { ok: true, text: text.slice(0, 120), ms: Date.now() - t0, via: 'local' } : null;
    } catch { return null; }
  };
  const first = await (viaLocal ? tryLocal() : tryCloud());
  if (first) return first;
  const second = await (viaLocal ? tryCloud() : tryLocal());
  if (second) return second;

  const fb = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
  return { ok: true, text: fb, ms: Date.now() - t0, fallback: true, via: 'template' };
}

// ── B 站：只读评论列表（面板「出评论」用，不调 LLM，秒回）────────────────
// 2026-10-28 加楼中楼：rcount>0 的顶层评论拉子评论（每条限 10 条），子评论可单独回复
// [qqbot-mod] pull-sort 2026-10-28：sort='latest'按时间/'hot'按热度，maxAgeHours 时间窗 ——
//   定向/较新的评论在前排，回复它们才有「抢前排」的效果；纯随机浪费配额
export async function biliList(root, { limit = 10, withSub = true, sort = 'latest', maxAgeHours = 0 } = {}) {
  const vids = ownBiliVideos(root);
  if (!vids.length) return { ok: true, items: [], note: '还没有已发布的 B 站视频' };
  const store = loadReplied(root);
  const ageOk = (t) => !maxAgeHours || (Number(t) || 0) * 1000 >= Date.now() - maxAgeHours * 3600000;
  const items = [];
  const mine = () => { try { const c = B.loadCookie ? B.loadCookie(root) : null; return String(c?.cookies?.DedeUserID || ''); } catch { return ''; } };
  for (const v of vids.slice(0, 5)) {
    let aid = v.aid;
    if (!aid && v.bvid) {
      try { aid = (await B.fetchVideoMeta(root, v.bvid)).aid; } catch { aid = 0; }
    }
    if (!aid) { items.push({ title: v.title || v.bvid, error: '拿不到 aid' }); continue; }
    const r = await B.comments(root, { aid, limit, sort });
    if (!r.ok) { items.push({ title: v.title || v.bvid, error: r.error || '读评论失败' }); continue; }
    for (const c of r.replies) {
      // [qqbot-mod] self-supplement 2026-10-29：自己的评论也收录（主人在自家评论下补楼），
      //   标 self:true 且不受时间窗限制（想补的楼永远可见）；自动回复档仍会跳过它（防自言自语循环）
      if (!c.isSelf && !ageOk(c.time)) continue;
      const key = 'bili:' + aid + ':' + c.rpid;
      const prev = store[key];
      items.push({
        aid, bvid: v.bvid, title: v.title || v.bvid, rpid: c.rpid,
        user: c.user, comment: String(c.text || '').slice(0, 160), likes: Number(c.likes) || 0,
        rcount: Number(c.replies) || 0,
        at: Number(c.time) || 0,
        self: !!c.isSelf,
        status: c.isSelf ? '我的评论（可补楼）'
          : prev ? (prev.kind === 'reply' ? '已回复' : prev.kind === 'shadowed' ? '已回复(被折叠)' : '有草稿') : '未回复',
        prevReply: prev ? String(prev.text || '') : '',
      });
      // 楼中楼：有子评论就拉一页（最多 10 条），子评论条目扁平插入，带 root/parent 供回复定位
      if (withSub && c.rcount > 0) {
        try {
          const sr = await B.subReplies(root, { aid, root: c.rpid, limit: 10, mine: mine() });
          if (sr.ok) {
            for (const s of sr.replies) {
              if (!s.isSelf && !ageOk(s.time)) continue;
              const skey = 'bili:' + aid + ':' + s.rpid;
              const sprev = store[skey];
              items.push({
                aid, bvid: v.bvid, title: v.title || v.bvid,
                rpid: s.rpid, rootRpid: String(s.root || c.rpid), parentRpid: String(s.parent || c.rpid),
                isSub: true, parentUser: c.user,
                user: s.user, comment: String(s.text || '').slice(0, 160), likes: Number(s.likes) || 0,
                at: Number(s.time) || 0,
                self: !!s.isSelf,
                status: s.isSelf ? '我之前的回复'
                  : sprev ? (sprev.kind === 'reply' ? '已回复' : sprev.kind === 'shadowed' ? '已回复(被折叠)' : '有草稿') : '未回复',
                prevReply: sprev ? String(sprev.text || '') : '',
              });
            }
          }
        } catch { /* 楼中楼拉不到就只出顶层 */ }
      }
    }
  }
  // 时间窗/最新模式下把新评论顶到前面，面板一眼看到「值得抢前排」的那几条
  items.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  return { ok: true, items, sort, maxAgeHours };
}

// ── B 站：单条操作（直接回复 / 重新生成草稿）────────────────────────────
// mode: 'send'=把 message 真发出去；'draft'=不管 message，用模型重新生成一条并存草稿
// 2026-10-28：支持回复楼中楼（parentRpid/rootRpid）、via 选本地/云端模型、直接评论视频（commentVideo）
export async function biliReply(root, { aid, bvid, rpid, parentRpid, rootRpid, message, mode = 'send', user, comment, title, via = 'cloud', commentVideo = false, selfSupplement = false, imgPath = '', myText = '' } = {}) {
  aid = Number(aid) || 0;
  const directVideo = commentVideo || !rpid;      // 不带 rpid = 直接评论视频本体
  if (!aid || (!rpid && !directVideo)) return { ok: false, error: '缺 aid 或 rpid' };
  const targetRpid = directVideo ? '' : String(rpid);
  const key = 'bili:' + aid + ':' + (targetRpid || 'video');
  const store = loadReplied(root);
  // 面板里"重新生成草稿"只传了 title，这里把这条视频的标题/一句话内容补上
  let vGist = '';
  try {
    const v = ownBiliVideos(root).find((x) => (aid && x.aid === aid) || (bvid && x.bvid === bvid));
    if (v) {
      vGist = v.gist || '';
      if (!title) title = v.title;
    }
  } catch { /* 查不到就只用传进来的 */ }
  let text = String(message || '').trim();
  if (!text && mode === 'draft') {
    const g = await genReply(root, { platform: 'bili', title, gist: vGist, user, comment, via, selfSupplement: selfSupplement === true, myText });
    text = g.text;
  }
  if (!text) return { ok: false, error: mode === 'send' ? '先写一句回复再发' : '生成失败' };
  if (mode !== 'send') {
    // [qqbot-mod] 2026-10-29 修：已回复过的楼再点「小蓝写」，以前会把台账 kind 覆写成 'draft'，
    //   UI 从「已回复」变成「有草稿」→ 主人看不出回过 → 二次回复。现在保留已回复状态，
    //   文案照常返回（手动仍可再发，台账以最后一次真发送为准）。
    const prevKind = store[key] && store[key].kind;
    if (prevKind === 'reply' || prevKind === 'shadowed') {
      return { ok: true, draft: true, text, alreadyReplied: true,
        prevReply: String(store[key].text || ''),
        status: prevKind === 'reply' ? '已回复' : '已回复(被折叠)' };
    }
    store[key] = Object.assign({}, store[key] || {}, { kind: 'draft', text, at: Date.now() });
    saveReplied(root, store);
    return { ok: true, draft: true, text };
  }
  // 楼中楼定位：root=顶层 rpid（必需），parent=被回复的那条（回顶层子楼时 = root）
  const rootId = directVideo ? '' : String(rootRpid || targetRpid);
  const parentId = directVideo ? '' : String(parentRpid || rootId || targetRpid);
  // [qqbot-mod] sticker-img 2026-10-29：选了本地表情包 → 先传 B 站图床 → 带 pictures 发
  let pictures = null;
  if (String(imgPath || '').trim()) {
    const up = await B.uploadCommentImage(root, { filePath: String(imgPath).trim() });
    if (!up || !up.ok) return { ok: false, posted: false, error: '表情包上传失败：' + ((up && up.error) || '?'), text };
    pictures = [{ img_url: up.url, img_width: up.width, img_height: up.height }];
  }
  // [qqbot-mod] 2026-10-29：异常必须带错误信息出去 —— 以前 postComment 抛异常会
  //   一路冒泡到宿主兜底，面板只看到「失败：?」，而评论其实可能已经发出去了。
  let pr;
  try {
    pr = await B.postComment(root, { aid, bvid, message: text, root: rootId || undefined, parent: parentId || undefined, pictures });
  } catch (e) {
    return { ok: false, posted: false, error: '发送异常：' + (e?.message || String(e)), text };
  }
  const posted = !!(pr.ok || pr.posted);
  if (posted) {
    store[key] = { kind: pr.verified ? 'reply' : 'shadowed', text, at: Date.now() };
    saveReplied(root, store);
    try { appendRecord(root, { type: 'comment-watch', platform: 'bili', manual: true, rpid: targetRpid || 'video', at: Date.now() }); } catch { /* ignore */ }
  }
  return { ok: posted, verified: !!pr.verified, shadowed: !!pr.shadowed, error: pr.error || '', text };
}

// ── B 站：我的评论追踪（主人在**别人的视频**下发过评论，想看收到的回复）──────
// [qqbot-mod] my-threads 2026-10-29：以前只扫机器人自己发布的视频，主人在别人视频下
//   发的评论和收到的回复完全看不到。现在按「与我相关的楼」过滤：我发的顶层评论整栋楼、
//   别人楼里我插过话的整栋楼，其余跳过 —— 面板一眼看到我的每条评论和它收到的全部回复。
export async function biliMyThreads(root, { bvid, aid, limit = 20 } = {}) {
  aid = Number(aid) || 0;
  if (!aid && bvid) {
    try { const v = await B.fetchVideoMeta(root, bvid); aid = Number(v?.aid) || 0; } catch { /* ignore */ }
  }
  if (!aid) return { ok: false, error: '拿不到 aid（检查 BV 号）' };
  const mine = (() => { try { const c = B.loadCookie ? B.loadCookie(root) : null; return String(c?.cookies?.DedeUserID || ''); } catch { return ''; } })();
  if (!mine) return { ok: false, needLogin: true, error: '还没登录 B 站，先扫码登录' };
  const cs = await B.comments(root, { aid, limit: Math.max(5, Math.min(20, limit)), sort: 'latest' });
  if (!cs.ok) return { ok: false, error: cs.error || '读评论失败' };
  const threads = [];
  for (const c of (cs.replies || [])) {
    const isMineTop = String(c.mid || '') === mine;
    let subs = [];
    if (Number(c.replies) > 0) {
      try {
        const sr = await B.subReplies(root, { aid, root: c.rpid, limit: 20, mine });
        if (sr.ok) subs = sr.replies || [];
      } catch { /* 楼中楼拉不到就当没有 */ }
    }
    const iSpoke = subs.some((s) => String(s.mid || '') === mine);
    if (!isMineTop && !iSpoke) continue;   // 与我无关的楼不占版面
    threads.push({
      rpid: c.rpid, isMine: isMineTop, user: c.user,
      text: String(c.text || '').slice(0, 200), likes: Number(c.likes) || 0, at: Number(c.time) || 0,
      replies: subs.map((s) => ({
        rpid: s.rpid, user: s.user,
        text: String(s.text || '').slice(0, 200),
        isMine: String(s.mid || '') === mine, at: Number(s.time) || 0,
        parent: String(s.parent || c.rpid),
      })).sort((a, b) => a.at - b.at),
    });
  }
  threads.sort((a, b) => b.at - a.at);
  return { ok: true, aid, threads, count: threads.length, total: cs.total,
    note: threads.length ? '' : '这个视频下没找到我发过的评论（或我插过话的楼）——确认 BV 号没贴错' };
}

// ── B 站：读 + （可选）自动回复 ────────────────────────────────────────
/**
 * @param {object} opt
 * @param {boolean} opt.auto     true=直接发回复（拟人间隔，一条约 1~2 分钟）；false=只出草稿
 * @param {number}  opt.maxReply 单次巡检最多发几条（配额保险丝）
 * @param {number}  opt.limit    每个视频读多少条评论（最新在前）
 * @param {string}  opt.sort     'latest'=按时间（默认，利于抢前排）/ 'hot'=按热度
 * @param {number}  opt.maxAgeHours 只看最近 N 小时的评论（0=不限）——定向捞新评论，
 *                          避免在一堆陈年评论上浪费回复配额；新评论在前排也更容易被看到
 * @param {boolean} opt.withSub  true=同时巡检楼中楼（被评论后回复「评论的评论」）
 */
export async function biliCheck(root, opt = {}) {
  const auto = opt.auto === true;
  const sort = opt.sort === 'hot' ? 'hot' : 'latest';
  const maxAge = Math.max(0, Number(opt.maxAgeHours) || 0);
  const withSub = opt.withSub !== false;
  const maxReply = Math.max(1, Math.min(5, Number(opt.maxReply) || 3));
  const limit = Math.max(1, Math.min(20, Number(opt.limit) || 10));
  const vids = ownBiliVideos(root);
  if (!vids.length) return { ok: true, videos: 0, results: [], replied: 0, note: '还没有已发布的 B 站视频' };
  const store = loadReplied(root);
  const results = [];
  let replied = 0;
  const mine = () => { try { const c = B.loadCookie ? B.loadCookie(root) : null; return String(c?.cookies?.DedeUserID || ''); } catch { return ''; } };
  const ageOk = (t) => !maxAge || (Number(t) || 0) * 1000 >= Date.now() - maxAge * 3600000;

  /** 一条评论（顶层或楼中楼）的统一处理：回复过跳过 → 生成/取草稿 → auto 时真发 */
  const handleOne = async (v, c, extra = {}) => {
    // [qqbot-mod] self-supplement 2026-10-29：自己的评论只在**手动档**（auto=false）起草补楼文案 ——
    //   自动档绝不回自己（机器人回自己的评论会被巡检再捕获，无限自言自语循环）；
    //   手动档不查已回复台账（同一栋楼想补几次补几次），也不把补楼写进防重台账。
    if (c.isSelf && auto) return null;
    const key = 'bili:' + v.aid + ':' + c.rpid;
    const prev = c.isSelf ? null : store[key];
    if (prev && prev.kind === 'reply') return null;   // 已回复过 —— 防二次回复的核心判据
    const entry = {
      video: v.title || v.bvid, bvid: v.bvid, rpid: c.rpid,
      user: c.user, comment: String(c.text || '').slice(0, 120),
      self: !!c.isSelf,
      ...(extra),
    };
    let text = prev && prev.text;
    if (!text) {
      const g = await genReply(root, {
        platform: 'bili', title: v.title, gist: v.gist, user: c.user, comment: c.text,
        via: opt.via === 'local' ? 'local' : 'cloud',
        selfSupplement: !!c.isSelf,
      });
      text = g.text;
      entry.genMs = g.ms;
      if (g.fallback) entry.fallback = true;
    } else {
      entry.fromDraft = true;
    }
    entry.reply = text;
    if (auto && replied < maxReply) {
      // 拟人间隔在 postComment 内部（先看视频再隔 20~90s），一条约 1~2 分钟
      const pr = await B.postComment(root, {
        aid: v.aid, bvid: v.bvid, message: text,
        root: extra.rootRpid || c.rpid, parent: extra.parentRpid || c.rpid,
      });
      entry.posted = !!(pr.ok || pr.posted);
      entry.verified = !!pr.verified;
      if (pr.shadowed) entry.shadowed = true;
      if (pr.error) entry.error = String(pr.error).slice(0, 120);
      if (entry.posted) {
        store[key] = { kind: entry.verified ? 'reply' : 'shadowed', text, at: Date.now() };
        replied += 1;
      } else if (!prev) {
        store[key] = { kind: 'draft', text, at: Date.now(), error: entry.error || '' };
      }
    } else {
      entry.drafted = true;
      if (!prev && !c.isSelf) store[key] = { kind: 'draft', text, at: Date.now() };
    }
    results.push(entry);
    return entry;
  };

  for (const v of vids) {
    let aid = v.aid;
    if (!aid && v.bvid) {
      try { aid = (await B.fetchVideoMeta(root, v.bvid)).aid; } catch { aid = 0; }
    }
    if (!aid) { results.push({ video: v.title || v.bvid, error: '拿不到 aid' }); continue; }
    const vv = { ...v, aid };
    const r = await B.comments(root, { aid, limit, sort });
    if (!r.ok) { results.push({ video: v.title || v.bvid, error: r.error || '读评论失败' }); continue; }
    for (const c of r.replies) {
      // 自己的评论：手动档也进 handleOne（出补楼草稿），自动档在 handleOne 内跳过；
      // 时间窗对 self 豁免 —— 想补的楼永远可见
      if (!c.isSelf && !ageOk(c.time)) continue;    // 时间窗外的不捞（配额留给新评论）
      await handleOne(vv, c);
      // 楼中楼：别人在（我们或别人的）回复底下接着聊 → 也回（被评论后回复「评论的评论」）
      if (withSub && Number(c.replies) > 0) {
        try {
          const sr = await B.subReplies(root, { aid, root: c.rpid, limit: 10, mine: mine() });
          for (const s of (sr.ok ? sr.replies : [])) {
            // 自己的楼中楼回复同样收（手动档补楼，自动档在 handleOne 内跳过）；时间窗对 self 豁免
            if (!s.isSelf && !ageOk(s.time)) continue;
            await handleOne(vv, s, {
              isSub: true, rootRpid: String(s.root || c.rpid), parentRpid: String(s.parent || c.rpid),
              parentUser: c.user,
            });
          }
        } catch { /* 楼中楼拉不到就只处理顶层 */ }
      }
    }
  }
  saveReplied(root, store);
  try {
    appendRecord(root, { type: 'comment-watch', platform: 'bili', auto, checked: results.length, replied, at: Date.now() });
  } catch { /* ignore */ }
  return { ok: true, videos: vids.length, results, replied, auto, sort, maxAgeHours: maxAge };
}

// ── 抖音：只读 + 出草稿（自动发=风控，明确不做）─────────────────────────
export async function douyinCheck(root, { url, limit = 15 } = {}) {
  const parsed = await douyin.parseVideoLink(url);
  if (!parsed.ok) return parsed;
  const awemeId = parsed.awemeId;
  const cl = await douyin.commentList(root, awemeId, { count: Math.max(5, Math.min(50, limit)) });
  if (!cl.ok) return cl;
  const rl = douyin.replyList(root);
  const existing = (rl && rl.ok && Array.isArray(rl.replies)) ? rl.replies : [];
  const seen = new Set(existing.map((r) => String(r.key || '')));
  let detailTitle = '';
  try {
    const d = await douyin.videoDetail(root, awemeId);
    if (d && d.ok) detailTitle = String(d.title || '');
  } catch { /* 标题拿不到不挡 */ }
  // [qqbot-mod] dy-inbox 2026-10-29：贴过链接的视频进「关注清单」——
  //   以后抖音收件箱一键看全部评论，不用每次重新粘链接
  douyinWatchAdd(root, { awemeId, title: detailTitle });
  const results = [];
  let drafted = 0;
  for (const c of (cl.comments || [])) {
    const key = awemeId + '|' + String(c.text || '').slice(0, 60);
    if (seen.has(key)) continue;                  // 出过草稿/已回复过的不再重复
    const g = await genReply(root, { platform: 'douyin', title: detailTitle, user: c.nickname, comment: c.text });
    await douyin.replyDraft(root, {
      awemeId, nickname: c.nickname, comment: c.text, text: g.text,
      videoUrl: 'https://www.douyin.com/video/' + awemeId,
    });
    drafted += 1;
    results.push({ user: c.nickname, comment: String(c.text || '').slice(0, 120), reply: g.text });
  }
  try {
    appendRecord(root, { type: 'comment-watch', platform: 'douyin', awemeId, checked: (cl.comments || []).length, drafted, at: Date.now() });
  } catch { /* ignore */ }
  return { ok: true, awemeId, title: detailTitle, total: cl.total ?? (cl.comments || []).length, drafted, results };
}

// ── 抖音收件箱（2026-10-29 主人需求）─────────────────────────────
// 主人原话：抖音回复不了总能看到吧？能看到的话让它生成，我来回复（人手工发）。
// 抖音写评论接口要设备级签名（硬发必风控，2026-10-28 已实测 403），所以终点永远是
// 「小蓝写文案 → 复制 → 人去视频页发」；收件箱负责让评论一眼全看到 + 记住草稿/已发状态。

/** 关注清单：贴过一次链接的视频记住（最新在前，最多 20 个） */
function watchedFile(root) {
  return join(opsPaths(root).root, 'douyin-watched.json');
}
export function douyinWatchAdd(root, { awemeId, title = '' } = {}) {
  const id = String(awemeId || '').trim();
  if (!/^\d{15,25}$/.test(id)) return { ok: false };
  let list = [];
  try { list = JSON.parse(readFileSync(watchedFile(root), 'utf8')); if (!Array.isArray(list)) list = []; } catch { /* 首次为空 */ }
  const prev = list.find((x) => x && x.awemeId === id);
  if (prev) { if (title) prev.title = String(title).slice(0, 80); prev.at = Date.now(); }
  else list.unshift({ awemeId: id, title: String(title || '').slice(0, 80), at: Date.now() });
  try { mkdirSync(opsPaths(root).root, { recursive: true }); writeFileSync(watchedFile(root), JSON.stringify(list.slice(0, 20))); } catch { /* 写不进只是收件箱空一点 */ }
  return { ok: true };
}
function douyinWatchList(root) {
  try { const l = JSON.parse(readFileSync(watchedFile(root), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
}

/** 抖音收件箱：关注清单里的视频逐个拉评论，对齐待审队列的草稿/已发状态 */
export async function douyinInbox(root, { limit = 12 } = {}) {
  const watched = douyinWatchList(root);
  if (!watched.length) {
    return { ok: true, items: [], note: '收件箱还是空的——在下面贴一次抖音视频链接（出草稿或只读速览），这个视频以后就会出现在这里' };
  }
  const rl = douyin.replyList(root);
  const drafts = {};
  for (const d of ((rl && rl.replies) || [])) drafts[String(d.key || '')] = d;
  const items = [];
  const errors = [];
  for (const w of watched.slice(0, 5)) {
    const cl = await douyin.commentList(root, w.awemeId, { count: Math.max(5, Math.min(50, limit)) });
    if (!cl.ok) { errors.push({ awemeId: w.awemeId, error: String(cl.error || '?').slice(0, 80) }); continue; }
    for (const c of (cl.comments || [])) {
      const key = w.awemeId + '|' + String(c.text || '').slice(0, 60);
      const d = drafts[key];
      items.push({
        awemeId: w.awemeId, cid: String(c.cid || ''), title: w.title || '',
        videoUrl: 'https://www.douyin.com/video/' + w.awemeId,
        user: c.nickname, comment: String(c.text || '').slice(0, 200),
        likes: Number(c.digg) || 0, at: Number(c.at) || 0,
        draftText: d && d.status === 'pending' ? String(d.text || '') : '',
        sent: !!(d && d.status === 'sent'),
      });
    }
  }
  items.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  return { ok: true, items, errors, count: items.length,
    note: items.length ? '' : '关注清单里的视频暂时都没有新评论' };
}

/** 收件箱「小蓝写」：性格引擎出一条文案 → 存抖音待审队列（复制手动发） */
export async function douyinGenOne(root, { awemeId, user, comment, title = '', via = 'cloud' } = {}) {
  if (!comment) return { ok: false, error: '缺评论内容' };
  const g = await genReply(root, { platform: 'douyin', title, user, comment, via: via === 'local' ? 'local' : 'cloud' });
  if (!g || !g.text) return { ok: false, error: '生成失败' };
  douyin.replyDraft(root, {
    awemeId, nickname: user, comment, text: g.text,
    videoUrl: 'https://www.douyin.com/video/' + String(awemeId || ''),
  });
  return { ok: true, text: g.text, via: g.via, fallback: !!g.fallback };
}

/** [qqbot-mod] dy-interact 2026-10-29：抖音「互动消息」——对标 B 站消息中心，
 *  谁评论/回复了我一个列表全看到；对齐待审队列的草稿/已发状态。只读，不动 App 已读。 */
export async function douyinInteract(root, { count = 15, group = '2' } = {}) {
  const r = await douyin.interactFeed(root, { group, count });
  if (!r.ok) return r;
  const rl = douyin.replyList(root);
  const drafts = {};
  for (const d of ((rl && rl.replies) || [])) drafts[String(d.key || '')] = d;
  const rows = (r.rows || []).map((x) => {
    const d = drafts[(x.awemeId || '') + '|' + String(x.text || '').slice(0, 60)];
    return {
      ...x,
      videoUrl: x.awemeId ? 'https://www.douyin.com/video/' + x.awemeId : '',
      draftText: d && d.status === 'pending' ? String(d.text || '') : '',
      sent: !!(d && d.status === 'sent'),
    };
  });
  return { ok: true, rows, hasMore: r.hasMore, minTime: r.minTime,
    note: rows.length ? '' : '（还没有新的互动消息）' };
}

/** [qqbot-mod] dy-patrol 2026-10-30：抖音互动巡检 —— 拉「互动消息」通知流，
 *  对还没出过草稿的评论自动生成回复草稿。终点仍是「人手工发」（写接口必风控）。
 *  默认**不自动跑**（主人 2026-10-30 明确：不自动，点运行再搞）——
 *  hook 里要 cfg.douyinPatrol.enabled === true 才定时跑；浮窗按钮手动触发。 */
export async function douyinPatrol(root, { group = '2', count = 15, maxNew = 3 } = {}) {
  const feed = await douyinInteract(root, { group, count });
  if (!feed.ok) return feed;
  const all = feed.rows || [];
  const pending = all.filter((x) => x.awemeId && x.text && !x.draftText && !x.sent);
  const results = [];
  let drafted = 0;
  const cap = Math.max(1, Number(maxNew) || 3);
  for (const row of pending) {
    if (drafted >= cap) break;
    const g = await douyinGenOne(root, { awemeId: row.awemeId, user: row.user, comment: row.text, title: '' });
    if (g && g.ok) {
      drafted += 1;
      results.push({ user: row.user, comment: String(row.text || '').slice(0, 120), reply: g.text });
    }
  }
  // 巡检到的视频进关注清单，收件箱才能对上草稿/已发状态
  for (const row of pending) {
    if (row.awemeId) douyinWatchAdd(root, { awemeId: row.awemeId });
  }
  try {
    appendRecord(root, { type: 'comment-watch', platform: 'douyin-patrol', checked: all.length, pending: pending.length, drafted, at: Date.now() });
  } catch { /* ignore */ }
  return { ok: true, checked: all.length, pending: pending.length, drafted, results,
    note: drafted ? '' : (all.length ? '（这些互动都出过草稿或已回复，没有新要写的）' : '（还没有新的互动消息）') };
}

/** 台账读取（面板展示用） */
export function repliedList(root) {
  const store = loadReplied(root);
  return Object.entries(store)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .slice(0, 50);
}

/** [qqbot-mod] feed-status 2026-10-29：台账原始快照 ——
 *  宿主把「📬回复我的」通知流和台账对齐（key=bili:oid:rpid），
 *  回复过/有草稿的条目在收件箱里直接标状态，主人不会再「看不到状态 → 重复回复」。 */
export function repliedStore(root) {
  return loadReplied(root);
}
