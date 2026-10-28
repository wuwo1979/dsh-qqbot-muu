/**
 * memory-trace.mjs — 记忆系统的轻量运行轨迹（给浮窗「记忆」页看）
 *
 * 只记"什么时候、对哪个会话、召回/整理发生了什么"，不存聊天正文全文。
 * 文件：{dataRoot}/.qqbot/memory-trace.jsonl，超过 1MB 轮转一份 .1。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TRACE_FILE = 'memory-trace.jsonl';

function dirOf(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot');
}

function fileOf(dataRoot) {
  return join(dirOf(dataRoot), TRACE_FILE);
}

/** 追加一条轨迹；任何失败都静默（不能因为日志影响聊天） */
export function trace(dataRoot, rec = {}) {
  try {
    const root = String(dataRoot || '').trim();
    if (!root) return;
    mkdirSync(dirOf(root), { recursive: true });
    const p = fileOf(root);
    if (existsSync(p) && statSync(p).size > 1024 * 1024) {
      try { renameSync(p, p + '.1'); } catch { /* ignore */ }
    }
    appendFileSync(p, JSON.stringify({ ts: Date.now(), ...rec }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** 读最近 n 条（新的在前），可按 kind 过滤 */
export function readTrace(dataRoot, { limit = 20, kind = '' } = {}) {
  try {
    const p = fileOf(dataRoot);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < Math.max(1, Number(limit) || 20); i -= 1) {
      try {
        const o = JSON.parse(lines[i]);
        if (kind && o.kind !== kind) continue;
        out.push(o);
      } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch { return []; }
}

/** 读另一份 agent 日志（memory-agent.mjs 写的），统一给面板用 */
export function readAgentLog(dataRoot, limit = 20) {
  try {
    const p = join(dirOf(dataRoot), 'memory-agent-log.jsonl');
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < Math.max(1, Number(limit) || 20); i -= 1) {
      try { out.push(JSON.parse(lines[i])); } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch { return []; }
}

export default { trace, readTrace, readAgentLog };
