/**
 * md-media-rewrite.ts — 出站自动把「本地图片 markdown」换成 QQ 能渲染的引用（2026-10-21）
 *
 * 主人口径：正文/卡片里直接写 `![说明](D:/path/x.jpg)`，发到 QQ 时自动：
 *   上传（prepare→PUT→complete→list 核实）→ 解析宽高 → 改写 `![文件名 #Wpx #Hpx](url)`
 *   配额满 100 张自动删最早。
 *
 * 兼容各种写法：正/反斜杠、尖括号、路径带空格、file://、尾部标题。
 * 只处理本地路径；http(s)/qqbot-media 原样放过。失败保留原样，绝不吞正文。
 */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { uploadMarkdownImage, listMarkdownImages, deleteMarkdownImage } from './md-media.js';
function diag(msg) {
    try {
        appendFileSync(join(homedir(), '.dsh', 'md-media-diag.log'), new Date().toISOString() + ' ' + msg + String.fromCharCode(10));
    }
    catch { /* ignore */ }
}
let targetFactory;
let lastResult;
export function lastMediaRewrite() { return lastResult; }
function setLast(r) {
    lastResult = r;
    try {
        globalThis[Symbol.for('im-qqbot.md-media.last')] = r;
    }
    catch { /* ignore */ }
}
export function setMaterialTargetFactory(fn) {
    targetFactory = fn;
}
/** 尽量吃下各种写法：尖括号、空格、反斜杠、尾部标题都可选 */
const IMG_RE = /!\[([^\]]*)\]\(\s*<?((?:[^()"\n]|\[()])+?)>?(?:\s+"[^"\n]*")?\s*\)/g;
const MAX_IMAGES = 100;
function isLocalImagePath(u) {
    if (!u)
        return false;
    if (/^(https?:|qqbot-media:|data:)/i.test(u))
        return false;
    if (/^file:\/\//i.test(u))
        return true;
    if (/^[A-Za-z]:[\/]/.test(u))
        return true;
    if (u.startsWith('/'))
        return true;
    return false;
}
function fromFileUrl(u) {
    try {
        const p = decodeURIComponent(u.replace(/^file:\/\/\/?/i, ''));
        return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
    }
    catch {
        return u.replace(/^file:\/\/\/?/i, '');
    }
}
async function ensureQuota(target, need) {
    let deleted = 0;
    for (let guard = 0; guard < 20; guard++) {
        const r = await listMarkdownImages(target);
        if (!r.ok)
            return deleted;
        const d = (r.data ?? {});
        const list = Array.isArray(d.images) ? d.images : [];
        const total = Number(d.total ?? list.length);
        if (total + need <= MAX_IMAGES)
            return deleted;
        const oldest = list
            .filter((x) => typeof x.image_id === 'string' && x.image_id)
            .sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))[0];
        if (!oldest || !oldest.image_id)
            return deleted;
        const del = await deleteMarkdownImage(target, String(oldest.image_id));
        if (!del.ok)
            return deleted;
        deleted += 1;
    }
    return deleted;
}
/** 取文件名（不含目录），用作 alt —— 实测 alt 用纯文件名时 QQ 才稳定渲染 */
function baseName(p) {
    const parts = p.split(/[\/]/);
    const last = parts.length ? parts[parts.length - 1] : '';
    return (last || 'image').trim() || 'image';
}
/**
 * 扫描文本里的 markdown 图片；本地路径的替换成 QQ 引用。
 * @param explicitTarget 调用方自己的句柄（优先）；不传则用全局 factory
 */
export async function rewriteLocalMarkdownImages(text, explicitTarget) {
    if (!text || text.indexOf('![') < 0)
        return text;
    const target = explicitTarget ?? targetFactory?.();
    if (!target) {
        diag('no target（没有可用的 groupAdmin 句柄）');
        setLast({ matched: 0, converted: 0, failed: 0, at: Date.now() });
        return text;
    }
    const matches = [];
    IMG_RE.lastIndex = 0;
    let m;
    while ((m = IMG_RE.exec(text)) !== null) {
        const alt = String(m[1] ?? '');
        const src = String(m[2] ?? '').trim();
        if (isLocalImagePath(src))
            matches.push({ raw: m[0], alt, src });
    }
    if (matches.length === 0) {
        // 文本里本来就是 http(s)/qqbot-media 的图 —— 正常情况，不报错
        diag('no local image（全是远程/引用图，跳过）');
        setLast({ matched: 0, converted: 0, failed: 0, at: Date.now() });
        return text;
    }
    diag('matched ' + matches.length + ' local image(s): ' + matches.map((x) => x.src).join(' | '));
    await ensureQuota(target, matches.length);
    let out = text;
    let converted = 0;
    let failed = 0;
    for (const item of matches) {
        const path = /^file:\/\//i.test(item.src) ? fromFileUrl(item.src) : item.src;
        try {
            const up = await uploadMarkdownImage(target, path);
            if (!up.ok || !up.url) {
                diag('upload fail: ' + path + ' -> ' + String(up.msg || ''));
                failed += 1;
                continue;
            }
            diag('uploaded: ' + path + ' -> ' + String(up.url).slice(0, 60));
            const dim = up.width && up.height ? ' #' + up.width + 'px #' + up.height + 'px' : '';
            // 2026-10-22（主人口径）：源写法就是 ![说明 #宽px #高px](本地路径) ——
            //   转换后**保留原说明**（剥掉里面的 #Wpx #Hpx），再拼上真实解析出的尺寸。
            const srcAlt = String(item.alt || '').replace(/#s*d+s*px/gi, '').trim();
            const alt = srcAlt || baseName(path);
            const imgSrc = String(up.previewUrl || up.url);
            out = out.split(item.raw).join('![' + alt + dim + '](' + imgSrc + ')');
            converted += 1;
        }
        catch { /* 单张失败不影响其它 */ }
    }
    setLast({ matched: matches.length, converted, failed, at: Date.now() });
    return out;
}
// 暴露给扩展工具（send_md 等）做"先重写、再决定发不发"
try {
    globalThis[Symbol.for('im-qqbot.md-media.rewrite')] =
        (text, target) => rewriteLocalMarkdownImages(text, target);
}
catch { /* ignore */ }
//# sourceMappingURL=md-media-rewrite.js.map