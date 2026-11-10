/**
 * runtime-tuning.ts —— Runtime 调优的进程内单点(0.1.6)
 *
 * 为什么单开一个模块：出站缓冲/出口路由/会话管理都散在不同目录，谁都不该 import config 的完整 schema，
 * 也不该为读一个超时值去 `ctx.get(...)`。这里只放**三个被热更新反复读的数字/开关**，
 * 由启动路径 `configureRuntimeTuning()` 灌一次，之后各处直接读。
 *
 * 三个值都来自 `config.runtime`（见 config.ts 的 runtimeSchema）：
 *   · extHookTimeoutMs      —— 出站扩展链预算（默认 4000；0.1.5 写死 3000）
 *   · outboundDedupeWindowMs —— 同会话同正文抑制窗口（默认 3000；0=关）
 *   · disableStreamingWithExt —— 装了出站扩展就关流式（默认开）
 *
 * 契约：**永不抛出**，读不到就用默认值（宁可行为退回 0.1.5，也不能把消息弄丢）。
 */

const DEFAULTS = Object.freeze({
    extHookTimeoutMs: 4000,
    outboundDedupeWindowMs: 3000,
    disableStreamingWithExt: true,
});

const state = { ...DEFAULTS };

/** 同会话同正文的最近发送时刻：key = `scope|targetId|text` */
const recentText = new Map();
const RECENT_MAX = 200;
/** 太短的文本不做抑制（"嗯""好""哈哈哈"连发是正常人类行为） */
const MIN_DEDUPE_CHARS = 8;

function clampNum(v, def, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return def;
    return Math.min(max, Math.max(min, n));
}

/** 启动/设置热更新时灌值（字段缺失 = 保留当前值，不重置） */
export function configureRuntimeTuning(cfg = {}) {
    try {
        if (cfg.extHookTimeoutMs !== undefined)
            state.extHookTimeoutMs = clampNum(cfg.extHookTimeoutMs, DEFAULTS.extHookTimeoutMs, 500, 15000);
        if (cfg.outboundDedupeWindowMs !== undefined)
            state.outboundDedupeWindowMs = clampNum(cfg.outboundDedupeWindowMs, DEFAULTS.outboundDedupeWindowMs, 0, 60000);
        if (cfg.disableStreamingWithExt !== undefined)
            state.disableStreamingWithExt = cfg.disableStreamingWithExt !== false;
    }
    catch { /* 配置坏了就保持原值 */ }
    return { ...state };
}

/** 当前生效值（诊断/命令用） */
export function currentRuntimeTuning() {
    return { ...state };
}

export function extHookTimeoutMs() {
    return state.extHookTimeoutMs;
}

export function disableStreamingWithExt() {
    return state.disableStreamingWithExt;
}

function targetKeyOf(target) {
    if (!target || typeof target !== 'object')
        return '';
    const scope = String(target.scope ?? '');
    const id = String(target.targetId ?? target.openid ?? target.groupOpenid ?? '');
    return scope && id ? `${scope}:${id}` : '';
}

/**
 * 同一会话、同一段正文，在窗口内重复出现 → true（调用方应丢弃这一次）。
 * 只抑制"完全相同的文本"，且至少 MIN_DEDUPE_CHARS 个字。
 */
export function shouldSkipOutboundText(target, text) {
    const windowMs = state.outboundDedupeWindowMs;
    if (!(windowMs > 0))
        return false;
    const body = String(text ?? '');
    if (body.trim().length < MIN_DEDUPE_CHARS)
        return false;
    const key = targetKeyOf(target);
    if (!key)
        return false;
    const stamp = `${key}|${body}`;
    const now = Date.now();
    const prev = recentText.get(stamp);
    if (typeof prev === 'number' && now - prev < windowMs) {
        recentText.set(stamp, now);
        return true;
    }
    recentText.set(stamp, now);
    if (recentText.size > RECENT_MAX) {
        // 淘汰最旧的 1/4（Map 保持插入序，最前面的就是最早写的）
        let drop = Math.floor(RECENT_MAX / 4);
        for (const k of recentText.keys()) {
            recentText.delete(k);
            if (--drop <= 0)
                break;
        }
    }
    return false;
}

/** 测试用 */
export function __resetRuntimeTuningForTest() {
    Object.assign(state, DEFAULTS);
    recentText.clear();
}
