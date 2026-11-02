/**
 * access-care.js — care（特别关心）访问模式的名单源（2026-11-02 市场合规 11173）
 *
 * care 模式：私聊只放行「特别关心的人」(priorityPeople)，群聊只放行「特别关心群」(priority)。
 * 名单与人格体系同源（数据根 group-tiers.json，浮窗/命令改名单即时生效，这里带 5s 缓存）。
 * cfg 白名单（c2cAllow/groupAllow）与 care 名单叠加生效，"*" = 全部。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CARE_CACHE_TTL = 5000;
let _cache = { at: 0, people: [], groups: [] };

const norm = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);

/** 读特别关心名单（people=特别关心的人 / groups=特别关心群），带 5s 缓存 */
export function readCareLists(dataRoot) {
    const now = Date.now();
    if (now - _cache.at < CARE_CACHE_TTL) return _cache;
    let people = [];
    let groups = [];
    try {
        const j = JSON.parse(readFileSync(join(dataRoot, '.qqbot-extensions', 'data', 'group-tiers.json'), 'utf8'));
        people = norm(j?.priorityPeople);
        groups = norm(j?.priority).map((s) => String(s).replace(/^group:/, ''));
    }
    catch { /* 文件不存在 = 名单为空 = care 模式下全拒 */ }
    _cache = { at: now, people, groups };
    return _cache;
}

/** 测试用：清缓存 */
export function resetCareCache() {
    _cache = { at: 0, people: [], groups: [] };
}

/**
 * 构造 accessPolicy 的单通道 policy。
 * care 模式 → allowlist + 函数 matcher（accessPolicy 的 matcherMatches 对 function 直接调用看真值），
 *            闭包内现读名单，天然支持"改名单不重启"。
 * 其余模式 → 原样透传（allowlist 空名单 = 拒绝所有人，绝不回落 ['*']）。
 */
export function accessScopeOf(kind, mode, cfgAllow, dataRoot, extraAllow = []) {
    if (mode === 'care') {
        return { mode: 'allowlist', allow: [...extraAllow, (ctx) => {
            const m = ctx?.message || {};
            const id = kind === 'group' ? (m.groupOpenid ?? '') : (m.senderId ?? '');
            if (!id) return false;
            if (cfgAllow.includes(id) || cfgAllow.includes('*') || extraAllow.includes('*')) return true;
            const lists = readCareLists(dataRoot);
            const list = kind === 'group' ? lists.groups : lists.people;
            return list.includes(id) || list.includes('*');
        }] };
    }
    return { mode, allow: cfgAllow };
}

/** 空名单检测（用于启动时醒目 warn）：返回 null 或一条提示 */
export function careEmptyHint(kind, mode, cfgAllow, dataRoot) {
    if (mode !== 'care') {
        if (mode === 'allowlist' && (!cfgAllow || cfgAllow.length === 0)) {
            return `allowlist 模式但白名单为空 → 相关消息将被拒绝（往 Allow 填 openid，或改 open/care）`;
        }
        return null;
    }
    const lists = readCareLists(dataRoot);
    const list = kind === 'group' ? lists.groups : lists.people;
    const label = kind === 'group' ? '特别关心群(priority)' : '特别关心的人(priorityPeople)';
    if (list.length === 0 && (!cfgAllow || cfgAllow.length === 0)) {
        return `care(特别关心) 模式但 ${label} 名单为空 → 相关消息将被拒绝（把人/群设为特别关心即可，或往 Allow 填 openid，或改 open）`;
    }
    return null;
}
