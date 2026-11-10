/**
 * lib/media-file.mjs — 图片/表情发送前的统一校验
 *
 * QQ 与微信两侧的发图接口最终都吃「本地绝对路径」。微信侧刚修过的发送链路
 * 也是先校验路径再交给桥接，所以把规则收在这里，避免两边各写一套：
 *   · 必须是存在的普通文件；
 *   · 扩展名只允许 jpg/jpeg/png/gif/webp；
 *   · 默认上限 10MB（QQ/微信的图片消息都对超大文件不友好）；
 *   · 给了 allowedRoots 时，路径必须落在表情库等白名单目录内。
 * 只做校验，不发图、不依赖任何平台 SDK。
 */
import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function validateImageFile(inputPath, { allowedRoots = [], maxBytes = MAX_IMAGE_BYTES } = {}) {
  const p = String(inputPath || '').trim();
  if (!p) return { ok: false, reason: '路径为空' };
  if (!isAbsolute(p)) return { ok: false, reason: '需要绝对路径' };
  if (!existsSync(p)) return { ok: false, reason: '文件不存在', path: p };
  let st;
  try { st = statSync(p); } catch { return { ok: false, reason: '文件不可读', path: p }; }
  if (!st.isFile()) return { ok: false, reason: '不是普通文件', path: p };
  const ext = extname(p).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return { ok: false, reason: `不支持的图片格式：${ext || '(无扩展名)'}`, path: p };
  if (st.size <= 0) return { ok: false, reason: '空文件', path: p };
  if (st.size > maxBytes) return { ok: false, reason: `文件过大：${Math.round(st.size / 1024)}KB`, path: p };
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots]).filter(Boolean);
  if (roots.length) {
    const okRoot = roots.some((r) => {
      const rel = relative(resolve(String(r)), resolve(p));
      return rel && !rel.startsWith('..') && !isAbsolute(rel);
    });
    if (!okRoot) return { ok: false, reason: '路径不在允许的目录内', path: p };
  }
  return { ok: true, path: p, size: st.size, ext };
}

export function mediaMarker(p) {
  return `[MEDIA:image|${String(p || '').replace(/\\/g, '/')}]`;
}

export default { IMAGE_EXT, MAX_IMAGE_BYTES, validateImageFile, mediaMarker };
