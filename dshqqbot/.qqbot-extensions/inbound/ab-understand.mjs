/**
 * ab-understand.mjs — 先判断对方在表达什么，再决定怎么接（只在该判断时注入一句提示）
 *
 * 真机问题（2026-11-07）：群友发“难绷 / 好玩”是在分享、觉得好笑，她当成对自己的评价，
 * 反讽回去，观感很差。根因不是 prompt 不够长，而是上下文里没有“这句话是什么意图”。
 *
 * 做法：本地正则识别五类意图（分享/吐槽/自嘲/求安慰/求评价），命中才追加 ≤22 字的 [听懂] 提示；
 * 不命中就一个字不加（普通聊天零额外 token）。提示块会被 aa / chatlog 的清洗逻辑剥掉，
 * 不会被当成用户原话再次沉淀。
 *
 * 排序：文件名 ab- 排在 aa-memory-recall 之后、ac-image-see 之前：
 *   · 在 aa 之后 → 提示不会进入记忆沉淀的原文；
 *   · 在 ac 之前 → 图片描述追加在最后，不冲突。
 */
import { normalizeTypeTags } from '../lib/placeholder-text.mjs';

export const name = 'ab-understand';

// 2026-11-07 二轮：从“分享/自嘲/难受”扩到五类，覆盖吐槽与求评价。
// 关键：分享/自嘲这两类一律禁止反向嘲讽、反问、抬杠（真机最伤观感的错误）。
const SHARE_RE = /(难绷|绷不住|好玩|好笑|笑死|太好笑|笑不活|离谱|绝了|太强|牛啊|可爱|好看|快看|你看这个|分享|安利|哈哈哈|哈哈|爱了)/;
const MOCK_RE = /(吐槽|无语|吐了|什么鬼|服了|逆天|抽象|下头|气死|恶心|有病|傻逼|脑残|智障)/;
const SELF_DEP_RE = /(我(?:太|好|真|又|怎么这么|是不是)?(?:菜|蠢|笨|废|不行|弱|废物|垃圾)|我是(?:不是)?傻子|我服了我自己)/;
const COMFORT_RE = /(求安慰|抱抱|陪我|安慰我|哄我|开导|鼓励|撑不住|emoji|emo|难受|烦死|好烦|累死|好累|太累|累了|崩溃|委屈|难过|焦虑|生气|想哭|不想活|心累|失眠|压力大)/;
const ASK_EVAL_RE = /(你觉得|你看呢|怎么样|好看吗|好听吗|厉害吗|牛不牛|靠谱吗|要不要|该不该|行不行|给我(?:点|个)?(?:建议|评价)|我这样)/;

const HINTS = {
  share: '他在分享，先共鸣；别反讽、别抬杠。',
  mock: '他在吐槽，顺着骂两句；别教育他。',
  selfDep: '他在自嘲，别接成评价你；别补刀。',
  comfort: '他在难受，先陪着；别建议、别发图。',
  askEval: '他在问你看法，先给态度再给理由。',
  quote: '他在接上一句，顺着说。',
};

/** 去掉已注入块（含上一轮的 [听懂]），只看用户真正说的话 */
export function coreTextOf(ctx) {
  let t = String(ctx?.message?.content ?? ctx?.text ?? '');
  t = t
    .replace(/\n?\[听懂\][\s\S]*?\[\/听懂\]\n?/g, '\n')
    .replace(/\n?\[记忆\][\s\S]*?\[\/记忆\]\n?/g, '\n')
    .replace(/\n?\[设定\][\s\S]*?\[\/设定\]\n?/g, '\n')
    .replace(/\n?\[印象\][\s\S]*?\[\/印象\]\n?/g, '\n')
    .replace(/\n?\[状态\][\s\S]*?\[\/状态\]\n?/g, '\n')
    .replace(/\n?\[看见\][\s\S]*?\[\/看见\]\n?/g, '\n')
    .replace(/\n?\[手边\][^\n]*/g, '\n')
    .replace(/<@[^>]*>/g, '');
  try { t = normalizeTypeTags(t); } catch { /* 忽略 */ }
  return t.replace(/[\s\u3000]+/g, ' ').trim();
}

/** 返回 { kind, hint } 或 null（纯函数，便于测试） */
export function intentOf(ctx) {
  const text = coreTextOf(ctx);
  if (!text) return null;
  // 优先级：自嘲 > 求安慰 > 求评价 > 吐槽 > 分享（越具体的情绪越先判，避免分享盖过求助）
  if (SELF_DEP_RE.test(text)) return { kind: 'selfDep', hint: HINTS.selfDep };
  if (COMFORT_RE.test(text)) return { kind: 'comfort', hint: HINTS.comfort };
  if (ASK_EVAL_RE.test(text)) return { kind: 'askEval', hint: HINTS.askEval };
  if (MOCK_RE.test(text)) return { kind: 'mock', hint: HINTS.mock };
  if (SHARE_RE.test(text)) return { kind: 'share', hint: HINTS.share };
  let quoted = '';
  try {
    const q = ctx?.state?.quote;
    if (q && typeof q === 'object') quoted = String(q.text || q.content || '');
  } catch { quoted = ''; }
  if (quoted && text.length <= 12) return { kind: 'quote', hint: HINTS.quote };
  return null;
}

/** 同一 scope 同一类提示 3 分钟内不重复注（防止连着几轮刷同一句） */
const _lastHint = new Map();
function scopeOf(ctx) {
  const m = ctx?.message || {};
  return m.groupOpenid ? 'group:' + m.groupOpenid : (m.senderId ? 'c2c:' + m.senderId : 'default');
}

export async function onInbound(ctx, next) {
  try {
    const hit = intentOf(ctx);
    if (hit && typeof ctx.rewrite === 'function') {
      const scope = scopeOf(ctx);
      const prev = _lastHint.get(scope);
      const now = Date.now();
      if (!(prev && prev.kind === hit.kind && now - prev.ts < 3 * 60 * 1000)) {
        _lastHint.set(scope, { kind: hit.kind, ts: now });
        const base = String(ctx?.text == null ? '' : ctx.text);
        ctx.rewrite({ text: `${base}\n[听懂]${hit.hint}[/听懂]` });
      }
    }
  } catch (e) {
    ctx?.logger?.debug?.(`[understand] 失败(已忽略): ${e?.message || e}`);
  }
  return next();
}
