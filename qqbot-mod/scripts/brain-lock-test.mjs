/**
 * brain-lock-test.mjs — 「左右脑互搏」的专用验收
 *
 * 现场（用户原话）：问"你能发语音吗"，本地小模型秒答"我只会打字"，一秒后云端又答
 * "我可以呀"并发语音 —— 看着像两个脑子抢话。
 *
 * 根因不是"同一条消息被两个脑答"（插件里 annihilate 会把链吃掉，云端根本不跑），
 * 而是**两条消息交叠**：消息① 已放行给云端在算，消息② 一到本地就秒答。
 * 修法：按会话的单脑仲裁窗口（brain-lock）——云端在窗口内被放行过/刚说完，本地闭嘴。
 *
 * 跑法：node qqbot-mod/scripts/brain-lock-test.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'F:\\qqbot\\qqbot-mod\\.devdata-brainlock';
process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;
mkdirSync(join(ROOT, '.qqbot-extensions'), { recursive: true });
mkdirSync(join(ROOT, '.qqbot'), { recursive: true });

const brain = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/brain-lock.mjs');
const cloudMod = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/outbound/ab-brain-cloud.mjs');
const { scopeOf } = brain;

let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass += 1; console.log('  PASS  ' + n + (extra ? '  ' + extra : '')); }
  else { fail += 1; console.log('  FAIL  ' + n + (extra ? '  ' + extra : '')); }
};

// ── 1. scopeOf：必须带群号/对方 id（ctx.scope 只给 'group'）──────
console.log('\n[1] 会话作用域');
{
  ok('群消息 → group:<群号>', scopeOf({ scope: 'group', message: { groupOpenid: 'G9', senderId: 'U1' } }) === 'group:G9');
  ok('私聊 → c2c:<openid>', scopeOf({ scope: 'c2c', message: { senderId: 'U7' } }) === 'c2c:U7');
  ok('拿不到 message 时退回宿主 scope', scopeOf({ scope: 'c2c' }) === 'c2c');
  ok('两个群不会共用一个锁',
    scopeOf({ message: { groupOpenid: 'A' } }) !== scopeOf({ message: { groupOpenid: 'B' } }));
  ok('空 ctx 不抛', (() => { try { scopeOf(null); return true; } catch { return false; } })());
}

// ── 2. 记账与窗口 ────────────────────────────────────────────
console.log('\n[2] 记账与窗口');
brain.reset(ROOT);
{
  ok('没记过 = 安静', brain.quiet(ROOT, 'group:G1', 12000) === true);
  brain.mark(ROOT, 'group:G1', 'cloud', { why: 'dispatch' });
  const rec = brain.peek(ROOT, 'group:G1');
  ok('云端记账可读回', rec && rec.who === 'cloud' && rec.why === 'dispatch');
  ok('云端刚说过 → 不安静', brain.quiet(ROOT, 'group:G1', 12000) === false);
  ok('窗口过后 → 安静', brain.quiet(ROOT, 'group:G1', 12000, Date.now() + 13000) === true);
  ok('窗口 0 = 关闭仲裁', brain.quiet(ROOT, 'group:G1', 0) === true);
  brain.mark(ROOT, 'group:G1', 'local', { why: 'gag' });
  ok('本地自己说过不算挡', brain.quiet(ROOT, 'group:G1', 12000) === true);
  ok('别的会话不受影响', brain.quiet(ROOT, 'group:OTHER', 12000) === true);
  ok('空 scope 永远安静', brain.quiet(ROOT, '', 12000) === true);
  ok('坏锁文件不抛', (() => {
    writeFileSync(brain.lockFile(ROOT), 'not json at all', 'utf8');
    try { return brain.quiet(ROOT, 'group:G1', 12000) === true; } catch { return false; }
  })());
}

// ── 3. 出站记账（云端真的说话了）──────────────────────────────
console.log('\n[3] 出站记账');
brain.reset(ROOT);
{
  const mk = (o = {}) => ({
    phase: 'send', kind: 'text', isLastChunk: true, text: '本鲸在呢',
    target: { scope: 'group', peerId: 'G42' }, dataRoot: ROOT, ...o,
  });
  let nextCalls = 0;
  const next = async () => { nextCalls += 1; };
  await cloudMod.onOutbound(mk(), next);
  ok('末块正文 → 记 cloud', brain.peek(ROOT, 'group:G42')?.who === 'cloud');
  ok('记完仍然放行（不改行为）', nextCalls === 1);
  brain.reset(ROOT);
  await cloudMod.onOutbound(mk({ phase: 'turnEnd' }), next);
  ok('turnEnd 不记账', brain.peek(ROOT, 'group:G42') === null);
  await cloudMod.onOutbound(mk({ isLastChunk: false }), next);
  ok('非末块不记账', brain.peek(ROOT, 'group:G42') === null);
  await cloudMod.onOutbound(mk({ kind: 'image', text: '' }), next);
  ok('非文本不记账', brain.peek(ROOT, 'group:G42') === null);
  await cloudMod.onOutbound({ phase: 'send', text: 'x' }, next);
  ok('没有 dataRoot/target 也不抛', nextCalls >= 4);
}

// ── 4. 和本地代答联动（走真 local-answer，梗句不依赖模型）─────
console.log('\n[4] 本地代答联动');
const EXTDIR = join(ROOT, '.qqbot-extensions');
const CFG = join(EXTDIR, 'local-llm-config.json');
const BASE = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5:7b',
  timeoutMs: 8000,
  maxTokens: 48,
  maxInputChars: 80,
  maxReplyChars: 60,
  shortChatChars: 12,
  minIntervalMs: 0,
  maxPerWindow: 999,
  windowMs: 60000,
  allowUnmentioned: false,
  ownerToo: false,
  healthTtlMs: 0,
  systemPrompt: '',
  // 单脑铁律在夹具里放开：本套只用"被 @"的消息验仲裁窗口，
  // 若按线上默认（被 @ 交云端）就永远跑不到仲裁逻辑。
  onlyUnmentioned: false,
  c2cLocal: true,
};
const setCfg = (o) => writeFileSync(CFG, JSON.stringify({ ...BASE, ...o }, null, 2), 'utf8');

const local = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/local-answer.mjs');

function makeCtx(text, opts = {}) {
  const state = { nextCalls: 0, sent: [], annihilated: false };
  const ctx = {
    text,
    message: { groupOpenid: 'G1', senderId: 'U1', senderName: '测试' },
    platform: { mentioned: true },
    isOwner: false,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    rewrite() { return true; },
    annihilate() { state.annihilated = true; return true; },
    caps: { async text(s) { state.sent.push(s); return true; }, async media() { return true; } },
  };
  return { ctx, state, next: async () => { state.nextCalls += 1; } };
}

async function run(text, lock) {
  brain.reset(ROOT);
  if (lock) brain.mark(ROOT, 'group:G1', lock.who, { why: 'test', now: Date.now() - (lock.ageMs || 0) });
  local.resetRate?.();
  const { ctx, state, next } = makeCtx(text);
  await local.onInbound(ctx, next);
  return { took: state.annihilated, sent: state.sent, nextCalls: state.nextCalls };
}

setCfg({ brainHoldMs: 12000 });
{
  const a = await run('2+3等于多少', { who: 'cloud', ageMs: 500 });
  ok('云端刚被放行 → 本地不插嘴', a.took === false && a.sent.length === 0 && a.nextCalls === 1);
  const b = await run('2+3等于多少', { who: 'cloud', ageMs: 30000 });
  ok('窗口过后 → 本地照常答', b.took === true && b.sent[0] === '6');
  const c = await run('2+3等于多少', { who: 'local', ageMs: 500 });
  ok('本地自己说过不挡自己', c.took === true && c.sent[0] === '6');
  const d = await run('2+3等于多少', null);
  ok('没人在说话 → 本地照常答', d.took === true && d.sent[0] === '6');
  ok('答完记成 local', brain.peek(ROOT, 'group:G1')?.who === 'local');
}
setCfg({ brainHoldMs: 0 });
{
  const a = await run('2+3等于多少', { who: 'cloud', ageMs: 500 });
  ok('brainHoldMs=0 → 仲裁关闭，本地照答', a.took === true && a.sent[0] === '6');
}

// 收尾：清掉本套的临时数据
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
