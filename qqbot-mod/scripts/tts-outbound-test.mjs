/**
 * tts-outbound-test.mjs — 出站语音扩展（outbound/tts-voice.mjs）行为验收
 *
 * 用假 ctx 模拟插件出站链，验证：什么时候转、什么时候不转、失败会不会吞消息。
 * 真跑 edge-tts（沙箱下 spawn + stdio:'ignore' 可用）。
 *
 * 跑法：node qqbot-mod/scripts/tts-outbound-test.mjs
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = 'F:\\qqbot\\qqbot-mod\\.devdata';
process.env.QQBOT_MEMORY_DATA_ROOT = DATA_ROOT;
mkdirSync(join(DATA_ROOT, '.qqbot-extensions'), { recursive: true });
mkdirSync(join(DATA_ROOT, '.qqbot', 'tts'), { recursive: true });

const mod = await import('../../dshqqbot/.qqbot-extensions/outbound/tts-voice.mjs');
const onOutbound = mod.onOutbound || mod.default;

let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass += 1; console.log('  PASS  ' + n + (extra ? '  ' + extra : '')); }
  else { fail += 1; console.log('  FAIL  ' + n + (extra ? '  ' + extra : '')); }
};

/** 造一个假 ctx；next() 记一次"文字放行" */
function makeCtx(text, opts = {}) {
  const state = { nextCalls: 0, media: [], annihilated: false, rewrites: [], kind: opts.kind || 'text', isLastChunk: opts.isLastChunk !== false };
  const ctx = {
    text,
    kind: state.kind,
    isLastChunk: state.isLastChunk,
    target: { scope: opts.scope || 'group:TEST', peerId: opts.peerId || 'P1' },
    turnId: 't1',
    chunkIndex: 0,
    dataRoot: DATA_ROOT,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    rewrite(t) { state.rewrites.push(t); return true; },
    annihilate(reason) { state.annihilated = true; state.reason = reason; return true; },
    async sendMedia(input) { state.media.push(input); return true; },
    async send() { return true; },
  };
  const next = async () => { state.nextCalls += 1; };
  return { ctx, state, next };
}

console.log('数据根 ' + DATA_ROOT);
console.log('\n[1] 基本行为（真合成）');

// 1) 默认 sometimes + prob 变异 —— 直接测 always
const cfgPath = join(DATA_ROOT, '.qqbot-extensions', 'voice-config.json');
const { writeFileSync } = await import('node:fs');
const setCfg = (o) => writeFileSync(cfgPath, JSON.stringify(o, null, 2), 'utf8');

setCfg({ enabled: true, mode: 'always', keepText: false, maxChars: 70, cooldownMs: 0, voice: 'zh-CN-XiaoyiNeural' });
{
  const { ctx, state, next } = makeCtx('咕噜噜，本鲸在呢。');
  await onOutbound(ctx, next);
  ok('翻成语音后文字被摘掉', state.annihilated === true);
  ok('语音已发送', state.media.length === 1, JSON.stringify(state.media[0] || {}));
  ok('发的是 voice 类型', (state.media[0] || {}).kind === 'voice');
  ok('语音文件存在', !!(state.media[0] || {}).path);
  ok('文字没有重复放行', state.nextCalls === 0, 'next=' + state.nextCalls);
}

// 2) 长文本不转
{
  const long = '今天我们来聊一个非常长的话题'.repeat(8);
  const { ctx, state, next } = makeCtx(long);
  await onOutbound(ctx, next);
  ok('长文本不转语音', state.annihilated === false && state.media.length === 0);
  ok('长文本照常放行', state.nextCalls === 1);
}

// 3) 带图/引用的不转
{
  const { ctx, state, next } = makeCtx('看图![a](D:/x.png)');
  await onOutbound(ctx, next);
  ok('带 markdown 图不转', state.media.length === 0 && state.nextCalls === 1);
}
{
  const { ctx, state, next } = makeCtx('[rf:0913a] 嗯呐');
  await onOutbound(ctx, next);
  ok('带引用不转', state.media.length === 0 && state.nextCalls === 1);
}
{
  const { ctx, state, next } = makeCtx('[MEDIA:image|D:/x.png]');
  await onOutbound(ctx, next);
  ok('带媒体标记不转', state.media.length === 0 && state.nextCalls === 1);
}

// 4) keepText：文字照发 + 追加语音
//    注：edge-tts 是联网服务，连续合成可能偶发限流；这里重试一次，避免把网络抖动算成代码 bug。
{
  setCfg({ enabled: true, mode: 'always', keepText: true, cooldownMs: 0, voice: 'zh-CN-XiaoyiNeural' });
  let got = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = makeCtx('吃了吗人类' + (attempt > 1 ? '呀' : ''));
    await onOutbound(r.ctx, r.next);
    if (r.state.media.length === 1) { got = r; break; }
    if (attempt === 1) { console.log('    (第 1 次合成没成功，重试一次 —— 网络抖动)'); await new Promise((s) => setTimeout(s, 1500)); }
    got = r;
  }
  ok('keepText 时文字照发', got.state.nextCalls === 1 && got.state.annihilated === false);
  ok('keepText 时也发了语音', got.state.media.length === 1);
}

// 5) 冷却：同一会话第二条立刻被跳过
{
  setCfg({ enabled: true, mode: 'always', keepText: false, cooldownMs: 60000, voice: 'zh-CN-XiaoyiNeural' });
  const a = makeCtx('第一条', { scope: 'group:COOL' });
  await onOutbound(a.ctx, a.next);
  const b = makeCtx('第二条', { scope: 'group:COOL' });
  await onOutbound(b.ctx, b.next);
  ok('首条转了', a.state.media.length === 1);
  ok('冷却期内第二条不转', b.state.media.length === 0 && b.state.nextCalls === 1);
  // 换会话不受影响
  const c = makeCtx('别的群', { scope: 'group:OTHER' });
  await onOutbound(c.ctx, c.next);
  ok('不同会话冷却独立', c.state.media.length === 1);
}

// 6) mode=off 完全不碰
{
  setCfg({ enabled: true, mode: 'off', keepText: false });
  const { ctx, state, next } = makeCtx('关掉试试');
  await onOutbound(ctx, next);
  ok('mode=off 时原样放行', state.nextCalls === 1 && state.media.length === 0);
}

// 7) 合成失败（坏音色）→ 消息必须还在
{
  setCfg({ enabled: true, mode: 'always', keepText: false, cooldownMs: 0, voice: 'no-such-voice-xx' });
  const { ctx, state, next } = makeCtx('这条不能丢');
  await onOutbound(ctx, next);
  ok('合成失败时不摘消息', state.annihilated === false);
  ok('合成失败时文字照发', state.nextCalls === 1 && state.media.length === 0);
}

// 8) 非 text kind 不处理
{
  setCfg({ enabled: true, mode: 'always', keepText: false, cooldownMs: 0, voice: 'zh-CN-XiaoyiNeural' });
  const { ctx, state, next } = makeCtx('卡片内容', { kind: 'card' });
  await onOutbound(ctx, next);
  ok('kind!=text 不转', state.media.length === 0 && state.nextCalls === 1);
}

// 9) 非最后一块不转
{
  const { ctx, state, next } = makeCtx('中间块', { isLastChunk: false });
  await onOutbound(ctx, next);
  ok('非最后一块不转', state.media.length === 0 && state.nextCalls === 1);
}

// 收尾：把配置恢复成上线默认
setCfg({ enabled: true, mode: 'sometimes', prob: 0.35, voice: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+10Hz', maxChars: 70, minChars: 2, cooldownMs: 45000, keepText: false, timeoutMs: 20000 });

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
