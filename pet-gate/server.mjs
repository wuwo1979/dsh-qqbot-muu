/**
 * pet-gate/server.mjs — 桌宠公网网关（云端侧，零依赖）
 *
 * 架构（2026-11-01 主人拍板：发布为限制人数的在线链接，可重置，防 IP 攻击）：
 *   浏览器 → 本网关（云沙箱，只开一个 HTTP 口）
 *     ├─ 静态素材 /media/<form>/<名>.webm（部署时随源码打包，免中继）
 *     └─ /api/qqbot-settings/pet-*（动作/状态/形态）→ 任务队列
 *   本机 agent（agent.mjs，主动外连本网关，不开本地入站端口）
 *     └─ 长轮询取任务 → 代答本机 harness（127.0.0.1:43129）→ 回投结果
 *   dsh token 只存在于本机内存，云端与浏览器全程见不到。
 *
 * 安全设计（防 IP 攻击）：
 *   · 访问码登录：恒时比较；每 IP 10 分钟最多 5 次失败，超了拉黑 15 分钟
 *   · 单席位：同时只允许 N 个会话（默认 1），新登录被拒；可由主人重置踢人
 *   · 会话 cookie：HttpOnly + SameSite=Lax + HMAC 签名，空闲 30 分钟自动退席
 *   · 全局限速：每 IP 120 请求/分钟；请求体上限 64KB；所有出站路径白名单
 *   · 管理口（重置席位/换访问码）只认 adminKey，且结果不回显 key 本体
 *   · 安全响应头全套；不回显内部错误细节
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const PAGE_VER = '1101c4'; // 页面版本号：路径 /watch?v= 用它破 webview 顽固缓存（每次改页面必 bump）1101c4=整活动作池+拎起交互；1101c3=修 muu 素材目录 404（petId=main≠目录muu）+ canPlayType 选格反转

// ── 密钥与配置（secrets.json 部署时随包上传但被 git 忽略；首次启动自动生成）──
const SEC_PATH = join(ROOT, 'secrets.json');
function loadSecrets() {
  if (existsSync(SEC_PATH)) {
    try { return JSON.parse(readFileSync(SEC_PATH, 'utf8')); } catch { /* 坏了重生成 */ }
  }
  const s = {
    accessKey: randomBytes(9).toString('base64url'),   // 访问码（发给那位群友）
    adminKey: randomBytes(18).toString('base64url'),   // 主人管理口令（重置/换码）
    agentKey: randomBytes(18).toString('base64url'),   // 本机 agent 连接凭据
    seats: 1,                                          // 席位数（主人拍板：先 1 人）
    cookieSecret: randomBytes(24).toString('base64url'),
  };
  writeFileSync(SEC_PATH, JSON.stringify(s, null, 2), 'utf8');
  return s;
}
const SEC = loadSecrets();
const IDLE_MS = 30 * 60 * 1000;        // 席位空闲回收
const SESSION_TTL = 12 * 3600 * 1000;  // 会话最长寿命

// ── 席位表（内存 + 落盘，重启不丢）──
const SEATS_PATH = join(ROOT, 'seats.json');
let seats = new Map(); // sid → { at, born, ua }
try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(SEATS_PATH, 'utf8')))) seats.set(k, v); } catch { /* 首次 */ }
function saveSeats() {
  try { writeFileSync(SEATS_PATH, JSON.stringify(Object.fromEntries(seats)), 'utf8'); } catch { /* ignore */ }
}
function gcSeats() {
  const now = Date.now();
  let changed = false;
  for (const [sid, s] of seats) {
    if (now - s.at > IDLE_MS || now - s.born > SESSION_TTL) { seats.delete(sid); changed = true; }
  }
  if (changed) saveSeats();
}
setInterval(gcSeats, 60 * 1000).unref?.();

// ── 限速（每 IP 桶）──
const buckets = new Map(); // ip → { tokens, at }
const RATE_PER_MIN = 120;
function rateOK(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: RATE_PER_MIN, at: now }; buckets.set(ip, b); }
  b.tokens = Math.min(RATE_PER_MIN, b.tokens + ((now - b.at) / 60000) * RATE_PER_MIN);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
const loginFails = new Map(); // ip → { n, until }
// 周期清理：限速桶/失败表只增不减会慢性漏内存（公网长期跑必备）
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.at > 10 * 60 * 1000) buckets.delete(ip);
  for (const [ip, f] of loginFails) if (f.until < now && f.n === 0) loginFails.delete(ip);
}, 5 * 60 * 1000).unref?.();
function loginBlocked(ip) {
  const f = loginFails.get(ip);
  return f && f.until > Date.now();
}
function loginFail(ip) {
  const f = loginFails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; }
  loginFails.set(ip, f);
}

// ── 小工具 ──
const sha = (s) => createHash('sha256').update(String(s)).digest();
function safeEq(a, b) {
  const x = sha(a), y = sha(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function sign(sid) { return createHmac('sha256', SEC.cookieSecret).update(sid).digest('base64url'); }
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const cs = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); return; } cs.push(c); });
    req.on('end', () => resolve(Buffer.concat(cs)));
    req.on('error', reject);
  });
}
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
};
function reply(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  try {
    res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', ...SEC_HEADERS, ...extra });
    res.end(buf);
  } catch { /* 客户端断开 */ }
}
function ipOf(req) {
  const xf = req.headers['x-forwarded-for'];
  return (typeof xf === 'string' && xf.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}

// ── 任务队列（浏览器 ⇄ agent 中继）──
const jobs = new Map();      // id → { id, method, path, bodyB64, resolve, at }
const jobQueue = [];         // 待取任务 id
let jobSeq = 0;
function enqueueJob(method, path, bodyB64) {
  const id = `j${++jobSeq}_${randomBytes(4).toString('hex')}`;
  return new Promise((resolve) => {
    const j = { id, method, path, bodyB64, resolve, at: Date.now() };
    jobs.set(id, j);
    jobQueue.push(j);
    setTimeout(() => {
      if (jobs.has(id)) { jobs.delete(id); const i = jobQueue.findIndex((x) => x.id === id); if (i >= 0) jobQueue.splice(i, 1); resolve({ status: 504, type: 'application/json', body: Buffer.from(JSON.stringify({ ok: false, message: '网关中继超时（本机 agent 不在线？）' })) }); }
    }, 25000).unref?.();
  });
}
setInterval(() => { /* 清理孤儿任务由 25s 超时兜底 */ }, 30000).unref?.();

const AGENT_PATH_RE = /^\/api\/qqbot-settings\/(pet-anim|pet-media|pet-status|pet-share)$/; // 双白名单之一（云端侧）
const MEDIA_FORMS = 'xiaolan|classic|de|muu'; // 四形态静态素材目录（部署时随包分发）
const MEDIA_RE = /^[^/\\]+\.(webm|mp4)$/; // 文件名可含中文；禁路径分隔符即禁穿越
const MEDIA_TYPE = { webm: 'video/webm', mp4: 'video/mp4' };

// ── 桌宠页面（从 pet-panel v5 页面适配：素材走 /media 静态，404 回退中继）──
import { PAGE_HTML, loginHtml } from './gate-page.mjs';

// ── 主循环 ──
const server = http.createServer(async (req, res) => {
  const ip = ipOf(req);
  const u = new URL(req.url, 'http://x');

  if (!rateOK(ip)) return reply(res, 429, { ok: false, message: '请求太频繁，稍后再试' });

  // ── agent 端点（agentKey 认证，不走席位）──
  if (u.pathname === '/agent/poll' || u.pathname === '/agent/result') {
    if (!safeEq(String(req.headers['x-agent-key'] || ''), SEC.agentKey)) return reply(res, 403, { ok: false, message: 'forbidden' });
    if (req.method !== 'POST') return reply(res, 405, { ok: false });
    let body = {};
    try { body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8') || '{}'); } catch { body = {}; }
    if (u.pathname === '/agent/poll') {
      const waitUntil = Date.now() + 20000;
      while (jobQueue.length === 0 && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 300));
      const take = jobQueue.splice(0, 4);
      return reply(res, 200, { ok: true, jobs: take.map((j) => ({ id: j.id, method: j.method, path: j.path, bodyB64: j.bodyB64 || '' })) });
    }
    // /agent/result
    const j = jobs.get(String(body.id || ''));
    if (!j) return reply(res, 200, { ok: false, message: 'job gone' });
    if (!AGENT_PATH_RE.test(j.path)) { jobs.delete(j.id); return reply(res, 200, { ok: false }); }
    jobs.delete(j.id);
    const i = jobQueue.findIndex((x) => x.id === j.id); if (i >= 0) jobQueue.splice(i, 1);
    j.resolve({ status: Number(body.status) || 200, type: String(body.type || 'application/json; charset=utf-8'), body: Buffer.from(String(body.bodyB64 || ''), 'base64') });
    return reply(res, 200, { ok: true });
  }

  // ── 静态素材（免登录？不 —— 也要登录，防素材被扫）──
  const mMedia = new RegExp(`^\\/media\\/(${MEDIA_FORMS})\\/([^/\\\\]+\\.(?:webm|mp4))$`).exec(decodeURIComponent(u.pathname));
  if (mMedia) {
    const sid = authCookie(req);
    if (!sid || !seats.has(sid)) return reply(res, 401, { ok: false, message: '请先登录' });
    if (!MEDIA_RE.test(mMedia[2])) return reply(res, 404, { ok: false });
    const p = join(ROOT, 'media', mMedia[1], mMedia[2]);
    console.log(`[media] ${mMedia[1]}/${mMedia[2]} exists=${existsSync(p)} ua=${String(req.headers['user-agent'] || '').slice(0, 40)}`);
    if (!existsSync(p)) return reply(res, 404, { ok: false, message: 'fallthrough' }); // 前端回退到中继
    const buf = readFileSync(p);
    const ext = mMedia[2].split('.').pop();
    return reply(res, 200, buf, MEDIA_TYPE[ext] || 'video/webm', { 'cache-control': 'private, max-age=3600' });
  }

  // ── 登录/页面（2026-11-01：页面路径 / → /watch，用换路径的方式破 webview 对旧页面的顽固缓存）──
  if (u.pathname === '/') {
    const qs = u.searchParams.toString();
    return reply(res, 302, '', 'text/plain', { location: '/watch?v=' + PAGE_VER + (qs ? '&' + qs : '') });
  }
  if (u.pathname === '/login' && req.method === 'GET') {
    return reply(res, 302, '', 'text/plain', { location: '/watch?v=' + PAGE_VER });
  }
  if (u.pathname === '/watch') {
    if (req.method === 'GET') {
      // ?key= 直进通道（免密钥模式或键入访问码）：服务端验证后种 cookie 再回页面
      const qk = u.searchParams.get('key') || '';
      const sid0 = authCookie(req);
      if ((!sid0 || !seats.has(sid0)) && qk && (SEC.freeMode === true || safeEq(qk, SEC.accessKey))) {
        gcSeats();
        if (seats.size < SEC.seats) {
          const nsid = randomBytes(24).toString('hex');
          seats.set(nsid, { at: Date.now(), born: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 120) });
          saveSeats();
          return reply(res, 302, '', 'text/plain', {
            location: '/watch?v=' + PAGE_VER + '&t=' + Date.now(),
            'set-cookie': `pgs=${nsid}.${sign(nsid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`,
          });
        }
      }
      const sid = authCookie(req);
      if (sid && seats.has(sid)) { seats.get(sid).at = Date.now(); saveSeats(); return reply(res, 200, PAGE_HTML, 'text/html; charset=utf-8'); }
      return reply(res, 200, loginHtml(SEC.freeMode === true), 'text/html; charset=utf-8');
    }
  }
  if (u.pathname === '/login' && req.method === 'POST') {
    {
      if (loginBlocked(ip)) return reply(res, 429, { ok: false, message: '尝试次数过多，15 分钟后再来' });
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return reply(res, 400, { ok: false, message: 'bad request' }); }
      // 免密钥模式（2026-11-01 主人要求：邀请制入口）—— 开启时不需要访问码，
      // 其余防护（单席位/限速/拉黑）全部保留；关闭后立刻恢复验码。
      const free = SEC.freeMode === true;
      if (!free && !safeEq(String(body.key || ''), SEC.accessKey)) { loginFail(ip); return reply(res, 403, { ok: false, message: '访问码不对' }); }
      gcSeats();
      if (seats.size >= SEC.seats) return reply(res, 403, { ok: false, message: `席位已满（限 ${SEC.seats} 人）——请让主人重置席位后再来` });
      const sid = randomBytes(24).toString('hex');
      seats.set(sid, { at: Date.now(), born: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 120) });
      saveSeats();
      loginFails.delete(ip);
      return reply(res, 200, { ok: true }, 'application/json; charset=utf-8', {
        'set-cookie': `pgs=${sid}.${sign(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`,
      });
    }
  }

  // ── 业务 API（须有席位；只放行白名单，其余一律 404 不解释）──
  if (AGENT_PATH_RE.test(u.pathname)) {
    const sid = authCookie(req);
    if (!sid || !seats.has(sid)) return reply(res, 401, { ok: false, message: '请先登录' });
    seats.get(sid).at = Date.now();
    let raw = Buffer.alloc(0);
    if (req.method === 'POST') { try { raw = await readBody(req); } catch { return reply(res, 413, { ok: false }); } }
    const r = await enqueueJob(req.method, u.pathname, raw.length ? raw.toString('base64') : '');
    return reply(res, r.status, r.body, r.type);
  }

  // ── 管理口（adminKey；不给任何 key 回显）──
  if (u.pathname === '/admin/status' || u.pathname === '/admin/reset-seat' || u.pathname === '/admin/rotate-key' || u.pathname === '/admin/free-mode') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { }
    if (!safeEq(String((req.headers['x-admin-key'] || body.adminKey) || ''), SEC.adminKey)) return reply(res, 403, { ok: false, message: 'forbidden' });
    gcSeats();
    if (u.pathname === '/admin/status') {
      return reply(res, 200, { ok: true, seatsUsed: seats.size, seatsMax: SEC.seats, sessions: [...seats.values()].map((s) => ({ born: new Date(s.born).toISOString(), idleMin: Math.round((Date.now() - s.at) / 60000), ua: s.ua })) });
    }
    if (u.pathname === '/admin/reset-seat') {
      const n = seats.size; seats.clear(); saveSeats();
      return reply(res, 200, { ok: true, kicked: n, message: '已重置席位，凭访问码可重新进入' });
    }
    // free-mode：免密钥邀请开关（开=任何人拿到链接即可进，仍限席位；关=恢复验码）
    if (u.pathname === '/admin/free-mode') {
      SEC.freeMode = body.on === true;
      writeFileSync(SEC_PATH, JSON.stringify(SEC, null, 2), 'utf8');
      return reply(res, 200, { ok: true, freeMode: SEC.freeMode, message: SEC.freeMode ? '免密钥已开启（链接直接进，仍限席位）' : '免密钥已关闭（恢复访问码验证）' });
    }
    // rotate-key：换访问码（新码由本机 CLI 生成后经 adminKey 鉴权通道送来 —— 云端沙箱里的文件主人读不到）
    const nk = String(body.newKey || '').trim();
    if (nk.length < 8 || nk.length > 64 || !/^[\w-]+$/.test(nk)) return reply(res, 400, { ok: false, message: 'newKey 需要 8~64 位字母数字' });
    SEC.accessKey = nk;
    writeFileSync(SEC_PATH, JSON.stringify(SEC, null, 2), 'utf8');
    return reply(res, 200, { ok: true, message: '访问码已更换' });
  }

  return reply(res, 404, { ok: false, message: 'not found' });
});

function authCookie(req) {
  const c = String(req.headers.cookie || '');
  const m = /(?:^|;\s*)pgs=([\w]+)\.([\w-]+)(?:;|$)/.exec(c);
  if (!m) return null;
  const [, sid, sig] = m;
  try { if (safeEq(sig, sign(sid))) return sid; } catch { /* ignore */ }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pet-gate] listening on 0.0.0.0:${PORT}（seats=${SEC.seats}）`);
});
