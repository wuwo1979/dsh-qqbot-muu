/**
 * voice-queue.mjs —— 语音发件箱
 *
 * ★ 为什么需要它（真机 bug）：
 *   `tools/voice.mjs` 里直接调 `globalThis[Symbol.for('im-qqbot.outbound')].sendMedia()`，
 *   而那条通道靠**模块内的 lastCtx** 拿 sender/target。工具是在"回合进行中"被调用的，
 *   此时这一回合的出站链可能还没跑过（尤其重启后第一条消息）⇒ lastCtx === null
 *   ⇒ sendMedia 返回 false ⇒ 她只能回一句"语音发送失败（可能没有可回复的会话）"。
 *
 *   正确做法：工具只**排进发件箱**，由出站扩展在 `phase === 'turnEnd'` 时用
 *   **当前回合作主的 ctx**（自带 sender/target）补发。这样永远不会发错会话。
 *
 * 文件：`{dataRoot}/.qqbot/voice-queue.json`（数组，最多 6 条，超 10 分钟自动丢弃）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_ITEMS = 6;
const MAX_AGE_MS = 10 * 60 * 1000;

export function queueFile(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot', 'voice-queue.json');
}

function readRaw(dataRoot) {
  try {
    const p = queueFile(dataRoot);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function writeRaw(dataRoot, arr) {
  const p = queueFile(dataRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(arr, null, 0), 'utf8');
}

function fresh(items) {
  const now = Date.now();
  return items.filter((it) => it && it.path && Number(now - Number(it.ts || 0)) < MAX_AGE_MS);
}

/** 排一条语音进发件箱；返回排完后的条数 */
export function enqueue(dataRoot, item = {}) {
  const path = String(item.path || '').trim();
  if (!path) return { ok: false, msg: 'path 为空' };
  const items = fresh(readRaw(dataRoot));
  items.push({
    path,
    text: String(item.text || '').slice(0, 200),
    voice: String(item.voice || ''),
    bytes: Number(item.bytes || 0),
    ts: Date.now(),
  });
  while (items.length > MAX_ITEMS) items.shift();
  writeRaw(dataRoot, items);
  return { ok: true, n: items.length };
}

/** 取走全部待发（并清空） */
export function drain(dataRoot) {
  const items = fresh(readRaw(dataRoot));
  try { writeRaw(dataRoot, []); } catch { /* 清不掉也不影响发送 */ }
  return items;
}

/** 只看不取 */
export function pending(dataRoot) {
  return fresh(readRaw(dataRoot));
}
