/**
 * zz-video-card.mjs — 出站：B 站 / 抖音链接 → 一张卡片（封面 + 标题 + 可点链接）
 *
 * 主人口径（2026-11-03）：分享 B 站/抖音视频应当是**卡片**，不是"一句话 + 一条裸链接"。
 *
 * 做法：出站链最后一步，认出发出去的文本里有没有视频链接：
 *   · B 站：bilibili.com/video/BV…、b23.tv/xxxx、bili2233.cn/xxxx（短链先跟跳转解出 BV）
 *   · 抖音：v.douyin.com/xxxx、douyin.com/video|note/<id>、modal_id=<id>
 * 认出来就去拉标题/UP/播放（B 站不用登录）、把封面存到本地，
 * 然后把整条文本改写成 markdown 卡片：
 *   **标题**
 *   ![封面](本地路径)          ← 本地图，走 md-media 上传，不依赖外链（B 站图床有防盗链）
 *   UP：xx · 播放 1,234
 *   [▶ 在 B 站打开](https://…)
 * 她自己那句话（去掉链接后的部分）保留在卡片上面。
 *
 * 三条纪律：
 *   1) **失败安全**：拉不到信息 / 超预算 / 任何异常 ⇒ 直接放行原文，绝不吞消息、绝不降级成难看的东西。
 *   2) **不占主动权**：仍是这一条被动回复，不额外多发消息（尾巴由 split-reply 那条负责）。
 *   3) **有预算**：出站链有 3000ms 硬超时（超时宿主会丢改写、按原文重发一遍 ⇒ 重复气泡），
 *      这里自己掐 2000ms（可配），绝不把链拖过线。
 *
 * 开关（memory-config.json，可选）：
 *   "videoCard": { "enabled": true, "budgetMs": 2000, "withCover": true }
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'zz-video-card';

const DEFAULTS = { enabled: true, budgetMs: 2000, withCover: true };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** dataRoot 口径与其它扩展一致：env QQBOT_MEMORY_DATA_ROOT → cwd/dshqqbot → F:/qqbot/dshqqbot */
function dataRootOf() {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env.replace(/\\/g, '/');
  for (const p of [join(process.cwd(), 'dshqqbot'), 'F:/qqbot/dshqqbot']) {
    try { if (existsSync(join(p, '.qqbot-extensions', 'memory-config.json'))) return p.replace(/\\/g, '/'); } catch { /* ignore */ }
  }
  return 'F:/qqbot/dshqqbot';
}

function readCfg(root) {
  try {
    const p = join(root, '.qqbot-extensions', 'memory-config.json');
    if (!existsSync(p)) return { ...DEFAULTS };
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    const v = j?.videoCard || {};
    return {
      enabled: v.enabled !== false,
      budgetMs: Math.max(600, Math.min(2600, Number(v.budgetMs) || DEFAULTS.budgetMs)),
      withCover: v.withCover !== false,
    };
  } catch { return { ...DEFAULTS }; }
}

// ───────────────────────── 链接识别 ─────────────────────────
const BILI_RE = /https?:\/\/[^\s"'<>()\[\]]*?(?:bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)|b23\.tv\/([A-Za-z0-9]+)|bili2233\.cn\/([A-Za-z0-9]+))/i;
const DY_RE = /https?:\/\/[^\s"'<>()\[\]]*?(?:v\.douyin\.com\/([A-Za-z0-9_-]+)|douyin\.com\/(?:video|note)\/(\d{15,25})|modal_id=(\d{15,25}))/i;

/** 从文本里认出一条视频链接；没有返回 null */
export function detectUrl(text) {
  const s = String(text || '');
  const b = BILI_RE.exec(s);
  if (b) {
    const bvid = b[1] && /^BV/i.test(b[1]) ? b[1] : '';
    return { platform: 'bilibili', raw: b[0], bvid, shortCode: bvid ? '' : (b[2] || b[3] || '') };
  }
  const d = DY_RE.exec(s);
  if (d) {
    return { platform: 'douyin', raw: d[0], awemeId: d[2] || d[3] || '', shortCode: d[1] || '' };
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, what = '超时') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(what)), Math.max(1, ms))),
  ]);
}

async function httpGet(url, { referer = '', timeoutMs = 1800 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(250, timeoutMs));
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, ...(referer ? { referer } : {}) },
      redirect: 'follow',
      signal: ctl.signal,
    });
    return res;
  } finally { clearTimeout(timer); }
}

/** 跟短链跳转，从最终 URL 里抠 BV / aweme id */
async function expandShort(url, timeoutMs) {
  try {
    const res = await httpGet(url, { referer: 'https://www.bilibili.com/', timeoutMs });
    const final = String(res.url || '');
    const bv = /(BV[0-9A-Za-z]{10})/.exec(final);
    if (bv) return { ok: true, bvid: bv[1] };
    const dym = /douyin\.com\/(?:video|note)\/(\d{15,25})/.exec(final);
    if (dym) return { ok: true, awemeId: dym[1] };
    return { ok: false, error: '短链没跳成视频页（' + (final || '?').slice(0, 80) + '）' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ───────────────────────── 元信息 ─────────────────────────
/** B 站：用插件自己的 bili-api（免登录，已含 wbi 签名），只读标题/UP/播放/封面 */
async function biliMeta(root, bvid) {
  const { video } = await import('../lib/bili-api.mjs');
  const r = await video(root, { bvid });
  if (!r?.ok) return { ok: false, error: r?.error || 'B 站接口失败' };
  const v = r.video || {};
  return {
    ok: true,
    title: String(v.title || '').slice(0, 120),
    author: String(v.owner || ''),
    views: v.views,
    cover: String(v.cover || ''),
    url: 'https://www.bilibili.com/video/' + encodeURIComponent(bvid),
    label: 'B站',
    referer: 'https://www.bilibili.com/',
  };
}

/** 抖音：能拿到就带上标题/作者/封面，拿不到就只给链接（卡片依旧成立） */
async function douyinMeta(root, awemeId) {
  try {
    const { videoDetail } = await import('../lib/platforms/douyin.mjs');
    const r = await videoDetail(root, awemeId);
    if (r?.ok) {
      return {
        ok: true,
        title: String(r.title || '').slice(0, 120),
        author: String(r.author || ''),
        views: r.stats?.play,
        cover: String(r.cover || ''),
        url: r.url || ('https://www.douyin.com/video/' + awemeId),
        label: '抖音',
        referer: 'https://www.douyin.com/',
      };
    }
    // 拉不到标题/封面 ⇒ 只发一条纯链接的"卡片"没有意义，干脆放行原文
    return { ok: false, error: r?.error || '抖音详情拿不到' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 抖音兜底：抖音 App「复制链接」的分享文案里本身就带作者和标题，比如
 *   8.43 复制打开抖音，看看【某某的作品】标题文案… https://v.douyin.com/xxxx/
 * 接口被风控（403）时就从这段文案里抠，别为了封面把整条卡片丢掉。
 */
export function douyinFromText(text, raw) {
  const s = String(text || '');
  const m = /【([^】]{1,40})】/.exec(s);
  if (!m) return { ok: false, error: '文案里没有【作者】' };
  const author = String(m[1]).replace(/的作品$/, '').trim();
  const afterBracket = s.slice(m.index + m[0].length);
  const urlAt = afterBracket.search(/https?:\/\//);
  const title = (urlAt >= 0 ? afterBracket.slice(0, urlAt) : afterBracket)
    .replace(/^[\s，,。.、:：;；!！?？~～-]+|[\s，,。.、:：;；!！?？~～-]+$/g, '')
    .trim().slice(0, 120);
  if (!title) return { ok: false, error: '标题是空的' };
  return {
    ok: true,
    title,
    author,
    views: null,
    cover: '',
    url: raw || 'https://www.douyin.com/',
    label: '抖音',
    referer: 'https://www.douyin.com/',
    via: 'share-text',
  };
}

// ───────────────────────── 封面落本地 ─────────────────────────
// 首选 .qqbot/video-card；万一那个目录不可写（权限/ACL），退到扩展数据目录，
// 封面丢了卡还能发，但能发就别丢。
function coverDirs(root) {
  return [
    join(root, '.qqbot', 'video-card'),
    join(root, '.qqbot-extensions', 'data', 'video-card'),
  ];
}

function ensureDir(p) {
  try {
    mkdirSync(p, { recursive: true });
    return existsSync(p);
  } catch {
    return false;
  }
}

function coverFileIn(dir, key, ext) {
  return join(dir, String(key).replace(/[^\w-]/g, '') + ext);
}

function findCached(dirs, key) {
  for (const dir of dirs) {
    for (const ext of ['.jpg', '.png', '.webp', '.gif']) {
      const p = coverFileIn(dir, key, ext);
      try { if (existsSync(p) && statSync(p).size > 1024) return { ok: true, path: p, cached: true }; } catch { /* ignore */ }
    }
  }
  return null;
}

function extOfType(type = '') {
  const t = String(type).toLowerCase();
  if (t.includes('png')) return '.png';
  if (t.includes('webp')) return '.webp';
  if (t.includes('gif')) return '.gif';
  return '.jpg';
}

async function saveCover(root, key, url, referer, timeoutMs) {
  const dirs = coverDirs(root);
  const hit = findCached(dirs, key);
  if (hit) return hit;
  try {
    const res = await httpGet(url, { referer, timeoutMs });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return { ok: false, error: '图太小（' + buf.length + 'B）' };
    if (buf.length > 10 * 1024 * 1024) return { ok: false, error: '图超过 10MB' };
    const ext = extOfType(type);
    for (const dir of dirs) {
      if (!ensureDir(dir)) continue;
      const p = coverFileIn(dir, key, ext);
      try {
        writeFileSync(p, buf);
        return { ok: true, path: p, size: buf.length };
      } catch { /* 换下一个目录再试 */ }
    }
    return { ok: false, error: '封面目录都写不进去' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ───────────────────────── 卡片文本 ─────────────────────────
export function buildCard(meta, coverLocal = '') {
  const lines = [];
  if (meta.title) lines.push('**' + meta.title.replace(/[*`]/g, '') + '**');
  if (coverLocal) lines.push('![封面](' + String(coverLocal).replace(/\\/g, '/') + ')');
  const bits = [];
  if (meta.author) bits.push((meta.label === 'B站' ? 'UP：' : '作者：') + meta.author);
  if (meta.views != null && Number(meta.views) > 0) bits.push('播放 ' + Number(meta.views).toLocaleString('zh-CN'));
  if (bits.length) lines.push(bits.join(' · '));
  const label = meta.label || '视频';
  lines.push('[▶ 在' + label + '打开](' + meta.url + ')');
  if (!meta.title && !coverLocal) {
    // 什么信息都没有时，只留一句人话，别发一坨空卡片
    return '[▶ 在' + label + '打开](' + meta.url + ')';
  }
  return lines.join('\n');
}

/** 去掉文本里的这条链接（以及它前后多余的空白/标点），留下她自己的话 */
function stripUrl(text, raw) {
  let s = String(text || '');
  const i = s.indexOf(raw);
  if (i >= 0) s = s.slice(0, i) + s.slice(i + raw.length);
  return s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s，,。.、:：;；!！?？~～-]+|[\s，,。.、:：;；~～-]+$/g, '')
    .trim();
}

// ───────────────────────── 入口 ─────────────────────────
export async function onOutbound(ctx, next) {
  try {
    if (!ctx || ctx.phase !== 'send') return next();
    if (ctx.kind && ctx.kind !== 'text') return next();
    if (ctx.isLastChunk === false) return next();
    const text = String(ctx.text || '');
    // 已经是卡片（有图/有媒体引用）就不要再动
    if (!text || text.includes('![') || text.includes('[MEDIA:') || text.includes('qqbot-media://')) return next();

    const hit = detectUrl(text);
    if (!hit) return next();

    const root = dataRootOf();
    const cfg = readCfg(root);
    if (!cfg.enabled) return next();
    if (typeof ctx.rewrite !== 'function') return next();

    const t0 = Date.now();
    const deadline = t0 + cfg.budgetMs;
    const left = () => deadline - Date.now();

    // ① 先解出 id（短链要跟跳转）
    let key = hit.bvid || hit.awemeId || '';
    if (!key && hit.shortCode) {
      if (hit.platform === 'douyin') {
        // 抖音短链只认 h2（h1.1 会被静默黑洞），用插件里已经打通过的解析器
        try {
          const { parseVideoLink } = await import('../lib/platforms/douyin.mjs');
          const p = await withTimeout(parseVideoLink(hit.raw), Math.min(1500, left()), '抖音短链超时');
          if (p?.ok && p.awemeId) key = String(p.awemeId);
        } catch (e) {
          ctx?.logger?.debug?.(`[video-card] 抖音短链没解开：${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        const ex = await withTimeout(expandShort(hit.raw, Math.min(1200, left())), Math.min(1300, left()), '短链解析超时').catch((e) => ({ ok: false, error: e.message }));
        if (ex.ok) key = ex.bvid || ex.awemeId || '';
      }
    }
    if (!key && hit.platform !== 'douyin') return next();
    if (left() < 400) return next();

    // ② 拉元信息（超预算就放弃改写，原文照发）
    let meta;
    try {
      meta = key
        ? (hit.platform === 'bilibili'
          ? await withTimeout(biliMeta(root, key), left(), 'B 站接口超时')
          : await withTimeout(douyinMeta(root, key), Math.min(left(), 900), '抖音接口超时'))
        : { ok: false };
    } catch (e) {
      ctx?.logger?.debug?.(`[video-card] 接口放弃（${e instanceof Error ? e.message : String(e)}）`);
      meta = { ok: false };
    }
    // 抖音接口常年被风控（403）⇒ 退回分享文案里的【作者】标题；再不行就不改写
    if (!meta?.ok && hit.platform === 'douyin') meta = douyinFromText(text, hit.raw);
    if (!meta?.ok) return next();

    // ③ 封面（失败就不带图，卡片照样成立）
    let cover = '';
    if (cfg.withCover && meta.cover && left() > 350) {
      const c = await withTimeout(saveCover(root, hit.platform + '-' + key, meta.cover, meta.referer, left()), left(), '封面超时')
        .catch((e) => ({ ok: false, error: e.message }));
      if (c?.ok) cover = c.path;
      else if (c?.error) ctx?.logger?.debug?.(`[video-card] 封面没取到：${c.error}`);
    }

    // ④ 改写：她的话 + 卡片
    const card = buildCard(meta, cover);
    let rest = stripUrl(text, hit.raw);
    // 抖音 App 的分享文案（"8.43 复制打开抖音，看看【…】标题"）不是她的话，别原样贴回去
    if (meta.via === 'share-text' || (hit.platform === 'douyin' && /复制打开|看看【/.test(rest))) rest = '';
    const out = rest && rest.length >= 2 ? rest + '\n\n' + card : card;
    ctx.rewrite(out);
    ctx?.logger?.info?.(`[video-card] ${hit.platform} ${key} 卡已成（${Date.now() - t0}ms${cover ? '，带封面' : '，无封面'}）`);
    await next();
    return;
  } catch (e) {
    ctx?.logger?.debug?.(`[video-card] 异常(已忽略，原文照发)：${e instanceof Error ? e.message : String(e)}`);
    try { return await next(); } catch { return; }
  }
}

export default { name, onOutbound, detectUrl, buildCard };
