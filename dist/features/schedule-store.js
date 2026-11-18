/**
 * schedule-store.ts — QQ 会话自我定时任务(一次性/每日)存储与调度
 *
 * AI(QQ 会话内)可给自己安排定时提醒/任务: 到点后把 prompt 注入原会话(followup),
 * 她会像收到新消息一样处理并回复到 QQ(带群聊上下文)。
 * 数据落盘 {dataDir}/timers.json, 重启不丢; bootstrap 启动一个 30s ticker 驱动。
 * 类型: once(一次性: seconds 相对秒 或 atTime 今天某时) / daily(每天 HH:MM)。
 *
 * ⚠️ 本地手改功能(fork 新增)。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
const FILE_NAME = 'timers.json';
/** 最小相对秒(与 ticker 粒度对齐) */
const MIN_SECONDS = 30;
/** 单会话(scope:peer)最多启用的任务数 */
const MAX_PER_PEER = 20;
/** 全局任务总数上限 */
const MAX_GLOBAL = 200;
/**
 * 收件人 id 合法性（2026-11-14 加）：
 * 真 openid/watchId 都是 16~64 位十六进制；曾经有一条任务把 peerId 写成最后 8 位
 * "62F0C901"，注入永远找不到会话 → 连续失败被自动停用，人看到的就是「没发就没了」。
 */
const PEER_RE = /^[0-9A-Za-z_@.-]{10,64}$/;
function looksLikePeerId(id) {
    const s = String(id ?? '').trim();
    return PEER_RE.test(s);
}
/** 解析 HH:MM → 当天该时刻 ms; 已过则明天 */
function dueAtFromHHMM(hhmm, base = Date.now()) {
    const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
    if (!m)
        return NaN;
    const h = Math.min(23, Number(m[1]));
    const min = Math.min(59, Number(m[2]));
    const d = new Date(base);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= base)
        d.setDate(d.getDate() + 1); // 已过 → 明天
    return d.getTime();
}
/** 解析 'HH:MM' → 当天分钟数(0-1439)；非法返回 NaN */
function hhmmToMin(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
    if (!m)
        return NaN;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59))
        return NaN;
    return h * 60 + mi;
}
function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
/**
 * 时间窗任务：在 [from,to] 之间随机挑 perDay 个点（彼此至少隔 minGapMin 分钟）。
 * 拟人化的关键——不是每天同一分钟打卡，是"这段时间里她哪个点想起来就哪个点"。
 */
function planWindowSlots(job, now = Date.now()) {
    const fromMin = hhmmToMin(job.from);
    const toMin = hhmmToMin(job.to);
    if (!Number.isFinite(fromMin) || !Number.isFinite(toMin) || toMin - fromMin < 1)
        return [];
    const perDay = Math.max(1, Math.min(6, Number(job.perDay) || 1));
    const gap = Math.max(0, Math.min(720, Number(job.minGapMin) || 0));
    const base = new Date(now);
    const slots = [];
    let cursor = fromMin;
    for (let i = 0; i < perDay; i++) {
        const latest = toMin - (perDay - 1 - i) * gap;
        if (latest < cursor)
            break;
        const t = cursor + Math.floor(Math.random() * (latest - cursor + 1));
        const d = new Date(base);
        d.setHours(Math.floor(t / 60), t % 60, 0, 0);
        slots.push(d.getTime());
        cursor = t + gap + 1;
    }
    return slots.sort((a, b) => a - b);
}
/** 今天还剩几个点；不足则顺延到明天 */
function nextSlotFor(job, now = Date.now()) {
    const today = dayKey(now);
    if (!job.slots || job.slotsDay !== today) {
        job.slotsDay = today;
        job.slots = planWindowSlots(job, now);
    }
    const left = job.slots.filter((t) => t > now + 30_000);
    if (left.length)
        return left[0];
    const tomorrow = now + 86_400_000;
    job.slotsDay = dayKey(tomorrow);
    job.slots = planWindowSlots(job, tomorrow);
    return job.slots[0] ?? null;
}
/** 时间窗型任务。'any' = 时间窗 或 事件，任一满足就触发（两类条件都要配齐）。 */
const WINDOW_KINDS = new Set(['window', 'any']);
/** 事件型任务：不是到点触发，而是等聊天里出现某件事（dist/features/schedule-events.js 评估） */
const EVENT_KINDS = new Set(['event']);
export class ScheduleStore {
    jobs = [];
    saveTimer = null;
    dirty = false;
    dataDir;
    logger;
    /** 上次读到磁盘时的 mtime —— 外部(工具/手改)写了 timers.json 就据此重读 */
    _mtimeMs = 0;
    constructor(dataDir, logger) {
        this.dataDir = dataDir;
        this.logger = logger;
        mkdirSync(dataDir, { recursive: true });
        this.load();
    }
    file() {
        return join(this.dataDir, FILE_NAME);
    }
    load() {
        try {
            const p = this.file();
            if (existsSync(p)) {
                const raw = JSON.parse(readFileSync(p, 'utf8'));
                this.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
                try { this._mtimeMs = statSync(p).mtimeMs; } catch { /* 拿不到 mtime 就下次再说 */ }
            }
            // 旧版工具/面板把任务写在 {dataRoot}/timers.json，调度器读的是 {dataRoot}/.qqbot/timers.json
            // ⇒ 用工具建的任务永远不会到点。空的时候把旧文件接管过来（只接管一次，旧文件留着当备份）。
            if (!this.jobs.length && basename(this.dataDir) === '.qqbot') {
                const legacy = join(this.dataDir, '..', FILE_NAME);
                if (existsSync(legacy)) {
                    const raw = JSON.parse(readFileSync(legacy, 'utf8'));
                    const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
                    if (jobs.length) {
                        this.logger?.info?.(`[schedule] 接管旧任务 ${jobs.length} 条：${legacy} → ${p}`);
                        this.jobs = jobs;
                        this.save();
                    }
                }
            }
        }
        catch {
            this.jobs = [];
        }
    }
    /**
     * 外部改盘后重读（2026-11-11 加）：
     * `qq_timer` 工具是**直接写 timers.json** 的，内存里的这份不重读就永远看不见新任务
     * ⇒ 表现成「说明明建了定时任务，到点却没动」。只在没有待保存改动时重读，避免覆盖自己刚写的。
     */
    reloadIfChanged() {
        if (this.dirty || this.saveTimer) return;
        try {
            const p = this.file();
            if (!existsSync(p)) return;
            const m = statSync(p).mtimeMs;
            if (m && m !== this._mtimeMs) this.load();
        } catch { /* 读不到就当没变 */ }
    }
    save() {
        this.dirty = true;
        if (this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            if (!this.dirty)
                return;
            this.dirty = false;
            try {
                const p = this.file();
                const tmp = `${p}.tmp`;
                writeFileSync(tmp, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), 'utf8');
                renameSync(tmp, p);
            }
            catch (err) {
                this.logger?.warn?.(`[schedule] save failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }, 300);
    }
    flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (!this.dirty)
            return;
        this.dirty = false;
        try {
            writeFileSync(this.file(), JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), 'utf8');
        }
        catch { /* ignore */ }
    }
    /** 新建任务; 返回 {ok, id?, error?}。kind 缺省: atTime 且无 seconds→daily, 否则 once */
    add(input) {
        const kind = input.kind ?? (input.atTime && !input.seconds ? 'daily' : 'once');
        const now = Date.now();
        const seconds = Number(input.seconds);
        const hasSec = Number.isFinite(seconds) && seconds > 0;
        const hasAt = /^(\d{1,2}):(\d{2})$/.test((input.atTime ?? '').trim());
        if (!input.scope || typeof input.scope !== 'string')
            return { ok: false, error: '缺少会话类型 scope(c2c/group)' };
        if (!looksLikePeerId(input.peerId))
            return { ok: false, error: `收件人 id 不完整（${String(input.peerId ?? '')}）——要完整 openid，不是尾号；请用 qq_send/list 或台账里的完整 id` };
        const key = `${input.scope}:${input.peerId}`;
        if (kind === 'once' && hasSec && seconds < MIN_SECONDS)
            return { ok: false, error: `seconds 不能小于 ${MIN_SECONDS} 秒` };
        if (!WINDOW_KINDS.has(kind) && !EVENT_KINDS.has(kind) && !hasSec && !hasAt)
            return { ok: false, error: 'seconds 与 atTime 至少要给一个' };
        if (kind === 'daily' && !hasAt)
            return { ok: false, error: '每日任务需提供 atTime(几点几分 HH:MM)' };
        if (hasAt && !/^(\d{1,2}):(\d{2})$/.test((input.atTime ?? '').trim()))
            return { ok: false, error: 'atTime 格式应为 HH:MM(如 08:30)' };
        if (kind !== 'once' && kind !== 'daily' && !WINDOW_KINDS.has(kind) && !EVENT_KINDS.has(kind))
            return { ok: false, error: 'kind 只能为 once / daily / window / event / any' };
        if (EVENT_KINDS.has(kind) || kind === 'any') {
            const kws = Array.isArray(input.event?.keywords)
                ? input.event.keywords.map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
                : [];
            if (!kws.length)
                return { ok: false, error: 'event 任务需要 event.keywords(触发词数组)' };
        }
        if (WINDOW_KINDS.has(kind)) {
            if (!Number.isFinite(hhmmToMin(input.from)) || !Number.isFinite(hhmmToMin(input.to)))
                return { ok: false, error: 'window 任务需要 from/to(HH:MM)' };
            if (hhmmToMin(input.to) <= hhmmToMin(input.from))
                return { ok: false, error: 'window 的 to 必须晚于 from' };
        }
        // 配额
        const perPeer = this.jobs.filter(j => `${j.scope}:${j.peerId}` === key && j.enabled).length;
        if (perPeer >= MAX_PER_PEER)
            return { ok: false, error: `该会话定时任务已达上限(${MAX_PER_PEER}条)` };
        if (this.jobs.filter(j => j.enabled).length >= MAX_GLOBAL)
            return { ok: false, error: `定时任务总数已达上限(${MAX_GLOBAL}条)` };
        // 去重: 同一会话同一条 daily(同 atTime)不重复建
        if (kind === 'daily') {
            const dup = this.jobs.find(j => j.kind === 'daily' && `${j.scope}:${j.peerId}` === key && j.atTime === input.atTime.trim() && j.enabled);
            if (dup)
                return { ok: false, error: `已存在相同每日任务(每天 ${dup.atTime}), 请删除后再建` };
        }
        if (EVENT_KINDS.has(kind) || kind === 'any') {
            const sig = (input.event?.keywords || []).map((s) => String(s).trim()).join('|');
            const dup = this.jobs.find(j => j.kind === kind && `${j.scope}:${j.peerId}` === key && j.enabled && (j.event?.keywords || []).join('|') === sig);
            if (dup)
                return { ok: false, error: `已存在相同事件任务(${dup.id}), 请删除后再建` };
        }
        const weight = Number(input.weight) > 0 ? Math.max(0.05, Math.min(1, Number(input.weight))) : 1;
        const decay = input.decay && typeof input.decay === 'object'
            ? {
                step: Number.isFinite(Number(input.decay.step)) ? Math.max(0, Math.min(1, Number(input.decay.step))) : 0.2,
                min: Number(input.decay.min) > 0 ? Math.max(0.05, Math.min(1, Number(input.decay.min))) : 0.1,
            }
            : { step: 0.2, min: 0.1 };
        const job = {
            id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            kind,
            scope: input.scope,
            peerId: input.peerId,
            prompt: (input.prompt ?? '').slice(0, 800),
            createdAt: now,
            enabled: true,
            weight,
            decay,
            ...(hasAt ? { atTime: input.atTime.trim() } : {}),
            ...(kind === 'once' ? { dueAt: hasSec && hasAt ? Math.min(now + seconds * 1000, dueAtFromHHMM(input.atTime.trim(), now)) : hasSec ? now + seconds * 1000 : dueAtFromHHMM(input.atTime.trim(), now) } : {}),
        };
        if (!job.prompt)
            return { ok: false, error: 'prompt 不能为空' };
        if (WINDOW_KINDS.has(kind)) {
            job.from = String(input.from).trim();
            job.to = String(input.to).trim();
            job.perDay = Math.max(1, Math.min(6, Number(input.perDay) || 1));
            job.minGapMin = Math.max(0, Math.min(720, Number(input.minGapMin) || 0));
            if (input.guard && typeof input.guard === 'object')
                job.guard = input.guard;
            job.slotsDay = dayKey(now);
            job.slots = planWindowSlots(job, now);
            job.nextAt = nextSlotFor(job, now) ?? undefined;
        }
        if (EVENT_KINDS.has(kind) || kind === 'any') {
            const ev = input.event || {};
            job.event = {
                keywords: (ev.keywords || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12),
                match: ev.match === 'all' ? 'all' : 'any',
                withinMin: Math.max(5, Math.min(10080, Number(ev.withinMin) || 720)),
                cooldownMin: Math.max(5, Math.min(10080, Number(ev.cooldownMin) || 180)),
            };
            job.lastFiredAt = 0;
            job.firedCount = 0;
        }
        this.jobs.push(job);
        this.save();
        return { ok: true, id: job.id };
    }
    get(id) {
        return this.jobs.find(j => j.id === id);
    }
    /** 下次触发时间戳(用于展示; once=dueAt, daily=今天该点(已过则明天); 禁用/null) */
    nextFireAt(job, now = Date.now()) {
        if (!job.enabled)
            return null;
        if (EVENT_KINDS.has(job.kind))
            return null;
        if (job.kind === 'once')
            return job.dueAt ?? null;
        if (WINDOW_KINDS.has(job.kind))
            return job.nextAt ?? null;
        const mm = /^(\d{1,2}):(\d{2})$/.exec(job.atTime ?? '');
        if (!mm)
            return null;
        const d = new Date(now);
        d.setHours(Math.min(23, Number(mm[1])), Math.min(59, Number(mm[2])), 0, 0);
        const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        if (job.lastRunDate === today || d.getTime() <= now)
            d.setDate(d.getDate() + 1);
        return d.getTime();
    }
    list() {
        return this.jobs.slice().sort((a, b) => (a.createdAt - b.createdAt));
    }
    remove(id) {
        const i = this.jobs.findIndex(j => j.id === id);
        if (i < 0)
            return false;
        this.jobs.splice(i, 1);
        this.save();
        return true;
    }
    /**
     * 手改任务（面板「任务管理」/QQ 里让她自己改都走这里）：只改「内容 + 时间」，
     * 不动 id / kind / scope / peerId —— 换人、换类型请删了重建，避免调度语义半新半旧。
     * 返回 {ok:true, job} 或 {ok:false, error}。
     */
    update(id, patch = {}) {
        this.reloadIfChanged();
        const j = this.jobs.find(x => x.id === id);
        if (!j)
            return { ok: false, error: '任务不存在' };
        const p = (patch && typeof patch === 'object') ? patch : {};
        const kind = j.kind;
        if (p.prompt !== undefined) {
            const text = String(p.prompt ?? '').trim().slice(0, 800);
            if (!text)
                return { ok: false, error: '内容不能为空' };
            j.prompt = text;
        }
        // ── daily / once：改点 ──
        if (p.atTime !== undefined && (kind === 'daily' || kind === 'once')) {
            const at = String(p.atTime ?? '').trim();
            if (!Number.isFinite(hhmmToMin(at)))
                return { ok: false, error: '时间要写成 HH:MM（例如 21:30）' };
            j.atTime = at;
            if (kind === 'once')
                j.dueAt = dueAtFromHHMM(at, Date.now());
            else {
                // 改成「今天已经过去」的点，今天就不再补跑，等明天
                const d = new Date();
                const curMin = d.getHours() * 60 + d.getMinutes();
                j.lastRunDate = hhmmToMin(at) <= curMin ? dayKey(Date.now()) : undefined;
            }
        }
        if (kind === 'once' && p.dueAt !== undefined) {
            const ts = Number(p.dueAt);
            if (!Number.isFinite(ts))
                return { ok: false, error: '时间格式不对' };
            if (ts < Date.now() - 60_000)
                return { ok: false, error: '这个时间已经过去了，改成将来的时间' };
            j.dueAt = ts;
            delete j.atTime;
        }
        // ── window / any：改窗口，重排今天的点 ──
        if (WINDOW_KINDS.has(kind)) {
            if (p.from !== undefined) {
                const v = String(p.from ?? '').trim();
                if (!Number.isFinite(hhmmToMin(v)))
                    return { ok: false, error: '开始时间要写成 HH:MM' };
                j.from = v;
            }
            if (p.to !== undefined) {
                const v = String(p.to ?? '').trim();
                if (!Number.isFinite(hhmmToMin(v)))
                    return { ok: false, error: '结束时间要写成 HH:MM' };
                j.to = v;
            }
            if (!(hhmmToMin(j.to) - hhmmToMin(j.from) >= 1))
                return { ok: false, error: '结束时间要晚于开始时间' };
            if (p.perDay !== undefined)
                j.perDay = Math.max(1, Math.min(6, Number(p.perDay) || 1));
            if (p.minGapMin !== undefined)
                j.minGapMin = Math.max(0, Math.min(720, Number(p.minGapMin) || 0));
            const now = Date.now();
            j.slotsDay = dayKey(now);
            j.slots = planWindowSlots(j, now);
            j.nextAt = nextSlotFor(j, now) ?? undefined;
        }
        // ── event / any：改触发词与冷却 ──
        if (EVENT_KINDS.has(kind) || kind === 'any') {
            const ev = { ...(j.event || {}) };
            if (p.keywords !== undefined) {
                const list = Array.isArray(p.keywords) ? p.keywords : String(p.keywords ?? '').split(/[,，、;；\s]+/);
                const kws = list.map(s => String(s).trim()).filter(Boolean).slice(0, 12);
                if (!kws.length)
                    return { ok: false, error: '触发词不能为空' };
                ev.keywords = kws;
            }
            if (p.match !== undefined)
                ev.match = p.match === 'all' ? 'all' : 'any';
            if (p.withinMin !== undefined)
                ev.withinMin = Math.max(5, Math.min(10080, Number(p.withinMin) || 720));
            if (p.cooldownMin !== undefined)
                ev.cooldownMin = Math.max(5, Math.min(10080, Number(p.cooldownMin) || 180));
            j.event = ev;
        }
        this.save();
        return { ok: true, job: j };
    }
    /** 当前应触发的任务(由 ticker 调用) */
    due(now = Date.now()) {
        this.reloadIfChanged();
        const today = new Date(now);
        const ymd = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
        const curMin = today.getHours() * 60 + today.getMinutes();
        return this.jobs.filter(j => {
            if (!j.enabled)
                return false;
            if (EVENT_KINDS.has(j.kind))
                return false; // 事件任务由 schedule-events 评估，不走时间轮
            if (j.kind === 'once')
                return j.dueAt !== undefined && j.dueAt <= now;
            if (WINDOW_KINDS.has(j.kind)) {
                if (j.nextAt === undefined || j.nextAt === null) {
                    j.nextAt = nextSlotFor(j, now) ?? undefined;
                    this.save();
                    return false; // 刚排好点，等下一轮 tick 再看
                }
                return j.nextAt <= now;
            }
            // daily: 到 HH:MM 且今天还没跑过
            const mm = /^(\d{1,2}):(\d{2})$/.exec(j.atTime ?? '');
            if (!mm)
                return false;
            const target = Math.min(23, Number(mm[1])) * 60 + Math.min(59, Number(mm[2]));
            return curMin >= target && j.lastRunDate !== ymd;
        });
    }
    /** 触发后记账: once 删除; daily 记今天 */
    markDone(id) {
        const j = this.jobs.find(x => x.id === id);
        if (!j)
            return;
        if (j.kind === 'once') {
            const i = this.jobs.indexOf(j);
            if (i >= 0)
                this.jobs.splice(i, 1);
        }
        else if (EVENT_KINDS.has(j.kind)) {
            // 事件任务：记时间 + 进冷却 + 说过了就淡一点（入站互动会回涨，见 schedule-events.bumpActivation）
            const now = Date.now();
            j.lastFiredAt = now;
            j.firedCount = (Number(j.firedCount) || 0) + 1;
            j.cooldownUntil = now + Math.max(5, Number(j.event?.cooldownMin) || 180) * 60_000;
            const step = Number(j.decay?.step) || 0.2;
            const min = Number(j.decay?.min) || 0.1;
            const w = Number.isFinite(Number(j.weight)) ? Number(j.weight) : 1;
            j.weight = Math.max(min, Math.min(1, w - step));
        }
        else if (WINDOW_KINDS.has(j.kind)) {
            // 窗口任务：今天这一点跑过了，排下一个点；今天用完了就排明天
            if (j.kind === 'any') {
                const now = Date.now();
                j.lastFiredAt = now;
                j.firedCount = (Number(j.firedCount) || 0) + 1;
                j.cooldownUntil = now + Math.max(5, Number(j.event?.cooldownMin) || 180) * 60_000;
                const step = Number(j.decay?.step) || 0.2;
                const min = Number(j.decay?.min) || 0.1;
                const w = Number.isFinite(Number(j.weight)) ? Number(j.weight) : 1;
                j.weight = Math.max(min, Math.min(1, w - step));
            }
            const today = dayKey(Date.now());
            j.ranOn = j.ranOn === today ? (j.ranCount || 0) + 1 : 1;
            j.ranDate = today;
            const left = (j.slots || []).filter((t) => t > Date.now() + 30_000);
            if (left.length)
                j.nextAt = left[0];
            else {
                const tomorrow = Date.now() + 86_400_000;
                j.slotsDay = dayKey(tomorrow);
                j.slots = planWindowSlots(j, tomorrow);
                j.nextAt = j.slots[0] ?? undefined;
            }
        }
        else {
            const d = new Date();
            j.lastRunDate = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        }
        this.save();
    }
    setEnabled(id, enabled) {
        const j = this.jobs.find(x => x.id === id);
        if (!j)
            return false;
        j.enabled = enabled;
        if (enabled) {
            j.lastError = undefined;
            j.failCount = 0;
        }
        this.save();
        return true;
    }
    /**
     * 记账（2026-11-14 加）：投递成功 / 失败都留在 job 上，面板才看得见「为什么没发」，
     * 而不是任务凭空消失。ticker 在 inject 成功/失败后调用。
     */
    reportFire(id) {
        const j = this.jobs.find(x => x.id === id);
        if (!j)
            return;
        j.lastFiredAt = Date.now();
        j.firedCount = (Number(j.firedCount) || 0) + 1;
        j.lastError = undefined;
        j.failCount = 0;
        this.save();
    }
    reportFail(id, msg) {
        const j = this.jobs.find(x => x.id === id);
        if (!j)
            return;
        j.failCount = (Number(j.failCount) || 0) + 1;
        j.lastError = String(msg ?? '投递失败').slice(0, 200);
        j.lastFailAt = Date.now();
        this.save();
    }
    /** 手动补发：清掉失败标记，把下一次触发时间提到现在（once 用 dueAt，window/any 用 nextAt，daily 清今天水位） */
    retry(id, now = Date.now()) {
        const j = this.jobs.find(x => x.id === id);
        if (!j)
            return { ok: false, error: '任务不存在' };
        j.enabled = true;
        j.lastError = undefined;
        j.failCount = 0;
        if (j.kind === 'once')
            j.dueAt = now;
        else if (j.kind === 'daily')
            j.lastRunDate = undefined;
        else
            j.nextAt = now;
        this.save();
        return { ok: true, job: j };
    }
}
// ── 多例注册表(多账号支持, 2026-09-03): 每账号实例一个 dataDir({cwd}/.qqbot) → 各自定时任务。
// ⚠️ 2026-09-11 B类修复: 单例时序坑同 sticker-store —— primary 按实例(ns)各记一份。
const _stores = new Map();
const _primaryByNs = new Map();
let _primaryDir;
/** 配置定时任务实例(启动早期每账号按自己 dataDir 预初始化; 同目录幂等)。ns=实例标识。 */
export function configureScheduleStore(dataDir, logger, ns) {
    const key = resolve(dataDir);
    let s = _stores.get(key);
    if (!s) {
        s = new ScheduleStore(dataDir, logger);
        _stores.set(key, s);
    }
    if (!_primaryDir)
        _primaryDir = key;
    if (ns)
        _primaryByNs.set(ns, key);
    return s;
}
/** 获取实例。带 dataDir → 按目录取(不在则容错新建); 带 ns → 按该实例 primary; 无参 → 全局 primary。 */
export function getScheduleStore(dataDir, logger, ns) {
    if (dataDir) {
        const key = resolve(dataDir);
        let s = _stores.get(key);
        if (!s) {
            s = new ScheduleStore(dataDir, logger);
            _stores.set(key, s);
        }
        return s;
    }
    if (ns) {
        const p = _primaryByNs.get(ns);
        if (p) {
            const s = _stores.get(p);
            if (s)
                return s;
        }
    }
    if (_primaryDir) {
        const s = _stores.get(_primaryDir);
        if (s)
            return s;
    }
    if (_stores.size === 1)
        return _stores.values().next().value;
    const dir = join(process.cwd(), '.qqbot');
    const s = new ScheduleStore(dir, logger);
    _stores.set(resolve(dir), s);
    if (!_primaryDir)
        _primaryDir = resolve(dir);
    if (ns)
        _primaryByNs.set(ns, resolve(dir));
    return s;
}
//# sourceMappingURL=schedule-store.js.map