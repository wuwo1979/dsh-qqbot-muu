/**
 * game.mjs — 「聊天小游戏」扩展工具（2026-10-25）
 *
 * 参考 QuickQuip（Session 型对战）与 qq-agent-plus（轻量小游戏直接玩 + 状态机主持）的
 * 设计：**规则裁决全部本地完成（零 LLM），AI 只负责把 ≤3 行的结果用人设口吻转达**。
 * 状态落盘（tools/lib/game-lib.mjs），上下文零负担；每群同时一局，15 分钟没动静自动收摊。
 *
 * 用法（AI 侧）：
 *   game {action:'start', kind:'guess'}                  → 开局（返回开场白，转达即可）
 *   game {action:'move',  text:'87'}                     → 有人出招，裁决并返回结果
 *   game {action:'status'}                               → 看本群进行中的对局
 *   game {action:'end'}                                  → 收摊结算
 *   game {action:'list'}                                 → 所有群活跃对局（管理用）
 *   game {action:'truth', mode:'truth'|'dare'}           → 真心话/大冒险抽题（无状态）
 *   game {action:'roll',  sides:6}                       → 掷骰子（无状态）
 *
 * kinds: guess(猜数字) / bomb(数字炸弹) / idiom(成语接龙) / bj(21点) / rps(石头剪刀布)
 *
 * 入站联动：inbound/game-inbound.mjs 会把群友的「游戏动作消息」改写成
 *   `[游戏:<kind>] <原文>` 并强制唤醒 —— AI 收到后调本工具 move 裁决即可。
 *   「结束游戏 / 游戏状态 / 不玩了」等口令也会被接进来。
 */

import {
  engineOf, gameTitle, gameKinds, activeOf, endSession, listSessions, killSession,
  spinTruth, rollDice, startSession, finishSession, applyMove, loadStore, saveStore,
  IDLE_MINUTES, idiomCount,
} from './lib/game-lib.mjs';

const TOOL = 'game';
const KINDS_TIP = 'guess=猜数字 / bomb=数字炸弹 / idiom=成语接龙 / bj=21点 / rps=石头剪刀布 / soup=海龟汤 / story=故事接龙 / quiz=你问我答（后三种会临时叫醒本地模型，玩完自动放显存）';

/** 群/私聊会话键（与 game-inbound.mjs 同源） */
function chatKeyOf(env) {
  const caps = env?.caps || {};
  const scope = String(caps.scope || env?.scope || 'group');
  const peerId = String(caps.peerId || '');
  return { scope, peerId, key: `${scope}:${peerId}` };
}
function dataRootOf(env) {
  return String(env?.dataRoot || env?.caps?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || '');
}

export default {
  name: TOOL,
  description: `聊天小游戏陪玩（状态本地保存、每群一局、15分钟无动静自动结束）。${KINDS_TIP}；另有 truth(真心话/大冒险抽题)、roll(骰子)。有人出招时（消息带 [游戏:xxx] 标签）调 move 裁决，把返回的 msg 用你的口吻转达即可，不要自己改游戏规则。`,
  inputSchema: {
    action: { type: 'string', required: true, description: 'start=开局 / move=出招裁决 / status=看对局 / end=收摊 / list=所有群对局 / truth=真心话大冒险 / roll=骰子' },
    kind: { type: 'string', description: 'start 必填：guess / bomb / idiom / bj / rps' },
    text: { type: 'string', description: 'move 必填：对方出的招（猜的数/成语/要牌/石头剪刀布等）' },
    who: { type: 'string', description: 'move 可选：出招人的昵称（结算时点名用）' },
    mode: { type: 'string', description: 'truth 可选：truth=真心话 / dare=大冒险 / 不填随机' },
    sides: { type: 'number', description: 'roll 可选：骰子面数，默认 6' },
    range: { type: 'number', description: 'start(guess) 可选：范围上限，默认 100' },
  },

  async run(args, env) {
    const action = String(args?.action ?? '').trim().toLowerCase();
    const dataRoot = dataRootOf(env);
    if (!dataRoot) return { ok: false, msg: '拿不到数据根（env.dataRoot 为空）' };
    const { scope, peerId } = chatKeyOf(env);

    // ── 无状态小游戏 ──
    if (action === 'truth') {
      const mode = String(args?.mode || '').toLowerCase();
      const r = spinTruth(mode === 'dare' || mode === '大冒险' ? 'dare' : mode === 'truth' ? 'truth' : undefined);
      return { ok: true, msg: `【${r.mode}】${r.text}` };
    }
    if (action === 'roll') {
      const r = rollDice(args?.sides);
      return { ok: true, msg: `🎲 掷出 ${r.sides} 面骰：**${r.n}**` };
    }

    // ── 管理动作（不需要会话） ──
    if (action === 'list') {
      const all = listSessions(dataRoot);
      if (!all.length) return { ok: true, msg: '现在没有任何进行中的对局。' };
      return {
        ok: true,
        msg: all.map((s) => `${s.id} · ${s.key} · ${gameTitle(s.kind)} · 空闲 ${s.idleMin} 分钟${s.score != null ? ` · 比分 ${s.score}` : ''}`).join('\n'),
        data: { sessions: all },
      };
    }

    // ── 开局 ──
    if (action === 'start') {
      const kind = String(args?.kind || '').trim().toLowerCase();
      if (!engineOf(kind)) return { ok: false, msg: `不认识这个游戏：${kind}。可选：${KINDS_TIP}（或 truth / roll）` };
      const started = await startSession(dataRoot, scope, peerId, kind, {
        args,
        startedBy: String(args?.who || ''),
      });
      if (!started) return { ok: false, msg: `开局失败：${kind}` };
      return {
        ok: true,
        msg: `【${started.title}】开局（${started.id}）\n${started.intro}\n（群里直接出招即可${started.needsLlm ? '；这局要用本地小模型，我已经把它叫醒了，玩完会放掉显存' : '，本地裁决零 token'}；结束喊「结束游戏」；${IDLE_MINUTES} 分钟没动静自动收摊）`,
        data: { id: started.id, kind, needsLlm: !!started.needsLlm },
      };
    }

    // ── 其余动作需要有会话 ──
    const s = activeOf(dataRoot, scope, peerId);
    if (action === 'status') {
      if (!s) return { ok: true, msg: `本群没有进行中的对局（想玩就说「玩${gameKinds().map(gameTitle).join('」「玩')}」其中之一）。` };
      const eng = engineOf(s.kind);
      return { ok: true, msg: `进行中：${gameTitle(s.kind)}（${s.id}）。\n${eng?.title === '猜数字' ? `范围 ${s.state.lo}~${s.state.hi}` : eng?.title === '数字炸弹' ? `范围 ${s.state.lo}~${s.state.hi}` : eng?.title === '成语接龙' ? `上一手：${s.state.last}` : eng?.title === '21点' ? `你的牌：${s.state.player.join(' ')}` : `比分 你${s.state.you}:${s.state.me}我`}` };
    }
    if (action === 'end') {
      const fin = await finishSession(dataRoot, scope, peerId, '手动');
      if (!fin) return { ok: true, msg: '本来就没有对局，收什么摊～' };
      return { ok: true, msg: `好，「${fin.title}」（${fin.id}）收摊了。想再玩随时喊我。` };
    }
    if (action === 'move') {
      if (!s) return { ok: false, msg: '本群没有进行中的对局（这条 move 忽略即可，或问问对方想玩什么）。' };
      const text = String(args?.text ?? '').trim();
      if (!text) return { ok: false, msg: 'move 缺 text' };
      const who = String(args?.who || '').trim();
      const r = await applyMove(dataRoot, scope, peerId, text, who);
      if (!r.handled) return { ok: false, msg: '这句不像是游戏里的出招，忽略即可。' };
      return {
        ok: true,
        done: !!r.done,
        win: !!r.win,
        msg: r.reply + (r.done ? '\n（这局结束了。想再来一局就喊「玩' + gameTitle(r.kind || s.kind) + '」）' : ''),
        data: { id: r.id, kind: r.kind || s.kind },
      };
    }

    return { ok: false, msg: `不认识的 action：${action}（start/move/status/end/list/truth/roll）。词库：成语接龙 ${idiomCount()} 条。` };
  },
};
