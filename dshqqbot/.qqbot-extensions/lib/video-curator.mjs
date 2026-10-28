/**
 * video-curator.mjs — 视频雷达（主人 2026-10-27 点单）：
 *   给定链接或「随机来一个」→ 拉视频信息+热评 → 本地模型生成一条评论文案
 *   → 抖音：浮窗弹窗展示（Argus 挡自动发，复制去发）
 *   → B 站：浮窗展示 + 可选「人点确认后直接发评论」（S4 档）
 *   → 遇到好玩的：📝 记笔记 + 📤 分享到指定 QQ 群（复用宿主 group/send）。
 *
 * 设计：
 *   · 全部复用既有平台库（douyin.mjs signedGet / bili-api video+comments+popular），不引新依赖
 *   · LLM 失败 → 给一个朴素兜底文案（照常出卡片，绝不空手）
 *   · 笔记落 data/video-notes.jsonl；已看过去重 data/video-radar.json（随机避免重推）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import * as B from './bili-api.mjs';
import * as douyin from './platforms/douyin.mjs';
import { chat as llmChat, loadConfig as llmLoadConfig } from './local-llm.mjs';

const DATA_DIR = (root) => join(String(root), 'data');
const NOTES_FILE = (root) => join(DATA_DIR(root), 'video-notes.jsonl');
const SEEN_FILE = (root) => join(DATA_DIR(root), 'video-radar.json');

function readJson(file, dflt) {
  try {
    if (!existsSync(file)) return dflt;
    return JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch { return dflt; }
}

// ── 解析 ────────────────────────────────────────────────────────────────
export function parseBvid(text) {
  const s = String(text || '');
  const m = s.match(/BV[0-9A-Za-z]{8,12}/);
  if (m) return m[0];
  const aid = s.match(/av(\d{6,15})/i);
  if (aid) return { aid: aid[1] };
  return null;
}

// ── 拉取 ────────────────────────────────────────────────────────────────
async function pullBili(root, { id, random = false } = {}) {
  let bvid = typeof id === 'string' ? id : null;
  if (random || !bvid) {
    const pop = await B.popular(root, { limit: 40 });
    if (!pop.ok) return pop;
    const seen = readJson(SEEN_FILE(root), { seen: [] });
    const fresh = pop.list.filter((v) => !seen.seen.includes(v.bvid));
    const pool = fresh.length ? fresh : pop.list;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    bvid = pick.bvid;
  }
  const v = await B.video(root, { bvid });
  if (!v.ok) return v;
  const cm = await B.comments(root, { aid: v.video.aid, limit: 5, sort: 'hot' });
  try {
    const seen = readJson(SEEN_FILE(root), { seen: [] });
    if (!seen.seen.includes(bvid)) {
      seen.seen.push(bvid);
      seen.seen = seen.seen.slice(-200);
      mkdirSync(DATA_DIR(root), { recursive: true });
      writeFileSync(SEEN_FILE(root), JSON.stringify(seen));
    }
  } catch { /* 去重失败无碍 */ }
  return {
    ok: true,
    platform: 'bili',
    video: {
      id: bvid, title: v.video.title, desc: String(v.video.desc || '').slice(0, 300),
      author: v.video.owner, url: v.video.url, cover: v.video.cover,
      stats: { views: v.video.views, likes: v.video.likes, comments: v.video.replies },
    },
    comments: (cm.ok && Array.isArray(cm.replies) ? cm.replies : []).slice(0, 5)
      .map((c) => ({ text: String(c.text || '').slice(0, 120), likes: Number(c.likes || 0) })),
  };
}

async function pullDouyin(root, { id, url } = {}) {
  const p = await douyin.parseVideoLink(url || id || '');
  if (!p.ok) return p;
  const vd = await douyin.videoDetail(root, p.awemeId);
  const cm = await douyin.commentList(root, p.awemeId, { count: 8 });
  if (!vd.ok && !cm.ok) {
    return { ok: false, error: '抖音拉取失败：' + (vd.error || cm.error || '?') };
  }
  return {
    ok: true,
    platform: 'douyin',
    video: {
      id: p.awemeId,
      title: vd.ok ? vd.title : ('抖音视频 ' + p.awemeId),
      desc: '', author: vd.ok ? vd.author : '',
      url: 'https://www.douyin.com/video/' + p.awemeId,
      cover: vd.ok ? vd.cover : '',
      stats: vd.ok ? vd.stats : null,
    },
    comments: (cm.ok ? cm.comments : []).slice(0, 5).map((c) => ({ text: c.text, likes: c.digg })),
  };
}

/** 统一入口。opt: { platform: 'bili'|'douyin', url, random } */
export async function pull(root, opt = {}) {
  const platform = String(opt.platform || '').toLowerCase();
  try {
    if (platform === 'douyin') return await pullDouyin(root, { id: opt.url, url: opt.url });
    if (platform === 'bili') {
      const parsed = parseBvid(opt.url);
      return await pullBili(root, { id: parsed && typeof parsed === 'string' ? parsed : (parsed && parsed.aid), random: !parsed || opt.random });
    }
    return { ok: false, error: 'platform 要是 bili 或 douyin' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── 生成评论 ────────────────────────────────────────────────────────────
/**
 * 以小蓝口吻生成一条评论（20~48 字）。本地模型优先；失败给兜底文案。
 * return { ok, text, ms, fallback }
 */
export async function draftComment(root, video) {
  if (!video || !video.title) return { ok: false, error: '没有视频信息' };
  const hot = (video.comments || []).slice(0, 3).map((c) => '- ' + c.text).join('\n');
  const sys = [
    '你是「小蓝」，一个真实、有梗、说话自然的 QQ 群机器人（年轻人语气）。',
    '看完这个视频的信息和热评，写**一条**你要发在视频下的评论。',
    '要求：20~48 字；像真人随手写的（可以有梗/共情/吐槽，不要彩虹屁，不要「这视频真不错」这种空话）；不要 emoji 堆砌，最多 1 个；只输出评论文本本身，不要引号不要解释。',
  ].join('\n');
  const user = [
    `标题：${video.title}`,
    video.author ? `UP主/作者：${video.author}` : '',
    video.desc ? `简介：${video.desc.slice(0, 150)}` : '',
    hot ? `热评参考：\n${hot}` : '',
    '',
    '写评论（只输出评论本身）。',
  ].filter(Boolean).join('\n');
  const t0 = Date.now();
  try {
    const cfg = llmLoadConfig(root);
    const r = await llmChat({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], cfg, timeoutMs: 45000, maxTokens: 120 });
    const text = String((r && r.text) || '').trim().replace(/^["「『]|["」』]$/g, '');
    if (r && r.ok !== false && text) {
      return { ok: true, text: text.slice(0, 120), ms: Date.now() - t0 };
    }
  } catch { /* 落兜底 */ }
  const fb = (video.comments && video.comments[0] && video.comments[0].text)
    ? `看到「${String(video.comments[0].text).slice(0, 18)}」这条热评，同感了`
    : `标题就很有画面感，先码后看`;
  return { ok: true, text: fb, ms: Date.now() - t0, fallback: true };
}

// ── 笔记 ────────────────────────────────────────────────────────────────
export function noteAdd(root, note = {}) {
  const rec = {
    ts: Date.now(),
    platform: String(note.platform || ''),
    id: String(note.id || ''),
    title: String(note.title || '').slice(0, 200),
    url: String(note.url || ''),
    comment: String(note.comment || '').slice(0, 200),
    note: String(note.note || '').slice(0, 400),
    sharedTo: Array.isArray(note.sharedTo) ? note.sharedTo.slice(0, 6) : [],
  };
  try {
    mkdirSync(DATA_DIR(root), { recursive: true });
    appendFileSync(NOTES_FILE(root), JSON.stringify(rec) + '\n', 'utf8');
    return { ok: true, rec };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

export function noteList(root, { limit = 30 } = {}) {
  try {
    if (!existsSync(NOTES_FILE(root))) return [];
    const rows = String(readFileSync(NOTES_FILE(root), 'utf8')).split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.slice(-Math.max(1, Math.min(100, limit))).reverse();
  } catch { return []; }
}

/** 分享文案（发 QQ 群用的一句话） */
export function shareText(note) {
  return `【${note.platform === 'douyin' ? '抖音' : 'B站'}】${note.title}\n${note.url}` +
    (note.comment ? `\n小蓝：${note.comment}` : '');
}

export default { pull, draftComment, noteAdd, noteList, shareText, parseBvid };
