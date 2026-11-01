#!/usr/bin/env node
/**
 * pet-gate/agent.mjs — 桌宠公网网关的本机连接器（零依赖）
 *
 * 职责：主动外连云端网关（不开本机任何入站端口），长轮询取任务 →
 *       代答本机 harness（127.0.0.1:43129 的 /api/qqbot-settings/pet-*，
 *       由 bot 的 pet-panel 挂载）→ 回投结果。dsh token 全程不出本机。
 *
 * 用法（在 F:/qqbot 下）：
 *   node pet-gate/agent.mjs                # 前台运行（默认）
 *   node pet-gate/agent.mjs status         # 看云端席位占用
 *   node pet-gate/agent.mjs reset-seat     # 重置席位（踢掉当前在线的人，可重进）
 *   node pet-gate/agent.mjs new-key        # 换访问码（旧的立即作废，新码看 secrets.json）
 *
 * 配置：pet-gate/secrets.json { cloudUrl, agentKey }（cloudUrl 首次部署后填入）
 * 安全：只代答 pet-anim/pet-media/pet-status 三个路径（本地再验一次白名单）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SEC_PATH = join(ROOT, 'secrets.json');
const AGENT_PATH_RE = /^\/api\/qqbot-settings\/(pet-anim|pet-media|pet-status)$/; // 双白名单之二（本机侧）
const CMD = process.argv[2] || 'run';

function loadSec() {
  if (!existsSync(SEC_PATH)) { console.error('✗ 找不到 pet-gate/secrets.json（先部署网关生成）'); process.exit(1); }
  try { return JSON.parse(readFileSync(SEC_PATH, 'utf8')); } catch (e) { console.error('✗ secrets.json 坏了:', e.message); process.exit(1); }
}
const SEC = loadSec();

// ── 复用 bot 的 harness 端点解析（port+token 惰性读 harness.log，token 轮换自愈）──
const { webEndpoint } = await import('../dshqqbot/.qqbot-extensions/lib/pet-anim.mjs');

async function localHandle(method, path, bodyBuf) {
  let ep = webEndpoint();
  if (!ep) return { status: 503, type: 'application/json', body: Buffer.from(JSON.stringify({ ok: false, message: '本机桌宿没启动' })) };
  const call = async (e2) => {
    // 注意：不能加任何 query（如缓存戳）—— harness 的 exact 路由按原始路径匹配，加了会 405
    const url = `http://127.0.0.1:${e2.port}${path}`;
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? bodyBuf : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const type = r.headers.get('content-type') || 'application/json; charset=utf-8';
    return { status: r.status, type, body: Buffer.from(await r.arrayBuffer()) };
  };
  let r = await call(ep);
  if (r.status === 401 || r.status === 403) {
    ep = webEndpoint(true);
    if (ep) r = await call(ep);
  }
  return r;
}

async function run() {
  if (!SEC.cloudUrl) { console.error('✗ secrets.json 里还没有 cloudUrl（等首次部署后填入）'); process.exit(1); }
  console.log(`[agent] 云端: ${SEC.cloudUrl}`);
  // 平台层 sharecode 门：先首访领 cookie，之后所有请求带上（浏览器自动做，agent 手动做）
  const sharecode = (SEC.cloudUrl.split('sharecode=')[1] || '').split('&')[0];
  const base = SEC.cloudUrl.split('?')[0];
  let platformCookie = '';
  try {
    const boot = await fetch(`${base}/?sharecode=${sharecode}`, { signal: AbortSignal.timeout(15000) });
    const sc = boot.headers.getSetCookie ? boot.headers.getSetCookie() : [];
    platformCookie = sc.map((c) => c.split(';')[0]).join('; ');
    console.log(`[agent] 平台门通过（cookie ${platformCookie ? '已领取' : '未需要'}）`);
  } catch (e) { console.log(`[agent] 平台门首访失败（继续尝试）: ${e.message}`); }
  const hdrs = () => ({ 'x-agent-key': SEC.agentKey, 'content-type': 'application/json', ...(platformCookie ? { cookie: platformCookie } : {}) });
  let backoff = 3000;
  for (;;) {
    try {
      const r = await fetch(`${base}/agent/poll`, {
        method: 'POST',
        headers: hdrs(),
        body: '{}',
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`poll http-${r.status}`);
      const j = await r.json();
      backoff = 3000;
      for (const job of j.jobs || []) {
        if (!AGENT_PATH_RE.test(job.path)) continue; // 本地白名单再验一次
        // 并行代答：harness 内部重试可能拖到十几秒，串行会让后续任务排队超时
        (async () => {
          let out;
          try {
            out = await localHandle(job.method, job.path, job.bodyB64 ? Buffer.from(job.bodyB64, 'base64') : Buffer.alloc(0));
          } catch (e) {
            out = { status: 502, type: 'application/json', body: Buffer.from(JSON.stringify({ ok: false, message: `本机代答失败: ${e.message}` })) };
          }
          await fetch(`${base}/agent/result`, {
            method: 'POST',
            headers: hdrs(),
            body: JSON.stringify({ id: job.id, status: out.status, type: out.type, bodyB64: out.body.toString('base64') }),
            signal: AbortSignal.timeout(30000),
          }).catch(() => { /* 结果丢了就让 25s 超时兜底 */ });
        })();
      }
    } catch (e) {
      await new Promise((r2) => setTimeout(r2, backoff));
      backoff = Math.min(backoff * 2, 60000);
      console.log(`[agent] ${new Date().toLocaleTimeString('zh-CN')} 重连（${e.message}）`);
    }
  }
}

// ── 管理子命令（本机信任区执行，adminKey 不出本机）──
async function admin(path, label, bodyObj) {
  const base = (SEC.cloudUrl || '').split('?')[0];
  if (!base) { console.error('✗ secrets.json 里还没有 cloudUrl'); process.exit(1); }
  const sharecode = (SEC.cloudUrl.split('sharecode=')[1] || '').split('&')[0];
  let cookie = '';
  try {
    const boot = await fetch(`${base}/?sharecode=${sharecode}`, { signal: AbortSignal.timeout(15000) });
    const sc = boot.headers.getSetCookie ? boot.headers.getSetCookie() : [];
    cookie = sc.map((c) => c.split(';')[0]).join('; ');
  } catch { /* 门没过就试直连 */ }
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-admin-key': SEC.adminKey, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(bodyObj || {}),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  console.log(JSON.stringify(j, null, 2));
  if (!j.ok) process.exitCode = 1;
  else if (label) console.log(`✔ ${label}`);
}

if (CMD === 'run') await run();
else if (CMD === 'status') await admin('/admin/status');
else if (CMD === 'reset-seat') await admin('/admin/reset-seat', '席位已重置');
else if (CMD === 'new-key') {
  const { randomBytes } = await import('node:crypto');
  const nk = randomBytes(9).toString('base64url');
  // 平台 sharecode 门：管理通道同样要先领 cookie（与 admin() 同款），否则 403
  const base = (SEC.cloudUrl || '').split('?')[0];
  const sharecode = (SEC.cloudUrl.split('sharecode=')[1] || '').split('&')[0];
  let cookie = '';
  try {
    const boot = await fetch(`${base}/?sharecode=${sharecode}`, { signal: AbortSignal.timeout(15000) });
    const sc = boot.headers.getSetCookie ? boot.headers.getSetCookie() : [];
    cookie = sc.map((c) => c.split(';')[0]).join('; ');
  } catch { /* 门没过就试直连 */ }
  const r = await fetch(`${base}/admin/rotate-key`, {
    method: 'POST', headers: { 'x-admin-key': SEC.adminKey, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ newKey: nk }), signal: AbortSignal.timeout(15000),
  }).catch((e) => { console.error('✗ 云端没连上:', e.message); process.exit(1); });
  const j = await r.json().catch(() => ({}));
  if (j.ok) {
    const sec = JSON.parse(readFileSync(SEC_PATH, 'utf8'));
    sec.accessKey = nk;
    writeFileSync(SEC_PATH, JSON.stringify(sec, null, 2), 'utf8');
    console.log('✔ 访问码已更换（旧码立即作废），新访问码：');
    console.log('  ', nk);
  } else { console.error('✗', j.message || r.status); process.exitCode = 1; }
}
else if (CMD === 'free-on' || CMD === 'free-off') {
  // 免密钥邀请开关：开=拿到链接就能进（仍限席位）；关=恢复访问码
  await admin('/admin/free-mode', CMD === 'free-on' ? '免密钥已开启' : '免密钥已关闭', { on: CMD === 'free-on' });
}
else { console.error('未知子命令:', CMD); process.exit(2); }
