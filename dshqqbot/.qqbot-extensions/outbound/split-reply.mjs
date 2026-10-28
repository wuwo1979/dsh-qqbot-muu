/**
 * split-reply.mjs —— 把一整段回复拆成 2~3 条短消息连发（「活人感」最有效的一招）
 *
 * 为什么：
 *   真人聊天不是一个白框里说完三句话，而是「欸」「哈哈哈哈」「你认真的吗」连着发。
 *   QQ 群里一次长回复 vs 两三条短句，观感差别极大 —— 这是 Neuro 系腔调的物理来源。
 *
 * 做法（出站扩展，phase='send'）：
 *   1. 只在**最后一块**文本上动作（isLastChunk !== false），避免把流式片段拆碎；
 *   2. 带媒体/图片/引用/注入块的回复一概不拆（拆了会破坏语法）；
 *   3. 按句末标点切，过长再按逗号切，最多 maxBubbles 条；
 *   4. `ctx.rewrite` 把第一条留作正文，`await next()` 发正文，然后隔 gapMs 用 `ctx.send` 补发余下。
 *
 * 安全：任何异常都只记日志，绝不吞消息（最坏情况就是原样一条发出去）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'split-reply';

const DEFAULTS = {
  enabled: true,
  prob: 0.4,          // 每回合有多大概率连发
  maxBubbles: 3,      // 最多几条（含第一条）
  gapMs: 700,         // 条间隔
  minLen: 12,         // 短于此不拆
  maxLen: 80,         // 长于此不拆（长回答拆开像刷屏）
};

function dataRootOf() {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  try {
    const p = join(process.cwd(), 'dshqqbot', 'alive-config.json');
    if (existsSync(p)) return join(process.cwd(), 'dshqqbot');
  } catch { /* 忽略 */ }
  return 'F:/qqbot/dshqqbot';
}

function loadCfg(root) {
  const cfg = { ...DEFAULTS };
  try {
    const p = join(root, 'alive-config.json');
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) {
        if (raw[k] !== undefined && raw[k] !== null) cfg[k] = raw[k];
      }
    }
  } catch { /* 配置坏了用默认 */ }
  return cfg;
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 不该拆的正文 */
function skipText(t) {
  if (!t) return true;
  if (/\[MEDIA:/.test(t)) return true;
  if (/!\[[^\]]*\]\(/.test(t)) return true;
  if (/\[rf:/.test(t)) return true;
  if (/https?:\/\//.test(t)) return true;
  if (/\[(记忆|设定|别重复)\]/.test(t)) return true;
  return false;
}

const ENDS = '。！？!?…~～';

/** 切成气泡（保留标点） */
export function splitBubbles(text, max = 3) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = [];
  let cur = '';
  for (const ch of t) {
    cur += ch;
    if (ENDS.includes(ch)) { parts.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) parts.push(cur.trim());

  const out = [];
  for (const p of parts) {
    if (p.length > 14) {
      const sub = p.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
      if (sub.length > 1) { out.push(...sub); continue; }
    }
    out.push(p);
  }
  // 把过短的并入上一条（"哈！" 单独发很怪）
  const merged = [];
  for (const s of out) {
    const t2 = s.trim();
    if (!t2) continue;
    if (merged.length && t2.length <= 3 && (merged[merged.length - 1].length + t2.length) <= 24) {
      merged[merged.length - 1] += t2;
    } else merged.push(t2);
  }
  return merged.slice(0, Math.max(1, max));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onOutbound(ctx, next) {
  try {
    if (!ctx || ctx.phase !== 'send') return next();
    if (ctx.kind && ctx.kind !== 'text') return next();
    if (ctx.isLastChunk === false) return next();

    const text = String(ctx.text || '');
    if (skipText(text)) return next();

    const cfg = loadCfg(dataRootOf());
    if (cfg.enabled === false) return next();
    const len = text.trim().length;
    if (len < num(cfg.minLen, 12) || len > num(cfg.maxLen, 80)) return next();
    if (Math.random() >= num(cfg.prob, 0.4)) return next();

    const parts = splitBubbles(text, num(cfg.maxBubbles, 3));
    if (parts.length < 2 || typeof ctx.rewrite !== 'function') return next();

    ctx.rewrite(parts[0]);
    await next();                                   // 先发第一条（正文）

    const gap = Math.max(200, Math.min(4000, num(cfg.gapMs, 700)));
    for (let i = 1; i < parts.length; i += 1) {
      await sleep(gap);
      try {
        if (typeof ctx.send === 'function') await ctx.send(parts[i]);
      } catch (e) {
        ctx?.logger?.debug?.(`[split] 补发失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    ctx?.logger?.debug?.(`[split] 连发 ${parts.length} 条`);
    return;
  } catch (e) {
    ctx?.logger?.debug?.(`[split] 异常(已忽略): ${e instanceof Error ? e.message : String(e)}`);
    return next();
  }
}
