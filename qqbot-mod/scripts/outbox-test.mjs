/**
 * outbox-test.mjs —— 语音「发件箱」回归
 *
 * 历史：用户报"语音条半路死掉了"。
 *   第一版根因：`tools/voice.mjs` 在**回合进行中**被调用，`lastCtx` 为空 ⇒
 *     `sendViaOutboundChannel` 拿不到 sender/target ⇒ return false。
 *   第二版根因（线上实测）：只挂 `turnEnd` 也不够 —— 线上队列里 2 条语音
 *     永远没人取，说明 turnEnd 那一跳不可靠。
 *
 * 现在：`tools/voice.mjs` 用 `env.caps.voice()` 当场直发（见 voice-tool-test.mjs），
 * 发件箱只做兜底；兜底同时挂 `send`(末块) 与 `turnEnd` 两跳。
 *
 * 这里不起真机，只验队列 + 投递顺序 + 失败不抛 + 两跳都能投递。
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-outbox';
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
mkdirSync(ROOT, { recursive: true });
process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;

const { enqueue, drain, pending } = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/voice-queue.mjs');
const { onOutbound } = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/outbound/outbox.mjs');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail += 1; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

// 用一个假的 mp3 路径（队列只存路径，真正的上传在发送侧）
const FAKE = ROOT + '/fake.mp3';
const silent = { info() {}, warn() {}, debug() {} };

// ── ① 入队 / 计数 / 取出 ─────────────────────────────────────
{
  ok('初始队列为空', pending(ROOT).length === 0, JSON.stringify(pending(ROOT)));
  const r1 = enqueue(ROOT, { path: FAKE, text: '第一句语音', voice: 'zh-CN-XiaoyiNeural', bytes: 12345 });
  ok('入队成功', r1.ok === true, JSON.stringify(r1));
  const r2 = enqueue(ROOT, { path: FAKE, text: '第二句语音', bytes: 23456 });
  ok('可入队多条', r2.ok === true);
  ok('pending 看到 2 条', pending(ROOT).length === 2, String(pending(ROOT).length));
  const items = drain(ROOT);
  ok('drain 取走 2 条', items.length === 2, JSON.stringify(items.map((x) => x.text)));
  ok('取走后队列清空', pending(ROOT).length === 0, String(pending(ROOT).length));
  ok('drain 保留 kind 语义(path/bytes)', typeof items[0].path === 'string' && items[0].bytes === 12345, JSON.stringify(items[0]));
}

// ── ② turnEnd：先正文(next) 再语音 ──────────────────────────
{
  enqueue(ROOT, { path: FAKE, text: '要补发的语音', bytes: 999 });
  const order = [];
  const ctx = {
    phase: 'turnEnd',
    logger: silent,
    async sendMedia(input) { order.push('voice:' + input.kind); return true; },
  };
  let nexted = 0;
  await onOutbound(ctx, async () => { nexted += 1; order.push('text'); });
  ok('正文先发', order[0] === 'text', JSON.stringify(order));
  ok('语音后补', order[1] === 'voice:voice', JSON.stringify(order));
  ok('只 next 一次', nexted === 1, String(nexted));
  ok('投递后队列已空', pending(ROOT).length === 0);
}

// ── ③ send 末块也能投递（第二版新增的兜底跳）───────────────
{
  enqueue(ROOT, { path: FAKE, text: 'send 阶段兜底', bytes: 7 });
  const order = [];
  const ctx = {
    phase: 'send',
    isLastChunk: true,
    logger: silent,
    async sendMedia(input) { order.push('voice:' + input.kind); return true; },
  };
  await onOutbound(ctx, async () => { order.push('text'); });
  ok('send 末块：正文先发', order[0] === 'text', JSON.stringify(order));
  ok('send 末块：语音后补', order[1] === 'voice:voice', JSON.stringify(order));
  ok('send 末块：投递后队列已空', pending(ROOT).length === 0);
}

// ── ④ send 非末块不投递（多块中途发语音会插进半句话里）─────
{
  enqueue(ROOT, { path: FAKE, text: '中途不该发', bytes: 1 });
  const ctx = { phase: 'send', isLastChunk: false, logger: silent, async sendMedia() { throw new Error('不该发'); } };
  await onOutbound(ctx, async () => {});
  ok('send 非末块不投递', pending(ROOT).length === 1, String(pending(ROOT).length));
  drain(ROOT);
}

// ── ⑤ 空队列不打扰正文 ──────────────────────────────────────
{
  let nexted = 0;
  const ctx = { phase: 'turnEnd', logger: silent, async sendMedia() { throw new Error('不该发'); } };
  await onOutbound(ctx, async () => { nexted += 1; });
  ok('空队列也 next 一次', nexted === 1, String(nexted));
}

// ── ⑥ 发送失败不抛、不阻塞正文 ──────────────────────────────
{
  enqueue(ROOT, { path: FAKE, text: '会失败的语音', bytes: 1 });
  let nexted = 0;
  const ctx = {
    phase: 'turnEnd',
    logger: silent,
    async sendMedia() { throw new Error('boom'); },
  };
  let threw = null;
  try { await onOutbound(ctx, async () => { nexted += 1; }); } catch (e) { threw = e; }
  ok('语音发失败不抛出', threw === null, threw ? String(threw.message) : '');
  ok('语音发失败正文照常', nexted === 1, String(nexted));
}

// ── ⑦ 队列文件是 JSON 且可读 ────────────────────────────────
{
  ok('队列文件已生成', existsSync(ROOT + '/.qqbot/voice-queue.json'), ROOT + '/.qqbot/voice-queue.json');
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
