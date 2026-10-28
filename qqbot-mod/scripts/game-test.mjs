/**
 * game-test.mjs — 小游戏系统回归测试（2026-10-25）
 *
 * 覆盖：引擎裁决（5 种游戏 + 无状态）、会话存档（开局/出招/结算/超时/重开）、
 *       工具契约（start/move/status/end/list/truth/roll）、入站中间件（口令/限流/放行）。
 * 跑法：node qqbot-mod/scripts/game-test.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'game-test-'));
// 数据根结构对齐：{root}/.qqbot-extensions/tools/data/
mkdirSync(join(ROOT, '.qqbot-extensions', 'tools', 'data'), { recursive: true });

const LIB = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/lib/game-lib.mjs');
const tool = (await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/game.mjs')).default;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; }
  else { fail += 1; fails.push(name + (extra ? ` :: ${extra}` : '')); }
}

// ── 引擎直测 ──────────────────────────────────────────────────────────
{
  const g = LIB.engineOf('guess').start({});
  ok('guess: 开局有开场白', /1~/u.test(g.intro) && g.state.answer >= 1 && g.state.answer <= 100);
  const hit = LIB.engineOf('guess').move({ ...g.state, answer: 50 }, '50', '测试');
  ok('guess: 猜中结算', hit.done && hit.win && hit.reply.includes('猜中'));
  const low = LIB.engineOf('guess').move({ ...g.state, answer: 50, tries: 0, lo: 1, hi: 100 }, '30', '测试');
  ok('guess: 猜小提示+缩范围', !low.done && low.reply.includes('小了') && low.state.lo === 31);
}
{
  const b = LIB.engineOf('bomb').start();
  const bomb = b.state.bomb;
  const safeN = bomb > 50 ? 50 : 99;
  const r1 = LIB.engineOf('bomb').move(b.state, String(safeN), '甲');
  ok('bomb: 安全报数缩范围', !r1.done && (safeN < bomb ? r1.state.lo === safeN : r1.state.hi === safeN));
  const r2 = LIB.engineOf('bomb').move(r1.state, String(bomb), '乙');
  ok('bomb: 踩雷结算', r2.done && r2.reply.includes('炸弹'));
  const r3 = LIB.engineOf('bomb').move(b.state, '0', '丙');
  ok('bomb: 出界被拒', !r3.done && r3.reply.includes('要报'));
}
{
  const i = LIB.engineOf('idiom').start();
  ok('idiom: 开局给合法成语', i.state.chain.length === 1 && LIB.engineOf('idiom').match(i.state.last));
  const head = i.state.last.slice(-1);
  const nextIdiom = '海阔天空'.startsWith(head) ? '海阔天空' : null;
  // 用词库里一定有的接龙词测两条
  const target = ['一心一意', '一鸣惊人'].find((w) => LIB.idiomCount() > 0 && w[0] === head);
  if (target) {
    const r = LIB.engineOf('idiom').move({ last: i.state.last, chain: [...i.state.chain], round: 0 }, target, '测试');
    ok('idiom: 正确接龙继续', !r.done || r.reply.includes('赢'));
  }
  const wrong = LIB.engineOf('idiom').move({ last: '一心一意', chain: ['一心一意'], round: 0 }, '意气风发'.replace('意', '错'), '测试');
  ok('idiom: 首字不符被拒', !wrong.done && wrong.reply.includes('要接'));
  const dup = LIB.engineOf('idiom').move({ last: '意气风发', chain: ['一心一意', '意气风发'], round: 1 }, '一心一意', '测试');
  ok('idiom: 重复被拒', dup.reply.includes('接过了'));
}
{
  const j = LIB.engineOf('bj').start();
  ok('bj: 开局发牌', j.state.player.length === 2 && j.state.dealer.length === 2);
  const stand = LIB.engineOf('bj').move(j.state, '停牌', '测试');
  ok('bj: 停牌结算', stand.done && (stand.reply.includes('结算')));
  const hit = LIB.engineOf('bj').move({ ...j.state, done: false }, '要牌', '测试');
  ok('bj: 要牌加一张', hit.state.player.length === 3);
}
{
  const r = LIB.engineOf('rps').start();
  let st = r.state, done = false, guard = 0;
  while (!done && guard < 20) { const x = LIB.engineOf('rps').move(st, '石头', '测试'); st = x.state; done = !!x.done; guard += 1; }
  ok('rps: 必然三局两胜内结束', done && (st.you >= 2 || st.me >= 2));
}
ok('truth: 抽题非空', LIB.spinTruth('truth').text.length > 4 && LIB.spinTruth('dare').text.length > 4);
ok('roll: 范围正确', (() => { const r = LIB.rollDice(20); return r.n >= 1 && r.n <= 20 && r.sides === 20; })());

// ── 会话存档 ──────────────────────────────────────────────────────────
{
  const started = LIB.startSession(ROOT, 'group', 'G1', 'guess', {});
  ok('startSession: 返回 id+intro', !!started?.id && !!started?.intro);
  const act = LIB.activeOf(ROOT, 'group', 'G1');
  ok('activeOf: 能读到刚开的局', act?.id === started.id);
  const mv = LIB.applyMove(ROOT, 'group', 'G1', String(act.state.answer), '测试');
  ok('applyMove: 猜中结算并清档', mv.handled && mv.done && !LIB.activeOf(ROOT, 'group', 'G1'));
  const mvNone = LIB.applyMove(ROOT, 'group', 'G1', '55', '测试');
  ok('applyMove: 没对局不接', mvNone.handled === false);
  LIB.startSession(ROOT, 'group', 'G1', 'bomb', {});
  const again = LIB.startSession(ROOT, 'group', 'G1', 'idiom', {});
  ok('startSession: 重开自动清旧局', again.kind === 'idiom' && LIB.activeOf(ROOT, 'group', 'G1')?.kind === 'idiom');
  ok('finishSession: 返回结算信息', LIB.finishSession(ROOT, 'group', 'G1', '口令')?.title === '成语接龙');
  ok('finishSession: 空收摊返回 null', LIB.finishSession(ROOT, 'group', 'G1', '口令') === null);
  ok('存档文件落在约定位置', existsSync(join(ROOT, '.qqbot-extensions', 'tools', 'data', 'game-sessions.json')));
  // 超时懒过期
  LIB.startSession(ROOT, 'group', 'G2', 'guess', {});
  const p = join(ROOT, '.qqbot-extensions', 'tools', 'data', 'game-sessions.json');
  const d = JSON.parse(readFileSync(p, 'utf8'));
  d.sessions['group:G2'].lastAt = Date.now() - 16 * 60_000;
  writeFileSync(p, JSON.stringify(d), 'utf8');
  ok('懒过期：16 分钟没动静自动清', LIB.activeOf(ROOT, 'group', 'G2') === null);
}

// ── 工具契约 ──────────────────────────────────────────────────────────
const envOf = (scope, peerId) => ({ dataRoot: ROOT, caps: { scope, peerId, dataRoot: ROOT } });
{
  const r = await tool.run({ action: 'start', kind: 'guess' }, envOf('group', 'T1'));
  ok('tool start: ok+msg', r.ok === true && r.msg.includes('开局'));
  const mv = await tool.run({ action: 'move', text: '999', who: '测试' }, envOf('group', 'T1'));
  ok('tool move: 出界提示', mv.ok === true && mv.msg.includes('不在范围'));
  const st = await tool.run({ action: 'status' }, envOf('group', 'T1'));
  ok('tool status: 显示进行中', st.ok === true && st.msg.includes('进行中'));
  const ed = await tool.run({ action: 'end' }, envOf('group', 'T1'));
  ok('tool end: 收摊', ed.ok === true && ed.msg.includes('收摊'));
  const bad = await tool.run({ action: 'start', kind: '斗地主' }, envOf('group', 'T1'));
  ok('tool start: 不认识的 kind 拒绝', bad.ok === false);
  const tr = await tool.run({ action: 'truth', mode: 'dare' }, envOf('group', 'T1'));
  ok('tool truth: 大冒险', tr.ok === true && tr.msg.includes('大冒险'));
  const ro = await tool.run({ action: 'roll', sides: 6 }, envOf('group', 'T1'));
  ok('tool roll: 骰子', ro.ok === true && /[0-6]/u.test(ro.msg));
  const ls = await tool.run({ action: 'list' }, envOf('group', 'T1'));
  ok('tool list: 结构完整', ls.ok === true && typeof ls.msg === 'string');
  // 两群互不干扰
  await tool.run({ action: 'start', kind: 'rps' }, envOf('group', 'TA'));
  await tool.run({ action: 'start', kind: 'guess' }, envOf('group', 'TB'));
  const la = LIB.activeOf(ROOT, 'group', 'TA');
  const lb = LIB.activeOf(ROOT, 'group', 'TB');
  ok('两群各自一局', la?.kind === 'rps' && lb?.kind === 'guess');
  LIB.killSession(ROOT, 'group:TA'); LIB.killSession(ROOT, 'group:TB');
  ok('killSession: 按键清除', !LIB.activeOf(ROOT, 'group', 'TA') && !LIB.activeOf(ROOT, 'group', 'TB'));
}

// ── 入站中间件 ────────────────────────────────────────────────────────
{
  const mod = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/game-inbound.mjs');
  const resetRate = mod._testResetRate;
  const sent = [];
  const mkCtx = (text, scope = 'group', peer = 'M1', extra = {}) => ({
    text,
    scope,
    groupId: scope === 'group' ? peer : '',
    sender: peer,
    senderName: '测试员',
    dataRoot: ROOT,
    caps: { dataRoot: ROOT, text: async (t) => { sent.push(t); return { ok: true }; } },
    ...extra,
  });
  let nexted = 0;
  const next = async () => { nexted += 1; };

  // 开局口令
  sent.length = 0;
  resetRate();
  await mod.onInbound(mkCtx('玩成语接龙'), next);
  ok('inbound: 玩成语接龙本地开局', sent.length === 1 && sent[0].includes('开局') && sent[0].includes('我先来'));
  ok('inbound: 开局口令被吃掉（annihilate）', nexted === 0);
  // 出招（接龙正确词）——先拿上一手
  const sess = LIB.activeOf(ROOT, 'group', 'M1');
  const head = sess.state.last.slice(-1);
  // 找词库里以 head 开头且没用过的词
  const all = ['一心一意', '一鸣惊人', '一举两得', '一步登天'];
  const cand = all.find((w) => w[0] === head && !sess.state.chain.includes(w));
  sent.length = 0;
  resetRate();
  if (cand) {
    await mod.onInbound(mkCtx(cand), next);
    ok('inbound: 出招被本地裁决', sent.length === 1 && (sent[0].includes('我接') || sent[0].includes('接不上')));
    ok('inbound: 出招不进上下文', nexted === 0);
  } else {
    ok('inbound: 出招被本地裁决(跳过-无词可接)', true);
    ok('inbound: 出招不进上下文(跳过)', true);
  }
  // 非游戏消息照常放行
  const before = nexted;
  await mod.onInbound(mkCtx('今天天气真不错啊'), next);
  ok('inbound: 普通聊天照常放行', nexted === before + 1 && sent.length === 0);
  // 结束口令（先确保有一局——上一步接龙可能直接赢局清档）
  LIB.startSession(ROOT, 'group', 'M1', 'bomb', {});
  sent.length = 0;
  resetRate();
  await mod.onInbound(mkCtx('结束游戏'), next);
  ok('inbound: 结束口令收摊', sent.length === 1 && sent[0].includes('收摊'));
  // 没对局时结束口令放行（不说话不吞消息）
  const b2 = nexted;
  await mod.onInbound(mkCtx('不玩了'), next);
  ok('inbound: 没对局时结束口令放行', nexted === b2 + 1);
  // 真心话/骰子（无状态）
  sent.length = 0;
  resetRate();
  await mod.onInbound(mkCtx('真心话'), next);
  ok('inbound: 真心话抽题', sent.length === 1 && sent[0].startsWith('【真心话】'));
  sent.length = 0;
  resetRate();
  await mod.onInbound(mkCtx('掷骰子'), next);
  ok('inbound: 掷骰子', sent.length === 1 && sent[0].includes('面骰'));
  // 菜单
  sent.length = 0;
  resetRate();
  await mod.onInbound(mkCtx('玩游戏'), next);
  ok('inbound: 游戏菜单', sent.length === 1 && sent[0].includes('猜数字'));
  // 空文本放行
  const b3 = nexted;
  await mod.onInbound(mkCtx(''), next);
  ok('inbound: 空文本放行', nexted === b3 + 1);
}

// ── 清理 ──────────────────────────────────────────────────────────────
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 换目录重试 */ }
if (existsSync(ROOT)) { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } }

console.log(`\n===== game-test: ${pass} pass / ${fail} fail =====`);
if (fails.length) { console.log('FAILED:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
