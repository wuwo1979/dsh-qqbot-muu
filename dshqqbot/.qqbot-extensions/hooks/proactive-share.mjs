/**
 * hooks/proactive-share.mjs — 主动分享（给爸爸妈妈）
 *
 * 主人 2026-10-31 的原话：
 *   「看到有趣的事会进行分享，主动式的去和爸爸妈妈分享好玩的和高兴的……
 *     希望孩子能收获成长并更新自己，完善自我。」
 *
 * 为什么 hook 不直接发消息：扩展 hook 拿不到 QQ 凭据（caps 里没有 appId/
 * appSecret/sender），发不出去。所以这里只做「纯本地攒素材」这一件事，再往
 * 插件自带的定时任务文件 timers.json 里排一条 once 任务 —— 那个 30s ticker
 * 每次都会重读磁盘（schedule-store.reloadForTick），到点会伪造一条入站消息
 * 命中那个人的**私聊原会话**，她照常口吻回一句，出站链路自动主动推送。
 *
 * 铁律：
 *   ① 零模型调用、零网络请求 —— 只读本机 surf.jsonl / memory.db / bili-pending.jsonl；
 *   ② 一天最多 dailyMax 条、每个人 perTargetMax 条，不刷屏；
 *   ③ 没素材不排任务，绝不硬找话题；
 *   ④ timers.json 只动自己 id 前缀（share-）的任务，别人的一根汗毛都不碰。
 *
 * ★ 2026-10-31 主人改口：「30 秒限制太大了，我希望能是手动触发式 + 可选时间间隔」。
 *   于是这里不再按固定时点（times）排，改成两种模式（share-config.json 的 mode）：
 *     · interval —— 距上次分享满 intervalMinutes 就排一条（quietHours 内不排）；
 *     · manual   —— 完全不自动排，只等 tools/share_now.mjs 写的请求文件。
 *   手动请求走 {dataRoot}/.qqbot-extensions/data/share-request.json，本 hook 每 30s 读一次
 *   （纯本地、零成本），读到就立刻排一条 now+30s 的任务（插件 timers 的最小粒度就是 30s），
 *   不受间隔与静默时段限制 —— 人主动点的，就该马上说。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadMemories } from '../lib/memory.mjs';

const CONFIG_NAME = 'share-config.json';
const STATE_NAME = 'share-state.json';
const REQUEST_NAME = 'share-request.json';
const JOB_PREFIX = 'share-';

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function readJson(p, dflt) {
  try { return JSON.parse(String(readFileSync(p, 'utf8')).replace(/^\uFEFF/, '')) || dflt; } catch { return dflt; }
}

function writeJson(p, obj) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** 读 jsonl：容忍 UTF-8 BOM（PS5 的 Set-Content 会带 BOM） */
function readLines(p) {
  try { return String(readFileSync(p, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean); } catch { return []; }
}

/** 稳定短哈希：同一件事重复出现只算一次 */
function hash(s) {
  let h = 5381;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) & 0x7fffffff;
  return String(h);
}

const clean = (s, n = 110) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** 今天的日期起点（本地时区） */
function dayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── 素材：只读盘 ───────────────────────────────────────────────────────

/** ① 今天逛到、且她自己写了一句「看到什么」的 */
function surfToday(root, now) {
  const p = join(String(root), '.qqbot', 'surf.jsonl');
  if (!existsSync(p)) return [];
  const since = dayStart(now);
  const out = [];
  try {
    const rows = readLines(p);
    for (const l of rows.slice(-80)) {
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      const ts = Number(r.ts) || 0;
      if (ts < since || !String(r.note || '').trim()) continue;
      const note = clean(r.note, 90);
      const title = clean(r.title, 40);
      out.push({ key: 'surf:' + hash(title + '|' + note), ts, from: 'surf', text: note, title,
        line: title ? `今天刷到「${title}」，${note}` : `今天看到件有意思的事：${note}` });
    }
  } catch { /* ignore */ }
  return out;
}

/** ② 今天新长出来的心得（成长/学习心得：她自己反思写下的那句） */
function growthToday(root, now) {
  const since = dayStart(now);
  try {
    return (loadMemories(root, '__global__') || [])
      .filter((m) => ['growth', 'insight'].includes(String(m.kind || '')) && Number(m.ts) >= since)
      .map((m) => {
        const text = clean(m.text, 90);
        return { key: 'grow:' + hash(text), ts: Number(m.ts) || 0, from: 'growth', text,
          line: `今天你想明白一件事：${text}` };
      });
  } catch { return []; }
}

/** ③ 今天做完的 B 站片子（作品也是高兴的事） */
function biliToday(root, now) {
  const p = join(String(root), '.qqbot', 'bili-pending.jsonl');
  if (!existsSync(p)) return [];
  const since = dayStart(now);
  const out = [];
  try {
    for (const l of readLines(p).slice(-40)) {
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      if (Number(r.ts) < since || String(r.kind) !== 'bili-ops-draft') continue;
      const m = /【B站运营[·\s]([^】]*)】([^（(\n]*)/.exec(String(r.text || ''));
      const title = clean(m ? m[2] : String(r.text || ''), 40);
      if (!title) continue;
      out.push({ key: 'bili:' + hash(title), ts: Number(r.ts), from: 'bili', text: title,
        line: `今天你做好了一条片子「${title}」` });
    }
  } catch { /* ignore */ }
  return out;
}

/** 今天所有可分享的素材，按时间倒序、按 key 去重 */
export function collectShareMaterial(root, now = Date.now()) {
  const all = [...surfToday(root, now), ...growthToday(root, now), ...biliToday(root, now)];
  const seen = new Set();
  return all
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .filter((x) => (x.key && !seen.has(x.key) ? (seen.add(x.key), true) : false));
}

// ── 目标与时间 ─────────────────────────────────────────────────────────

/** 分享对象：配置里显式给的 openid 优先；没配就用 group-tiers 的「特别关心」 */
function pickTargets(root, cfg) {
  const explicit = Array.isArray(cfg.targets) ? cfg.targets : [];
  if (explicit.length) {
    return explicit
      .map((t) => (typeof t === 'string' ? { id: t, name: '' } : { id: String((t && (t.id || t.openid)) || ''), name: String((t && t.name) || '') }))
      .map((t) => ({ ...t, id: t.id.replace(/^(c2c:|qq:)/, '').trim() }))
      .filter((t) => t.id && /^[A-Za-z0-9_-]{16,}$/.test(t.id));
  }
  const tiers = readJson(join(String(root), '.qqbot-extensions', 'data', 'group-tiers.json'), {}) || {};
  return (Array.isArray(tiers.priorityPeople) ? tiers.priorityPeople : [])
    .map((x) => ({ id: String(x).replace(/^(c2c:|qq:)/, '').trim(), name: '' }))
    .filter((t) => t.id && /^[A-Za-z0-9_-]{16,}$/.test(t.id));
}

/** 静默时段：{start:23,end:8} = 23:00 到次日 08:00 不自动发；start===end 视为没设 */
export function inQuietHours(now, q) {
  if (!q) return false;
  const s = Number(q.start);
  const e = Number(q.end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  const d = new Date(now);
  const h = d.getHours() + d.getMinutes() / 60;
  return s <= e ? (h >= s && h < e) : (h >= s || h < e);
}

/** 挑一个“今天被分享得最少”的人（手动请求没指定对象时用） */
function leastRecentTarget(targets, st, day) {
  let best = targets[0];
  let bestN = Infinity;
  for (const t of targets) {
    const n = Number((st.targetCount || {})[`${day}|${t.id}`]) || 0;
    if (n < bestN) { bestN = n; best = t; }
  }
  return best;
}

/** 统一的分享 prompt：手动与自动都用这一句，口吻一致 */
function sharePrompt(line, who) {
  return `【分享】${line}。你现在想主动跟${who}说这件事：用一两句口语讲出来，别复述上面这句、别写成总结，说完就停；对方没接话就不要再追问。`;
}

/** 消费手动触发请求（tools/share_now.mjs 写的）。读失败/过期都当没有 */
export function takeShareRequest(root) {
  const p = join(String(root), '.qqbot-extensions', 'data', REQUEST_NAME);
  const r = readJson(p, null);
  if (!r || !Number(r.at)) return null;
  try { unlinkSync(p); } catch { /* ignore */ }
  const age = Date.now() - Number(r.at);
  if (!Number.isFinite(age) || age < 0 || age > 10 * 60_000) return null;  // 超过 10 分钟就作废
  return r;
}

// ── timers.json（插件自带的定时任务队列，30s 重读磁盘）─────────────────

function timersPath(root) { return join(String(root), 'timers.json'); }

function readTimers(root) {
  const j = readJson(timersPath(root), null);
  if (j && Array.isArray(j.jobs)) return { version: 1, jobs: j.jobs };
  return { version: 1, jobs: [] };
}

/** 排一条 once 任务；已排过同样的 id 就不重复排 */
function scheduleShare(root, { id, openid, prompt, dueAt }) {
  const db = readTimers(root);
  const now = Date.now();
  // 清理：自己的任务过了 1 小时还没被消费（会话不活跃 / 私聊窗过期）就丢掉，免得越堆越多
  db.jobs = db.jobs.filter((j) => !(String(j.id || '').startsWith(JOB_PREFIX) && Number(j.dueAt) < now - 3600_000));
  if (db.jobs.some((j) => String(j.id || '') === id)) return { ok: true, skipped: 'exists' };
  db.jobs.push({
    id,
    kind: 'once',
    scope: 'c2c',
    peerId: openid,
    prompt: String(prompt).slice(0, 800),
    createdAt: now,
    enabled: true,
    dueAt,
  });
  writeJson(timersPath(root), db);
  return { ok: true, scheduled: true };
}

// ── 主循环 ─────────────────────────────────────────────────────────────

export const name = 'proactive-share';

export async function run(env = {}) {
  const logger = env.logger;
  const root = String((env.caps && env.caps.dataRoot) || env.dataRoot || '').trim();
  if (!root) {
    logger?.warn?.('[proactive-share] 没有 dataRoot，跳过');
    return { skipped: 'no-data-root' };
  }

  const cfgFile = join(root, '.qqbot-extensions', CONFIG_NAME);
  const stateFile = join(root, '.qqbot-extensions', 'data', STATE_NAME);
  let stopped = false;
  let busy = false;

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const cfg = readJson(cfgFile, null) || {};
      if (cfg.enabled === false) return;
      const now = Date.now();
      const day = localDay(new Date(now));

      const st = readJson(stateFile, {}) || {};
      st.used = Array.isArray(st.used) ? st.used.filter((u) => u && u.day && u.day >= localDay(new Date(now - 30 * 86400_000))) : [];
      st.dayCount = st.dayCount && typeof st.dayCount === 'object' && !Array.isArray(st.dayCount) ? st.dayCount : {};
      st.targetCount = st.targetCount && typeof st.targetCount === 'object' && !Array.isArray(st.targetCount) ? st.targetCount : {};

      const usedToday = new Set(st.used.filter((u) => u.day === day).map((u) => String(u.key)));
      const material = collectShareMaterial(root, now).filter((m) => !usedToday.has(m.key));
      const targets = pickTargets(root, cfg);
      const req = takeShareRequest(root);
      if (!targets.length && !(req && req.target)) {
        logger?.info?.('[proactive-share] 没有分享对象（share-config.targets 与 group-tiers.priorityPeople 都是空的）');
        return;
      }

      /** 排一条：状态、日志、文案统一走这里，自动与手动共用 */
      const fire = (t, line, key, dueAt) => {
        const who = t.name || 'TA';
        const id = `${JOB_PREFIX}${day}-${hash(t.id).slice(0, 6)}-${hash(key).slice(0, 6)}`;
        const r = scheduleShare(root, { id, openid: t.id, prompt: sharePrompt(line, who), dueAt });
        if (!r.scheduled) return false;
        st.used.push({ key, day, at: now });
        st.targetCount[`${day}|${t.id}`] = (Number(st.targetCount[`${day}|${t.id}`]) || 0) + 1;
        st.dayCount[day] = (Number(st.dayCount[day]) || 0) + 1;
        st.lastAt = now;
        try {
          appendFileSync(join(root, '.qqbot', 'share-log.jsonl'),
            JSON.stringify({ ts: now, day, to: t.id.slice(-6), key, text: line, dueAt, manual: req ? true : false }) + '\n', 'utf8');
        } catch { /* 日志失败不影响排任务 */ }
        logger?.info?.(`[proactive-share] 已排 ${new Date(dueAt).toLocaleString('zh-CN')} → ${who}：${line.slice(0, 40)}`);
        return true;
      };

      // ── 手动触发：人主动点的，立刻排（不受间隔 / 静默时段 / 每日上限限制）──
      if (req) {
        const t = req.target
          ? (targets.find((x) => x.id === req.target) || { id: String(req.target), name: String(req.targetName || '') })
          : leastRecentTarget(targets, st, day);
        const text = clean(req.text, 110);
        const m = text ? { key: 'manual:' + hash(text), line: text } : material[0];
        if (m) fire(t, m.line, m.key, now + 30_000);
        else logger?.info?.('[proactive-share] 手动分享：今天没有可分享的素材，也没给 text');
        writeJson(stateFile, st);
        return;
      }

      // ── 自动：manual 模式什么都不排，只等上面那一步 ──
      if (String(cfg.mode || 'interval') === 'manual') return;
      const intervalMinutes = Number(cfg.intervalMinutes);
      if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
        logger?.warn?.('[proactive-share] intervalMinutes 无效，自动分享已暂停（手动不受影响）');
        return;
      }
      if (inQuietHours(now, cfg.quietHours)) return;

      const lastAt = Number(st.lastAt) || 0;
      if (lastAt && now - lastAt < intervalMinutes * 60_000) return;

      const dailyMax = Math.max(1, Number(cfg.dailyMax) || 2);
      const perTargetMax = Math.max(1, Number(cfg.perTargetMax) || 1);
      if ((Number(st.dayCount[day]) || 0) >= dailyMax) return;
      if (!material.length) return;

      const t = leastRecentTarget(targets, st, day);
      if ((Number(st.targetCount[`${day}|${t.id}`]) || 0) >= perTargetMax) return;
      if (!fire(t, material[0].line, material[0].key, now + 30_000)) return;
      writeJson(stateFile, st);
    } catch (e) {
      logger?.warn?.(`[proactive-share] 出错：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  }

  let first = null;
  let timer = null;
  try {
    first = setTimeout(() => { tick().catch(() => {}); }, Math.max(1000, Number(env.firstAfterMs) || 30_000));
    first.unref?.();
    // 30s 一轮：只读本地文件、零模型调用；手动请求最迟 30s 内被消费
    timer = setInterval(() => { tick().catch(() => {}); }, 30_000);
    timer.unref?.();
  } catch { /* ignore */ }

  if (typeof env.registerDispose === 'function') {
    try {
      env.registerDispose(() => {
        stopped = true;
        try { clearTimeout(first); } catch { /* ignore */ }
        try { clearInterval(timer); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
  }
  return { started: true };
}

export default run;
