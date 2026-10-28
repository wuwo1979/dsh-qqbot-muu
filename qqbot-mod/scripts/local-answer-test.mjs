/**
 * local-answer-test.mjs — 入站本地代答（inbound/local-answer.mjs）行为验收
 *
 * 用假 inbound ctx 验证：什么时候接管、什么时候放行、接管时顺序对不对。
 * 需要本机 Ollama 活着（qwen2.5:0.5b）；服务不在时相关用例会跳过而不是报假错。
 *
 * 跑法：node qqbot-mod/scripts/local-answer-test.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = 'F:\\qqbot\\qqbot-mod\\.devdata';
process.env.QQBOT_MEMORY_DATA_ROOT = DATA_ROOT;
mkdirSync(join(DATA_ROOT, '.qqbot-extensions'), { recursive: true });

const mod = await import('../../dshqqbot/.qqbot-extensions/inbound/local-answer.mjs');
const onInbound = mod.onInbound;
const gagReply = mod.gagReply;
const resetRate = mod.resetRate || (() => {});

const cfgPath = join(DATA_ROOT, '.qqbot-extensions', 'local-llm-config.json');
const setCfg = (o) => writeFileSync(cfgPath, JSON.stringify(o, null, 2), 'utf8');

let pass = 0;
let fail = 0;
const skip = [];
const ok = (n, c, extra = '') => {
  if (c) { pass += 1; console.log('  PASS  ' + n + (extra ? '  ' + extra : '')); }
  else { fail += 1; console.log('  FAIL  ' + n + (extra ? '  ' + extra : '')); }
};

/** 假 inbound ctx */
function makeCtx(text, opts = {}) {
  const state = { nextCalls: 0, sent: [], annihilated: false, rewrites: [] };
  const ctx = {
    text,
    message: { groupOpenid: opts.groupOpenid === null ? undefined : 'G1', senderId: opts.senderId || 'U1', senderName: '测试' },
    platform: { mentioned: opts.mentioned === true },
    isOwner: opts.isOwner === true,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    rewrite(t) { state.rewrites.push(t); return true; },
    // 与真实插件同签名：annihilate(opts)，opts = { reason, ownerAck }
    annihilate(o) {
      state.killOpts = o;
      if (opts.annihilateFails) return false;
      if (opts.isOwner === true && !(o && o.ownerAck === true)) return false;
      state.annihilated = true;
      return true;
    },
    caps: {
      async text(s) { state.sent.push(s); return true; },
      async media() { return true; },
    },
  };
  const next = async () => { state.nextCalls += 1; };
  return { ctx, state, next };
}

const BASE = {
  enabled: true,
  // 2026-10-23：本机 ollama 已经没有 0.5b（现在是 qwen2.5:7b），
  // 夹具要跟线上跑的那个模型一致，否则永远 SKIP「Ollama 未就绪」。
  model: 'qwen2.5:7b',
  baseUrl: 'http://127.0.0.1:11434',
  timeoutMs: 8000,
  maxTokens: 48,
  maxInputChars: 24,
  maxReplyChars: 60,
  minIntervalMs: 0,
  maxPerWindow: 99,
  windowMs: 60000,
  allowUnmentioned: false,
  ownerToo: false,
  healthTtlMs: 0,
  // 2026-10-23：新默认是"被 @ 的消息交给云端（避免双答）"，
  // 本套前面的门禁用例都是 @ 着的，所以这里显式关掉，只测本地接管本身的逻辑；
  // 新默认本身由 [5] 单脑铁律 专门验。
  onlyUnmentioned: false,
  c2cLocal: true,
  // 单脑仲裁在本套里关掉（本套一条条独立验门禁，窗口会互相干扰）；
  // 仲裁本身由 brain-lock-test.mjs 专门验。
  brainHoldMs: 0,
};

console.log('数据根 ' + DATA_ROOT);

// ── 1. 门禁（不依赖模型）─────────────────────────────────
console.log('\n[1] 门禁');
setCfg({ ...BASE, minIntervalMs: 60000 });
{
  const { ctx, state, next } = makeCtx('哈哈哈');
  await onInbound(ctx, next);
  ok('没 @ 她 → 放行给云端', state.nextCalls === 1 && state.sent.length === 0);
}
{
  const { ctx, state, next } = makeCtx('帮我看看这个报错怎么解决，E404 一直退，重启也不行', { mentioned: true, isOwner: true });
  await onInbound(ctx, next);
  ok('主人的复杂活 → 放行给云端', state.nextCalls === 1 && state.sent.length === 0);
}
{
  const { ctx, state, next } = makeCtx('/bot-restart', { mentioned: true });
  await onInbound(ctx, next);
  ok('斜杠命令 → 放行', state.nextCalls === 1 && state.sent.length === 0);
}
{
  const { ctx, state, next } = makeCtx('[图片: 326KB]', { mentioned: true });
  await onInbound(ctx, next);
  ok('纯媒体 → 放行', state.nextCalls === 1 && state.sent.length === 0);
}
{
  const { ctx, state, next } = makeCtx('帮我看看这个报错怎么解决，E404 一直退', { mentioned: true });
  await onInbound(ctx, next);
  ok('长消息 → 放行', state.nextCalls === 1 && state.sent.length === 0);
}
{
  setCfg({ ...BASE, enabled: false });
  const { ctx, state, next } = makeCtx('在吗', { mentioned: true });
  await onInbound(ctx, next);
  ok('enabled=false → 完全不碰', state.nextCalls === 1 && state.sent.length === 0);
}

// ── 2. 梗（不走模型，服务挂了也要答）────────────────────
console.log('\n[2] 死梗直答');
setCfg({ ...BASE, minIntervalMs: 0 });
{
  const { ctx, state, next } = makeCtx('2+3等于多少', { mentioned: true });
  await onInbound(ctx, next);
  ok('2+3 被接管', state.annihilated === true, 'next=' + state.nextCalls);
  ok('回答是 6', state.sent[0] === '6', JSON.stringify(state.sent));
}
{
  setCfg({ ...BASE, baseUrl: 'http://127.0.0.1:59999' }); // 服务不可达
  const { ctx, state, next } = makeCtx('2+3=?', { mentioned: true });
  await onInbound(ctx, next);
  ok('Ollama 挂了梗照样答', state.sent[0] === '6', JSON.stringify(state.sent));
}

// ── 3. 模型代答 ─────────────────────────────────────────
console.log('\n[3] 模型代答');
setCfg({ ...BASE, minIntervalMs: 0 });
const { status } = await import('../../dshqqbot/.qqbot-extensions/lib/local-llm.mjs');
const st = await status(null, true);
if (!st.serverUp || !st.hasModel) {
  skip.push('模型代答（Ollama 未就绪：' + (st.error || 'no model') + '）');
  console.log('  SKIP  模型代答（Ollama 未就绪）');
} else {
  {
    const { ctx, state, next } = makeCtx('在吗', { mentioned: true });
    await onInbound(ctx, next);
    ok('trivial + @ → 本地接管', state.annihilated === true && state.sent.length === 1, JSON.stringify(state.sent));
    ok('回复很短（≤60字）', (state.sent[0] || '').length <= 60, (state.sent[0] || '').length + '字');
    ok('回复没有 markdown/媒体标记', !/[*_`#>]|\[MEDIA:|!\[/.test(state.sent[0] || ''), JSON.stringify(state.sent[0]));
    ok('接管后不再放行给云端', state.nextCalls === 0, 'next=' + state.nextCalls);
  }
  {
    // 私聊（没有 groupOpenid）不需要 @
    const { ctx, state, next } = makeCtx('嗯嗯', { groupOpenid: null, mentioned: false });
    await onInbound(ctx, next);
    ok('私聊 trivial 也接管', state.annihilated === true && state.sent.length === 1);
  }
  {
    // annihilate 失败时必须放行、且不能发两条
    setCfg({ ...BASE, minIntervalMs: 0 });
    const { ctx, state, next } = makeCtx('哦哦', { mentioned: true, annihilateFails: true });
    await onInbound(ctx, next);
    ok('摘不掉就不发（防双回复）', state.sent.length === 0 && state.nextCalls === 1);
  }
}

// ── 4. 限流 ─────────────────────────────────────────────
console.log('\n[4] 限流');
setCfg({ ...BASE, minIntervalMs: 60000, maxPerWindow: 99 });
resetRate();
{
  const a = makeCtx('2+3', { mentioned: true });
  await onInbound(a.ctx, a.next);
  const b = makeCtx('2+3', { mentioned: true });
  await onInbound(b.ctx, b.next);
  ok('最小间隔内第二条放行', a.state.sent.length === 1 && b.state.sent.length === 0, 'b.next=' + b.state.nextCalls);
}
setCfg({ ...BASE, minIntervalMs: 0, maxPerWindow: 2, windowMs: 60000 });
resetRate();
{
  const r1 = makeCtx('2+3', { mentioned: true }); await onInbound(r1.ctx, r1.next);
  const r2 = makeCtx('2+3', { mentioned: true }); await onInbound(r2.ctx, r2.next);
  const r3 = makeCtx('2+3', { mentioned: true }); await onInbound(r3.ctx, r3.next);
  ok('窗口内超额后放行', r1.state.sent.length + r2.state.sent.length === 2 && r3.state.sent.length === 0, 'r3.next=' + r3.state.nextCalls);
}

// ── 5. 谁接这条：简单话本地先接，复杂活给云端 ─────────────
// 历史：2026-10-23 上午为治"两个大脑各说一句"，私聊/被@ 一律交云端；
// 当晚主人反馈"一句你好也调大模型太浪费" ⇒ 改成按消息本身判：
//   简单话（trivial/短句/非任务）本地先接（摘得掉就省一整轮云 token）；
//   复杂话仍交云端；c2cLocal=false / onlyUnmentioned=true 可整类关死。
console.log('\n[5] 谁接这条（简单话本地 / 复杂活云端）');
{
  resetRate();
  setCfg({ ...BASE, onlyUnmentioned: false, c2cLocal: true, ownerToo: true, minIntervalMs: 0 });
  const { ctx, state, next } = makeCtx('你好', { groupOpenid: null, mentioned: false, isOwner: true });
  await onInbound(ctx, next);
  ok('主人私聊「你好」→ 本地接管（摘得掉）', state.sent.length === 1 && state.nextCalls === 0, 'sent=' + state.sent.length);
  ok('摘除带 ownerAck=true（不然主人消息摘不掉）', state.killOpts && state.killOpts.ownerAck === true && state.killOpts.reason === '本地小模型代答', JSON.stringify(state.killOpts));
}
{
  resetRate();
  setCfg({ ...BASE, onlyUnmentioned: false, c2cLocal: true, minIntervalMs: 0 });
  const { ctx, state, next } = makeCtx('在吗', { mentioned: true });
  await onInbound(ctx, next);
  ok('群里被 @ 的短句 → 本地接管', state.sent.length === 1 && state.nextCalls === 0, 'sent=' + state.sent.length);
}
{
  resetRate();
  setCfg({ ...BASE, onlyUnmentioned: false, c2cLocal: true, minIntervalMs: 0 });
  const { ctx, state, next } = makeCtx('这个报错一直退，你觉得是哪里的问题，重启也不管用', { mentioned: true });
  await onInbound(ctx, next);
  ok('群里被 @ 的复杂句 → 让给云端', state.sent.length === 0 && state.nextCalls === 1, 'sent=' + state.sent.length);
}
{
  resetRate();
  setCfg({ ...BASE, onlyUnmentioned: false, c2cLocal: true, minIntervalMs: 0, allowUnmentioned: true, unmentionedProb: 1 });
  const { ctx, state, next } = makeCtx('嗯嗯', { mentioned: false });
  await onInbound(ctx, next);
  ok('群里没 @ 的碎消息 → 本地接管', state.sent.length === 1, 'sent=' + state.sent.length);
}
{
  resetRate();
  setCfg({ ...BASE, onlyUnmentioned: false, c2cLocal: true, ownerToo: true, minIntervalMs: 0 });
  const { ctx, state, next } = makeCtx('2+3等于多少', { mentioned: true });
  await onInbound(ctx, next);
  ok('死梗被 @ 也归本地（回 6）', state.sent[0] === '6', JSON.stringify(state.sent));
}
{
  resetRate();
  setCfg({ ...BASE, onlyUnmentioned: false, c2cLocal: true, minIntervalMs: 0 });
  const { ctx, state, next } = makeCtx('画一条小鲸鱼', { mentioned: true });
}
{
  resetRate();
  setCfg({ ...BASE, onlyUnmentioned: false, c2cLocal: false, minIntervalMs: 0 });
  const { ctx, state, next } = makeCtx('你好', { groupOpenid: null, mentioned: false });
  await onInbound(ctx, next);
  ok('c2cLocal=false → 私聊整类交云端（开关仍有效）', state.sent.length === 0 && state.nextCalls === 1);
}
{
  resetRate();
  setCfg({ ...BASE, onlyUnmentioned: true, c2cLocal: true, minIntervalMs: 0 });
  const { ctx, state, next } = makeCtx('你好', { mentioned: true });
  await onInbound(ctx, next);
  ok('onlyUnmentioned=true → 被 @ 整类交云端', state.sent.length === 0 && state.nextCalls === 1);
}
{
  resetRate();
  setCfg({ ...BASE, onlyUnmentioned: false, c2cLocal: true, ownerToo: false, minIntervalMs: 0 });
  const { ctx, state, next } = makeCtx('你好', { mentioned: true, isOwner: true });
  await onInbound(ctx, next);
  ok('ownerToo=false → 主人的话不本地答', state.sent.length === 0 && state.nextCalls === 1);
}

// 收尾恢复上线默认
setCfg({
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5:7b',
  timeoutMs: 6000,
  maxTokens: 48,
  temperature: 0.7,
  topP: 0.9,
  healthTtlMs: 5000,
  whoAnswers: 'chat',
  maxInputChars: 80,
  maxReplyChars: 60,
  shortChatChars: 12,
  minIntervalMs: 6000,
  maxPerWindow: 6,
  windowMs: 60000,
  allowUnmentioned: true,
  unmentionedProb: 0.3,
  ownerToo: true,
  onlyUnmentioned: false,
  c2cLocal: true,
  brainHoldMs: 12000,
});

console.log('\nPASS ' + pass + ' / FAIL ' + fail + (skip.length ? ' / SKIP ' + skip.length : ''));
process.exit(fail === 0 ? 0 : 1);
