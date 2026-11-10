/**
 * lib/timefmt.mjs — 统一时间显示 + 会话“最近活动”取时（零依赖）
 *
 * 背景（2026-11-08）：
 *   · 宿主 `session.v4.jsonl.zstd` 头的 createdAt 是**真 UTC**，界面必须按本地时区渲染；
 *   · 会话目录 mtime 只在新增/删除文件时变，长期会话会永远停在创建那一刻，不能当作“最后活动”；
 *   · 需要一处共用实现，避免每个命令各自手拼 UTC 字段或 toLocaleString。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const p2 = (n) => String(n).padStart(2, '0');

/** 宽松解析：数字(秒/毫秒)、ISO 字符串、Date；非法返回 null */
function toDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v;          // 兼容秒级时间戳
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  let d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    d = new Date(n < 1e12 ? n * 1000 : n);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** `MM/DD HH:mm`（本地时区）——列表/卡片用 */
export function toLocalStamp(v) {
  const d = toDate(v);
  if (!d) return '—';
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** `YYYY-MM-DD HH:mm:ss`（本地时区）——自检/日志用 */
export function toLocalFull(v) {
  const d = toDate(v);
  if (!d) return '—';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * 目录“最后活动”时间（毫秒）：
 *   · 优先目录内会话文件（session.v*.jsonl*）的最新 mtime；
 *   · 其次任意文件的最新 mtime；
 *   · 都没有才回退目录自身 mtime（目录 mtime 不随追加写入变化，仅作兜底）。
 */
export function lastActivityOfDir(dir) {
  let dirMtime = 0;
  try { dirMtime = statSync(dir).mtimeMs; } catch { return 0; }
  let bestSession = 0;
  let bestAny = 0;
  const walk = (d, depth) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = join(d, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(f, depth + 1); continue; }
      let st;
      try { st = statSync(f); } catch { continue; }
      if (/^session\.v\d+.*\.(jsonl|zstd|json|jsonl\.zstd)$/i.test(e.name)) {
        bestSession = Math.max(bestSession, st.mtimeMs);
      } else {
        bestAny = Math.max(bestAny, st.mtimeMs);
      }
    }
  };
  walk(dir, 0);
  return bestSession || bestAny || dirMtime;
}
