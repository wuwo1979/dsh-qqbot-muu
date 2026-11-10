/**
 * quiz.mjs —— QQ 聊天里的问答题（2026-11-10，v0.1.6 新增）
 *
 * 和 `/面试` 的分工：
 *   · `/面试` 走 interview-core 的**完整场次**（多题、追问、评分、可落盘复盘）；
 *   · `/答题` 只抽**一道**判定式问答题（题库 `quiz` 类，keywords 命中判定，零模型、零落盘）。
 *
 * 为什么零落盘：这类纯练习不需要留痕，答完就散 —— 少存一份你的话，就少一份要保护的隐私。
 *
 * 用法：
 *   /答题        抽一题
 *   /答题 <回答> 判这道题（对/错 + 依据出处 + 标准答案）
 *   /答题 换     换一题
 */
function cn(v) { return v === undefined || v === null ? '' : String(v); }

function dataRootOf(ctx) {
  try {
    const caps = ctx?.caps ?? ctx ?? {};
    const p = caps?.paths ?? {};
    const cand = p.dataRoot ?? caps.dataRoot ?? ctx?.dataRoot ?? '';
    if (cand) return String(cand);
  } catch { /* ignore */ }
  try {
    return decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/[\\/]+$/, '');
  } catch { return ''; }
}

/** 这道正被问的题（按会话存，进程内 + 落盘各一份；落盘只为"两份模块实例"也能对上） */
const PENDING = new Map();

async function pendingFile(root) {
  const { join } = await import('node:path');
  return join(root, '.qqbot', 'quiz-pending.json');
}

async function loadPending(root) {
  try {
    const { readFileSync } = await import('node:fs');
    const j = JSON.parse(readFileSync(await pendingFile(root), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

async function savePending(root, all) {
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const f = await pendingFile(root);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(all, null, 2), 'utf8');
  } catch { /* 存不下也能靠内存 */ }
}

function whoOf(ctx) {
  const mc = ctx?.message ?? {};
  const rt = ctx?.replyTarget ?? {};
  const pe = ctx?.peer ?? {};
  const scope = cn(rt.scope || ctx?.scope || pe.scope || mc.kind || ((mc.groupOpenid || pe.groupId || pe.peerId) ? 'group' : 'c2c')) || 'c2c';
  return `${scope}:${cn(mc.groupOpenid || rt.targetId || pe.groupId || mc.senderId || 'unknown')}`;
}

export default {
  name: ['答题', 'quiz', '问答题'],
  description: '抽一道问答题：/答题 出题，/答题 <回答> 判对错，/答题 换 换一题',
  usage: '/答题 | /答题 <回答> | /答题 换',

  async handler(ctx) {
    const raw = cn(ctx?.command?.raw).trim();
    const root = dataRootOf(ctx);
    if (!root)
      return { kind: 'text', content: '呜…本鲸找不到题库。' };

    let core;
    try {
      core = await import('../lib/interview-core.mjs');
    }
    catch (err) {
      return { kind: 'text', content: `题库模块没装好（${err instanceof Error ? err.message : String(err)}）。` };
    }

    const who = whoOf(ctx);
    const all = await loadPending(root);
    const pending = PENDING.get(who) || all[who] || null;

    const draw = () => {
      const bank = core.loadQuestionBank(root);
      const cat = (bank?.data?.categories || []).find((x) => x && x.id === 'quiz');
      const items = (cat?.questions || []).filter((q) => q && q.text);
      if (!items.length) return null;
      // 记一下最近抽过的，别连着抽同一道
      const recent = new Set(Array.isArray(all._recent) ? all._recent : []);
      const pool = items.filter((q) => !recent.has(q.qid));
      const pick = (pool.length ? pool : items)[Math.floor(Math.random() * (pool.length || items.length))];
      const r = [...recent, pick.qid].slice(-8);
      all._recent = r;
      return pick;
    };

    // 判答
    if (raw && raw !== '换' && pending) {
      const j = core.judgeQuiz(pending, raw);
      const lines = [`${j.correct ? '✅ 对' : '❌ 不对'}（命中 ${j.hit}/${j.need} 个要点）`];
      if (j.feedback) lines.push(cn(j.feedback));
      if (pending.answer) lines.push(`标准答案：${cn(pending.answer)}`);
      if (!j.correct && pending.correction) lines.push(cn(pending.correction));
      if (pending.supplement) lines.push(cn(pending.supplement));
      lines.push('', '再来一题发 `/答题`。');
      delete all[who];
      PENDING.delete(who);
      void savePending(root, all);
      return { kind: 'text', content: lines.join('\n') };
    }

    // 出题（无 pending 或说"换"）
    const q = draw();
    if (!q)
      return { kind: 'text', content: '题库里这会儿没抽到合适的题，晚点再试。' };
    PENDING.set(who, q);
    all[who] = q;
    void savePending(root, all);
    const src = cn(q.source);
    return {
      kind: 'text',
      content: [`📝 ${cn(q.text)}`, src ? `（${src}）` : '', '', '直接回 `/答题 你的回答`，我判对错。'].filter(Boolean).join('\n'),
    };
  },
};
