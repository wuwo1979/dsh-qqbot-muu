/**
 * msg-history.ts — 群消息历史台账（2026-10-20 主人定：独立台账 + 按会话分目录 + 一天一个文件）
 *
 * 目录结构（`{dataRoot}/.qqbot/msg-history/`）：
 *   group_<群openid>/2026-10-20.jsonl
 *   c2c_<对方openid>/2026-10-20.jsonl
 *
 * 设计要点（主人要求）：
 *   · **一会话一目录** → 群与群、群与私聊天然隔离，读的时候根本碰不到别人的文件；
 *   · **一天一个文件** → 不会反复读写同一个越滚越大的文件；
 *   · **默认只保留 7 天** → 启动时 + 每 200 次写顺手清掉过期日期文件；
 *   · 一行一条：`{"id":"message_id","s":"发送者","n":"昵称","t":毫秒,"k":"text|image|voice|video|file","x":"正文摘要","me":true?}`
 *
 * 用途：`group_recall`（撤某人最近一条）、`group_msg_search`（按关键词/类型搜）、
 *       `group_recall_batch`（批量撤 + 顺带禁言）。与引用补全用的 msg-content.jsonl **互不干扰**。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** 默认保留天数（主人定：7 天） */
export const KEEP_DAYS = 7;
/** 单日文件读取上限（防御：一天消息特别多时别把内存吃爆） */
const MAX_READ_LINES = 5000;
/** 正文摘要长度 */
const TEXT_MAX = 200;
let historyRoot = '';
let writeTick = 0;
const pad = (n) => String(n).padStart(2, '0');
/** 本地日期 YYYY-MM-DD（不能用 toISOString，那是 UTC 会错日） */
function dayOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function safeId(id) {
    return String(id).replace(/[^0-9A-Za-z_-]/gu, '');
}
function dirOf(scope, peerId) {
    return join(historyRoot, `${scope}_${safeId(peerId)}`);
}
/** 初始化（bootstrap 启动时调一次）：建目录 + 清过期 */
export function initMsgHistory(dataRoot) {
    if (!dataRoot)
        return;
    historyRoot = join(dataRoot, '.qqbot', 'msg-history');
    try {
        mkdirSync(historyRoot, { recursive: true });
    }
    catch {
        historyRoot = '';
        return;
    }
    pruneOld();
}
/** 删掉超过 KEEP_DAYS 天的日期文件（顺带删空目录） */
export function pruneOld() {
    if (!historyRoot)
        return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    const cutoffDay = dayOf(cutoff);
    let dirs = [];
    try {
        dirs = readdirSync(historyRoot);
    }
    catch {
        return;
    }
    for (const d of dirs) {
        const dir = join(historyRoot, d);
        let files = [];
        try {
            if (!statSync(dir).isDirectory())
                continue;
            files = readdirSync(dir);
        }
        catch {
            continue;
        }
        let alive = 0;
        for (const f of files) {
            if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(f))
                continue;
            if (f.slice(0, 10) < cutoffDay) {
                try {
                    rmSync(join(dir, f), { force: true });
                }
                catch { /* ignore */ }
            }
            else {
                alive++;
            }
        }
        if (alive === 0) {
            try {
                rmSync(dir, { recursive: true, force: true });
            }
            catch { /* ignore */ }
        }
    }
}
/** 已经写过名字文件的会话（避免每条消息都写） */
const marked = new Set();
/** 读 {dataRoot}/.qqbot/groups.json 拿群名 */
function groupNameOf(gid) {
    try {
        const f = join(historyRoot, '..', 'groups.json');
        const j = JSON.parse(readFileSync(f, 'utf8'));
        const n = j?.[gid]?.name;
        if (n)
            return String(n).trim();
    }
    catch { /* 没注册表就算了 */ }
    return '';
}
/** 根目录索引：所有群文件夹 ↔ 群名 对照（方便肉眼找） */
function refreshIndex() {
    if (!historyRoot)
        return;
    let dirs = [];
    try {
        dirs = readdirSync(historyRoot);
    }
    catch {
        return;
    }
    const lines = ['QQ 消息历史台账索引', '', '目录 → 群名（本目录只保留最近 ' + KEEP_DAYS + ' 天）', ''];
    for (const d of dirs.sort()) {
        if (!d.startsWith('group_') && !d.startsWith('c2c_'))
            continue;
        const id = d.slice(6);
        const name = d.startsWith('group_') ? (groupNameOf(id) || '未命名群') : ('私聊 ' + id.slice(0, 8));
        lines.push('  ' + d + '  →  ' + name);
    }
    lines.push('');
    try {
        writeFileSync(join(historyRoot, '_索引.txt'), lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    }
    catch { /* ignore */ }
}
/**
 * 在该会话目录里放一个「<群名>.txt」（主人要求：打开文件夹一眼认出是哪个群）。
 * 群名变了会顺手删掉旧名字文件；同时刷新根目录 _索引.txt。
 */
export function markSession(scope, peerId) {
    if (!historyRoot || !peerId)
        return;
    const key = scope + ':' + peerId;
    if (marked.has(key))
        return;
    const dir = dirOf(scope, peerId);
    try {
        mkdirSync(dir, { recursive: true });
    }
    catch {
        return;
    }
    const rawName = scope === 'group' ? (groupNameOf(peerId) || '未命名群') : ('私聊_' + peerId.slice(0, 8));
    const BAD = String.fromCharCode(92) + '/:*?"<>|' + String.fromCharCode(13) + String.fromCharCode(10);
    const safe = rawName.split('').map((ch) => (BAD.indexOf(ch) >= 0 ? '_' : ch)).join('').slice(0, 40) || '未命名';
    try {
        for (const f of readdirSync(dir)) {
            if (f.endsWith('.txt') && f !== safe + '.txt')
                rmSync(join(dir, f), { force: true });
        }
    }
    catch { /* ignore */ }
    const body = [
        rawName,
        '',
        '群号(gid): ' + peerId,
        '类型: ' + (scope === 'group' ? 'QQ群' : '私聊'),
        '本目录保存最近 ' + KEEP_DAYS + ' 天的历史消息，每天一个 .jsonl（一行一条）。',
        '由 dsh-qqbot 自动生成，仅用于人工辨认；删掉会自动重建。',
        '',
    ].join(String.fromCharCode(10));
    try {
        writeFileSync(join(dir, safe + '.txt'), body, 'utf8');
    }
    catch { /* ignore */ }
    marked.add(key);
    refreshIndex();
}
/** 记一条（写入当天文件） */
export function appendMsgHistory(scope, peerId, rec) {
    if (!historyRoot || !peerId || !rec?.id)
        return;
    markSession(scope, peerId);
    const now = Date.now();
    const row = {
        id: String(rec.id),
        s: String(rec.s ?? ''),
        n: String(rec.n ?? ''),
        t: Number(rec.t ?? now),
        k: (rec.k ?? 'text'),
        x: (function (v) { var t = String(v ?? ''); t = t.replace(/\[记忆\][\s\S]*?\[\/记忆\]/gu, ' ').replace(/\[设定\][\s\S]*?\[\/设定\]/gu, ' ').replace(/\[印象\][\s\S]*?\[\/印象\]/gu, ' ').replace(/\[关系\][\s\S]*?\[\/关系\]/gu, ' ').replace(/\[状态\][\s\S]*?\[\/状态\]/gu, ' ').replace(/\[B站\][\s\S]*?\[\/B站\]/gu, ' ').replace(/\n?\[别重复\][^\n]*/gu, ' '); return t.replace(/\s+/gu, ' ').trim().slice(0, TEXT_MAX); })(rec.x), // qqs-clean-injected
        ...(rec.me ? { me: true } : {}),
    };
    try {
        const dir = dirOf(scope, peerId);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `${dayOf(row.t)}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8');
    }
    catch {
        return;
    }
    writeTick = (writeTick + 1) % 200;
    if (writeTick === 0)
        pruneOld();
}
/** 读该会话的历史（**只碰它自己的目录**），新→旧 */
export function readMsgHistory(scope, peerId, q = {}) {
    if (!historyRoot || !peerId)
        return [];
    const dir = dirOf(scope, peerId);
    if (!existsSync(dir))
        return [];
    const now = Date.now();
    const within = q.withinMs ?? KEEP_DAYS * 24 * 60 * 60 * 1000;
    const from = now - within;
    const limit = Math.max(1, Math.min(200, q.limit ?? 20));
    const kw = String(q.keyword ?? '').trim().toLowerCase();
    // 只读窗口覆盖到的日期文件（新→旧）
    const days = [];
    for (let d = new Date(now); d.getTime() >= from && days.length <= KEEP_DAYS; d = new Date(d.getTime() - 24 * 60 * 60 * 1000)) {
        days.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    const out = [];
    for (const day of days) {
        if (out.length >= limit)
            break;
        const f = join(dir, `${day}.jsonl`);
        if (!existsSync(f))
            continue;
        let text = '';
        try {
            text = readFileSync(f, 'utf8');
        }
        catch {
            continue;
        }
        const lines = text.split('\n');
        const start = Math.max(0, lines.length - MAX_READ_LINES);
        for (let i = lines.length - 1; i >= start && out.length < limit; i--) {
            const line = lines[i];
            if (!line)
                continue;
            let r;
            try {
                r = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!r?.id)
                continue;
            if (Number(r.t) < from)
                continue;
            if (q.fromSelf !== undefined && Boolean(r.me) !== q.fromSelf)
                continue;
            if (q.senderId && r.s !== q.senderId)
                continue;
            if (q.kind && (r.k ?? 'text') !== q.kind)
                continue;
            if (kw && !String(r.x ?? '').toLowerCase().includes(kw))
                continue;
            out.push(r);
        }
    }
    return out;
}
/** 找「某人最近一条」/「最近一条」 */
export function latestMsgHistory(scope, peerId, opts = {}) {
    return readMsgHistory(scope, peerId, { ...opts, limit: 1 })[0];
}
/** 诊断：会话目录 + 今天文件行数 */
export function historyDebug(scope, peerId) {
    if (!historyRoot)
        return '(台账未初始化)';
    const dir = dirOf(scope, peerId);
    if (!existsSync(dir))
        return `(该会话还没有台账目录: ${dir})`;
    const f = join(dir, `${dayOf(Date.now())}.jsonl`);
    let n = 0;
    try {
        if (existsSync(f))
            n = readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
    }
    catch { /* ignore */ }
    return `(台账 ${dir} · 今天 ${n} 条 · 保留 ${KEEP_DAYS} 天)`;
}
/**
 * 最近有消息写入的群目录对应的 gid（2026-10-20）。
 * 用途：web 会话里拿不到群会话记录时的兜底 —— 一般就是"当前正在聊的群"。
 */
export function latestGroupId() {
    if (!historyRoot)
        return '';
    let best = '';
    let bestT = 0;
    try {
        for (const d of readdirSync(historyRoot)) {
            if (!d.startsWith('group_'))
                continue;
            const st = statSync(join(historyRoot, d));
            if (st.mtimeMs > bestT) {
                bestT = st.mtimeMs;
                best = d.slice(6);
            }
        }
    }
    catch { /* ignore */ }
    return best;
}
//# sourceMappingURL=msg-history.js.map