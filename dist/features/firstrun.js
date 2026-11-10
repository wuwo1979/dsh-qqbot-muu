/**
 * firstrun.ts —— 新装用户的「补丁式首装」(0.1.6)
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────────
 * 0.1.5 之前，插件下载下来是"半成品"：
 *   ① 扩展全部躺在包里（`<pkg>/dshqqbot/.qqbot-extensions`），**不会自己进数据根**
 *      —— 不手工跑 `install.mjs` 的话，新用户一个扩展都没有（分句/卡片/记忆/表情全空）；
 *   ② 会话去重只有 SDK 的**内存 5 秒**窗口，重启/重连超过 5 秒的重复推送照样回两遍；
 *   ③ 出站扩展链写死 3000ms 超时，超时宿主"按原文整条再发" ⇒ 一条回复发两遍；
 *   ④ 新会话权限档沿用宿主默认（常常是只读/要审批），工具被拒 → 看起来"很笨"，审批没人答 → "卡住"。
 * 这些都是**默认值问题**，不该让用户去翻文档手调。
 *
 * ── 铁律 ──────────────────────────────────────────────────────────────────
 *  ① **只缺省才写**：已有配置一个字节都不动（判断粒度是"叶子键在不在"，不是值等不等于默认）；
 *  ② **幂等**：跑一百次和跑一次结果一样（第二次全都"already present"）；
 *  ③ **失败绝不影响启动**：任何一个补丁炸了只 warn，网关照样连；
 *  ④ **留痕**：写了什么记在 `{dataRoot}/.qqbot/firstrun.json`，出问题可以直接看；
 *  ⑤ **不删除任何东西**：迁移只做加法。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { nsPathsOf } from './ns-guard.js';
import { resolveProfileName } from '../shared/utils.js';

/** 补丁清单：点分路径 → 默认值。只写「用户配置里根本没有这个叶子」的那些。 */
export const FIRST_RUN_DEFAULTS = Object.freeze({
    'runtime.inboundDedupeTtlSec': 120,
    'runtime.outboundDedupeWindowMs': 3000,
    'runtime.extHookTimeoutMs': 4000,
    'runtime.disableStreamingWithExt': true,
    // 空 = 沿用宿主默认；用户可以填 workspace-write 让新会话自动可写
    'runtime.permissionPreset': '',
});

/** 播种时永远不碰的目录/文件（运行时数据、停用标记、依赖、备份、隐私目录） */
const SEED_SKIP_DIRS = new Set(['data', '.state', 'node_modules', '.git', 'tmp', 'secrets']);
const SEED_SKIP_RE = /(\.bak(\.|$)|\.log$|\.tmp$|cookie\.json$|\.env(\.|$))/i;
/** 作者机器上的绝对路径：播种到别人机器上必须改写（install.mjs 同款规则） */
const AUTHOR_ROOT_RE = /F:[\\/]qqbot[\\/]dshqqbot/gi;
/** 单个文本文件最大参与"路径改写"的体积（扩展里都是小脚本，超过就跳过） */
const REWRITE_MAX_BYTES = 512 * 1024;

function readJson(file, fallback) {
    try {
        const o = JSON.parse(readFileSync(file, 'utf8'));
        return o && typeof o === 'object' ? o : fallback;
    }
    catch {
        return fallback;
    }
}

function writeJson(file, obj) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/** 读一个点分路径；不存在（或中间不是对象）返回 undefined */
export function getPath(obj, dotted) {
    let cur = obj;
    for (const key of String(dotted).split('.')) {
        if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key))
            return undefined;
        cur = cur[key];
    }
    return cur;
}

/** 写一个点分路径（只在缺省时调用；会补出中间对象） */
export function setPath(obj, dotted, value) {
    const keys = String(dotted).split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k]))
            cur[k] = {};
        cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
}

/**
 * 定位「用户真正编辑的那份」设置文件（与 dist/index.ts 的 nsPaths 同规则，含老布局兜底）。
 * 只用来**判断键在不在**和必要时直接落盘；正常情况下写走 settings 服务的 update。
 */
export function locateOwnSettings(ns) {
    const dshHome = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
    const paths = nsPathsOf(dshHome, String(ns), resolveProfileName());
    const file = existsSync(paths.file) ? paths.file : (existsSync(paths.legacyFile) ? paths.legacyFile : paths.file);
    return { ...paths, file, exists: existsSync(file) };
}

/**
 * 首装补丁：把 FIRST_RUN_DEFAULTS 里「用户没设过」的键写进去。
 *
 * @param opts.ns       settings 命名空间（默认 im-qqbot）
 * @param opts.dataRoot 数据根（留痕用；缺省则不落痕）
 * @param opts.defaults 覆盖补丁清单（测试用）
 * @param opts.settingsService 宿主 settings 服务（有 update 就优先用它写）
 * @param opts.dryRun   只算不写（测试/诊断用）
 * @returns {{written: Record<string, unknown>, skipped: string[], file: string}}
 */
export async function applyDefaultsPatch(opts = {}) {
    const logger = opts.logger ?? null;
    const ns = String(opts.ns ?? 'im-qqbot');
    const defaults = opts.defaults ?? FIRST_RUN_DEFAULTS;
    const paths = locateOwnSettings(ns);
    const current = paths.exists ? readJson(paths.file, {}) : {};
    const patch = {};
    const written = {};
    const skipped = [];
    for (const [dotted, value] of Object.entries(defaults)) {
        if (getPath(current, dotted) !== undefined) {
            skipped.push(dotted);
            continue;
        }
        setPath(patch, dotted, value);
        written[dotted] = value;
    }
    const keys = Object.keys(written);
    if (keys.length === 0)
        return { written, skipped, file: paths.file };
    if (opts.dryRun)
        return { written, skipped, file: paths.file };
    let persisted = false;
    // ① 首选官方通道：settings.update(ns, patch) —— 面板/yml/内存三份一致
    const svc = opts.settingsService;
    if (svc && typeof svc.update === 'function') {
        try {
            await svc.update(ns, patch);
            persisted = true;
        }
        catch (err) {
            logger?.warn?.(`im-qqbot: 首装补丁经 settings 服务写入失败(改用自有存储): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ② 兜底：直接写自有存储（与 settings-host 同一份文件；先并再写，绝不覆盖别的键）
    if (!persisted) {
        try {
            const merged = readJson(paths.file, {});
            for (const dotted of keys)
                setPath(merged, dotted, written[dotted]);
            writeJson(paths.file, merged);
            persisted = true;
        }
        catch (err) {
            logger?.warn?.(`im-qqbot: 首装补丁写自有存储失败(不影响启动): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (opts.dataRoot && persisted) {
        try {
            const trail = join(String(opts.dataRoot), '.qqbot', 'firstrun.json');
            const prev = readJson(trail, {});
            writeJson(trail, {
                at: new Date().toISOString(),
                ns,
                patch: { ...(prev.patch ?? {}), ...written },
                history: [...(Array.isArray(prev.history) ? prev.history : []), { at: new Date().toISOString(), wrote: keys }].slice(-20),
            });
        }
        catch { /* 留痕失败无所谓 */ }
    }
    logger?.info?.(`im-qqbot: 首装补丁已写入 ${keys.length} 项默认值(${keys.join(', ')}) — 已存在的用户配置未改动`);
    return { written, skipped, file: paths.file };
}

/**
 * 首装播种：把包里带的扩展目录复制到数据根（**只补缺失，绝不覆盖**）。
 *
 * 为什么不是"检测目录空不空"而是"逐个文件判断"：
 *   老用户升级时也想拿到 0.1.6 新带的扩展（比如面试），但不能把人家改过的文件冲掉。
 *
 * @param opts.pkgRoot   包根（`<pkg>/dshqqbot/.qqbot-extensions` 的父目录）
 * @param opts.dataRoot  数据根
 * @param opts.force     true = 覆盖同名文件（默认 false；仅 install.mjs --force 场景）
 * @returns {{copied: string[], kept: number, skipped: number}}
 */
export function seedExtensions(opts = {}) {
    const logger = opts.logger ?? null;
    const force = opts.force === true;
    const dataRoot = String(opts.dataRoot ?? '').trim();
    const pkgRoot = String(opts.pkgRoot ?? '').trim();
    const result = { copied: [], kept: 0, skipped: 0 };
    if (!dataRoot || !pkgRoot)
        return result;
    const srcRoot = join(pkgRoot, 'dshqqbot', '.qqbot-extensions');
    if (!existsSync(srcRoot))
        return result;
    const dstRoot = join(dataRoot, '.qqbot-extensions');
    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const abs = join(dir, e.name);
            const rel = abs.slice(srcRoot.length).replace(/^[\\/]+/, '');
            if (e.isDirectory()) {
                if (SEED_SKIP_DIRS.has(e.name))
                    continue;
                walk(abs);
                continue;
            }
            if (!e.isFile())
                continue;
            if (SEED_SKIP_RE.test(e.name)) {
                result.skipped += 1;
                continue;
            }
            const dst = join(dstRoot, rel);
            if (existsSync(dst) && !force) {
                result.kept += 1;
                continue;
            }
            try {
                mkdirSync(dirname(dst), { recursive: true });
                const size = (() => {
                    try {
                        return statSync(abs).size;
                    }
                    catch {
                        return 0;
                    }
                })();
                // 文本文件顺手把作者机绝对路径改写成这台机器的数据根（否则扩展里写死的 F:/qqbot/dshqqbot 会指向不存在的目录）
                if (size > 0 && size <= REWRITE_MAX_BYTES && /\.(mjs|js|cjs|json|ya?ml|md|txt)$/i.test(e.name)) {
                    const raw = readFileSync(abs, 'utf8');
                    if (AUTHOR_ROOT_RE.test(raw)) {
                        AUTHOR_ROOT_RE.lastIndex = 0;
                        writeFileSync(dst, raw.replace(AUTHOR_ROOT_RE, resolve(dataRoot).replace(/\\/g, '/')), 'utf8');
                        result.copied.push(rel);
                        continue;
                    }
                    AUTHOR_ROOT_RE.lastIndex = 0;
                }
                copyFileSync(abs, dst);
                result.copied.push(rel);
            }
            catch (err) {
                result.skipped += 1;
                logger?.warn?.(`im-qqbot: 首装播种失败(${basename(rel)}): ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    };
    try {
        walk(srcRoot);
    }
    catch (err) {
        logger?.warn?.(`im-qqbot: 首装播种中断(不影响启动): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (result.copied.length > 0) {
        logger?.info?.(`im-qqbot: 首装播种完成 — 新增 ${result.copied.length} 个扩展文件到 ${dstRoot}（已存在的 ${result.kept} 个文件未改动）`);
    }
    return result;
}

/**
 * 数据根里有没有出站扩展（决定要不要关掉流式）。
 * 用目录扫描而不是"已装载列表"：流式判定发生在会话创建时，此刻扩展可能还没 load。
 * 结果按目录 mtime 缓存 10s，避免每条消息都 stat 一遍。
 */
const outboundPresence = { at: 0, dataRoot: '', has: false };
export function hasOutboundExtensions(dataRoot) {
    const root = String(dataRoot ?? '').trim();
    if (!root)
        return false;
    const now = Date.now();
    if (outboundPresence.dataRoot === root && now - outboundPresence.at < 10_000)
        return outboundPresence.has;
    const hits = [];
    const push = (dir) => {
        try {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                if (e.isFile() && /\.(mjs|js|cjs)$/i.test(e.name))
                    hits.push(join(dir, e.name));
            }
        }
        catch { /* 目录不存在 = 没有 */ }
    };
    push(join(root, '.qqbot-extensions', 'outbound'));
    // 扩展包目录（{dataRoot}/.qqbot-extensions/packs/<pkg>/outbound）也认
    try {
        for (const e of readdirSync(join(root, '.qqbot-extensions', 'packs'), { withFileTypes: true })) {
            if (e.isDirectory())
                push(join(root, '.qqbot-extensions', 'packs', e.name, 'outbound'));
        }
    }
    catch { /* 没有扩展包目录是常态 */ }
    outboundPresence.at = now;
    outboundPresence.dataRoot = root;
    outboundPresence.has = hits.length > 0;
    return outboundPresence.has;
}

/** 测试用：清掉 hasOutboundExtensions 的缓存 */
export function __resetOutboundPresenceForTest() {
    outboundPresence.at = 0;
    outboundPresence.dataRoot = '';
    outboundPresence.has = false;
}
