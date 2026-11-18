/**
 * schedule-events.ts — 事件型任务评估 + 权重衰减/激活（2026-11-13 加）
 *
 * 为什么要有这一层：
 *   小蓝答应的事多半不是「每天 22:00 打卡」，而是「你要是又熬夜我就来说你」。
 *   所以任务不再只有时间，还有「聊天里出现了这件事」。她自己在会话里用 `qq_timer`
 *   的 `event` 动作建，落盘在 .qqbot/timers.json，由 bootstrap 的 ticker 每 5s 评估一次。
 *
 * 两条规则（用户明确要的）：
 *   · 事件触发：只看 `dir='in'` 的入站聊天，关键词命中（any/all）后，若距上次触发
 *     已过冷却时间，就交给 ticker 注入原会话 —— 和她主动说话一样，不是发死文案。
 *   · 可衰减 / 可激活：每说一次 weight 减 decay.step（不低于 decay.min），
 *     但对方真回了话（同 scope 有入站）就每次回涨一点 —— 越聊越活，久不说话就淡下去。
 *
 * 数据只读：这里只用 node:sqlite 打开 memory.db 做 SELECT，不写库。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
const DEFAULT_ACTIVE_MS = 10 * 60_000;
/**
 * 把任务上的 peerId 变成库里可能用到的 scope 列表。
 * 正常写库已归一到 `c2c:<personId>`，这里再兜一层旧数据（group:/wechat:/裸 openid）。
 */
export function scopesForJob(job) {
    const peer = String(job?.peerId || '').trim();
    if (!peer)
        return [];
    const out = new Set([`c2c:${peer}`, `wechat:${peer}`]);
    if (job?.scope === 'group')
        out.add(`group:${peer}`);
    return [...out];
}
function openDb(dataRoot) {
    try {
        const base = basename(String(dataRoot || '').replace(/[\\/]+$/, '')) === '.qqbot'
            ? String(dataRoot)
            : join(String(dataRoot), '.qqbot');
        const file = join(base, 'memory.db');
        if (!existsSync(file))
            return null;
        // 宿主是 Electron 内置 node 24，DatabaseSync 可用；拿不到就静默跳过（不影响定时任务）
        const { DatabaseSync } = requireNodeSqlite();
        return new DatabaseSync(file, { readOnly: true });
    }
    catch {
        return null;
    }
}
let _sqlite = null;
function requireNodeSqlite() {
    if (_sqlite)
        return _sqlite;
    // 宿主是 Electron 内置 node，node:sqlite 是内置模块；用 createRequire 拿，ESM/CJS 都稳
    const req = createRequire(import.meta.url);
    _sqlite = req('node:sqlite');
    return _sqlite;
}
function recentInbound(db, scopes, sinceTs, limit = 200) {
    if (!db || !scopes.length)
        return [];
    const ph = scopes.map(() => '?').join(',');
    const sql = `SELECT scope, text, ts FROM chat WHERE dir = 'in' AND ts >= ? AND scope IN (${ph}) ORDER BY ts DESC LIMIT ${Number(limit) || 200}`;
    try {
        return db.prepare(sql).all(Number(sinceTs) || 0, ...scopes) || [];
    }
    catch {
        return [];
    }
}
/** 按权重摇一次：weight=1 必开，weight=0.2 五次一开 */
export function rollFire(job, rand = Math.random) {
    const w = Number.isFinite(Number(job && job.weight)) ? Number(job.weight) : 1;
    return rand() < Math.max(0, Math.min(1, w));
}
/**
 * 找出现在该开口的事件任务。
 * @returns {Array<{job:object, hits:string[], samples:string[]}>}
 */
export function matchEventJobs(store, opts = {}) {
    const now = Number(opts.now) || Date.now();
    const dataRoot = String(opts.dataRoot || '');
    // 'any' = 时间窗或事件：事件这条腿也参与匹配，冷却与窗口任务共用
    const jobs = (store.list ? store.list() : []).filter((j) => j && j.enabled && (j.kind === 'event' || j.kind === 'any'));
    if (!jobs.length)
        return [];
    const db = openDb(dataRoot);
    if (!db)
        return [];
    const out = [];
    try {
        for (const job of jobs) {
            if (Number(job.cooldownUntil) > now)
                continue;
            const ev = job.event || {};
            const keywords = Array.isArray(ev.keywords) ? ev.keywords.map((s) => String(s).trim()).filter(Boolean) : [];
            if (!keywords.length)
                continue;
            const withinMs = Math.max(5, Number(ev.withinMin) || 720) * 60_000;
            // 只认「建任务之后」的消息，避免一建就翻旧账；同一条消息也不重复触发
            const since = Math.max(Number(job.createdAt) || 0, now - withinMs, Number(job.lastEventTs) || 0);
            const rows = recentInbound(db, scopesForJob(job), since);
            if (!rows.length)
                continue;
            const joined = rows.map((r) => String(r.text || '')).join('\n');
            const hits = keywords.filter((k) => joined.includes(k));
            const matched = ev.match === 'all' ? hits.length === keywords.length : hits.length > 0;
            if (!matched)
                continue;
            const newest = rows.reduce((m, r) => Math.max(m, Number(r.ts) || 0), 0);
            job.lastEventTs = newest;
            try { store.save?.(); } catch { /* ignore */ }
            out.push({ job, hits, samples: rows.slice(0, 3).map((r) => String(r.text || '').slice(0, 80)) });
        }
    }
    finally {
        try { db.close?.(); } catch { /* ignore */ }
    }
    return out;
}
/**
 * 可激活：同 scope 最近有入站消息，就把权重往上抬一点（久不说话自然衰减）。
 * 只在真的变了的时候写盘。
 */
export function bumpActivation(store, opts = {}) {
    const now = Number(opts.now) || Date.now();
    const dataRoot = String(opts.dataRoot || '');
    const jobs = (store.list ? store.list() : []).filter((j) => j && j.enabled && Number(j.weight) < 1);
    if (!jobs.length)
        return 0;
    const db = openDb(dataRoot);
    if (!db)
        return 0;
    let changed = 0;
    try {
        for (const job of jobs) {
            const rows = recentInbound(db, scopesForJob(job), now - DEFAULT_ACTIVE_MS, 1);
            const newest = rows.length ? Number(rows[0].ts) || 0 : 0;
            if (!newest || newest <= (Number(job.lastActiveAt) || 0))
                continue;
            const step = Number(job.decay && job.decay.step) || 0.2;
            job.weight = Math.min(1, (Number(job.weight) || 0) + Math.max(0.05, step / 2));
            job.lastActiveAt = newest;
            changed += 1;
        }
        if (changed)
            store.save?.();
    }
    finally {
        try { db.close?.(); } catch { /* ignore */ }
    }
    return changed;
}
