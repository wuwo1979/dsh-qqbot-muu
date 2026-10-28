/**
 * outbound/ac-media-fix.mjs — 出站媒体兜底：把「像图但没写成图」的东西修成真图
 *
 * 真机现场（2026-10-23，群 29CE…）：
 *   她先说「热场的来了」，然后发了空文本，再吐出裸文件名
 *   c36d2851221a.jpg / 0077253deef5.png —— 文件其实都在表情库里，
 *   只是没包成插件认识的 [MEDIA:image|<绝对路径>]。
 *
 * 本扩展只做三件事：
 *   1) MEDIA:image|xxx 漏写方括号 → 补成 [MEDIA:image|xxx]
 *   2) [[MEDIA:…]] 双层 → 单层
 *   3) 正文里的裸表情文件名（id.ext）→ 解析成绝对路径的 [MEDIA:image|…]
 *      解析不到就删掉这段，绝不把文件名当文字发给群友。
 *
 * 排序：文件名 ac- 开头，排在 aa-sanitize 之后、ab-brain 之前。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToken, loadIndex } from '../lib/sticker-resolve.mjs';

export const name = 'media-fix';

const HERE = dirname(fileURLToPath(import.meta.url));

function dataRootOf(ctx) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  if (ctx && typeof ctx.dataRoot === 'string' && ctx.dataRoot) return ctx.dataRoot;
  return dirname(dirname(HERE));
}

const BARE_MEDIA = /(?<!\[)\bMEDIA:(image|record|video|file)\|([^\]\s]+)/gi;
const DOUBLE = /\[\[(MEDIA:[^\]]+)\]\]/gi;
const BARE_FILE = /(?<![\w./\\-])([0-9a-fA-F]{8,16})\.(jpe?g|png|gif|webp)(?![\w./\\-])/g;

function log(root, rec) {
  try {
    const dir = join(root, '.qqbot');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'media-fix-log.jsonl'), JSON.stringify({ ts: Date.now(), ...rec }) + '\n', 'utf8');
  } catch { /* 日志失败不影响发消息 */ }
}

/**
 * @param {string} text
 * @param {string} root
 * @returns {{text:string, fixed:number, dropped:number}}
 */
export function fixMedia(text, root) {
  let t = String(text == null ? '' : text);
  let fixed = 0;
  let dropped = 0;

  t = t.replace(DOUBLE, (m, inner) => { fixed += 1; return '[' + inner + ']'; });
  t = t.replace(BARE_MEDIA, (m, kind, target) => { fixed += 1; return `[MEDIA:${kind}|${target}]`; });

  // 裸文件名 → 查表情库（引号/括号包着也认）
  t = t.replace(BARE_FILE, (m, id, ext) => {
    const hit = resolveToken(root, `${id}.${ext}`);
    if (hit.ok && hit.path) {
      fixed += 1;
      return `[MEDIA:image|${hit.path.replace(/\\/g, '/')}]`;
    }
    dropped += 1;
    return '';
  });

  // 修完后如果只剩标点和空白，说明这条消息只有一张解析失败的图
  t = t.replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|\n)[，。！？、,.!?\s]+(?=\n|$)/g, '$1')
    .trim();

  return { text: t, fixed, dropped };
}

export async function onOutbound(ctx, next) {
  if (!ctx || ctx.phase !== 'send' || ctx.kind !== 'text') return next();
  const before = String(ctx.text || '');
  if (!before) return next();
  if (!/MEDIA:|[0-9a-fA-F]{8,16}\.(jpe?g|png|gif|webp)/i.test(before)) return next();

  try {
    const root = dataRootOf(ctx);
    loadIndex(root); // 预热（mtime 缓存，极便宜）
    const r = fixMedia(before, root);
    if (r.text !== before) {
      try { ctx.rewrite(r.text); } catch { /* ignore */ }
      try { ctx.note && ctx.note(`media-fix: 修复 ${r.fixed} 张，丢弃 ${r.dropped} 个无效文件名`); } catch { /* ignore */ }
      if (r.dropped > 0) log(root, { scope: ctx?.target?.scope || '', fixed: r.fixed, dropped: r.dropped, before: before.slice(0, 300) });
    }
  } catch { /* 任何异常都不能挡住发消息 */ }

  return next();
}

export default onOutbound;
