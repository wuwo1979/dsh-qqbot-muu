/**
 * memory-mmtr.mjs — 「会遗忘的记忆层」（借鉴 MMTR / Hippo Memory / Bitterbot / 前瞻记忆四家）
 *
 * 背景（主人 2026-10-27）：现有海马体（memory-hippo.mjs）解决了「检索的质量」，
 *   但没有解决「记忆的时间性」——所有记忆永远同样新鲜，承诺和闲聊一个待遇，
 *   而且越常用越亮（自增强）。这层补四个 MMTR 式的机制：
 *
 *   ① 三通道衰减  每条记忆拆 fact/gist/affect 三条通道，**半衰期不同、地板不同**：
 *        fact   事实  半衰期 4 天   地板 0.02（几乎可以归零）
 *        gist   感觉  半衰期 12 天  地板 0.12
 *        affect 情绪  半衰期 180 天 地板 0.55（强烈的经历永远留一点偏向）
 *      ——「记得那天下过雨、记得当时的心情，却不记得具体说了什么」的结构化表达。
 *
 *   ② 前瞻记忆（承诺账本）  答应过的事单独一类：入库即锁定原文、永不压缩；
 *      权重曲线反向——离到期越近越清晰；到期窗口自己浮上来提醒；
 *      过期超宽限未兑现 = broken（可靠性↓ 信任↓ 温度↓），兑现 = kept（可靠性小幅+）。
 *
 *   ③ 防自增强三闸  回血递减（同一条记忆被想起的增益随次数递减）、
 *      本轮刚用过的下一条消息降权、重要性完全不受检索影响（检索只记日志不加分）。
 *
 *   ④ 睡眠结算  会话结束时（间隔超阈值后的第一条消息触发上场的结算）：
 *      belief 回归锚点（半衰期 14 天，energy/humor 更快）、承诺到期判定、通道地板钳制。
 *
 * 设计约束（与 memory-hippo 一致）：纯本地、零依赖、不联网、不调模型；
 *   CREATE IF NOT EXISTS 自建表，任何失败都降级为 no-op，绝不打断聊天。
 */
import { createHash } from 'node:crypto';
import { getHandle } from './memory-db.mjs';
import { observeTrait } from './memory-hippo.mjs';

const SCHEMA_ADD = `
CREATE TABLE IF NOT EXISTS mem_channel (
  id     TEXT,
  scope  TEXT,
  fact   REAL DEFAULT 1,
  gist   REAL DEFAULT 0.8,
  affect REAL DEFAULT 0.3,
  ts     INTEGER,
  last_ts INTEGER,
  PRIMARY KEY(id, scope)
);
CREATE INDEX IF NOT EXISTS idx_mem_channel_scope ON mem_channel(scope, ts);

CREATE TABLE IF NOT EXISTS promise (
  id        TEXT PRIMARY KEY,
  scope     TEXT,
  text      TEXT,
  due_ts    INTEGER,
  created_ts INTEGER,
  status    TEXT DEFAULT 'pending',   -- pending | kept | broken
  settled_ts INTEGER,
  note      TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_promise_scope ON promise(scope, status, due_ts);

CREATE TABLE IF NOT EXISTS mem_recall_log (
  mem_id TEXT,
  scope  TEXT,
  ts     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mem_recall_log ON mem_recall_log(mem_id, ts);

CREATE TABLE IF NOT EXISTS mmtr_log (
  ts INTEGER, scope TEXT, action TEXT, detail TEXT
);
`;

const _ready = new Set();

function h_(dataRoot) {
  const h = getHandle(dataRoot);
  const k = h.file || String(dataRoot);
  if (!_ready.has(k)) { h.db.exec(SCHEMA_ADD); _ready.add(k); }
  return h;
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const DAY = 86400000;
/** 三通道参数：半衰期(ms) 与地板。要调体验就调这里。 */
export const CHANNELS = {
  fact:   { half: 4 * DAY,   floor: 0.02 },
  gist:   { half: 12 * DAY,  floor: 0.12 },
  affect: { half: 180 * DAY, floor: 0.55 },
};

function mlog(h, scope, action, detail = '') {
  try {
    h.db.prepare('INSERT INTO mmtr_log(ts, scope, action, detail) VALUES (?,?,?,?)')
      .run(Date.now(), String(scope || ''), String(action), String(detail).slice(0, 400));
  } catch { /* ignore */ }
}

function sid(prefix, s) {
  return prefix + createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

// ── ① 三通道 ────────────────────────────────────────────────────────────
/**
 * 记忆入库时拆通道。affectValence ∈ [-1,1]（情绪强度绝对值越大越持久）。
 * 任何一步失败都静默——这层是增益，不是依赖。
 */
export function channelize(dataRoot, scope, memId, { affectValence = 0 } = {}) {
  const sc = String(scope || 'unknown');
  if (!memId) return { ok: false };
  let h;
  try { h = h_(dataRoot); } catch { return { ok: false }; }
  try {
    const av = Math.max(-1, Math.min(1, Number(affectValence) || 0));
    h.db.prepare(
      `INSERT INTO mem_channel(id, scope, fact, gist, affect, ts, last_ts) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id, scope) DO NOTHING`,
    ).run(String(memId), sc, 1, 0.8, Math.abs(av), Date.now(), Date.now());
    mlog(h, sc, 'channelize', `${memId} affect=${av.toFixed(2)}`);
    return { ok: true };
  } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
}

/** 三通道在 now 时刻的强度（0..1）。不落库——衰减是纯函数，查询时现算。 */
export function channelStrengths(dataRoot, scope, memId, now = Date.now()) {
  const sc = String(scope || 'unknown');
  let h;
  try { h = h_(dataRoot); } catch { return null; }
  try {
    const r = h.db.prepare('SELECT * FROM mem_channel WHERE id = ? AND scope = ?').get(String(memId), sc);
    if (!r) return null;
    const dt = Math.max(0, now - num(r.ts, now));
    const out = {};
    for (const ch of ['fact', 'gist', 'affect']) {
      const c = CHANNELS[ch];
      const decayed = num(r[ch]) * Math.pow(0.5, dt / c.half);
      out[ch] = Number(Math.max(c.floor, decayed).toFixed(3));
    }
    return out;
  } catch { return null; }
}

// ── ② 前瞻记忆（承诺账本） ──────────────────────────────────────────────
/** 记一个承诺。text 锁定原文（不摘要不改写——事实必须完整）。 */
export function promiseAdd(dataRoot, scope, { text, dueTs, note = '' } = {}) {
  const sc = String(scope || 'unknown');
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'no-text' };
  const due = Number(dueTs) || 0;
  let h;
  try { h = h_(dataRoot); } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  try {
    const id = sid('p_', sc + t + due);
    h.db.prepare(
      `INSERT INTO promise(id, scope, text, due_ts, created_ts, status, note)
       VALUES (?,?,?,?,?,'pending',?)
       ON CONFLICT(id) DO UPDATE SET due_ts = excluded.due_ts, note = excluded.note`,
    ).run(id, sc, t, due, Date.now(), String(note).slice(0, 120));
    mlog(h, sc, 'promise.add', t.slice(0, 60));
    return { ok: true, id };
  } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
}

export function promiseList(dataRoot, scope, { status = 'pending' } = {}) {
  const sc = String(scope || 'unknown');
  let h;
  try { h = h_(dataRoot); } catch { return []; }
  try {
    return h.db.prepare(
      `SELECT id, text, due_ts, created_ts, status, settled_ts, note FROM promise
        WHERE scope = ? AND status = ? ORDER BY due_ts ASC LIMIT 50`,
    ).all(sc, String(status || 'pending')).map((r) => ({
      id: r.id, text: r.text, dueTs: num(r.due_ts), createdTs: num(r.created_ts),
      status: r.status, settledTs: num(r.settled_ts), note: r.note || '',
    }));
  } catch { return []; }
}

/**
 * 到期窗口内的承诺（注入用）：提前 48h 开始「浮上来」；
 * 宽限期 7 天内还能提醒，超了就该结算成 broken。
 */
const DUE_AHEAD = 2 * DAY;
const GRACE = 7 * DAY;

export function promiseDue(dataRoot, scope, now = Date.now()) {
  const rows = promiseList(dataRoot, scope, { status: 'pending' });
  const out = [];
  for (const r of rows) {
    if (!r.dueTs) { out.push({ ...r, urgency: 'open' }); continue; }  // 没写日期的也常驻提醒
    const dt = r.dueTs - now;
    if (dt > DUE_AHEAD) continue;            // 还早
    if (dt < -GRACE) { promiseSettle(dataRoot, scope, r.id, 'broken', '超宽限期自动判定'); continue; }
    out.push({
      ...r,
      urgency: dt < 0 ? 'overdue' : dt < DAY ? 'today' : 'soon',
      overdueDays: dt < 0 ? Math.round(-dt / DAY) : 0,
    });
  }
  return out;
}

/** 结算承诺：broken 付关系代价（可靠↓信任↓温度↓），kept 有小幅正向回报。 */
export function promiseSettle(dataRoot, scope, id, result, note = '') {
  const sc = String(scope || 'unknown');
  let h;
  try { h = h_(dataRoot); } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  try {
    const r = h.db.prepare('SELECT * FROM promise WHERE id = ?').get(String(id));
    if (!r) return { ok: false, reason: 'no-such-promise' };
    if (r.status !== 'pending') return { ok: true, already: true, status: r.status };
    h.db.prepare('UPDATE promise SET status = ?, settled_ts = ?, note = ? WHERE id = ?')
      .run(String(result) === 'kept' ? 'kept' : 'broken', Date.now(), String(note).slice(0, 120), String(id));
    mlog(h, sc, 'promise.' + result, String(r.text).slice(0, 60));
    // 关系代价/回报：走 belief 层的护栏更新（步长上限、负向重复抑制全都自动生效）。
    // 只有人能对应上的 scope 才结算（c2c:<id> / person:qq:<id>）；群 scope 找不到"人"，不扣。
    const m2 = /^(?:c2c:|person:qq:)?(\w+)$/.exec(sc.replace(/^c2c:/, 'c2c:'));
    const personScope = /^c2c:/.test(sc) ? ('person:qq:' + sc.slice(4))
      : /^person:qq:/.test(sc) ? sc : '';
    void m2;
    if (personScope) {
      if (result === 'kept') {
        observeTrait(dataRoot, personScope, { key: 'reliability', delta: 0.08, weight: 1.2, note: '承诺兑现' });
      } else {
        observeTrait(dataRoot, personScope, { key: 'reliability', delta: -0.2, weight: 1.5, note: '承诺未兑现' });
        observeTrait(dataRoot, personScope, { key: 'trust', delta: -0.12, weight: 1, note: '承诺未兑现' });
        observeTrait(dataRoot, personScope, { key: 'warmth', delta: -0.08, weight: 1, note: '承诺未兑现' });
      }
    }
    return { ok: true, status: result };
  } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
}

/** [约定] 注入块：只带到期的、quiet 风格（不给数值不给标签，人话） */
export function promiseBlockFor(dataRoot, scope) {
  const due = promiseDue(dataRoot, scope);
  if (!due.length) return '';
  const lines = due.slice(0, 3).map((p) => {
    const d = p.dueTs ? new Date(p.dueTs).toISOString().slice(5, 10) : '';
    const tag = p.urgency === 'overdue' ? `（已过 ${p.overdueDays} 天）` : p.urgency === 'today' ? '（就快到了）' : p.urgency === 'soon' ? `（${d} 前）` : '';
    return `- ${String(p.text).slice(0, 50)}${tag}`;
  });
  return `\n[约定]答应过的事要记得：\n${lines.join('\n')}[/约定]`;
}

// ── ③ 防自增强 ─────────────────────────────────────────────────────────
/** 检索日志：只记不用（重要性完全不受检索影响——第三闸就是这么满足的） */
export function logRecall(dataRoot, scope, memIds = []) {
  if (!memIds.length) return;
  let h;
  try { h = h_(dataRoot); } catch { return; }
  const sc = String(scope || 'unknown');
  try {
    const now = Date.now();
    const st = h.db.prepare('INSERT INTO mem_recall_log(mem_id, scope, ts) VALUES (?,?,?)');
    for (const id of memIds.slice(0, 12)) st.run(String(id), sc, now);
    // 顺带修剪：日志只留 30 天
    h.db.prepare('DELETE FROM mem_recall_log WHERE ts < ?').run(now - 30 * DAY);
  } catch { /* ignore */ }
}

/**
 * 近期用过的记忆集合（10 分钟内）——外层召回后对这些 id 打折（第二闸）。
 * 返回 Map<memId, lastUsedTs>。
 */
export function recentUsed(dataRoot, scope, withinMs = 10 * 60000) {
  let h;
  try { h = h_(dataRoot); } catch { return new Map(); }
  const out = new Map();
  try {
    const rows = h.db.prepare(
      'SELECT mem_id, MAX(ts) AS t FROM mem_recall_log WHERE scope = ? AND ts > ? GROUP BY mem_id',
    ).all(String(scope || 'unknown'), Date.now() - withinMs);
    for (const r of rows) out.set(r.mem_id, num(r.t));
  } catch { /* ignore */ }
  return out;
}

/** 对召回列表应用「刚用过就降权」并打使用日志（aa-memory-recall 出口调用一次即可） */
export function applyRecallGuard(dataRoot, scope, items = []) {
  const used = recentUsed(dataRoot, scope);
  const now = Date.now();
  for (const it of items) {
    const t = used.get(String(it.id));
    if (t) {
      const mins = (now - t) / 60000;
      it.score = Number((num(it.score) * (mins < 2 ? 0.55 : 0.75)).toFixed(2));
      it.why = [...(it.why || []), 'recent-used'];
    }
  }
  items.sort((a, b) => num(b.score) - num(a.score));
  logRecall(dataRoot, scope, items.map((x) => x.id));
  return items;
}

// ── ④ 睡眠结算 ─────────────────────────────────────────────────────────
/**
 * 一次会话结束时结算：belief 向锚点回归（半衰期 14 天；energy/humor 7 天——
 * 「吵架比亲密更容易过去」）、到期承诺自动判定、留痕。
 * 幂等：重复调无害；每天最多结算一次（由调用方 tick 控制）。
 */
export function sleepSettle(dataRoot, scope, now = Date.now()) {
  const sc = String(scope || 'unknown');
  let h;
  try { h = h_(dataRoot); } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
  const stat = { beliefs: 0, promisesBroken: 0, scope: sc };
  try {
    const rows = h.db.prepare('SELECT key, value, base, last_ts FROM belief WHERE scope = ?').all(sc);
    const up = h.db.prepare('UPDATE belief SET value = ?, last_ts = ? WHERE scope = ? AND key = ?');
    for (const r of rows) {
      const half = (r.key === 'energy' || r.key === 'humor') ? 7 * DAY : 14 * DAY;
      const dt = now - num(r.last_ts, now);
      if (dt < DAY) continue;                       // 太近，不动
      const k = 1 - Math.pow(0.5, dt / half);       // 向基线回归的比例
      const v = num(r.value) + (num(r.base) - num(r.value)) * k;
      if (Math.abs(v - num(r.value)) < 0.005) continue;
      up.run(Number(v.toFixed(3)), now, sc, r.key);
      stat.beliefs++;
    }
    // 到期承诺：超宽限的自动 broken（关系代价在 promiseSettle 里结算）
    const due = promiseDue(dataRoot, sc, now);
    stat.due = due.length;
    mlog(h, sc, 'sleep', JSON.stringify(stat).slice(0, 200));
    return { ok: true, ...stat };
  } catch (e) { return { ok: false, reason: String(e?.message || e) }; }
}

/** 面板/排查用统计 */
export function mmtrStats(dataRoot, scope) {
  const sc = String(scope || 'unknown');
  let h;
  try { h = h_(dataRoot); } catch { return { ok: false }; }
  const one = (sql, ...p) => { try { return h.db.prepare(sql).get(...p) || {}; } catch { return {}; } };
  const promises = promiseList(dataRoot, sc);
  return {
    ok: true,
    channels: num(one('SELECT COUNT(*) AS n FROM mem_channel WHERE scope = ?', sc).n),
    promisePending: promises.length,
    promiseDue: promiseDue(dataRoot, sc).length,
    recallLogs: num(one('SELECT COUNT(*) AS n FROM mem_recall_log WHERE scope = ?', sc).n),
    lastSleep: num(one("SELECT ts FROM mmtr_log WHERE scope = ? AND action = 'sleep' ORDER BY ts DESC LIMIT 1", sc).ts),
  };
}

export default {
  channelize, channelStrengths, CHANNELS,
  promiseAdd, promiseList, promiseDue, promiseSettle, promiseBlockFor,
  logRecall, recentUsed, applyRecallGuard, sleepSettle, mmtrStats,
};
