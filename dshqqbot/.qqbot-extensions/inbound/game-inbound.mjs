/**
 * game-inbound.mjs — 小游戏入站中间件（2026-10-25）
 *
 * 挂点：早挂点 onInbound。链路顺序（按文件名升序）：game-inbound → local-answer → memory-recall → router-observe
 *
 * 目标（主人定的）：聊天里陪玩小游戏，**规则裁决零 token**——
 *   · 群友说「玩成语接龙」等口令 → 本地开局，直接把开场白发回群里（annihilate + caps.text），
 *     云端 LLM 根本不参与；
 *   · 对局中群友的「出招消息」（猜的数/成语/要牌/石头剪刀布…）→ 本地裁决、直接回结果；
 *   · 「结束游戏 / 游戏状态」同理本地处理；
 *   · 其余消息一律 next() 放行，行为与装之前完全一致（**绝不劫持正常聊天**）。
 *
 * AI 侧入口（tools/game.mjs）保留：主人用自然语言让她开局/收摊/看对局时走工具，
 * 会话文件与这里同源（tools/data/game-sessions.json），两条路随时混用。
 *
 * 安全阀（照抄 local-answer 的纪律）：
 *   · 限流：同一会话两次本地游戏回复至少隔 800ms，每分钟最多 8 条（防刷屏 + 防熔断）；
 *   · annihilate 带 ownerAck:true（与 local-answer 同款；引擎本身也会保护主人）；
 *   · 任何异常都 next() 放行，绝不让游戏拖垮消息链。
 */

import {
  applyMove, startSession, finishSession, activeOf, spinTruth, rollDice,
  gameKinds, gameTitle, engineOf, IDLE_MINUTES,
} from '../tools/lib/game-lib.mjs';

export const name = 'game-inbound';

// ── 口令表 ────────────────────────────────────────────────────────────
const KIND_ALIAS = {
  '猜数字': 'guess', '数字炸弹': 'bomb', '成语接龙': 'idiom', '接龙': 'idiom',
  '21点': 'bj', '二十一': 'bj', '二十一点': 'bj', '黑杰克': 'bj', '21': 'bj',
  '石头剪刀布': 'rps', '猜拳': 'rps',
  // 2026-10-26 新增：要用本地模型的三种（开局会把模型叫醒，收摊就让它离开显存）
  '海龟汤': 'soup', '汤': 'soup',
  '故事接龙': 'story', '写故事': 'story',
  '你问我答': 'quiz', '问答题': 'quiz', '答题': 'quiz',
};
const RE_START = /^玩\s*(猜数字|数字炸弹|成语接龙|接龙|21点|二十一点|二十一|黑杰克|石头剪刀布|猜拳|海龟汤|汤|故事接龙|写故事|你问我答|问答题|答题)/;
const RE_END = /^(结束游戏|游戏结束|不玩了|不玩啦|收摊)[\s!！。~～]*$/;
const RE_STATUS = /^游戏(状态|规则|是啥|呢)[\s?？!！。~～]*$/;
const RE_MENU = /^(玩游戏?|玩啥游戏|有什么游戏|游戏菜单)[\s?？!！。~～]*$/;
const RE_TRUTH = /^(真心话|大冒险)[\s!！。~～]*$/;
const RE_ROLL = /^(掷骰子|骰子|roll)(\s*(\d{1,3}))?[\s!！。~～]*$/;

const MENU_TEXT = [
  '🎮 会玩的小游戏（说「玩xx」就能开局）：',
  '　· 猜数字 —— 1~100，7 次机会',
  '　· 数字炸弹 —— 轮流报数缩范围，谁踩雷谁爆炸',
  '　· 成语接龙 —— 我出题你接，接不上算输',
  '　· 21点 —— 跟我斗庄，「要牌/停牌」',
  '　· 石头剪刀布 —— 三局两胜',
  '　🐋 海龟汤 —— 我出谜，你问，我只答「是/不是/无关」，喊「揭晓」看汤底',
  '　🐋 故事接龙 —— 我开头，你写「接：你的句子」，我顺着往下写',
  '　🐋 你问我答 —— 三题冷知识，回「答：xxx」，可「跳过」',
  '　· 还有「真心话/大冒险」抽题、「掷骰子」',
  `（一局里直接在群里出招就行，不用@我；${IDLE_MINUTES} 分钟没动静自动收摊。海龟汤/故事接龙/问我答会临时叫醒本地小模型，玩完自动放掉显存）`,
].join('\n');

// ── 限流（进程内；重启清零没关系，只是软限流） ────────────────────────
const _lastReplyAt = new Map();   // key -> ts
const _minPerKey = [];            // [{key, ts}] 环形窗口
let _winStart = 0;
function rateOk(key, now) {
  const last = _lastReplyAt.get(key) || 0;
  if (now - last < 800) return false;
  // 每分钟 8 条
  if (now - _winStart >= 60_000) { _winStart = now; _minPerKey.length = 0; }
  const n = _minPerKey.filter((x) => x.key === key).length;
  if (n >= 8) return false;
  _lastReplyAt.set(key, now);
  _minPerKey.push({ key, ts: now });
  return true;
}

/** 会话键：与工具侧 env.caps.scope/peerId 同源（ext-inbound-context.js:614-652 / 701-702） */
function chatOf(ctx) {
  const scope = String(ctx.scope || 'group');
  const peerId = scope === 'group' ? String(ctx.groupId || '') : String(ctx.sender || ctx.groupId || '');
  return { scope, peerId, key: `${scope}:${peerId}` };
}
function dataRootOf(ctx) {
  return String(ctx?.dataRoot || ctx?.caps?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || '');
}

async function localReply(ctx, text, why) {
  const sent = await ctx?.caps?.text?.(text);
  if (sent !== false) {
    try { ctx.annihilate({ reason: why, ownerAck: true }); } catch { /* 放行也无妨 */ }
    return true;
  }
  return false; // 发送能力缺失 → 放行走正常链路（AI 能兜住）
}

export async function onInbound(ctx, next) {
  try {
    const text = String(ctx.text || '').trim();
    if (!text) return next();
    const { scope, peerId, key } = chatOf(ctx);
    const dataRoot = dataRootOf(ctx);
    if (!dataRoot || !peerId) return next();
    const now = Date.now();

    // ── 1. 出招裁决（有对局且消息长得像招）——最高优先 ──
    const move = await applyMove(dataRoot, scope, peerId, text, ctx.senderName || '');
    if (move.handled) {
      if (!rateOk(key, now)) return next();   // 限流兜底：宁可让 AI 看见也别刷屏
      const ok = await localReply(ctx, move.reply, `游戏:${move.kind}`);
      if (ok) return;                          // 消灭成功，链到此为止（零 token）
      return next();                           // 发送失败 → 放行让 AI 兜
    }

    // ── 2. 口令 ──
    const mEnd = text.match(RE_END);
    if (mEnd) {
      const s = activeOf(dataRoot, scope, peerId);
      if (s && rateOk(key, now)) {
        const fin = await finishSession(dataRoot, scope, peerId, '口令');
        if (fin && await localReply(ctx, `好，「${fin.title}」（${fin.id}）收摊了。想再玩随时喊我～`, '游戏:end')) return;
      }
      return next();
    }
    const mStart = text.match(RE_START);
    if (mStart) {
      const kind = KIND_ALIAS[mStart[1]] || mStart[1];
      const eng = engineOf(kind);
      if (eng && rateOk(key, now)) {
        const started = await startSession(dataRoot, scope, peerId, kind, {
          startedBy: String(ctx.senderName || ''), startedByOpenid: String(ctx.sender || ''),
        });
        if (started && await localReply(ctx, `【${started.title}】开局（${started.id}）\n${started.intro}`, `游戏:start:${kind}`)) return;
      }
      return next();
    }
    if (RE_MENU.test(text)) {
      if (rateOk(key, now) && await localReply(ctx, MENU_TEXT, '游戏:menu')) return;
      return next();
    }
    if (RE_STATUS.test(text)) {
      const s = activeOf(dataRoot, scope, peerId);
      if (s && rateOk(key, now)) {
        const lines = [`进行中：「${gameTitle(s.kind)}」（${s.id}），开局于 ${new Date(s.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}。`];
        if (Array.isArray(s.log) && s.log.length) lines.push('最近几手：' + s.log.slice(-3).map((l) => `${l.who || '?'}→${l.move}`).join('；'));
        if (await localReply(ctx, lines.join('\n'), '游戏:status')) return;
      }
      return next();
    }
    const mTruth = text.match(RE_TRUTH);
    if (mTruth) {
      if (rateOk(key, now)) {
        const r = spinTruth(mTruth[1] === '大冒险' ? 'dare' : 'truth');
        if (await localReply(ctx, `【${r.mode}】${r.text}`, '游戏:truth')) return;
      }
      return next();
    }
    const mRoll = text.match(RE_ROLL);
    if (mRoll) {
      if (rateOk(key, now)) {
        const r = rollDice(mRoll[3]);
        if (await localReply(ctx, `🎲 ${ctx.senderName || '有人'} 掷出 ${r.sides} 面骰：**${r.n}**`, '游戏:roll')) return;
      }
      return next();
    }
  } catch {
    // 游戏的任何异常都不许拖垮消息链
  }
  return next();
}

/** 卸载清理（无资源） */
export async function dispose() { /* noop */ }

/** 测试钩子：清空限流状态（软限流是时间敏感的，测试里连发会被拦） */
export function _testResetRate() {
  _lastReplyAt.clear();
  _minPerKey.length = 0;
  _winStart = 0;
}
