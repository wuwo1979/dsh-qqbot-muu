/**
 * 面试.mjs —— QQ 聊天里的模拟面试官（2026-11-10，v0.1.6 新增）
 *
 * 为什么是「命令 + 文本」而不是「拦截普通聊天」：
 *   入站扩展只有「改写 / 消灭」两种手段，**没有"直接回一句"的能力**（见 dist/features/ext-inbound.js 的动作表）。
 *   靠改写喂给模型去演面试官，既烧 token 又会跑题；聊天记录里还会留下"用户在答题"的半截对话。
 *   ⇒ 做成显式命令：练习时你自己输入 /答，面试内容不进群历史、不进模型上下文。
 *
 * 隐私（重要）：
 *   · 题目、你的回答、评分 **只落本机** `secrets/interview/sessions/<sid>/`；
 *   · 命令回复里**不出现任何绝对路径**，只说"记在本机"；
 *   · 保留策略由 `secrets/interview/config.json` 的 privacy/retention 控制（默认 14 天后归档）。
 *
 * 命令：
 *   /面试              开一场（回开场白 + 规则）
 *   /面试开始 或 /下一题 出题 / 下一题
 *   /答 <你的回答>      作答（支持追问）
 *   /面试点评          看当前进度与评分
 *   /面试结束          收摊 + 结语
 *
 * ⚠️ 文件名/命令名别和宿主的 `/bot-restart` 之类撞车（撞了会 duplicate name 把网关炸掉）。
 */
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

function cn(v) { return v === undefined || v === null ? '' : String(v); }

/** 扩展数据根（与其它命令同口径：caps.paths.dataRoot → 本文件上两级） */
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

/** 会话标识：谁在哪个会话里练（私聊=人，群聊=群） */
function whoOf(ctx) {
  const mc = ctx?.message ?? {};
  const rt = ctx?.replyTarget ?? {};
  const pe = ctx?.peer ?? {};
  const scope = cn(rt.scope || ctx?.scope || pe.scope || mc.kind || ((mc.groupOpenid || pe.groupId || pe.peerId) ? 'group' : 'c2c')) || 'c2c';
  const target = cn(mc.groupOpenid || rt.targetId || pe.groupId || mc.senderId || pe.openid || 'unknown');
  return `${scope}:${target}`;
}

/** 进行中的面试（文件落盘：命令可能被实例化成两份模块，模块变量不可信） */
async function activeFile(root) {
  const { join } = await import('node:path');
  return join(root, '.qqbot', 'interview-active.json');
}

async function readActive(root) {
  try {
    const { readFileSync } = await import('node:fs');
    const j = JSON.parse(readFileSync(await activeFile(root), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

async function writeActive(root, all) {
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const f = await activeFile(root);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(all, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

/** 把 publicState 渲染成一条 QQ 文本（不打印路径、不打印分数表以外的内部字段） */
function render(st, fallback = '') {
  const say = cn(st?.say).trim();
  if (st?.stage === 'ended') {
    // 面试核心的结束语是给**网页通话窗口**写的（"复盘放在通话窗口里了"），
    // QQ 里没有那个窗口 ⇒ 自己给一句，别让用户去找不存在的东西。
    return [say && !/复盘|通话窗口|重新开始/.test(say) ? say : '这场就到这里，辛苦啦。', '', '想再练一轮发 `/面试`；看总评发 `/面试点评`。'].join('\n');
  }
  const q = st?.question;
  if (say) {
    const lines = [say];
    // say 里没有题目正文时才补（有的模板把题目直接写进 say）
    if (q?.text && !say.includes(cn(q.text).slice(0, 12))) {
      lines.push('');
      lines.push(`📌 ${cn(q.text)}`);
    }
    if (q) lines.push('', '答题发 `/答 你的回答`，跳过发 `/下一题`。');
    else if (st?.stage === 'opening') lines.push('', '说 `/面试开始` 我们就开始。');
    return lines.join('\n');
  }
  if (q?.text)
    return [`📌 ${cn(q.text)}`, '', '答题发 `/答 你的回答`。'].join('\n');
  return fallback;
}

export default {
  name: ['面试', 'interview', '答', '下一题', '面试结束', '面试点评'],
  description: '模拟面试官：/面试 开场，/答 作答，/下一题 跳过，/面试点评 看评分，/面试结束 收摊',
  usage: '/面试 | /答 <回答> | /下一题 | /面试点评 | /面试结束',

  async handler(ctx) {
    const cmd = cn(ctx?.command?.name || '').toLowerCase();
    const raw = cn(ctx?.command?.raw).trim();
    const root = dataRootOf(ctx);
    if (!root)
      return { kind: 'text', content: '呜…本鲸找不到自己的数据目录，这场先欠着。' };

    let core;
    try {
      core = await import('../lib/interview-core.mjs');
    }
    catch (err) {
      return { kind: 'text', content: `呜…面试模块没装好（${err instanceof Error ? err.message : String(err)}）。` };
    }

    const who = whoOf(ctx);
    const all = await readActive(root);
    const cur = all[who] && Number(all[who].at || 0) + SESSION_TTL_MS > Date.now() ? all[who] : null;

    // ── 结束 ──
    if (cmd === '面试结束') {
      if (!cur) return { kind: 'text', content: '这会儿没有在练的面试。发 `/面试` 开一场？' };
      try {
        const st = core.endSession(root, cur.sid);
        delete all[who];
        await writeActive(root, all);
        return { kind: 'text', content: render(st) };
      }
      catch (err) {
        return { kind: 'text', content: `收摊没成功：${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // ── 点评 / 进度 ──
    if (cmd === '面试点评') {
      if (!cur) return { kind: 'text', content: '这场还没开。发 `/面试` 我当面试官。' };
      try {
        const s = core.loadSession(root, cur.sid);
        const done = Array.isArray(s.answers) ? s.answers.filter((a) => a && a.chunks && a.chunks.length) : [];
        const lines = [`已答 ${done.length} 题 · 当前阶段：${s.stage === 'asking' ? '提问中' : s.stage === 'followup' ? '追问中' : s.stage === 'ended' ? '已结束' : '开场'}`];
        for (const a of done.slice(-5)) {
          const score = Number(a.score);
          lines.push(`· ${cn(a.categoryName || a.categoryId)} ${Number.isFinite(score) ? `— ${score} 分` : ''}${cn(a.comment) ? `：${cn(a.comment)}` : ''}`.trim());
        }
        if (!done.length) lines.push('还没答，发 `/面试开始` 出第一题。');
        return { kind: 'text', content: lines.join('\n') };
      }
      catch (err) {
        return { kind: 'text', content: `没读到进度：${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // ── 作答 ──
    if (cmd === '答') {
      if (!cur) return { kind: 'text', content: '先发 `/面试` 开一场，再 `/答 ...` 才有题目。' };
      if (!raw) return { kind: 'text', content: '要答什么呀？`/答 你的回答`。' };
      try {
        const st = await core.submitAnswer(root, cur.sid, raw);
        all[who] = { sid: cur.sid, at: Date.now() };
        await writeActive(root, all);
        return { kind: 'text', content: render(st) };
      }
      catch (err) {
        return { kind: 'text', content: `这句没记上：${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // ── 出题 / 下一题 ──
    if (cmd === '下一题') {
      if (!cur) return { kind: 'text', content: '先发 `/面试` 开一场。' };
      try {
        const st = core.proceed(root, cur.sid);
        all[who] = { sid: cur.sid, at: Date.now() };
        await writeActive(root, all);
        if (st.stage === 'ended') {
          delete all[who];
          await writeActive(root, all);
        }
        return { kind: 'text', content: render(st) };
      }
      catch (err) {
        return { kind: 'text', content: `出题卡住了：${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // ── /面试：开场（有进行中的就先说规矩，不重复开）──
    if (cur) {
      try {
        const st = core.proceed(root, cur.sid);
        all[who] = { sid: cur.sid, at: Date.now() };
        await writeActive(root, all);
        return { kind: 'text', content: render(st, '已经在练了，接着答就好。') };
      }
      catch { /* 会话坏了就重开 */ }
    }

    try {
      // 可选模式：/面试 教资 | /面试 英语 | /面试 quiz …
      const want = raw.split(/\s+/)[0] || '';
      const st = core.createSession(root, want ? { mode: want } : {});
      all[who] = { sid: st.sid, at: Date.now() };
      const saved = await writeActive(root, all);
      const tail = saved ? '' : '\n（进度存不下来，这一场只在本轮有效）';
      return { kind: 'text', content: render(st) + tail };
    }
    catch (err) {
      return { kind: 'text', content: `开场失败：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
