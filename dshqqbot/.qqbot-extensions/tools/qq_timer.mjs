/**
 * qq_timer — 真正会活过重启的定时任务（落盘 `{dataRoot}/timers.json`）
 *
 * 为什么要这个工具（2026-11-11 修的账）：
 *   以前说「定时任务已建好」，用的是宿主的会话级定时器 —— 它挂在**某一个会话**上，
 *   QQ 这边一重启 / 会话一重建，任务就跟着没了，表现就是「说了到点会发，结果没发」。
 *   插件自己其实有一套**落盘**的定时队列（`{dataRoot}/timers.json`，启动时 30s ticker 驱动，
 *   `dist/features/schedule-store.js`），但一直没暴露成工具，所以她根本没法用它。
 *   这个工具就是那道门：写进去的任务重启不丢，到点由插件唤起一轮「主动开口」。
 *
 * 任务形状（与 schedule-store 完全一致，别改字段名）：
 *   { id, kind:'once'|'daily', scope:'c2c'|'group', peerId, prompt, createdAt, enabled,
 *     atTime?:'HH:MM', dueAt?:毫秒 }
 *
 * 动作：
 *   · add  —— 建一条（默认 daily；给 seconds 则 once 相对 N 秒；给 atTime='HH:MM' 表示每天/今天的这个点）
 *   · list —— 看现有任务（id / 时间 / 对象 / 开关 / 预演内容）
 *   · rm   —— 按 id 删
 *   · on / off —— 开关（不删）
 *
 * 纪律：
 *   ⛔ prompt 是「到点时对你自己说的话」，不是发给对方原文 —— 到点还是你自己开口，别写成死文案；
 *   ⛔ peerId 必须是 openid，不接受昵称；群里 @ 人的活儿交给到点那一轮去做；
 *   ✅ 返回据实：建了就说建了，撞了已有的每日任务就直说撞了。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MIN_SECONDS = 60;
const MAX_JOBS = 200;

function dataRootOf(env) {
  return String((env && (env.caps && env.caps.dataRoot)) || process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot');
}
function timersPath(root) {
  return join(root, 'timers.json');
}
function readDb(root) {
  try {
    const j = JSON.parse(readFileSync(timersPath(root), 'utf8'));
    if (j && Array.isArray(j.jobs)) return { version: 1, jobs: j.jobs };
  } catch { /* 没有 / 坏了就重建 */ }
  return { version: 1, jobs: [] };
}
function writeDb(root, db) {
  const p = timersPath(root);
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* ignore */ }
  writeFileSync(p, JSON.stringify({ version: 1, jobs: db.jobs.slice(-MAX_JOBS) }, null, 2), 'utf8');
}
function pad(n) {
  return String(n).padStart(2, '0');
}
/** 'HH:MM' → 今天这个点的毫秒时间戳（已过则明天的） */
function dueAtFromHHMM(hhmm, base = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  const d = new Date(base);
  d.setSeconds(0, 0);
  d.setHours(h, mi, 0, 0);
  let t = d.getTime();
  if (t <= base) t += 86400_000;
  return t;
}
function fmt(ts) {
  try {
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '?';
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return '?'; }
}
function nextOf(job) {
  if (!job || job.enabled === false) return null;
  if (job.kind === 'daily') return dueAtFromHHMM(job.atTime, Date.now());
  return Number(job.dueAt) || null;
}

export default {
  name: 'qq_timer',
  expose: 'all',
  description: '建/看/删**重启也不会丢**的定时任务（落盘 timers.json）：到点由插件唤起一轮主动开口。action=add 要 scope+peerId+prompt（可选 atTime="HH:MM" 或 seconds）；list 看全部；rm 按 id 删；on/off 开关',
  inputSchema: {
    action: { type: 'string', enum: ['add', 'list', 'rm', 'on', 'off'], description: 'add=新建；list=查看；rm=删除；on/off=开关' },
    scope: { type: 'string', enum: ['c2c', 'group'], description: 'add 用：发给私聊还是群' },
    peerId: { type: 'string', description: 'add 用：目标 openid（私聊=对方 openid，群=群 openid）' },
    prompt: { type: 'string', description: 'add 用：到点时**对你自己说的话**（要说什么、什么分寸），不是发给对方的死文案' },
    atTime: { type: 'string', description: 'add 用：HH:MM（24 小时制，本地时区）；不给则用 seconds' },
    seconds: { type: 'integer', description: 'add 用：N 秒后触发一次（>=60）；给了 seconds 就是一次性任务' },
    daily: { type: 'boolean', description: 'add 用：true=每天这个点（默认，需 atTime）；false=一次性' },
    id: { type: 'string', description: 'rm/on/off 用：任务 id' },
    enabled: { type: 'boolean', description: 'on/off 用（on=true）' },
  },
  run: async (args, env) => {
    const root = dataRootOf(env);
    const db = readDb(root);
    const action = String(args.action || 'list');

    if (action === 'list') {
      if (!db.jobs.length) return { ok: true, msg: '现在没有任何定时任务（timers.json 是空的）' };
      const now = Date.now();
      const rows = db.jobs.slice(-40).map((j) => {
        const nx = nextOf(j);
        const when = j.kind === 'daily' ? `每天 ${j.atTime}` : fmt(j.dueAt);
        const state = j.enabled === false ? '（关着）' : nx && nx < now ? '（已过期待跑）' : '';
        return `${j.id} · ${when}${state} · ${j.scope}:${String(j.peerId || '').slice(-8)} · ${String(j.prompt || '').slice(0, 40)}`;
      });
      return { ok: true, msg: `定时任务 ${db.jobs.length} 条（最多显示 40）：\n` + rows.join('\n') };
    }

    if (action === 'add') {
      const scope = String(args.scope || '').trim();
      const peerId = String(args.peerId || '').trim();
      const prompt = String(args.prompt || '').trim();
      if (scope !== 'c2c' && scope !== 'group') return { ok: false, msg: 'scope 只能是 c2c 或 group' };
      if (!peerId) return { ok: false, msg: 'peerId 必填（openid，不接受昵称）' };
      if (!prompt) return { ok: false, msg: 'prompt 必填：到点要跟你说什么' };
      const hasSec = Number.isFinite(Number(args.seconds)) && Number(args.seconds) > 0;
      const wantOnce = args.daily === false || (hasSec && !args.atTime);
      const kind = wantOnce ? 'once' : 'daily';
      const atTime = String(args.atTime || '').trim();
      if (kind === 'daily' && !dueAtFromHHMM(atTime, Date.now())) return { ok: false, msg: 'daily 任务需要合法的 atTime（HH:MM）' };
      if (kind === 'once' && !hasSec && !dueAtFromHHMM(atTime, Date.now())) return { ok: false, msg: '一次性任务需要 seconds 或 atTime' };
      if (hasSec && Number(args.seconds) < MIN_SECONDS) return { ok: false, msg: `seconds 最少 ${MIN_SECONDS} 秒` };

      const key = `${scope}:${peerId}`;
      if (kind === 'daily') {
        const dup = db.jobs.find((j) => j.kind === 'daily' && `${j.scope}:${j.peerId}` === key && j.atTime === atTime && j.enabled !== false);
        if (dup) return { ok: false, msg: `已经有一条同样的每日任务了：${dup.id}（每天 ${dup.atTime}），要改先 rm 它` };
      }
      const job = {
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind,
        scope,
        peerId,
        prompt: prompt.slice(0, 800),
        createdAt: Date.now(),
        enabled: true,
      };
      if (atTime && dueAtFromHHMM(atTime, Date.now())) job.atTime = atTime;
      if (kind === 'once') {
        job.dueAt = hasSec && atTime
          ? Math.min(Date.now() + Number(args.seconds) * 1000, dueAtFromHHMM(atTime, Date.now()) || Infinity)
          : hasSec
            ? Date.now() + Number(args.seconds) * 1000
            : dueAtFromHHMM(atTime, Date.now());
      }
      db.jobs.push(job);
      writeDb(root, db);
      const when = job.kind === 'daily' ? `每天 ${job.atTime}` : fmt(job.dueAt);
      return { ok: true, msg: `建好了 ${job.id}：${when} → ${scope}:${String(peerId).slice(-8)}（落盘在 timers.json，重启不丢）` };
    }

    const id = String(args.id || '').trim();
    if (!id) return { ok: false, msg: '要指定 id（先用 action=list 看）' };
    const i = db.jobs.findIndex((j) => String(j.id) === id);
    if (i < 0) return { ok: false, msg: `没有这个任务：${id}` };

    if (action === 'rm') {
      const gone = db.jobs.splice(i, 1)[0];
      writeDb(root, db);
      return { ok: true, msg: `删掉了 ${gone.id}（${gone.kind === 'daily' ? '每天 ' + gone.atTime : fmt(gone.dueAt)}）` };
    }
    if (action === 'on' || action === 'off') {
      const want = action === 'on' ? args.enabled !== false : false;
      db.jobs[i].enabled = want;
      writeDb(root, db);
      return { ok: true, msg: `${db.jobs[i].id} 已${want ? '打开' : '关掉'}` };
    }
    return { ok: false, msg: `不认识的 action：${action}` };
  },
};
