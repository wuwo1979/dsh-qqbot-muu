/**
 * lib/bili-api.mjs — B 站只读/低风险能力（Cookie + 扫码登录）
 *
 * 设计原则（2026-10-23 主人定）：
 *  · 登录只走官方扫码接口，Cookie 存本地 {dataRoot}/bili-cookie.json，不外传；
 *  · 所有请求带 UA + Referer，出错不抛，返回 {ok:false, error}；
 *  · 未登录（code -101/-400）统一返回 needLogin=true，便于上层汇报"登录已失效"；
 *  · 评论等写操作必须由上层（工具/定时任务）显式触发，本模块不自作主张。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-write.mjs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { looksLikeRisk, noteRisk } from './platforms/pacing.mjs';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';

export const COOKIE_FILE = (dataRoot) => join(dataRoot, 'bili-cookie.json');
export const CONFIG_FILE = (dataRoot) => join(dataRoot, 'bili-config.json');

export const DEFAULT_CONFIG = {
  enabled: true,
  schedule: {
    enabled: false,
    times: ['09:30', '21:30'],
    actions: ['dynamics'],
    limit: 5,
    collect: false,
  },
  comment: { enabled: true, dailyLimit: 5 },
};

export function loadConfig(dataRoot) {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE(dataRoot), 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw, schedule: { ...DEFAULT_CONFIG.schedule, ...(raw.schedule || {}) }, comment: { ...DEFAULT_CONFIG.comment, ...(raw.comment || {}) } };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

export function saveConfig(dataRoot, cfg) {
  try {
    mkdirSync(dataRoot, { recursive: true });
    // [qqbot-mod] atomic-write 2026-10-27：原子写（临时文件+rename），断电/并发不再产生半截配置
    writeJsonAtomic(CONFIG_FILE(dataRoot), cfg);
    return true;
  } catch { return false; }
}

export function loadCookie(dataRoot) {
  try {
    const j = JSON.parse(readFileSync(COOKIE_FILE(dataRoot), 'utf8'));
    if (!j || !j.cookies || !j.cookies.SESSDATA) return null;
    return j;
  } catch { return null; }
}

/// 把任意粘贴内容解析成 cookie 映射：支持 Header String / Cookie-Editor JSON / Netscape。
export function parseCookieText(input) {
  let raw = String(input || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return {};
  const line = raw.match(/^cookie:\s*(.+)$/im);
  if (line) raw = line[1].trim();
  const META = new Set(['domain', 'path', 'expires', 'secure', 'httponly', 'samesite', 'hostonly', 'session', 'expirationdate', 'storeid']);
  const out = {};
  const put = (k, v) => { const n = String(k || '').trim(); if (!n || META.has(n.toLowerCase())) return; out[n] = String(v ?? ''); };
  if (/^[[{]/.test(raw)) {
    try {
      const j = JSON.parse(raw);
      const arr = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : null;
      if (arr) { for (const c of arr) if (c && c.name) put(c.name, c.value); }
      else if (j && typeof j === 'object') { for (const [k, v] of Object.entries(j)) { if (v && typeof v === 'object' && 'value' in v) put(k, v.value); else if (typeof v === 'string') put(k, v); } }
      return out;
    } catch { /* 落到文本解析 */ }
  }
  if (/\t/.test(raw)) {
    for (const ln0 of raw.split(/\r?\n/)) {
      let ln = ln0.trim();
      if (!ln) continue;
      if (ln.startsWith('#HttpOnly_')) ln = ln.slice(10);
      else if (ln.startsWith('#')) continue;
      const cols = ln.split('\t');
      if (cols.length >= 7) put(cols[5], cols[6]);
    }
    if (Object.keys(out).length) return out;
  }
  for (const seg of raw.split(/;|\r?\n/)) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i > 0) put(s.slice(0, i), s.slice(i + 1));
  }
  return out;
}

export function saveCookie(dataRoot, cookies, extra = {}) {
  try {
    if (typeof cookies === 'string') cookies = parseCookieText(cookies);
    if (!cookies || !Object.keys(cookies).length) return false;
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(COOKIE_FILE(dataRoot), JSON.stringify({
      savedAt: Date.now(),
      ...extra,
      cookies,
    }, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

export function cookieHeader(c) {
  return Object.entries(c || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join('; ');
}

async function request(url, { method = 'GET', cookie = null, body = null, form = false, raw = false, timeoutMs = 15000, referer = null, origin = null } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // 2026-10-26 实测：服务端硬校验的是 Cookie + csrf + form-urlencoded + WBI，
    // 其余头剥了也能 code 0；但真人浏览器一定带这些，带上更稳也更容易解释异常。
    const headers = {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': '"Chromium";v="126", "Not:A-Brand";v="24", "Google Chrome";v="126"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      dnt: '1',
      referer: referer || REFERER,
      origin: origin || 'https://www.bilibili.com',
      ...(cookie ? { cookie: cookieHeader(cookie) } : {}),
    };
    let payload;
    if (body != null) {
      if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        payload = new URLSearchParams(body).toString();
      } else {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    const res = await fetch(url, { method, headers, body: payload, signal: ctl.signal });
    if (raw) return { ok: true, res };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, error: `返回不是 JSON（HTTP ${res.status}）`, status: res.status }; }
    return { ok: true, json, res };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? '请求超时' : (e instanceof Error ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

function needLogin(json) {
  const code = Number(json?.code);
  // -400 是"请求错误"（参数/风控），-403 是权限不足，都不是登录失效。
  // 只有 -101 账号未登录、-111 csrf 校验失败才该让主人重新扫码。
  return code === -101 || code === -111;
}

// ── WBI 签名（2023 起多数接口要求 w_rid + wts）──────────────────────
/**
 * B 站 2023 起对 /wbi/ 系列接口（如 /x/v2/reply/wbi/main、/x/space/wbi/arc/search）
 * 强制要求 w_rid + wts。缺签名会回 -403 访问权限不足 / -352 风控校验失败，
 * 看起来像"没权限"，其实就是缺签名。
 *
 * 做法：nav 里取 wbi_img.img_url/sub_url 的文件名（去目录、去扩展名）拼起来，
 * 按 MIXIN_KEY_ENC_TAB 重排取前 32 位得到 mixin_key；参数按 key 排序 urlencode，
 * 加上 wts，再 md5(query + mixin_key) 得 w_rid。
 */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

let _wbiCache = { key: '', at: 0, mid: 0 };

export function md5Hex(s) {
  return createHash('md5').update(String(s), 'utf8').digest('hex');
}

/** 取（并缓存 30 分钟）mixin_key */
export async function wbiMixinKey(dataRoot) {
  const c = loadCookie(dataRoot);
  const mid = Number(c?.cookies?.DedeUserID || 0);
  if (_wbiCache.key && _wbiCache.mid === mid && Date.now() - _wbiCache.at < 30 * 60e3) {
    return { ok: true, key: _wbiCache.key };
  }
  const r = await request(`${API}/x/web-interface/nav`, { cookie: c?.cookies });
  if (!r.ok) return r;
  const img = String(r.json?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0];
  const sub = String(r.json?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0];
  if (!img || !sub) return { ok: false, error: '拿不到 wbi_img（多半是没登录/登录失效）', needLogin: !c };
  const raw = img + sub;
  const key = MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32);
  _wbiCache = { key, at: Date.now(), mid };
  return { ok: true, key };
}

/** 生成带 w_rid + wts 的查询串（不含路径） */
export async function wbiQuery(dataRoot, params = {}) {
  const k = await wbiMixinKey(dataRoot);
  if (!k.ok) return k;
  const p = { ...params, wts: Math.round(Date.now() / 1000) };
  const q = Object.keys(p).sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(p[key] ?? '').replace(/[!'()*]/g, ''))}`)
    .join('&');
  return { ok: true, query: `${q}&w_rid=${md5Hex(q + k.key)}` };
}

// ── 扫码登录 ─────────────────────────────────────────────────────────

export async function qrGenerate() {
  const r = await request(`${PASSPORT}/x/passport-login/web/qrcode/generate`);
  if (!r.ok) return r;
  const j = r.json;
  if (j.code !== 0 || !j.data) return { ok: false, error: j.message || `code ${j.code}` };
  return { ok: true, url: j.data.url, key: j.data.qrcode_key };
}

function parseSetCookies(res) {
  const out = {};
  let list = [];
  try {
    list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  } catch { list = []; }
  if (!list.length) {
    const one = res.headers.get('set-cookie');
    if (one) list = [one];
  }
  for (const line of list) {
    const first = String(line || '').split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}

/**
 * 轮询扫码状态。返回：
 *  { ok:true, state:'wait'|'scanned'|'expired'|'ok', cookies? }
 *  B 站 data.code: 0=成功, 86090=已扫码待确认, 86101=未扫码, 86038=已失效
 */
export async function qrPoll(key) {
  const r = await request(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, { raw: true });
  if (!r.ok) return r;
  const res = r.res;
  let j;
  try { j = await res.json(); } catch { return { ok: false, error: `返回不是 JSON（HTTP ${res.status}）` }; }
  if (j.code !== 0) return { ok: false, error: j.message || `code ${j.code}` };
  const sc = Number(j.data?.code);
  if (sc === 86038) return { ok: true, state: 'expired' };
  if (sc === 86090) return { ok: true, state: 'scanned' };
  if (sc === 86101) return { ok: true, state: 'wait' };
  if (sc === 0) {
    const cookies = parseSetCookies(res);
    if (!cookies.SESSDATA) return { ok: false, error: '扫码成功但没拿到 SESSDATA' };
    return { ok: true, state: 'ok', cookies };
  }
  return { ok: true, state: 'wait', raw: sc };
}

// ── 只读接口 ─────────────────────────────────────────────────────────

export async function nav(dataRoot) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站（先用 bili 工具扫码）' };
  const r = await request(`${API}/x/web-interface/nav`, { cookie: c.cookies });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j) || !j.data?.isLogin) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  return { ok: true, data: { mid: j.data.mid, name: j.data.uname, level: j.data.level_info?.current_level, vip: j.data.vip?.label?.text || '' } };
}

export async function dynamics(dataRoot, { limit = 5, offset = '' } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  const u = `${API}/x/polymer/web-dynamic/v1/feed/all?type=all&page=1&offset=${encodeURIComponent(offset)}&features=itemOpusStyle`;
  const r = await request(u, { cookie: c.cookies });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) return { ok: false, error: j.message || `code ${j.code}` };
  const items = (j.data?.items || []).slice(0, Math.max(1, Math.min(20, limit))).map((it) => {
    const md = it.modules?.module_dynamic || {};
    const major = md.major || {};
    const arch = major.archive || {};
    const draw = major.draw?.items || [];
    const opus = major.opus?.pics || [];
    const text = md.desc?.text || '';
    return {
      id: it.id_str,
      type: it.type,
      time: it.modules?.module_author?.pub_ts,
      author: it.modules?.module_author?.name,
      text,
      bvid: arch.bvid || '',
      title: arch.title || '',
      images: [...draw.map((d) => d.src), ...opus.map((p) => p.src)].filter(Boolean).slice(0, 9),
    };
  });
  return { ok: true, items, offset: j.data?.offset || '' };
}

export async function favorites(dataRoot, { limit = 10 } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  const me = await nav(dataRoot);
  if (!me.ok) return me;
  const mid = me.data.mid;
  const r = await request(`${API}/x/v3/fav/folder/created/list-all?up_mid=${mid}&web_location=333.1387`, { cookie: c.cookies });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) return { ok: false, error: j.message || `code ${j.code}` };
  const folders = (j.data?.list || []).slice(0, Math.max(1, Math.min(20, limit))).map((f) => ({ id: f.id, title: f.title, count: f.media_count }));
  return { ok: true, folders, mid };
}

export async function favItems(dataRoot, { mediaId, limit = 10 } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  if (!mediaId) return { ok: false, error: '缺少 mediaId（先用 favorites 拿收藏夹 id）' };
  const r = await request(`${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&pn=1&ps=${Math.max(1, Math.min(20, limit))}&platform=web`, { cookie: c.cookies });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) return { ok: false, error: j.message || `code ${j.code}` };
  const items = (j.data?.medias || []).map((m) => ({ bvid: m.bvid, title: m.title, cover: m.cover, upper: m.upper?.name, intro: m.intro }));
  return { ok: true, items };
}

export async function video(dataRoot, { bvid } = {}) {
  if (!bvid) return { ok: false, error: '缺少 bvid' };
  const c = loadCookie(dataRoot);
  const r = await request(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { cookie: c?.cookies });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) return { ok: false, error: j.message || `code ${j.code}` };
  const d = j.data;
  return {
    ok: true,
    video: {
      aid: d.aid,
      bvid: d.bvid,
      // title 一律原样返回：主人要靠完整标题核对，绝不截断（2026-10-26 修）
      title: d.title,
      desc: d.desc,
      cover: d.pic,
      owner: d.owner?.name,
      ownerMid: d.owner?.mid,
      views: d.stat?.view,
      likes: d.stat?.like,
      coins: d.stat?.coin,
      replies: d.stat?.reply,
      pubdate: d.pubdate,
      // 方便直接引用核对（问题 B）
      url: videoUrl(d.bvid),
    },
  };
}

export function videoUrl(bvid) {
  return `https://www.bilibili.com/video/${bvid}`;
}

/**
 * [qqbot-mod] popular 2026-10-27：热门榜（视频雷达「随机来一个」用）。
 * /x/web-interface/popular 带普通 cookie 即可，不需要 wbi。
 */
export async function popular(dataRoot, { limit = 20 } = {}) {
  const c = loadCookie(dataRoot);
  const r = await request(`${API}/x/web-interface/popular?ps=50&pn=1`, { cookie: c?.cookies });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) return { ok: false, error: j.message || `code ${j.code}` };
  const list = (j.data?.list || []).slice(0, Math.max(1, Math.min(50, limit))).map((d) => ({
    aid: d.aid, bvid: d.bvid, title: d.title, desc: d.desc, cover: d.pic,
    owner: d.owner?.name, views: d.stat?.view, likes: d.stat?.like,
    replies: d.stat?.reply, url: videoUrl(d.bvid),
  }));
  return { ok: true, list };
}

/**
 * 读评论区。
 *
 * 2026-10-26 实测：
 *  · 老接口 /x/v2/reply?sort=* 现在对匿名/普通账号经常只回 0~3 条甚至空列表；
 *  · 正确姿势是 /x/v2/reply/wbi/main?oid=&type=1&mode=3（按时间）/mode=2（按热度）
 *    + pagination_str={"offset":""}，**必须带 WBI 签名**才拿得到完整一页。
 *
 * 返回里带 state（B 站评论状态）：
 *  · 0  正常公开
 *  · 非 0（实测审核中/被风控的内容是 17）→ 只有本账号登录时能看到，别人看不到
 */
export async function comments(dataRoot, { aid, limit = 10, sort = 'latest' } = {}) {
  if (!aid) return { ok: false, error: '缺少 aid（先用 video 查）' };
  const c = loadCookie(dataRoot);
  const ps = Math.max(1, Math.min(20, limit));
  const mode = sort === 'hot' ? 2 : 3;
  const mine = String(c?.cookies?.DedeUserID || '');

  const q = await wbiQuery(dataRoot, {
    oid: Number(aid), type: 1, mode, next: 0, ps: ps,
    plat: 1, pagination_str: '{"offset":""}', web_location: 1315875,
  });
  if (q.ok) {
    const r = await request(`${API}/x/v2/reply/wbi/main?${q.query}`, { cookie: c?.cookies });
    if (!r.ok) return r;
    const j = r.json;
    if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
    if (j.code === 0) {
      const replies = (j.data?.replies || []).map((x) => ({
        rpid: String(x.rpid_str || x.rpid || ''),
        user: x.member?.uname,
        mid: String(x.mid || ''),
        text: x.content?.message,
        likes: x.like,
        replies: x.rcount,
        state: Number(x.state ?? 0),
        isSelf: mine && String(x.mid) === mine,
        time: x.ctime,
      }));
      return { ok: true, replies, total: j.data?.cursor?.all_count ?? j.data?.page?.count ?? null, via: 'wbi/main' };
    }
    // -404 = 该 oid 没评论；其它 → 落回老接口
    if (j.code !== -404) {
      const fb = await legacyComments(dataRoot, { aid, limit: ps, mine });
      if (fb.ok) return { ...fb, wbiError: `${j.message || ''}（code ${j.code}）` };
    }
    if (j.code === -404) return { ok: true, replies: [], total: 0, via: 'wbi/main' };
  }
  return legacyComments(dataRoot, { aid, limit: ps, mine });
}

async function legacyComments(dataRoot, { aid, limit = 10, mine = '' } = {}) {
  const c = loadCookie(dataRoot);
  const r = await request(`${API}/x/v2/reply?type=1&oid=${encodeURIComponent(aid)}&sort=2&ps=${Math.max(1, Math.min(20, limit))}&pn=1`, { cookie: c?.cookies });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) return { ok: false, error: j.message || `code ${j.code}` };
  const replies = (j.data?.replies || []).map((x) => ({
    rpid: String(x.rpid_str || x.rpid || ''),
    user: x.member?.uname,
    mid: String(x.mid || ''),
    text: x.content?.message,
    likes: x.like,
    replies: x.rcount,
    state: Number(x.state ?? 0),
    isSelf: !!mine && String(x.mid) === mine,
    time: x.ctime,
  }));
  return { ok: true, replies, total: j.data?.page?.count ?? null, via: 'legacy' };
}

/**
 * 在评论列表 / 楼中楼里定位一条评论（回读校验用）。
 *
 * ⚠️ 2026-10-26 复测结论（决定性）：
 *   · 只用「登录态列表里有、state=0」判断"发出去了"是**错的**——
 *     当天 4 条被折叠的评论全是 state=0 + attr=274877906944(2^38)，
 *     在登录态列表里跟正常评论长得一模一样，但匿名/别人翻不到。
 *   · 唯一可信判据是**匿名（不带 cookie）能不能在列表里翻到**。
 *     所以校验必须传 `anon: true`，失败时才用登录态区分"折叠"还是"已删"。
 *
 * @param {object} opt
 * @param {boolean} opt.anon  不带 cookie（别人的视角）
 * @param {number}  opt.pages 翻几页（默认 1；匿名校验建议 3）
 */
export async function locateComment(dataRoot, { aid, rpid, root, anon = false, pages = 1 } = {}) {
  const target = String(rpid || '');
  if (!target) return { ok: false, error: '缺 rpid' };
  const c = anon ? null : loadCookie(dataRoot);
  const jar = c?.cookies;
  const via0 = anon ? 'anon:' : '';

  if (root) {
    const q = await wbiQuery(dataRoot, { oid: Number(aid), type: 1, root: Number(root), pn: 1, ps: 20, plat: 1 });
    if (q.ok) {
      const r = await request(`${API}/x/v2/reply/reply?${q.query}`, { cookie: jar });
      if (r.ok && r.json?.code === 0) {
        const hit = (r.json.data?.replies || []).find((x) => String(x.rpid_str || x.rpid) === target);
        if (hit) return fmtHit(hit, via0 + 'reply/reply');
      }
    }
  }

  const maxPages = Math.max(1, Math.min(10, Number(pages) || 1));
  for (const mode of [3, 2]) {
    for (let next = 0; next < maxPages; next += 1) {
      const q = await wbiQuery(dataRoot, { oid: Number(aid), type: 1, mode, next, ps: 20, plat: 1, web_location: 1315875 });
      if (!q.ok) break;
      const r = await request(`${API}/x/v2/reply/wbi/main?${q.query}`, { cookie: jar });
      if (!r.ok || r.json?.code !== 0) break;
      const list = [...(r.json.data?.replies || []), ...(r.json.data?.top_replies || [])];
      if (!list.length) break;
      const hit = list.find((x) => String(x.rpid_str || x.rpid) === target);
      if (hit) return fmtHit(hit, `${via0}${mode === 3 ? 'latest' : 'hot'}#${next + 1}`);
    }
  }
  return { ok: true, found: false, anon: !!anon };
}

function fmtHit(x, via) {
  return {
    ok: true,
    found: true,
    via,
    rpid: String(x.rpid_str || x.rpid || ''),
    state: Number(x.state ?? 0),
    // attr 的 2^38 (274877906944) 是「被折叠」的实测特征位，只做诊断用
    attr: Number(x.attr ?? 0),
    user: x.member?.uname,
    mid: String(x.mid || ''),
    text: x.content?.message,
    time: x.ctime,
  };
}

const COMMENT_CODE_HINT = {
  '-412': '被 B 站风控拦截（发太快 / 账号风控），隔一会儿再试',
  '-509': '操作太频繁，被限流了，等几分钟再试',
  '-400': '请求被拒（参数或风控），换个说法/隔一会儿再试',
  '-101': '没登录或登录失效，需要重新扫码',
  '-111': 'csrf 校验失败（cookie 里的 bili_jct 过期），重新扫码',
  '12002': '这个视频关闭了评论区',
  '12061': '需要在 B 站 App 里绑定手机/实名后才能评论',
  '12000': '评论内容被判定为不合适',
};

/**
 * 发评论（可回复某条评论），**发完一定用匿名视角回读校验**。
 *
 * 为什么要回读（2026-10-26 复测，4 组实验 + 同一秒同页对照）：
 *   · 新注册的低信用账号（社区道德分偏低）发评论会拿到 code 0 + rpid + "发送成功"，
 *     但**匿名/别人的列表里翻不到**（账号级降权，换视频、换 cookie jar、换请求形态都一样）。
 *   · 判据不能看 state：被折叠的评论 state=0 + attr=274877906944，跟正常评论外观一致；
 *     昨天那批 state=17 的现在匿名直查已返回 12006。**唯一可信判据是匿名能不能翻到。**
 *   · 请求形态实测：必须 form-urlencoded（JSON 打 /x/v2/reply/add 报 12066"不可发送空白内容"），
 *     WBI 放 query、csrf 放 body；/x/v2/reply/wbi/add 这个端点不存在；不带 WBI 会 -111。
 *
 * 返回：
 *  · {ok:true,  verified:true,  rpid}                          → 匿名都看得见，真的公开了
 *  · {ok:false, posted:true, shadowed:true, anonymousVisible:false} → B 站收下了但被折叠
 *  · {ok:false, posted:false, error, code, hint}               → 根本没提交成功
 */
// ── 拟人化：随机间隔 / 播放心跳 / 观看历史 ─────────────────────────
// 2026-10-26 实测结论（tmp/bili-humanlike.md）：
//  · 评论被折叠不是账号封禁、也不是缺设备指纹，而是"密集连发 + 没看过就评"进了审核通道；
//  · 先发播放心跳、隔 20~90s 再评论，评论就能公开（匿名翻页可见）；
//  · 心跳写完 /x/v2/history 就能看到"看过这条视频"。
const JITTER_MIN_MS = 45000;
const JITTER_MAX_MS = 240000;
let _lastWriteAt = 0;

/** 45~240 秒随机间隔（70% 落在前半段，像真人而不是定时器）。 */
export function jitterDelayMs(minMs = JITTER_MIN_MS, maxMs = JITTER_MAX_MS) {
  const span = Math.max(1000, maxMs - minMs);
  const skew = Math.random() < 0.7 ? Math.random() * 0.55 : 0.55 + Math.random() * 0.45;
  return Math.round(minMs + span * skew);
}

/** 看→赞→评之间的小间隔（20~90 秒）。 */
export function shortGapMs() {
  return 20000 + Math.round(Math.random() * 70000);
}

/**
 * 距离上次写操作不足 ms 就补等。`wait=false` 时只算不睡（给上层判断/自测用）。
 */
export async function jitterWait({ minMs = 0, wait = true } = {}) {
  const now = Date.now();
  const need = Math.max(Number(minMs) || 0, 0);
  const gap = _lastWriteAt ? Math.max(need, jitterDelayMs()) : need;
  const sleepMs = Math.max(0, _lastWriteAt + gap - now);
  if (wait && sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  _lastWriteAt = Date.now();
  return { sleptMs: sleepMs, waited: wait };
}

/** 视频元信息（心跳和评论都要 cid/aid/mid）。 */
export async function fetchVideoMeta(dataRoot, bvid) {
  const v = await video(dataRoot, { bvid });
  if (!v.ok) return v;
  const d = v.video || {};
  let cid = Number(d.cid || 0);
  if (!cid) {
    // view 接口不返回 cid，分P列表第一页就是主视频 cid
    const c = loadCookie(dataRoot);
    const p = await request(`${API}/x/player/pagelist?bvid=${encodeURIComponent(d.bvid || bvid)}`, { cookie: c?.cookies });
    if (p.ok && p.json?.code === 0) cid = Number(p.json.data?.[0]?.cid || 0);
  }
  return {
    ok: true,
    aid: Number(d.aid || 0),
    bvid: String(d.bvid || bvid || ''),
    cid,
    mid: Number(d.ownerMid || 0),
    duration: Number(d.duration || 0),
    title: String(d.title || ''),
  };
}

/**
 * 播放心跳：把"我真的看了这个视频"写进 B 站后台，顺带进观看历史。
 * played_time 必须递增（0→8→21→41…），每步间隔 9~12 秒左右才像真人。
 */
export async function reportWatch(dataRoot, { bvid, aid, cid, mid, playedTimes = [0, 8, 21, 41], gapMs = [9000, 12000] } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  const csrf = c.cookies.bili_jct;
  if (!csrf) return { ok: false, error: 'Cookie 里缺 bili_jct（csrf）' };
  let meta = { aid, cid, mid, bvid };
  if (!meta.aid || !meta.cid) {
    const m = await fetchVideoMeta(dataRoot, bvid);
    if (!m.ok) return m;
    meta = { aid: m.aid, cid: m.cid, mid: m.mid, bvid: m.bvid };
  }
  const referer = `https://www.bilibili.com/video/${meta.bvid}/`;
  const steps = [];
  for (const pt of playedTimes) {
    const body = {
      aid: String(meta.aid),
      bvid: meta.bvid,
      cid: String(meta.cid),
      mid: String(meta.mid || ''),
      played_time: String(pt),
      realtime: String(pt),
      type: '3',
      sub_type: '0',
      csrf,
      plat: '1',
    };
    const r = await request(`${API}/x/click-interface/web/heartbeat`, {
      method: 'POST', form: true, cookie: c.cookies, body, referer, origin: 'https://www.bilibili.com',
    });
    steps.push({ played_time: pt, code: r.ok ? r.json?.code : -1, message: r.ok ? (r.json?.message || '') : r.error });
    const [lo, hi] = gapMs;
    await new Promise((res) => setTimeout(res, lo + Math.round(Math.random() * Math.max(1, hi - lo))));
  }
  _lastWriteAt = Date.now();
  return { ok: steps.every((s) => s.code === 0), steps };
}

/** 一行把观看进度写进历史（/x/v2/history/report）。 */
export async function reportHistoryProgress(dataRoot, { bvid, aid, cid, progress = 46, duration = 0 } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  const csrf = c.cookies.bili_jct;
  let meta = { aid, cid, bvid };
  if (!meta.aid || !meta.cid) {
    const m = await fetchVideoMeta(dataRoot, bvid);
    if (!m.ok) return m;
    meta = { aid: m.aid, cid: m.cid, bvid: m.bvid };
    duration = duration || m.duration;
  }
  const body = {
    aid: String(meta.aid),
    cid: String(meta.cid),
    progress: String(Math.max(0, Math.round(progress))),
    type: '3',
    sub_type: '0',
    csrf,
    plat: '1',
  };
  const r = await request(`${API}/x/v2/history/report`, {
    method: 'POST', form: true, cookie: c.cookies, body,
    referer: `https://www.bilibili.com/video/${meta.bvid}/`,
  });
  _lastWriteAt = Date.now();
  if (!r.ok) return { ok: false, error: r.error };
  if (r.json?.code !== 0) return { ok: false, code: r.json?.code, error: r.json?.message || '写入历史失败' };
  return { ok: true };
}

/** 读观看历史（注意：data 是数组，不是 {list:[]}）。 */
export async function readHistory(dataRoot, { pn = 1, ps = 20 } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站', items: [] };
  const r = await request(`${API}/x/v2/history?pn=${pn}&ps=${ps}`, { cookie: c.cookies });
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const arr = Array.isArray(r.json?.data) ? r.json.data : (Array.isArray(r.json?.data?.list) ? r.json.data.list : []);
  return { ok: true, items: arr, total: arr.length };
}

/**
 * [qqbot-mod] like 2026-10-28：给视频点赞 / 取消点赞。
 * like=1 点赞、like=2 取消；先走 jitter（避免机械节奏），成功后回读确认。
 */
export async function likeVideo(dataRoot, { aid, bvid = '', like = 1, wait = false } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  const csrf = c.cookies.bili_jct;
  if (!csrf) return { ok: false, needLogin: true, error: 'Cookie 里没有 bili_jct，重新扫码登录一下' };
  let id = String(aid || '');
  if (!id && bvid) {
    const m = await fetchVideoMeta(dataRoot, bvid);
    if (!m.ok) return m;
    id = String(m.aid);
  }
  if (!/^\d+$/.test(id)) return { ok: false, error: 'aid 不对：' + id.slice(0, 40) };
  // 写操作前先抖一下（像真人；like 这种低风险动作给 1.5~6s，够自然又不卡界面）
  const _gap = jitterDelayMs(wait ? JITTER_MIN_MS : 1500, wait ? JITTER_MAX_MS : 6000);
  if (_gap > 0) await new Promise((res) => setTimeout(res, _gap));
  const body = { aid: id, like: String(like === 2 ? 2 : 1), csrf };
  const r = await request(`${API}/x/web-interface/archive/like`, {
    method: 'POST', form: true, cookie: c.cookies, body,
    referer: bvid ? `https://www.bilibili.com/video/${bvid}` : 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
  });
  _lastWriteAt = Date.now();
  if (!r.ok) return { ok: false, error: r.error };
  const j = r.json || {};
  if (Number(j.code) !== 0) {
    if (Number(j.code) === -101 || Number(j.code) === -111) return { ok: false, needLogin: true, error: '登录失效了（' + j.message + '）' };
    if (looksLikeRisk(200, j.message || '')) {
      noteRisk(dataRoot, 'bili', { code: j.code, message: String(j.message || '') });
      return { ok: false, risk: true, error: '被风控了：' + j.message + '（已进冷却，先歇一会儿）' };
    }
    return { ok: false, error: '点赞失败：' + (j.message || j.code) };
  }
  return { ok: true, aid: id, bvid: bvid || '', liked: like !== 2, msg: like === 2 ? '已取消赞' : '已点赞' };
}

/** 给一条评论点赞 / 取消（oid=aid，type=1 视频，action=1 赞 / 0 取消）。 */
export async function likeComment(dataRoot, { aid, rpid, action = 1 } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  const csrf = c.cookies.bili_jct;
  if (!csrf) return { ok: false, needLogin: true, error: 'Cookie 里没有 bili_jct' };
  if (!/^\d+$/.test(String(aid || '')) || !/^\d+$/.test(String(rpid || ''))) return { ok: false, error: 'aid / rpid 不对' };
  await new Promise((res) => setTimeout(res, jitterDelayMs(1200, 5000)));
  const body = { oid: String(aid), type: '1', rpid: String(rpid), action: String(action === 0 ? 0 : 1), csrf };
  const r = await request(`${API}/x/v2/reply/action`, {
    method: 'POST', form: true, cookie: c.cookies, body,
    referer: `https://www.bilibili.com/video/av${aid}`, origin: 'https://www.bilibili.com',
  });
  _lastWriteAt = Date.now();
  if (!r.ok) return { ok: false, error: r.error };
  const j = r.json || {};
  if (Number(j.code) !== 0) {
    if (looksLikeRisk(200, j.message || '')) {
      noteRisk(dataRoot, 'bili', { code: j.code, message: String(j.message || '') });
      return { ok: false, risk: true, error: '被风控了：' + (j.message || j.code) };
    }
    return { ok: false, error: '评论点赞失败：' + (j.message || j.code) };
  }
  return { ok: true, aid: String(aid), rpid: String(rpid), liked: action !== 0, msg: action === 0 ? '已取消赞' : '已给评论点赞' };
}

/** 某条视频是否已经在历史里（写心跳后用它自证）。 */
export async function assertInHistory(dataRoot, bvid, { pages = 2 } = {}) {
  const want = String(bvid || '').toLowerCase();
  for (let pn = 1; pn <= pages; pn += 1) {
    const h = await readHistory(dataRoot, { pn, ps: 20 });
    if (!h.ok) return { ok: false, error: h.error, hit: null };
    const hit = h.items.find((x) => String(x?.bvid || '').toLowerCase() === want
      || String(x?.history?.bvid || '').toLowerCase() === want);
    if (hit) {
      return {
        ok: true,
        hit: {
          bvid: hit.bvid || hit.history?.bvid,
          progress: hit.progress,
          duration: hit.duration,
          viewAt: hit.view_at,
          cid: hit.cid,
        },
      };
    }
  }
  return { ok: true, hit: null };
}

export async function postComment(dataRoot, { aid, message, root, parent, verifyMs = 15000, bvid = '', watchFirst = true } = {}) {
  if (!aid) return { ok: false, error: '缺少 aid' };
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: '评论内容为空' };
  if (text.length > 1000) return { ok: false, error: '评论过长（≤1000 字）' };
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  if (!c.cookies.bili_jct) return { ok: false, error: 'Cookie 里缺 bili_jct（csrf），请重新扫码' };

  const csrf = c.cookies.bili_jct;
  const body = { oid: String(aid), type: '1', message: text, csrf, plat: '1' };
  // 回复某条评论：root = 顶层评论 rpid，parent = 被回复的 rpid（回复顶层时两者相同）
  const rootId = String(root || '').trim();
  if (rootId) {
    body.root = rootId;
    body.parent = String(parent || rootId).trim();
  }

  // ── 拟人化前置：先"看"这个视频，隔 20~90 秒再评 ──
  // 实测：没看过就评、或者连发，评论容易进审核通道（匿名看不到）。
  let watched = null;
  if (watchFirst && bvid) {
    try {
      const w = await reportWatch(dataRoot, { bvid });
      watched = { ok: !!w.ok, steps: w.steps?.length || 0 };
      const gap = shortGapMs();
      await new Promise((res) => setTimeout(res, gap));
      watched.gapMs = gap;
    } catch (e) {
      watched = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 写接口也带 WBI 签名（部分账号/时段不加会 -412）
  const q = await wbiQuery(dataRoot, { oid: Number(aid), type: 1, plat: 1, web_location: 333.999 });
  const url = q.ok ? `${API}/x/v2/reply/add?${q.query}` : `${API}/x/v2/reply/add`;
  const r = await request(url, {
    method: 'POST', form: true, cookie: c.cookies, body,
    referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : null,
  });
  _lastWriteAt = Date.now();
  if (!r.ok) return { ok: false, posted: false, error: r.error };
  const j = r.json;
  if (needLogin(j)) return { ok: false, posted: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) {
    const code = String(j.code);
    return {
      ok: false,
      posted: false,
      error: `${j.message || '请求失败'}（code ${j.code}）`,
      code: j.code,
      hint: COMMENT_CODE_HINT[code] || 'B 站拒绝了这条评论',
    };
  }

  const rpid = String(j.data?.rpid_str || j.data?.rpid || '');
  if (!rpid) {
    return { ok: false, posted: true, verified: false, error: 'B 站返回成功但没给 rpid，无法确认是否真的发出去' };
  }

  // ── 回读校验：以「匿名能不能看到」为准 ──
  // 2026-10-26 复测：登录态 state=0 也会被折叠（attr=2^38），所以先匿名扫 3 页；
  // 匿名找不到时再用登录态确认「折叠」还是「已删」，回话必须区分开。
  const deadline = Date.now() + Math.max(2000, Math.min(60000, Number(verifyMs) || 15000));
  let anon = null;
  let self = null;
  let attempts = 0;
  do {
    attempts += 1;
    anon = await locateComment(dataRoot, { aid, rpid, root: rootId, anon: true, pages: 3 });
    if (anon.ok && anon.found) break;
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 2500));
  } while (true);

  if (anon?.ok && anon.found) {
    return { ok: true, posted: true, verified: true, rpid, state: anon.state, visible: true, via: anon.via, attempts, anon: true };
  }

  // 匿名看不见 → 看看自己（登录态）还在不在，用来区分"折叠"和"已删"
  self = await locateComment(dataRoot, { aid, rpid, root: rootId });
  if (self?.ok && self.found) {
    // attr 的 bit 38（274877906944）实测是"审核/折叠"标记：state 仍是 0，只有匿名视角能看出来。
    const attrNum = Number(self.attr || 0) || 0;
    const inReview = attrNum > 0 && Math.floor(attrNum / 2 ** 38) % 2 === 1;
    return {
      ok: false,
      posted: true,
      verified: false,
      shadowed: true,
      inReview,
      rpid,
      state: self.state,
      attr: self.attr,
      via: self.via,
      attempts,
      anonymousVisible: false,
      error:
        `B 站收下了这条评论（rpid ${rpid}），但**匿名视角翻 3 页都看不到**（只有本账号登录能看到）。`
        + (inReview ? '它被标了审核标记（attr bit 38），正在审核队列里。' : '它被折叠了。')
        + '这就是"说自己评了、别人却找不到"的原因——不是代码写错。',
      hint:
        '实测：同一账号能公开（别人的评论匿名可见那套机制没问题），这次进审核多半是**今天评得太多/连发**。'
        + '建议：① 今天别再评，隔 24 小时再来；② 每条间隔 1 小时以上；③ 别用"口供/免死鲸牌/排队占位"这类模板求互动文案。',
    };
  }
  return {
    ok: false,
    posted: true,
    verified: false,
    rpid,
    attempts,
    anonymousVisible: false,
    error: `提交返回成功（拿到 rpid ${rpid}），但匿名和登录态都翻不到这条评论`,
    hint: '可能刚被删除或列表刷新滞后；别对用户说"已经发好了"，过几分钟再用 comments 看一次。',
  };
}

/**
 * 发一条纯文字动态。
 *
 * ⚠️ 2026-10 实测：新版接口只吃 **JSON body**（`{dyn_req, csrf}`，csrf 同时放查询串），
 * 用 form-urlencoded 发出去永远是 `{"code":-400,"message":"请求错误"}`（旧版兜底接口则是
 * 4126143 请求数据发生错误）—— 这就是"发不了动态"的真正原因，不是风控也不是没登录。
 */
export async function postDynamic(dataRoot, { content } = {}) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: '动态内容为空' };
  if (text.length > 2000) return { ok: false, error: '动态过长（≤2000 字）' };
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  if (!c.cookies.bili_jct) return { ok: false, error: 'Cookie 缺 bili_jct（csrf）' };

  const csrf = c.cookies.bili_jct;
  const dynReq = {
    content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
    scene: 1,
    upload_id: '',
  };
  const r1 = await request(`https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${encodeURIComponent(csrf)}`, {
    method: 'POST',
    cookie: c.cookies,
    body: { dyn_req: dynReq, csrf },
  });
  if (r1.ok && r1.json && r1.json.code === 0) {
    return {
      ok: true,
      dynamicId: r1.json.data?.dyn_id_str || r1.json.data?.dynamic_id_str || r1.json.data?.dyn_id || r1.json.data?.dynamic_id,
      via: 'new-json',
    };
  }
  if (r1.ok && r1.json && needLogin(r1.json)) {
    return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  }

  // 旧版兜底（新接口 -400 时再试一次）
  const r = await request('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create', {
    method: 'POST',
    form: true,
    cookie: c.cookies,
    body: { content: text, type: 1, csrf: csrf },
  });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) return { ok: false, error: (r1.ok && r1.json && r1.json.message) || j.message || `code ${j.code}` };
  return { ok: true, dynamicId: j.data?.dynamic_id_str || j.data?.dynamic_id, via: 'legacy' };
}

/** 删掉自己的一条动态（发错了能收回来） */
export async function removeDynamic(dataRoot, { dynamicId } = {}) {
  const id = String(dynamicId || '').trim();
  if (!id) return { ok: false, error: '缺 dynamicId' };
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  const csrf = c.cookies.bili_jct;
  // 实测：字段名必须是 dyn_id（dynamic_id 会回 4101001 参数错误），且同样只吃 JSON body
  const r = await request(`https://api.bilibili.com/x/dynamic/feed/operate/remove?csrf=${encodeURIComponent(csrf)}&platform=web`, {
    method: 'POST',
    cookie: c.cookies,
    body: { dyn_id: id, csrf },
  });
  if (!r.ok) return r;
  if (needLogin(r.json)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (r.json.code !== 0) return { ok: false, error: r.json.message || `code ${r.json.code}` };
  return { ok: true };
}

// ── "最近那个视频" 台账 + 从聊天文本/卡片里抽 BV ──────────────────────
/**
 * 落盘格式（{dataRoot}/.qqbot/bili-last-video.json）：
 * {
 *   bvid, aid, title, url,
 *   at,          // 毫秒时间戳
 *   by,          // 谁分享/谁提的（昵称或 openid）
 *   source,      // 'inkbound-text' | 'inkbound-card' | 'tool-video' | 'tool-comment' | 'tool-share' | 'manual'
 *   commentRpid  // 最近一次对这个视频评论成功的 rpid（有才写）
 * }
 */
export const LAST_VIDEO_FILE = (dataRoot) => join(dataRoot, '.qqbot', 'bili-last-video.json');

export function readLastVideo(dataRoot) {
  try {
    const j = JSON.parse(readFileSync(LAST_VIDEO_FILE(dataRoot), 'utf8'));
    return j && j.bvid ? j : null;
  } catch { return null; }
}

export function writeLastVideo(dataRoot, rec = {}) {
  const prev = readLastVideo(dataRoot) || {};
  const merged = { ...prev, ...rec, at: Date.now() };
  if (!merged.bvid) return null;
  merged.url = merged.url || videoUrl(merged.bvid);
  try {
    mkdirSync(join(dataRoot, '.qqbot'), { recursive: true });
    writeFileSync(LAST_VIDEO_FILE(dataRoot), JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch { return null; }
}

/** 从任意文本里抽 B 站视频引用（BV 号 / av 号 / b23.tv 短链 / 带参数的播放页链接） */
export function extractVideoRef(text) {
  const s = String(text || '');
  const out = { bvid: '', avid: '', short: '', raw: '' };
  const bv = s.match(/\b(BV[0-9A-Za-z]{10})\b/);
  if (bv) { out.bvid = bv[1]; out.raw = bv[1]; }
  if (!out.bvid) {
    const av = s.match(/\b(?:^|[^0-9A-Za-z])(?:av|AV)(\d{3,})\b/);
    if (av) { out.avid = av[1]; out.raw = `av${av[1]}`; }
  }
  const b23 = s.match(/b23\.tv\/([0-9A-Za-z]+)/);
  if (b23) { out.short = `https://b23.tv/${b23[1]}`; out.raw = out.raw || out.short; }
  if (!out.bvid && !out.avid && !out.short) {
    const full = s.match(/bilibili\.com\/video\/(?:BV([0-9A-Za-z]{10})|av(\d+))/i);
    if (full) {
      if (full[1]) out.bvid = `BV${full[1]}`;
      else out.avid = full[2];
      out.raw = full[0];
    }
  }
  return out;
}

/** 把 b23.tv 短链跟一次 302，拿到真实 bvid / aid */
export async function expandShortLink(short) {
  const url = String(short || '').trim();
  if (!url) return { ok: false, error: '缺短链' };
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA, referer: REFERER } });
    let loc = res.headers.get('location') || '';
    if (!loc && res.status >= 300 && res.status < 400) loc = res.headers.get('Location') || '';
    if (!loc) {
      const body = await res.text().catch(() => '');
      const m = String(body).match(/https?:\/\/[^"'\\\s]+/);
      loc = m ? m[0] : '';
    }
    if (!loc) return { ok: false, error: `短链没返回跳转（HTTP ${res.status}）` };
    const ref = extractVideoRef(loc);
    return { ok: true, url: loc, ...ref };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 把任意视频引用（BV/av/b23 链接/整段文本）解析成 bvid。
 * 用户直接给了 BV/链接时优先用给的。
 */
export async function resolveVideoRef(dataRoot, ref) {
  const got = typeof ref === 'string' ? extractVideoRef(ref) : { ...(ref || {}) };
  if (got.bvid) return { ok: true, bvid: got.bvid, via: 'bvid' };
  if (got.short) {
    const e = await expandShortLink(got.short);
    if (e.ok && e.bvid) return { ok: true, bvid: e.bvid, via: 'b23', url: e.url };
    if (e.ok && e.avid) {
      // 短链落到 av 号的老视频：再换成 bvid，后面所有接口都吃 bvid
      const c = loadCookie(dataRoot);
      const r = await request(`${API}/x/web-interface/view?aid=${encodeURIComponent(e.avid)}`, { cookie: c?.cookies });
      if (r.ok && r.json?.code === 0 && r.json.data?.bvid) {
        return { ok: true, bvid: r.json.data.bvid, via: 'b23-av', url: e.url };
      }
      return { ok: false, error: `短链落到 av${e.avid}，但查不到这个视频` };
    }
    return { ok: false, error: e.error || '短链解析失败' };
  }
  if (got.avid) {
    const c = loadCookie(dataRoot);
    const r = await request(`${API}/x/web-interface/view?aid=${encodeURIComponent(got.avid)}`, { cookie: c?.cookies });
    if (r.ok && r.json?.code === 0 && r.json.data?.bvid) return { ok: true, bvid: r.json.data.bvid, via: 'av' };
    return { ok: false, error: `av${got.avid} 查不到视频` };
  }
  return { ok: false, error: '这段里没找到 BV 号 / av 号 / b23 短链' };
}

/** 查视频信息并写进"最近视频"台账（分享/评论入口都会调） */
export async function rememberVideo(dataRoot, { bvid, by = '', source = '' } = {}) {
  const v = await video(dataRoot, { bvid });
  if (!v.ok) return v;
  const rec = writeLastVideo(dataRoot, {
    bvid: v.video.bvid,
    aid: v.video.aid,
    title: v.video.title,
    url: v.video.url,
    by: String(by || ''),
    source: String(source || ''),
  });
  return { ok: true, video: v.video, record: rec };
}

export async function fetchImage(url, { timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: REFERER },
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!/^image\//i.test(type) && buf.length < 1024) return { ok: false, error: `不是图片（${type}）` };
    return { ok: true, buf, type, size: buf.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ═══ [[bili-msgs] 私信收件箱 2026-10-27：会话列表 / 读消息 / 发消息 ═══
// 参考 bilibili-API-collect 的 web IM 端点；发消息要 bili_jct（csrf）。只收发文本，别的不碰。

const VC = 'https://api.vc.bilibili.com';

/** 会话列表（私信收件箱）：type=1 为普通私聊。 */
export async function sessions(dataRoot, { limit = 20 } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  const r = await request(`${VC}/session_svr/v1/session_svr/get_sessions?type=1&group_fold=1&unfollow_fold=0&need_rule=1&build=0&mobi_app=web&ps=${Number(limit) || 20}`, { cookie: c.cookies });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) return { ok: false, error: `${j.message || '读会话失败'}（code ${j.code}）` };
  const rows = (j.data?.session_list || []).map((s) => {
    const u = s.account_info || {};
    const lm = s.last_msg || {};
    return {
      talkerId: s.talker_id,
      sessionId: s.session_id,
      name: u.nickname || String(u.uname || s.talker_id_desc || s.talker_id),
      avatar: u.avatar || '',
      unread: Number(s.unread_count || 0),
      ack: Number(s.new_msg_ack || 0),
      lastText: String(lm.content || '').slice(0, 120),
      lastTime: Number(s.last_time || 0) * 1000,
    };
  });
  return { ok: true, sessions: rows };
}

/** 某个会话的历史消息（talkerId = 对方 mid）。 */
export async function msgs(dataRoot, { talkerId, size = 20 } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  if (!talkerId) return { ok: false, error: '缺少会话（talkerId）' };
  const r = await request(`${VC}/sv_sync/v1/sync?client_type=web&ps=${Number(size) || 20}&session_id=${encodeURIComponent(talkerId)}&build=0&mobi_app=web`, { cookie: c.cookies });
  if (!r.ok) return r;
  const j = r.json;
  if (j.code !== 0) return { ok: false, error: `${j.message || '读消息失败'}（code ${j.code}）` };
  const myMid = String(c.cookies.DedeUserID || '');
  const rows = (j.data?.messages || []).map((m) => ({
    mid: String(m.msg_key || ''),
    fromMe: String(m.sender_uid || '') === myMid,
    sender: String(m.sender_uid || ''),
    type: Number(m.msg_type || 1),
    text: m.content?.content ? String(m.content.content).slice(0, 500) : (m.msg_type === 11 ? '[图片]' : m.content ? JSON.stringify(m.content).slice(0, 120) : ''),
    ts: Number(m.timestamp || 0) * 1000,
  })).sort((a, b) => a.ts - b.ts);
  return { ok: true, messages: rows };
}

/** 发一条文本私信（receiverId = 对方 mid）。 */
export async function msgSend(dataRoot, { receiverId, text } = {}) {
  const c = loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  const content = String(text || '').trim();
  if (!content) return { ok: false, error: '消息内容为空' };
  if (content.length > 500) return { ok: false, error: '消息过长（≤500 字）' };
  const csrf = c.cookies.bili_jct;
  if (!csrf) return { ok: false, error: 'Cookie 缺 bili_jct（csrf），请重新扫码' };
  const myMid = String(c.cookies.DedeUserID || '');
  if (!myMid) return { ok: false, error: 'Cookie 缺 DedeUserID（你的 mid）' };
  const devId = randomUUID().toUpperCase();
  const r = await request(`${VC}/web_im/v1/web_im_send_msg`, {
    method: 'POST', form: true, cookie: c.cookies,
    body: {
      'msg[sender_uid]': myMid,
      'msg[receiver_id]': String(receiverId),
      'msg[receiver_type]': '1',
      'msg[msg_type]': '1',
      'msg[msg_status]': '0',
      'msg[content]': JSON.stringify({ content }),
      'msg[dev_id]': devId,
      'msg[new_face_version]': '0',
      'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
      'from_firework': '0',
      'build': '0',
      'mobi_app': 'web',
      'send_from_me': '1',
      'csrf_token': csrf,
      'csrf': csrf,
    },
  });
  if (!r.ok) return r;
  const j = r.json;
  if (needLogin(j)) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
  if (j.code !== 0) return { ok: false, error: `${j.message || '发送失败'}（code ${j.code}）` };
  return { ok: true, msgKey: String(j.data?.msg_key || '') };
}
