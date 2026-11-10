/**
 * ac-image-see.mjs — 进来一张图，先替她看一眼。
 *
 * 她跑的是纯文本模型：宿主把图片放进 ctx.message.attachments 之后，模型侧只看到字面量 `[图片]`。
 * 这个 hook 在送模型之前补一句人话描述（本机 ollama qwen2.5vl:3b，约 10s/张，按图 sha1 缓存 30 天）。
 *
 * 开关（memory-config.json，可选，缺省即启用）：
 *   "vision": { "enabled": true, "model": "qwen2.5vl:3b", "maxPerMin": 3, "timeoutMs": 90000 }
 * 关闭：enabled 写 false。
 *
 * 为什么限流：视觉推理是 10s 级的重活，群里连发九张图会把队列堵住；
 *   所以每 scope 每分钟最多 maxPerMin 张，超出的这一轮就当没看见（不报错、不排队）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataRootOf } from '../lib/local-llm.mjs';
import { describeImage, imageRefsOf } from '../lib/vision.mjs';

export const name = 'ac-image-see';

const FALLBACK = { enabled: true, model: 'qwen2.5vl:3b', maxPerMin: 3, timeoutMs: 90000 };
// 只有“图片”占位才提示没看清；表情包由入站归一成一句人话，不需要看图
const IMG_PLACEHOLDER_RE = /(对方发来一张图片|\[图片\]|\[image\])/i;

function readCfg(root) {
  try {
    const p = join(String(root || '.'), '.qqbot-extensions', 'memory-config.json');
    if (!existsSync(p)) return FALLBACK;
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    const v = j?.vision || {};
    return {
      enabled: v.enabled !== false,
      model: String(v.model || FALLBACK.model),
      maxPerMin: Math.max(1, Math.min(6, Number(v.maxPerMin) || FALLBACK.maxPerMin)),
      timeoutMs: Math.max(10000, Number(v.timeoutMs) || FALLBACK.timeoutMs),
    };
  } catch { return FALLBACK; }
}

/** scope → 最近一分钟内的推理时间戳（进程内足够：限流只为挡突发，不必持久化） */
const _usage = new Map();

function allowScope(scope, maxPerMin, now = Date.now()) {
  const arr = (_usage.get(scope) || []).filter((t) => now - t < 60000);
  if (arr.length >= maxPerMin) { _usage.set(scope, arr); return false; }
  arr.push(now);
  _usage.set(scope, arr);
  return true;
}

/** 与 aa-memory-recall 完全一致的 scope 口径 */
function scopeOf(ctx) {
  const m = ctx?.message || {};
  if (m.groupOpenid) return 'group:' + m.groupOpenid;
  if (m.senderId) return 'c2c:' + m.senderId;
  return 'default';
}

export async function onInbound(ctx, next) {
  try {
    const root = dataRootOf(ctx?.config || ctx?.cfg || {});
    const cfg = readCfg(root);
    if (!cfg.enabled) return next();

    const refs = imageRefsOf(ctx?.message, 2);
    if (refs.length === 0) {
      // 只有占位、没有实体（微信无 svrid / 宿主没给附件）：明确告诉她“没看清”，别编内容
      if (IMG_PLACEHOLDER_RE.test(String(ctx?.text || '')) && typeof ctx.rewrite === 'function') {
        ctx.rewrite({ text: String(ctx.text || '') + '\n[看见]图片没取到，别编内容，直接说没看清。[/看见]' });
      }
      return next();
    }

    const scope = scopeOf(ctx);
    if (!allowScope(scope, cfg.maxPerMin)) {
      ctx?.logger?.debug?.('[vision] 本轮图片超过限流，跳过');
      return next();
    }

    const seen = [];
    for (const ref of refs) {
      const r = await describeImage(root, ref, { model: cfg.model, timeoutMs: cfg.timeoutMs });
      if (r.ok && r.text) {
        seen.push(r.text);
        ctx?.logger?.info?.(`[vision] 看懂了（${r.cached ? '缓存' : r.ms + 'ms'}）：${r.text.slice(0, 40)}…`);
      } else {
        ctx?.logger?.debug?.(`[vision] 没看成：${r.error}`);
      }
    }
    if (typeof ctx.rewrite === 'function') {
      if (seen.length > 0) {
        const body = seen.length > 1 ? seen.map((t, i) => `${i + 1}. ${t}`).join(' ') : seen[0];
        ctx.rewrite({ text: String(ctx.text || '') + `\n[看见]${body}[/看见]` });
      } else {
        // 有图但一张都没看成（模型忙/超时）：禁止瞎猜
        ctx.rewrite({ text: String(ctx.text || '') + '\n[看见]图没看清，别编内容。[/看见]' });
      }
    }
  } catch (e) {
    ctx?.logger?.debug?.(`[vision] 失败(已忽略): ${e?.message || e}`);
  }
  return next();
}
