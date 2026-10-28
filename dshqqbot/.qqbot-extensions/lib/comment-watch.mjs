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

import { readFileSync, writeFileSync } from 'node:fs';
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

async function genReply(root, { platform, title, gist, user, comment }) {
  const pb = personaBrief(root);
  const rel = (pb.relations || []).find((r) => r && (r.who === user || r.name === user));
  const where = platform === 'douyin' ? '抖音' : 'B站';
  const sys = [
    `你是「${pb.name}」，一只住在 QQ 群里的鲸鱼娘，说话像真人、有点小脾气。${pb.text}`,
    `你在${where}发过一条视频，有人在你视频底下留言。你要**回这个人的话**——像在评论区跟人搭一句，不是在介绍或点评自己的视频（最多顺口提一句相关的）。`,
    '15~40 字；可共情/接梗/答问题/反问一句；不要客服腔（「感谢支持」「谢谢关注」），不堆 emoji（最多 1 个）；只输出回复本身。',
  ].join('\n');
  const desc = rel?.role ? `${rel.role}` : '观众';
  const userMsg = [
    title ? `视频：《${String(title).slice(0, 60)}》${gist ? `（一句话内容：${String(gist).slice(0, 60)}）` : ''}` : '',
    `留言的人：${user || '观众'}（${desc}）`,
    `他说：「${String(comment || '').slice(0, 200)}」`,
    '',
    '回他一句（只输出回复本身）。',
  ].filter(Boolean).join('\n');
  const t0 = Date.now();

  // ① 云端 DeepSeek（唯一首选；不退回本地模型）
  try {
    const sec = readSecret(root);
    if (sec && sec.apiKey) {
      const r = await cloudChat({
        model: 'deepseek-flash',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
        temperature: 0.85,
        max_tokens: 160,
        stream: false,
      }, { timeoutMs: 45000, tag: 'comment-reply' }, { apiKey: sec.apiKey });
      const text = String((r && r.text) || '').trim().replace(/^["「『]|["」』]$/g, '');
      if (r && r.ok && text) return { ok: true, text: text.slice(0, 120), ms: Date.now() - t0, via: 'cloud' };
    }
  } catch { /* 落兜底 */ }

  const fb = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
  return { ok: true, text: fb, ms: Date.now() - t0, fallback: true, via: 'template' };
}

// ── B 站：只读评论列表（面板「出评论」用，不调 LLM，秒回）───────────────
export async function biliList(root, { limit = 10 } = {}) {
  const vids = ownBiliVideos(root);
  if (!vids.length) return { ok: true, items: [], note: '还没有已发布的 B 站视频' };
  const store = loadReplied(root);
  const items = [];
  for (const v of vids.slice(0, 5)) {
    let aid = v.aid;
    if (!aid && v.bvid) {
      try { aid = (await B.fetchVideoMeta(root, v.bvid)).aid; } catch { aid = 0; }
    }
    if (!aid) { items.push({ title: v.title || v.bvid, error: '拿不到 aid' }); continue; }
    const r = await B.comments(root, { aid, limit });
    if (!r.ok) { items.push({ title: v.title || v.bvid, error: r.error || '读评论失败' }); continue; }
    for (const c of r.replies) {
      if (c.isSelf) continue;
      const key = 'bili:' + aid + ':' + c.rpid;
      const prev = store[key];
      items.push({
        aid, bvid: v.bvid, title: v.title || v.bvid, rpid: c.rpid,
        user: c.user, comment: String(c.text || '').slice(0, 160), likes: Number(c.likes) || 0,
        status: prev ? (prev.kind === 'reply' ? '已回复' : prev.kind === 'shadowed' ? '已回复(被折叠)' : '有草稿') : '未回复',
        prevReply: prev ? String(prev.text || '') : '',
      });
    }
  }
  return { ok: true, items };
}

// ── B 站：单条操作（直接回复 / 重新生成草稿）────────────────────────────
// mode: 'send'=把 message 真发出去；'draft'=不管 message，用本地模型重新生成一条并存草稿
export async function biliReply(root, { aid, bvid, rpid, message, mode = 'send', user, comment, title } = {}) {
  aid = Number(aid) || 0;
  if (!aid || !rpid) return { ok: false, error: '缺 aid 或 rpid' };
  const key = 'bili:' + aid + ':' + rpid;
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
    const g = await genReply(root, { platform: 'bili', title, gist: vGist, user, comment });
    text = g.text;
  }
  if (!text) return { ok: false, error: mode === 'send' ? '先写一句回复再发' : '生成失败' };
  if (mode !== 'send') {
    store[key] = Object.assign({}, store[key] || {}, { kind: 'draft', text, at: Date.now() });
    saveReplied(root, store);
    return { ok: true, draft: true, text };
  }
  const pr = await B.postComment(root, { aid, bvid, message: text, root: rpid, parent: rpid });
  const posted = !!(pr.ok || pr.posted);
  if (posted) {
    store[key] = { kind: pr.verified ? 'reply' : 'shadowed', text, at: Date.now() };
    saveReplied(root, store);
    try { appendRecord(root, { type: 'comment-watch', platform: 'bili', manual: true, rpid, at: Date.now() }); } catch { /* ignore */ }
  }
  return { ok: posted, verified: !!pr.verified, shadowed: !!pr.shadowed, error: pr.error || '', text };
}

// ── B 站：读 + （可选）自动回复 ────────────────────────────────────────
/**
 * @param {object} opt
 * @param {boolean} opt.auto     true=直接发回复（拟人间隔，一条约 1~2 分钟）；false=只出草稿
 * @param {number}  opt.maxReply 单次巡检最多发几条（配额保险丝）
 * @param {number}  opt.limit    每个视频读多少条评论（最新在前）
 */
export async function biliCheck(root, opt = {}) {
  const auto = opt.auto === true;
  const maxReply = Math.max(1, Math.min(5, Number(opt.maxReply) || 3));
  const limit = Math.max(1, Math.min(20, Number(opt.limit) || 10));
  const vids = ownBiliVideos(root);
  if (!vids.length) return { ok: true, videos: 0, results: [], replied: 0, note: '还没有已发布的 B 站视频' };
  const store = loadReplied(root);
  const results = [];
  let replied = 0;
  for (const v of vids) {
    let aid = v.aid;
    if (!aid && v.bvid) {
      try { aid = (await B.fetchVideoMeta(root, v.bvid)).aid; } catch { aid = 0; }
    }
    if (!aid) { results.push({ video: v.title || v.bvid, error: '拿不到 aid' }); continue; }
    const r = await B.comments(root, { aid, limit });
    if (!r.ok) { results.push({ video: v.title || v.bvid, error: r.error || '读评论失败' }); continue; }
    for (const c of r.replies) {
      if (c.isSelf) continue;                       // 自己的置顶/回复不处理
      const key = 'bili:' + aid + ':' + c.rpid;
      const prev = store[key];
      if (prev && prev.kind === 'reply') continue;  // 已回复过 —— 防二次回复的核心判据
      const entry = {
        video: v.title || v.bvid, bvid: v.bvid, rpid: c.rpid,
        user: c.user, comment: String(c.text || '').slice(0, 120),
      };
      let text = prev && prev.text;
      if (!text) {
        const g = await genReply(root, { platform: 'bili', title: v.title, gist: v.gist, user: c.user, comment: c.text });
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
          aid, bvid: v.bvid, message: text, root: c.rpid, parent: c.rpid,
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
        if (!prev) store[key] = { kind: 'draft', text, at: Date.now() };
      }
      results.push(entry);
    }
  }
  saveReplied(root, store);
  try {
    appendRecord(root, { type: 'comment-watch', platform: 'bili', auto, checked: results.length, replied, at: Date.now() });
  } catch { /* ignore */ }
  return { ok: true, videos: vids.length, results, replied, auto };
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

/** 台账读取（面板展示用） */
export function repliedList(root) {
  const store = loadReplied(root);
  return Object.entries(store)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .slice(0, 50);
}
