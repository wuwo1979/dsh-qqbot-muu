/**
 * bili-share.mjs — B 站视频「一条卡片」分享 + 本地留档（2026-10-24）
 *
 * 主人口径：
 *   刷视频分享时应该是「链接 + 封面」合在一条卡片里；现在分成「文字链接」和「封面图」
 *   两条消息，既难看又白占 QQ 主动消息额度。
 *
 * 做法：
 *   · 封面先下载到本地（B 站图床有 Referer 防盗链，直接给 QQ 外链容易裂），
 *     交给插件 markdown 的 ![封面](本地路径) 走素材上传，一条 markdown 卡片发出去；
 *   · 卡片发送失败才降级成一条纯文本（标题 + 链接），仍然只占一条消息；
 *   · 每次分享都追加 `.qqbot/bili-shares.jsonl`，浮窗「记忆」页可回看，
 *     就算当时没发出去也留了档。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fetchImage } from './bili-api.mjs';

export function shareLogPath(dataRoot) {
  return join(String(dataRoot || ''), '.qqbot', 'bili-shares.jsonl');
}

export function coverDir(dataRoot) {
  return join(String(dataRoot || ''), '.qqbot', 'bili-share');
}

function extOfType(type, fallback = '.jpg') {
  const t = String(type || '').toLowerCase();
  if (t.includes('png')) return '.png';
  if (t.includes('webp')) return '.webp';
  if (t.includes('gif')) return '.gif';
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  return fallback;
}

/**
 * 下载封面到本地（已存在且非空就复用）。失败返回 {ok:false}，调用方用外链兜底。
 */
export async function saveCover(dataRoot, bvid, coverUrl) {
  const id = String(bvid || '').replace(/[^\w-]/g, '');
  if (!id || !coverUrl) return { ok: false, path: '', error: '缺少 bvid 或封面地址' };
  const dir = coverDir(dataRoot);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  // 先找已有的同 id 文件（扩展名可能是换过的）
  for (const ext of ['.jpg', '.png', '.webp', '.gif']) {
    const p = join(dir, id + ext);
    try { if (existsSync(p) && statSync(p).size > 1024) return { ok: true, path: p, cached: true }; } catch { /* ignore */ }
  }
  const r = await fetchImage(coverUrl);
  if (!r.ok) return { ok: false, path: '', error: r.error };
  const p = join(dir, id + extOfType(r.type));
  try {
    writeFileSync(p, r.buf);
    return { ok: true, path: p, size: r.size };
  } catch (e) {
    return { ok: false, path: '', error: e instanceof Error ? e.message : String(e) };
  }
}

export function videoUrlOf(bvid) {
  return 'https://www.bilibili.com/video/' + encodeURIComponent(String(bvid || ''));
}

/** 组装一条 markdown 卡片：标题 + 封面 + UP/播放/点赞 + 跳转链接 */
export function buildShareMarkdown(v = {}, coverSrc = '') {
  const lines = ['**' + String(v.title || '(无标题)') + '**'];
  if (coverSrc) lines.push('![封面](' + String(coverSrc).replace(/\\/g, '/') + ')');
  const meta = [];
  if (v.owner) meta.push('UP：' + v.owner);
  if (v.views != null) meta.push('播放 ' + Number(v.views).toLocaleString('zh-CN'));
  if (v.likes != null) meta.push('点赞 ' + Number(v.likes).toLocaleString('zh-CN'));
  if (meta.length) lines.push(meta.join(' · '));
  // 评论后分享：把刚发的那句一起带进卡片（相当于"评论截图"的文字版）
  if (v.comment) lines.push('我的评论：' + String(v.comment).replace(/\s+/g, ' ').slice(0, 200));
  lines.push('[▶ 在 B 站打开](' + videoUrlOf(v.bvid) + ')');
  return lines.join('\n');
}

/** 纯文本兜底（也只要一条消息） */
export function buildShareText(v = {}) {
  return [
    String(v.title || '(无标题)'),
    [v.owner ? 'UP：' + v.owner : '', v.views != null ? '播放 ' + v.views : ''].filter(Boolean).join(' · '),
    videoUrlOf(v.bvid),
  ].filter(Boolean).join('\n');
}

/** caps.peer 的 scope 兼容 'group' / 'group:xxx' 两种写法 */
export function splitPeer(peer = {}) {
  const raw = String(peer.scope || '');
  const m = /^(group|c2c)\s*:?\s*(.*)$/i.exec(raw);
  if (m) return { scope: m[1].toLowerCase(), id: m[2] || String(peer.peerId || '') };
  return { scope: raw === 'c2c' ? 'c2c' : 'group', id: String(peer.peerId || '') };
}

/**
 * 发一条 markdown 卡片。优先走当前会话（被动回复，不占主动额度），
 * 再退到 env.qq 显式目标；都不行就发纯文本。
 * @returns {Promise<{ok:boolean, via:string}>}
 */
export async function sendShareCard(env, md, text, peer = {}) {
  const caps = env?.caps || {};
  if (typeof caps.markdown === 'function') {
    try {
      if (await caps.markdown(md)) return { ok: true, via: 'card' };
    } catch { /* 继续兜底 */ }
  }
  const qq = env?.qq || {};
  const { scope, id } = splitPeer(peer);
  if (id && typeof qq.sendMarkdown === 'function') {
    try {
      if (await qq.sendMarkdown(scope, id, md)) return { ok: true, via: 'card-active' };
    } catch { /* 继续兜底 */ }
  }
  if (typeof caps.text === 'function') {
    try {
      if (await caps.text(text)) return { ok: true, via: 'text' };
    } catch { /* ignore */ }
  }
  if (id && typeof qq.sendText === 'function') {
    try {
      if (await qq.sendText(scope, id, text)) return { ok: true, via: 'text-active' };
    } catch { /* ignore */ }
  }
  return { ok: false, via: '' };
}

/** 留档：一次分享一行 JSON（失败也记，方便浮窗回看/补发） */
export function recordShare(dataRoot, rec = {}) {
  try {
    const p = shareLogPath(dataRoot);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ ts: Date.now(), ...rec }) + '\n', 'utf8');
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 倒序读最近 N 条（坏行跳过，不抛） */
export function readShares(dataRoot, { limit = 20 } = {}) {
  const p = shareLogPath(dataRoot);
  if (!existsSync(p)) return [];
  let text = '';
  try { text = readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < Math.max(1, Number(limit) || 20); i -= 1) {
    const s = lines[i].trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

/** 推一条「评论后顺手分享」需要的视频信息（字段对齐 B.video 的返回） */
export function sharePayloadOf(video = {}, extra = {}) {
  return {
    bvid: String(video.bvid || ''),
    title: String(video.title || ''),
    owner: String(video.owner || ''),
    views: video.views,
    likes: video.likes,
    cover: String(video.cover || ''),
    url: videoUrlOf(video.bvid),
    ...extra,
  };
}

export default { shareLogPath, coverDir, saveCover, videoUrlOf, buildShareMarkdown, buildShareText, sendShareCard, recordShare, readShares, sharePayloadOf };
