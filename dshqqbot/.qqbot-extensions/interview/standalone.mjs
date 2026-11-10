#!/usr/bin/env node
/**
 * standalone.mjs —— 把「小蓝面试」通话页从 DSH 宿主里拆出来，独立跑一个 http 服务。
 *
 * 为什么要有这个东西：
 *   以前 `/api/qqbot-settings/interview` 是挂在 DSH Desktop 的 webServer 上的钩子，
 *   所以必须：① 装着 DSH Desktop ② 服务常驻 ③ 只能本机 127.0.0.1:43129 访问。
 *   想给别人玩（或者手机/平板打开）就全废了。
 *
 * 做法：
 *   复用 hooks/interview-panel.mjs 的 run()，只是喂给它一个"假的 webServer"——
 *   这个假对象把 register() 注册的 handler 收进 Map，再用 node:http 自己分发。
 *   页面和接口的路径前缀保持一致（/api/qqbot-settings/interview），page.html 一个字都不用改。
 *
 * 用法：
 *   node interview/standalone.mjs                    # 0.0.0.0:4321，局域网可访问
 *   node interview/standalone.mjs --port 4321 --host 127.0.0.1
 *   node interview/standalone.mjs --key abc123       # 要求 ?k=abc123 才能进
 *
 * 环境变量同名等价：INTERVIEW_PORT / INTERVIEW_HOST / INTERVIEW_KEY
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));                       // …/.qqbot-extensions/interview
const EXT_DIR = dirname(HERE);                                              // …/.qqbot-extensions
const DATA_ROOT = dirname(dirname(EXT_DIR));                                // 实际是仓库根（含 secrets/ 的那层）
// 从 DATA_ROOT 往上找带 secrets/ 的那层，找不到就用 DATA_ROOT 本身
const REPO_ROOT = (() => {
  let p = DATA_ROOT;
  for (let i = 0; i < 3; i += 1) {
    if (existsSync(join(p, 'secrets'))) return p;
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return DATA_ROOT;
})();

// secrets/ 在本机被打成只读（低完整性 + NW）：沙箱里起的服务建不了 sessions/<sid>，
// 建会话会直接 EPERM。这里先探一下能不能写，不能就把会话落盘挪到 tmp/interview-sessions。
function ensureSessionsWritable() {
  if (process.env.QQBOT_INTERVIEW_SESSIONS_DIR) return;
  const dir = join(REPO_ROOT, 'secrets', 'interview', 'sessions');
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, '.write-probe');
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return;
  } catch { /* 落下去走 fallback */ }
  const alt = join(REPO_ROOT, 'tmp', 'interview-sessions');
  try { mkdirSync(alt, { recursive: true }); } catch { /* ignore */ }
  process.env.QQBOT_INTERVIEW_SESSIONS_DIR = alt;
  console.log('[小蓝面试·独立] secrets/ 不可写，会话改落', alt);
}
ensureSessionsWritable();

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = Number(arg('port', process.env.INTERVIEW_PORT || 4321));
const HOST = String(arg('host', process.env.INTERVIEW_HOST || '0.0.0.0'));
const KEY = String(arg('key', process.env.INTERVIEW_KEY || ''));

const routes = new Map();

// 假 webServer：只认 interview-panel 用到的 register 形态
const fakeWebServer = {
  register({ path, handler }) {
    routes.set(path, handler);
  },
};

const panelPath = join(EXT_DIR, 'hooks', 'interview-panel.mjs');
const extPanelPath = join(DATA_ROOT, '.qqbot-extensions', 'hooks', 'interview-panel.mjs');
const PANEL = existsSync(panelPath) ? panelPath : extPanelPath;

const log = (...a) => console.log('[小蓝面试·独立]', ...a);

function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

const main = async () => {
  const panel = await import(pathToFileURL(PANEL).href + '?t=' + Date.now()).catch((e) => {
    console.error('[小蓝面试·独立] 加载 interview-panel 失败：', e?.message || e);
    process.exit(1);
  });

  const r = await panel.run({
    dataRoot: DATA_ROOT,
    logger: console,
    ctx: { webServer: fakeWebServer },
  });
  log('panel.run ->', r, `已注册 ${routes.size} 条路由`);

  if (!routes.size) {
    console.error('[小蓝面试·独立] 一条路由都没注册上，退出。');
    process.exit(1);
  }

  const BASE = panel.BASE || '/api/qqbot-settings/interview';

  const server = createServer((req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { res.writeHead(400); res.end('bad url'); return; }

    // 简易口令：配了 key 就必须带 ?k=
    if (KEY) {
      const got = url.searchParams.get('k') || req.headers['x-interview-key'] || '';
      if (got !== KEY) {
        if (url.pathname === '/' || url.pathname === BASE || url.pathname === BASE + '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<meta charset="utf-8"><h3>需要口令</h3><p>地址后面加 ?k=你的口令</p>');
          return;
        }
        sendJson(res, { ok: false, message: 'unauthorized' }, 401);
        return;
      }
    }

    // 根路径直接跳通话页，分享出去少打一截
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(302, { location: BASE + (KEY ? `?k=${encodeURIComponent(KEY)}` : '') });
      res.end();
      return;
    }

    const handler = routes.get(url.pathname);
    if (!handler) {
      sendJson(res, { ok: false, message: 'not found', path: url.pathname }, 404);
      return;
    }
    try {
      handler(req, res);
    } catch (e) {
      log('处理出错', url.pathname, String(e?.message || e));
      try { sendJson(res, { ok: false, message: 'server error' }, 500); } catch { /* ignore */ }
    }
  });

  server.on('error', (e) => {
    if (e?.code === 'EADDRINUSE') console.error(`[小蓝面试·独立] 端口 ${PORT} 被占用，换 --port 试试`);
    else console.error('[小蓝面试·独立] 监听失败：', e?.message || e);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    log(`已启动 http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}${BASE}${KEY ? '?k=***' : ''}`);
    log('局域网/分享：把上面地址里的 127.0.0.1 换成这台机器的内网 IP');
  });

  const bye = () => { try { server.close(); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
};

main();
