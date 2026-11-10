/**
 * inbound-dedupe.ts —— 持久化入站去重(0.1.6)
 *
 * SDK 自带的 `messageFilter` 用**内存 Map + 5 秒窗口**去重（`@tencent-connect/qqbot-nodejs/dist/middleware/message-filter.js`）。
 * 两个洞，正好是用户抱怨的"重复发送会话"：
 *   ① 5 秒太短：断线重连、QQ 推送延迟、网关重建，重复帧常常在 5~60 秒后才到；
 *   ② 只在内存：**重启（/bot-restart 或崩溃重连）后窗口清零**，积压帧全部重放 → 同一句话回两遍。
 *
 * 这里做的是"落盘 + 可配窗口"的补丁层：
 *   · 键 = `messageId`（没有 messageId 的事件直接放行，宁可重复也不吞消息）；
 *   · 窗口默认 120 秒（`runtime.inboundDedupeTtlSec`，0=关）；
 *   · 落 `{dataRoot}/.qqbot/inbound-dedupe.json`，最多 3000 条，过期即清，写盘节流 1.5 秒；
 *   · 命中重复 → `ctx.stop('dedupe-persist')`，只打 debug，不打扰任何人。
 *
 * 纪律：本模块**永不抛出**（读写盘失败一律降级成"这次不落盘，但仍用内存去重"）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 落盘文件最多保留多少条 messageId（超出按时间淘汰最旧的） */
const MAX_ENTRIES = 3000;

function readStore(file) {
    try {
        if (!existsSync(file))
            return {};
        const o = JSON.parse(readFileSync(file, 'utf8'));
        return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    }
    catch {
        return {};
    }
}

export class InboundDedupe {
    file;
    ttlMs;
    logger;
    seen;
    dirty = 0;
    constructor(opts = {}) {
        this.logger = opts.logger;
        this.ttlMs = Math.max(0, Number(opts.ttlSec ?? 120)) * 1000;
        this.file = opts.dataRoot ? join(String(opts.dataRoot), '.qqbot', 'inbound-dedupe.json') : '';
        this.seen = this.file ? readStore(this.file) : {};
        this.prune();
    }
    prune() {
        const cutoff = Date.now() - this.ttlMs;
        let removed = 0;
        for (const [id, ts] of Object.entries(this.seen)) {
            if (typeof ts !== 'number' || ts < cutoff) {
                delete this.seen[id];
                removed += 1;
            }
        }
        // 兜底：条数封顶（时间淘汰可能因为时钟跳变失效，条数是最硬的闸）
        const ids = Object.keys(this.seen);
        if (ids.length > MAX_ENTRIES) {
            ids.sort((a, b) => (this.seen[a] ?? 0) - (this.seen[b] ?? 0));
            for (const id of ids.slice(0, ids.length - MAX_ENTRIES))
                delete this.seen[id];
        }
        return removed;
    }
    /** 命中返回 true（= 重复，应该丢掉） */
    hit(messageId) {
        if (this.ttlMs <= 0)
            return false;
        const id = String(messageId ?? '').trim();
        if (!id)
            return false;
        const prev = this.seen[id];
        const now = Date.now();
        if (typeof prev === 'number' && now - prev < this.ttlMs) {
            this.seen[id] = now; // 续期：重复帧不该把原始记录挤掉
            return true;
        }
        this.seen[id] = now;
        // 立即落盘：宁可每次多写 1ms，也不能"刚收到就重启"时窗口清零（那正是重连重复的成因）。
        // 写盘失败会降级成"内存里仍然有效"，不抛。
        this.save();
        return false;
    }
    save() {
        if (!this.file)
            return;
        this.dirty = 0;
        try {
            this.prune();
            mkdirSync(dirname(this.file), { recursive: true });
            writeFileSync(this.file, JSON.stringify(this.seen), 'utf8');
        }
        catch (err) {
            this.logger?.warn?.(`im-qqbot: 入站去重落盘失败(仍在内存生效): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    dispose() {
        if (this.dirty > 0)
            this.save();
    }
}

/**
 * 造一个中间件（挂在 messageFilter 之后）。
 * `ttlSec <= 0` 时返回直通中间件（完全零行为，给"我要关掉"的人）。
 */
export function createInboundDedupeMiddleware(opts = {}) {
    const ttlSec = Math.max(0, Number(opts.ttlSec ?? 120));
    if (!(ttlSec > 0))
        return async (_ctx, next) => next();
    const dedupe = new InboundDedupe({ ...opts, ttlSec });
    opts.registerDispose?.(() => dedupe.dispose());
    const mw = async (ctx, next) => {
        try {
            if (dedupe.hit(ctx?.message?.messageId)) {
                try {
                    ctx.log?.debug?.(`[dedupe] 丢弃重复入站 messageId=${ctx.message.messageId}`);
                }
                catch { /* ignore */ }
                ctx.stop?.('dedupe-persist');
                return;
            }
        }
        catch (err) {
            // 去重层坏了也绝不能挡住消息
            try {
                opts.logger?.warn?.(`im-qqbot: 入站去重异常(已放行): ${err instanceof Error ? err.message : String(err)}`);
            }
            catch { /* ignore */ }
        }
        await next();
    };
    mw.dedupe = dedupe;
    return mw;
}
