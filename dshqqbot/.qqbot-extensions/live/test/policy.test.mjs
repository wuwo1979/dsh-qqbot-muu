import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, inQuietHours, sanitizeReply, pickTemplate, REASON } from '../reply-policy.mjs';
import { normalizeBiliWeb } from '../event-model.mjs';

const cfg = {
  enabled: true,
  mentionNames: ['小蓝'],
  keywords: ['点歌'],
  minGapMs: 8000,
  maxPerMinute: 4,
  maxPerHour: 30,
  maxPerDay: 120,
  perUserCooldownMs: 600000,
  maxRepliesPerUserPerHour: 2,
  chatSampleRate: 0,
  questionSampleRate: 0.5,
  giftMinPrice: 5000,
  replyToFollow: true,
  replyToEnter: false,
  quietHours: [],
  reserveRatio: 0.2,
  maxChars: 26,
  skipWords: ['加微', '加v', '代练', '刷单', '网赚', '私聊', '接单'],
  llm: { maxCallsPerHour: 10, maxCallsPerDay: 40, maxTokensPerDay: 12000 },
};

function danmaku(text, uid = 7) {
  return normalizeBiliWeb({
    cmd: 'DANMU_MSG',
    info: [['x', 0, 25, 0, 1700000000000, 0, 0, 'h-' + text], text, [uid, '观众', 0], [0, '']],
  }, {});
}

function baseState(extra = {}) {
  return { day: '', sentAt: [], llmAt: [], perUser: {}, recentKeys: {}, recentTexts: [], counters: { replies: 0, llmCalls: 0, tokens: 0 }, ...extra };
}

test('关闭回复 / 静默时段 / 最小间隔', () => {
  const ev = danmaku('小蓝在吗');
  assert.equal(decide(ev, { ...cfg, enabled: false }, baseState()).reason, REASON.DISABLED);
  const now = Date.now();
  const quiet = decide(ev, { ...cfg, quietHours: ['00:00-23:59'] }, baseState(), { now });
  assert.equal(quiet.reason, REASON.QUIET);
  const gap = decide(ev, cfg, baseState({ sentAt: [now - 1000] }), { now, rand: () => 0 });
  assert.equal(gap.reason, REASON.MIN_GAP);
});

test('@ 与关键词优先，普通弹幕不逐条回', () => {
  const state = baseState();
  const mention = decide(danmaku('小蓝在吗'), cfg, state, { rand: () => 0 });
  assert.equal(mention.reply, true);
  assert.equal(mention.useLLM, true);
  const normal = decide(danmaku('今天天气不错'), cfg, state, { rand: () => 0.99 });
  assert.equal(normal.reply, false);
  assert.equal(normal.reason, REASON.LOW_INTEREST);
});

test('链接/广告/纯表情/重复文本不回复', () => {
  const state = baseState();
  assert.equal(decide(danmaku('看 https://x.com'), cfg, state).reason, REASON.LINK);
  assert.equal(decide(danmaku('加v 接单'), cfg, state).reason, REASON.SKIP_WORD);
  assert.equal(decide(danmaku('🐟🐟🐟'), cfg, state).reason, REASON.EMOJI_ONLY);
  const ev = danmaku('小蓝小蓝');
  state.recentKeys[ev.key] = Date.now();
  assert.equal(decide(ev, cfg, state).reason, REASON.DEDUP);
});

test('单用户冷却与 SC 例外', () => {
  const now = Date.now();
  const ev = danmaku('小蓝小蓝', 7);
  const state = baseState({ perUser: { [ev.user.id]: { lastAt: now - 1000, sentAt: [now - 1000] } } });
  assert.equal(decide(ev, cfg, state, { now, rand: () => 0 }).reason, REASON.USER_COOLDOWN);
  const sc = { ...ev, type: 'superchat', amount: { rmb: 30 } };
  const d = decide(sc, cfg, state, { now, rand: () => 0 });
  assert.equal(d.reply, true);
  assert.equal(d.useLLM, true);
});

test('LLM 预算耗尽时降级为模板', () => {
  const ev = danmaku('小蓝在吗');
  const state = baseState({ counters: { replies: 0, llmCalls: 40, tokens: 0 } });
  const d = decide(ev, cfg, state, { rand: () => 0 });
  assert.equal(d.reply, true);
  assert.equal(d.useLLM, false);
});

test('回复文本清洗与模板', () => {
  assert.equal(sanitizeReply('  @某人  你好 https://x.com ', 10).includes('http'), false);
  assert.ok(sanitizeReply('很长的回复'.repeat(10), 8).length <= 9);
  const t = pickTemplate({ type: 'gift', user: { name: '老板' }, gift: { name: '小花花' }, amount: { rmb: 5 } }, cfg, {}, () => 0);
  assert.ok(t.includes('老板') || t.includes('谢谢'));
  assert.ok(inQuietHours({ quietHours: ['23:00-07:00'] }, new Date(2026, 0, 1, 2, 0).getTime()));
});
