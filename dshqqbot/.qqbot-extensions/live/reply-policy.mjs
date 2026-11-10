/**
 * live/reply-policy.mjs — 直播回复策略（纯函数，便于单测）
 *
 * 目标：
 *   1) 不逐条回复，SC / 大航海 / 达标礼物 / @ 与关键词优先；
 *   2) 全局与单用户双重限流，静默时段可配；
 *   3) 直播 token 预算比普通聊天更严：只在高价值事件上调用云端模型，其余走固定短句；
 *   4) 返回「为什么不回」，面板可见，便于调策略。
 */
import { EVENT_TYPES } from './event-model.mjs';

const LINK_RE = /(https?:\/\/|www\.|b23\.tv|\b[a-z0-9-]+\.(com|cn|net|top|vip)\b|加群|进群|qq群|vx号|微信号)/i;
const PHONE_RE = /\b1[3-9]\d{9}\b/;
const EMOJI_ONLY_RE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;

export const REASON = {
  OK: 'ok',
  DISABLED: 'reply-disabled',
  QUIET: 'quiet-hours',
  MIN_GAP: 'min-gap',
  RATE_MINUTE: 'rate-per-minute',
  RATE_HOUR: 'rate-per-hour',
  DAILY_CAP: 'daily-cap',
  USER_COOLDOWN: 'user-cooldown',
  USER_HOUR: 'user-hour-cap',
  DEDUP: 'duplicate',
  SELF: 'self-message',
  LINK: 'contains-link',
  PHONE: 'contains-phone',
  SKIP_WORD: 'skip-word',
  TOO_SHORT: 'too-short',
  EMOJI_ONLY: 'emoji-only',
  TYPE_IGNORED: 'type-ignored',
  LOW_INTEREST: 'low-interest',
  BUDGET_RESERVED: 'budget-reserved',
  NO_LLM_BUDGET: 'no-llm-budget',
};

export function dayKey(now = Date.now(), tz = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function clockMinutes(now, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
    const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return h * 60 + m;
  } catch {
    const d = new Date(now);
    return d.getHours() * 60 + d.getMinutes();
  }
}

export function parseRanges(list = []) {
  const out = [];
  for (const item of list) {
    const m = String(item || '').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    out.push([Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  }
  return out;
}

export function inQuietHours(cfg, now, tz = 'Asia/Shanghai') {
  const ranges = parseRanges(cfg?.quietHours || []);
  if (!ranges.length) return false;
  const cur = clockMinutes(now, tz);
  return ranges.some(([a, b]) => (a <= b ? cur >= a && cur < b : cur >= a || cur < b));
}

export function rollDay(state, now, tz = 'Asia/Shanghai') {
  const key = dayKey(now, tz);
  if (!state.day || state.day !== key) {
    state.day = key;
    state.counters = { replies: 0, drafts: 0, skipped: 0, errors: 0, llmCalls: 0, tokens: 0 };
    state.llmAt = [];
    state.sentAt = state.sentAt || [];
  }
  return state;
}

export function prune(state, now) {
  const t24 = now - 24 * 3600_000;
  state.sentAt = (state.sentAt || []).filter((t) => t >= t24);
  state.llmAt = (state.llmAt || []).filter((t) => t >= t24);
  const t2h = now - 2 * 3600_000;
  const perUser = {};
  for (const [uid, rec] of Object.entries(state.perUser || {})) {
    const sentAt = (rec.sentAt || []).filter((t) => t >= t2h);
    if (sentAt.length || rec.lastAt >= t2h) perUser[uid] = { lastAt: rec.lastAt || 0, sentAt };
  }
  state.perUser = perUser;
  const keys = {};
  for (const [k, at] of Object.entries(state.recentKeys || {})) {
    if (at >= t24) keys[k] = at;
  }
  state.recentKeys = keys;
  state.recentTexts = (state.recentTexts || []).filter((r) => r.at >= t2h).slice(-20);
  return state;
}

function globalBlockReason(state, cfg, now) {
  const sentAt = state.sentAt || [];
  const last = sentAt.length ? sentAt[sentAt.length - 1] : 0;
  if (now - last < Number(cfg.minGapMs || 0) && last) return REASON.MIN_GAP;
  if (sentAt.filter((t) => now - t < 60_000).length >= Number(cfg.maxPerMinute || 4)) return REASON.RATE_MINUTE;
  if (sentAt.filter((t) => now - t < 3600_000).length >= Number(cfg.maxPerHour || 30)) return REASON.RATE_HOUR;
  if ((state.counters?.replies || 0) >= Number(cfg.maxPerDay || 120)) return REASON.DAILY_CAP;
  return '';
}

function userBlockReason(state, cfg, uid, now) {
  if (!uid) return '';
  const rec = state.perUser?.[uid];
  if (!rec) return '';
  if (rec.lastAt && now - rec.lastAt < Number(cfg.perUserCooldownMs || 0)) return REASON.USER_COOLDOWN;
  if ((rec.sentAt || []).filter((t) => now - t < 3600_000).length >= Number(cfg.maxRepliesPerUserPerHour || 2)) return REASON.USER_HOUR;
  return '';
}

export function canUseLLM(state, cfg, now, { critical = false } = {}) {
  const llm = cfg.llm || {};
  const llmAt = state.llmAt || [];
  if (llmAt.filter((t) => now - t < 3600_000).length >= Number(llm.maxCallsPerHour || 10)) return false;
  if ((state.counters?.llmCalls || 0) >= Number(llm.maxCallsPerDay || 40)) return false;
  const maxTokens = Number(llm.maxTokensPerDay || 0);
  if (maxTokens && (state.counters?.tokens || 0) >= maxTokens) return false;
  if (!critical) {
    const reserve = Number(cfg.reserveRatio || 0) * Number(llm.maxCallsPerDay || 0);
    if ((state.counters?.llmCalls || 0) >= Number(llm.maxCallsPerDay || 40) - reserve) return false;
  }
  return true;
}

function containsSkipWord(text, cfg) {
  return (cfg.skipWords || []).some((w) => w && String(text).includes(w));
}

export function classify(event, cfg) {
  const text = String(event?.text || '').trim();
  const mention = (cfg.mentionNames || []).some((n) => n && text.includes(n));
  const keyword = (cfg.keywords || []).some((k) => k && text.includes(k));
  const question = /[?？]/.test(text) || /吗$|呢$|怎么|为什么|多少|有没有/.test(text);
  switch (event?.type) {
    case EVENT_TYPES.SUPERCHAT: return { priority: 10, critical: true, useLLM: true, interest: 'superchat' };
    case EVENT_TYPES.GUARD: return { priority: 9, critical: true, useLLM: true, interest: 'guard' };
    case EVENT_TYPES.GIFT: {
      const total = event.amount?.coins || 0;
      if (event.gift?.paid && total >= Number(cfg.giftMinPrice || 0)) return { priority: 7, critical: false, useLLM: true, interest: 'gift' };
      return { priority: 2, critical: false, useLLM: false, interest: 'gift-small' };
    }
    case EVENT_TYPES.DANMAKU: {
      if (mention) return { priority: 6, critical: false, useLLM: true, interest: 'mention' };
      if (keyword) return { priority: 5, critical: false, useLLM: true, interest: 'keyword' };
      if (question) return { priority: 4, critical: false, useLLM: true, interest: 'question' };
      return { priority: 1, critical: false, useLLM: false, interest: 'chat' };
    }
    case EVENT_TYPES.FOLLOW: return { priority: 3, critical: false, useLLM: false, interest: 'follow' };
    case EVENT_TYPES.ENTER: return { priority: 0, critical: false, useLLM: false, interest: 'enter' };
    default: return { priority: 0, critical: false, useLLM: false, interest: 'other' };
  }
}

/**
 * @returns {{reply:boolean, reason:string, priority:number, useLLM:boolean, interest:string, tier:string}}
 */
export function decide(event, cfg, state, { now = Date.now(), rand = Math.random } = {}) {
  const base = { reply: false, reason: REASON.OK, priority: 0, useLLM: false, interest: 'other', tier: 'template' };
  if (!cfg || cfg.enabled === false) return { ...base, reason: REASON.DISABLED };
  if (!event) return { ...base, reason: REASON.TYPE_IGNORED };
  if (event.user?.self) return { ...base, reason: REASON.SELF };

  const c = classify(event, cfg);
  base.priority = c.priority;
  base.interest = c.interest;

  if (event.type === EVENT_TYPES.ENTER) {
    return { ...base, reason: cfg.replyToEnter ? REASON.OK : REASON.TYPE_IGNORED };
  }
  if (event.type === EVENT_TYPES.FOLLOW && cfg.replyToFollow === false) return { ...base, reason: REASON.TYPE_IGNORED };
  if ([EVENT_TYPES.LIKE, EVENT_TYPES.WATCH, EVENT_TYPES.LIVE_START, EVENT_TYPES.LIVE_END, EVENT_TYPES.UNKNOWN].includes(event.type)) {
    return { ...base, reason: REASON.TYPE_IGNORED };
  }

  if (event.type === EVENT_TYPES.DANMAKU) {
    const text = String(event.text || '').trim();
    if (!text) return { ...base, reason: REASON.TOO_SHORT };
    if (text.length < 2) return { ...base, reason: REASON.TOO_SHORT };
    if (LINK_RE.test(text)) return { ...base, reason: REASON.LINK };
    if (PHONE_RE.test(text)) return { ...base, reason: REASON.PHONE };
    if (EMOJI_ONLY_RE.test(text)) return { ...base, reason: REASON.EMOJI_ONLY };
    if (containsSkipWord(text, cfg)) return { ...base, reason: REASON.SKIP_WORD };
    if (/^(.)\1{6,}$/.test(text)) return { ...base, reason: REASON.LOW_INTEREST };
    if ((state.recentKeys || {})[event.key]) return { ...base, reason: REASON.DEDUP };
  }

  if (inQuietHours(cfg, now) && !(c.critical && cfg.quietAllowCritical !== false)) {
    return { ...base, reason: REASON.QUIET };
  }

  const blocked = globalBlockReason(state, cfg, now);
  if (blocked) return { ...base, reason: blocked };

  const ub = userBlockReason(state, cfg, event.user?.id, now);
  if (ub && !c.critical) return { ...base, reason: ub };

  if (c.priority <= 1 && !c.critical) {
    // 普通弹幕：抽样 + 给高价值事件预留配额
    const maxDay = Number(cfg.maxPerDay || 120);
    const reserve = Math.floor(maxDay * Number(cfg.reserveRatio || 0));
    if ((state.counters?.replies || 0) >= maxDay - reserve) return { ...base, reason: REASON.BUDGET_RESERVED };
    if (rand() >= Number(cfg.chatSampleRate ?? 0.12)) return { ...base, reason: REASON.LOW_INTEREST };
  }
  if (c.interest === 'question' && rand() >= Number(cfg.questionSampleRate ?? 0.5)) {
    return { ...base, reason: REASON.LOW_INTEREST };
  }
  if (c.interest === 'gift-small' && rand() >= 0.5) {
    return { ...base, reason: REASON.LOW_INTEREST };
  }

  let useLLM = Boolean(c.useLLM);
  if (useLLM && !canUseLLM(state, cfg, now, { critical: c.critical })) useLLM = false;

  return {
    ...base,
    reply: true,
    reason: REASON.OK,
    useLLM,
    tier: useLLM ? 'llm' : 'template',
  };
}

export function sanitizeReply(input, maxChars = 26) {
  let s = String(input || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/(^|\s)@?\S+\.(com|cn|net|tv|top|vip)\b/gi, ' ')
    .replace(/@\S+/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  s = s.replace(/我是(?:AI|人工智能|机器人|语言模型)/gi, '').trim();
  const chars = Array.from(s);
  if (chars.length > maxChars) s = chars.slice(0, maxChars).join('').replace(/[，,、]$/,'') + '…';
  return s;
}

const CHAT_LINES = [
  '我在呢，咕噜～',
  '这条看到啦，咕噜噜',
  '慢慢看就好，不着急～',
  '有道理，咕噜',
  '这个我也好奇，咕噜～',
  '先记下来，等会儿聊',
];

export function pickTemplate(event, cfg, state = {}, rand = Math.random) {
  const name = String(event?.user?.name || '').slice(0, 12);
  const gift = String(event?.gift?.name || '').slice(0, 12);
  const args = event?.amount?.rmb ? `${event.amount.rmb} 元` : '';
  let lines;
  if (event?.type === EVENT_TYPES.SUPERCHAT) {
    lines = [`谢谢你的醒目留言${args ? '（' + args + '）' : ''}，咕噜，我看到啦`, '你的留言我认真看了，咕噜～', '谢谢留言，咕噜，等我说完这句就回你'];
  } else if (event?.type === EVENT_TYPES.GUARD) {
    lines = [`谢谢${name || '你'}上舰，咕噜噜，记在心里了`, '大航海收到，咕噜～常来玩', `谢谢${name || '你'}的舰长，咕噜噜`];
  } else if (event?.type === EVENT_TYPES.GIFT) {
    lines = [`谢谢${name || '你'}的${gift || '礼物'}，咕噜～`, `${gift || '礼物'}收到啦，咕噜噜`, `谢谢${name || '你'}，咕噜，破费了`];
  } else if (event?.type === EVENT_TYPES.FOLLOW) {
    lines = [`谢谢${name || '你'}关注，咕噜～`, '新朋友来啦，咕噜噜，常来玩', '关注收到，咕噜～'];
  } else if (event?.interest === 'mention' || (cfg.mentionNames || []).some((n) => n && String(event?.text || '').includes(n))) {
    lines = ['我在，咕噜～', '叫我就到，咕噜噜', '听到啦，咕噜～'];
  } else if (event?.type === EVENT_TYPES.ENTER) {
    lines = ['咕噜，来了这么多人，慢慢看就好～', '欢迎来玩，咕噜噜'];
  } else {
    lines = CHAT_LINES;
  }
  const recent = (state.recentTexts || []).map((r) => r.text);
  const avail = lines.filter((x) => !recent.includes(x));
  const pool = avail.length ? avail : lines;
  const text = pool[Math.floor(rand() * pool.length)] || lines[0];
  return sanitizeReply(text, Number(cfg.maxChars || 26));
}

export function estimateTokens(promptChars, maxOutputTokens) {
  return Math.ceil(Number(promptChars || 0) / 1.8) + Number(maxOutputTokens || 0);
}
