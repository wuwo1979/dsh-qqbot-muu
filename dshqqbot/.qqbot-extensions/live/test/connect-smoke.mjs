#!/usr/bin/env node
/**
 * live/test/connect-smoke.mjs — 连接层冒烟（只读，不发弹幕）
 *
 * 用法：node connect-smoke.mjs [房间号]
 * 输出：状态流转 + 事件类型计数（不含房间号/UID/token 明文）
 */
import { loadConfig, loadBiliCookies } from '../config.mjs';
import { createRedactor, makeLogger } from '../redact.mjs';
import { BiliWebAdapter } from '../adapters/bilibili-web.mjs';

const dataRoot = 'f:/qqbot/dshqqbot';
const roomId = String(process.argv[2] || '').trim();
const cfg = loadConfig(dataRoot);
const cookies = loadBiliCookies(dataRoot);
if (roomId) cfg.bilibili.roomId = roomId;
cfg.bilibili.alwaysConnect = true;

const redactor = createRedactor({ roomId: cfg.bilibili.roomId, uid: cookies.DedeUserID, cookies });
const logger = makeLogger(console, redactor, 'live-smoke');
const counts = {};
const samples = [];
let lastState = '';

const adapter = new BiliWebAdapter({
  dataRoot,
  cfg,
  cookies,
  logger,
  redactor,
  onStatus: (s) => {
    if (s.state !== lastState) {
      lastState = s.state;
      console.log('[状态]', s.state, '| 节点数', s.hosts ?? '-', '| 错误', s.lastError || '-');
    }
  },
  onEvent: (e) => {
    counts[e.type] = (counts[e.type] || 0) + 1;
    if (samples.length < 8 && e.type !== 'enter' && e.type !== 'like') {
      samples.push({ type: e.type, name: e.user?.name || '', text: String(e.text || '').slice(0, 30), rmb: e.amount?.rmb ?? 0 });
    }
  },
});

const deadline = Date.now() + 45000;
await adapter.start();
while (lastState !== 'live' && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
}
if (lastState !== 'live') {
  console.log('连接未进入 live 状态，最后状态：', lastState, '错误：', adapter.snapshot().lastError);
  await adapter.stop();
  process.exit(2);
}
console.log('[连接成功] 房间', adapter.snapshot().room?.id, '· 静默观察 20 秒');
await new Promise((r) => setTimeout(r, 20000));
console.log('[事件计数]', JSON.stringify(counts));
console.log('[样例]', JSON.stringify(samples));
await adapter.stop();
console.log('[完成] 已断开');
process.exit(0);
