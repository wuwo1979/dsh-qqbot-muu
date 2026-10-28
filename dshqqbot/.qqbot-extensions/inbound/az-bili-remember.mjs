/**
 * inbound/az-bili-remember.mjs — 谁来群里丢了个 B 站视频，就记住是哪个（问题 C）
 *
 * 背景（主人 2026-10-26）：
 *   QQ 群分享 B 站视频时，到达的是 `ark` / `json` 卡片消息，正文通常只剩「【bilibili】标题」，
 *   播放页链接**不一定**出现在可见文本里。于是模型不知道"刚才那个视频"是哪个，
 *   也核对不了标题（问题 B 的另一半）。
 *
 * 这里在**早挂点**（记群历史之前）把能看到的都扫一遍：
 *   ① ctx.text（可见正文，卡片常常带 b23.tv 短链或完整 url）
 *   ② ctx.message 的整段 JSON（ark/json 卡片里的 jumpUrl 之类藏在里面）
 * 抽 BV 号 / av 号 / b23.tv 短链 / 播放页链接，写进
 *   `{dataRoot}/.qqbot/bili-last-video.json`（格式见 lib/bili-api.mjs 的 LAST_VIDEO_FILE 注释）。
 * 之后 `bili` 工具的 `last` / `comment` / `share` 不给 bvid 都会用它。
 *
 * 三条纪律：
 *   · **绝不阻断聊天**：整体 try/catch，永远 await next()。
 *   · **不拖慢入站链**：BV 号在正文里就同步写盘；b23 短链 / av 号要联网，改成后台解析（不 await）。
 *   · **只记不动手**：这个 hook 不发消息、不评论，纯记账。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as B from '../lib/bili-api.mjs';

export const name = 'az-bili-remember';

const DATA_ROOT_FALLBACK = 'F:/qqbot/dshqqbot';

function dataRootOf(ctx) {
  const fromCtx = String((ctx && ctx.dataRoot) || '').trim();
  if (fromCtx) return fromCtx;
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  try {
    const cfg = JSON.parse(readFileSync(join(DATA_ROOT_FALLBACK, 'memory-config.json'), 'utf8'));
    return cfg.dataRoot || DATA_ROOT_FALLBACK;
  } catch { return DATA_ROOT_FALLBACK; }
}

/** 把这条消息里所有能扫的东西拼成一坨（限长，别把大 JSON 整个正则） */
function haystackOf(ctx) {
  const parts = [];
  const text = String((ctx && ctx.text) || '');
  if (text) parts.push(text);
  try {
    const msg = ctx && ctx.message;
    if (msg) {
      // 卡片（ark/json）里的内容只在原始报文里，可见正文常常只有标题
      const raw = JSON.stringify(msg);
      if (raw && raw.length < 40000) parts.push(raw);
      else if (raw) parts.push(raw.slice(0, 40000));
    }
  } catch { /* ignore */ }
  return parts.join('\n');
}

function sameBvid(root, bvid) {
  try {
    const prev = B.readLastVideo(root);
    return !!prev && prev.bvid === bvid;
  } catch { return false; }
}

/** 后台补齐标题/aid（不 await，失败就留个只有 bvid 的账） */
function enrich(root, bvid, by, source) {
  B.video(root, { bvid })
    .then((v) => {
      if (!v.ok) return;
      // 别把用户刚分享的别的视频盖掉
      if (!sameBvid(root, bvid)) return;
      B.writeLastVideo(root, {
        bvid: v.video.bvid,
        aid: v.video.aid,
        title: v.video.title,
        url: v.video.url,
        by,
        source,
      });
    })
    .catch(() => { /* ignore */ });
}

function remember(root, { bvid, by, source }) {
  if (!bvid) return;
  if (sameBvid(root, bvid)) {
    B.writeLastVideo(root, { bvid, by, source }); // 只是刷新 at / by
    return;
  }
  B.writeLastVideo(root, { bvid, by, source });
  enrich(root, bvid, by, source);
}

export async function onInbound(ctx, next) {
  try {
    const root = dataRootOf(ctx);
    const hay = haystackOf(ctx);
    if (hay && /b23\.tv|bilibili\.com|BV[0-9A-Za-z]{10}|\bav\d{3,}\b/i.test(hay)) {
      const ref = B.extractVideoRef(hay);
      if (ref && ref.bvid) {
        // 最常见的情况：正文里就有 BV 号 —— 同步记，零延迟
        remember(root, { bvid: ref.bvid, by: String((ctx && ctx.senderName) || (ctx && ctx.sender) || ''), source: 'inbound-text' });
      } else if (ref && (ref.short || ref.avid)) {
        // 短链 / av 号要联网：后台解析，绝不拖慢这条消息
        const by = String((ctx && ctx.senderName) || (ctx && ctx.sender) || '');
        const source = ref.short ? 'inbound-card' : 'inbound-text';
        B.resolveVideoRef(root, ref)
          .then((rv) => { if (rv.ok && rv.bvid) remember(root, { bvid: rv.bvid, by, source }); })
          .catch(() => { /* ignore */ });
      }
    }
  } catch { /* 永不阻断聊天 */ }
  await next();
}

export default { name, onInbound };
