/**
 * turn-memory.mjs — 回合结束把"她自己说过的话"沉淀进记忆库
 *
 * 为什么需要：现在的记忆只有"别人说了什么"（入站沉淀）。
 * 结果她记不得自己答应过什么、说过什么梗 —— 而 Neuro 那种"像个人"的关键之一，
 * 就是**记得自己说过的话**（"你上次说教我钓鱼的"）。
 *
 * 挂点：第六套（出站）。出站链每回合会多跑一次 `phase === 'turnEnd'` 的收尾，
 *       正好当"回合结束"信号用，不需要插件再暴露新钩子。
 *
 * 省钱/防污染：
 *   · 只记 ≥ 12 字的正文（太短没信息量）；
 *   · 纯媒体/纯表情不记；
 *   · 含"答应/保证/下次/回头"这类承诺词的标成 promise，召回声量（hits 权重）用得上；
 *   · 去重交给记忆库（cos > 0.92 视为同一条）。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export const name = 'turn-memory';

const HERE = dirname(fileURLToPath(import.meta.url));

function dataRootOf(ctx) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  if (ctx && typeof ctx.dataRoot === 'string' && ctx.dataRoot) return ctx.dataRoot;
  return dirname(dirname(HERE)); // .../{dataRoot}/.qqbot-extensions/outbound/
}

function plainReply(text) {
  return String(text || '')
    .replace(/\[rf:[^\]]*\]/gi, '')
    .replace(/\[MEDIA:[^\]]*\]/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<@[^>]*>/g, '')
    .replace(/<qqbot-at-everyone\s*\/?>/gi, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 承诺/约定类：以后能被"你答应过我什么"召回 */
const PROMISE_RE = /(答应|保证|说好|下次|回头|以后|会给你|带你去|讲给你|教你|带你|给你)/;

/** 目标 → 记忆作用域（与 inbound/memory-recall.mjs 的 scopeOf 保持同一套命名） */
function scopeOfTarget(target) {
  if (!target) return '';
  // ⚠️ 真机 outbound ctx 给的是 { scope, targetId }（outbound-buffer 发送用的也是 targetId），
  //    peerId 只存在于旧文档/测试桩里 —— 两个都认，否则永远拼不出 scope、整条链静默跳过。
  const peer = String(target.peerId || target.targetId || '');
  if (!peer) return '';
  const kind = String(target.scope || '');
  if (kind === 'c2c' || kind === 'user' || kind === 'private') return 'c2c:' + peer;
  return 'group:' + peer;
}

function worthKeeping(text) {
  const t = String(text || '').trim();
  if (t.length < 12) return false;
  if (/^\[(图片|语音|视频|表情|文件)/.test(t)) return false;
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return false;
  return true;
}

export async function onOutbound(ctx, next) {
  // 只在回合收尾那一次动手，正文块照常放行
  if (ctx?.phase !== 'turnEnd') return next();

  let mem;
  try {
    mem = await import('../lib/memory.mjs');
  } catch {
    return next();
  }

  try {
    const cfg = mem.loadConfig(dataRootOf(ctx));
    if (cfg.enabled === false || cfg.captureSelf === false) return next();

    const text = plainReply(ctx?.text);
    if (!worthKeeping(text)) return next();

    const scope = scopeOfTarget(ctx?.target);
    if (!scope) return next();

    const kind = PROMISE_RE.test(text) ? 'promise' : 'say';
    const r = await mem.remember(dataRootOf(ctx), scope, {
      text: text.slice(0, 200),
      kind,
      subj: '小蓝',
    }, cfg);
    if (r && r.ok) {
      ctx?.logger?.debug?.(`[turn-memory] 记住自己说的(${kind})：${text.slice(0, 24)}`);
    }
  } catch (e) {
    ctx?.logger?.debug?.(`[turn-memory] 跳过(${e instanceof Error ? e.message : String(e)})`);
  }
  return next();
}
