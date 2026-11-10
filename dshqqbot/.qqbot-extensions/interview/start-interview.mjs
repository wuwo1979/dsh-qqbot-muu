#!/usr/bin/env node
/**
 * start-interview.mjs — 一键进「小蓝面试」通话页（2026-11-09 改：优先独立服务）
 *
 * 为什么改：
 *   以前非得把 DSH Desktop 整个拉起来、再等它的 webServer 就绪，慢且只能本机用。
 *   现在 `interview/standalone.mjs` 能自己起一个http服务（0.0.0.0:4321），
 *   只要 node 在就能开，局域网/别人也能进。所以按下面的顺序找入口：
 *
 *   ① 独立服务 4321 已在跑              → 直接开浏览器
 *   ② 没跑 → 自己拉起来（detached）      → 等就绪 → 开浏览器
 *   ③ 独立服务起不来（缺依赖/端口占用）  → 退回去拉 DSH Desktop + 43129
 *
 * 口令：环境变量 INTERVIEW_KEY（默认 xiaolan），会拼进 URL 的 ?k=
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));

const BASE_PATH = '/api/qqbot-settings/interview';
const KEY = String(process.env.INTERVIEW_KEY || 'xiaolan');

const DSH_HOST = String(process.env.QQBOT_HOST || '127.0.0.1');
const DSH_PORT = Number(process.env.QQBOT_PORT || 43129);
const DSH_EXE = String(process.env.DSH_DESKTOP_EXE || 'F:\\DSH\\DSH Desktop\\DSH Desktop.exe');

const SA_PORT = Number(process.env.INTERVIEW_PORT || 4321);
const SA_TRIES = 15;                  // 15 × 1s

const log = (...a) => console.log('[小蓝面试]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = request({ host, port, path: BASE_PATH + '/status?k=' + encodeURIComponent(KEY), method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume();
        finish(res.statusCode === 200);
      });
    } catch { finish(false); return; }
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } finish(false); });
    req.on('error', () => finish(false));
    req.end();
  });
}

function openUrl(url) {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } else {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

function pageUrl(port) {
  return `http://127.0.0.1:${port}${BASE_PATH}?k=${encodeURIComponent(KEY)}`;
}

/** ① 独立服务已经在跑 */
async function tryExistingStandalone() {
  if (await probe('127.0.0.1', SA_PORT)) {
    log(`独立服务已在 ${SA_PORT}，直接打开。`);
    openUrl(pageUrl(SA_PORT));
    return true;
  }
  return false;
}

/** ② 拉起独立服务 */
async function bootStandalone() {
  const script = join(HERE, 'standalone.mjs');
  if (!existsSync(script)) return false;

  log('拉起独立服务…');
  try {
    const child = spawn(process.execPath, [script, '--port', String(SA_PORT), '--key', KEY], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch (e) {
    log('拉起失败：' + ((e && e.message) || e));
    return false;
  }

  for (let i = 0; i < SA_TRIES; i += 1) {
    await sleep(1000);
    if (await probe('127.0.0.1', SA_PORT, 1200)) {
      log(`独立服务就绪（${i + 1}s），打开页面。`);
      openUrl(pageUrl(SA_PORT));
      return true;
    }
  }
  log('独立服务没起来，改用 DSH。');
  return false;
}

/** ③ 兜底：老路 —— 拉 DSH Desktop */
async function bootDsh() {
  if (await probe(DSH_HOST, DSH_PORT, 2500)) {
    log('DSH 服务已在线，直接打开。');
    openUrl(`http://${DSH_HOST}:${DSH_PORT}${BASE_PATH}`);
    return true;
  }
  if (!existsSync(DSH_EXE)) {
    console.error(`[小蓝面试] 找不到 DSH Desktop：${DSH_EXE}`);
    console.error('[小蓝面试] 设 DSH_DESKTOP_EXE 指过去，或者直接用独立服务。');
    return false;
  }
  log('正在拉起 DSH Desktop…');
  try {
    const child = spawn('explorer.exe', [DSH_EXE], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    console.error('[小蓝面试] 拉起失败：' + ((e && e.message) || e));
    return false;
  }
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    if (await probe(DSH_HOST, DSH_PORT, 1500)) {
      log('DSH 就绪，打开页面。');
      openUrl(`http://${DSH_HOST}:${DSH_PORT}${BASE_PATH}`);
      return true;
    }
  }
  console.error('[小蓝面试] 等了 60 秒还是没连上。手动开 DSH Desktop 再试一次。');
  return false;
}

async function main() {
  log(`找入口：独立服务 ${SA_PORT} ／ DSH ${DSH_PORT}`);
  if (await tryExistingStandalone()) return 0;
  if (await bootStandalone()) return 0;
  if (await bootDsh()) return 0;
  return 1;
}

main()
  .then((code) => { process.exitCode = Number(code) || 0; })
  .catch((e) => {
    console.error('[小蓝面试] 异常：' + ((e && e.stack) || e));
    process.exitCode = 1;
  });
