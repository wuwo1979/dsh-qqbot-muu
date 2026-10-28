/**
 * qq-history-import.mjs — 历史 QQ 聊天记录导入（本地、脱敏、按人隔离）
 *
 * 为什么不能"读进来就全存"：
 *   群聊里 80%~90% 是寒暄——"在吗""哈哈""收到""[图片]"。这些句子一旦进了
 *   记忆库，向量检索会被它们挤满，真正有信息的那几句反而召不回来。所以这里
 *   先用信息量打分筛一遍，只留"像事实/像态度/像承诺"的句子。
 *
 * 为什么必须先脱敏：
 *   聊天记录里天然夹着手机号、身份证、邮箱、银行卡、别人的 QQ 号。记忆库是
 *   长期持久化的，一旦写进去就很难追回。所以**脱敏发生在入库之前**，且默认
 *   开启，不是事后补救。
 *
 * 为什么按 person 分 scope：
 *   数据隔离靠 scope 实现——A 的记忆只在 `person:qq:<A>` 里，B 的召回永远
 *   看不到。同一个人换了昵称也会归到同一个 personId（见 person-registry），
 *   避免"同一个人被拆成五份记忆、画像互相打架"。
 *
 * 人物归一：
 *   QQ 号优先，昵称只作 alias。同昵称不同号**不合并**（那是两个人）。
 *
 * 支持格式：
 *   · QQ 客户端"导出消息记录"生成的 .txt（时间行 + 昵称(QQ号) + 多行正文）
 *   · 通用 JSON（字段名宽松匹配，见 pickField）
 *
 * 本地模型：导入本身不需要 LLM。需要"提炼印象"时，画像走统计（活跃时段、
 * 高频词、提问率、语气），不依赖模型也能给出稳定结论；调用方可另外接入本地
 * LLM 做更细的性格推断。
 */

import { existsSync, readFileSync } from 'node:fs';

import { remember } from './memory-db.mjs';
import { archiveMessages } from './chatlog-db.mjs';
import {
  loadRegistry, saveRegistry, registerPerson, personIdOf, normalizeNick,
} from './person-registry.mjs';

// ── 解析 ────────────────────────────────────────────────────────────────
// "2024-01-15 20:31:02 张三(123456789)"  —— 昵称后面括号里的就是 QQ 号
const RE_TXT_HEAD = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s+(.{1,40}?)\s*(?:[（(](\d{4,12})[）)])?\s*$/;

const RE_OBJ_TIME = ['time', 'date', 'timestamp', 'timeStr', 'sendTime'];
const RE_OBJ_NICK = ['sender', 'from', 'nick', 'nickname', 'name', 'senderName', 'fromName'];
const RE_OBJ_UIN = ['uin', 'qq', 'senderUin', 'fromUin', 'userId', 'uid'];
const RE_OBJ_TEXT = ['content', 'text', 'msg', 'message', 'body'];

function pickField(obj, names) {
  for (const n of names) {
    if (obj && obj[n] != null && String(obj[n]).trim() !== '') return String(obj[n]);
  }
  return '';
}

function parseTime(s) {
  const t = String(s || '').trim().replace(/\//g, '-');
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const n = Number(s);
    if (Number.isFinite(n) && n > 1e9) return n > 1e12 ? n : n * 1000;
    return 0;
  }
  const [, Y, M, D, h, mi, se] = m;
  return new Date(+Y, +M - 1, +D, +h, +mi, +(se || 0)).getTime();
}

/** 解析 QQ 导出的纯文本记录 */
export function parseQQText(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const msgs = [];
  let cur = null;
  let n = 0;
  for (const line of lines) {
    const m = line.match(RE_TXT_HEAD);
    // 排除"消息记录""消息分组"这类表头行被误判
    if (m && !/^消息/.test(line)) {
      if (cur) msgs.push(cur);
      n += 1;
      cur = {
        seq: n,
        ts: parseTime(`${m[1]} ${m[2]}`),
        nick: String(m[3] || '').trim(),
        uin: String(m[4] || '').trim(),
        lines: [],
      };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) msgs.push(cur);

  return msgs.map((x) => ({
    seq: x.seq,
    ts: x.ts,
    nick: x.nick,
    uin: x.uin,
    text: x.lines.join('\n').trim(),
  })).filter((x) => x.text);
}

/** 解析 JSON 导出（字段名宽松匹配） */
export function parseQQJson(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data
    : Array.isArray(data?.messages) ? data.messages
      : Array.isArray(data?.data) ? data.data
        : [];
  return arr.map((it, i) => ({
    seq: i + 1,
    ts: parseTime(pickField(it, RE_OBJ_TIME)),
    nick: pickField(it, RE_OBJ_NICK),
    uin: pickField(it, RE_OBJ_UIN).replace(/\D/g, ''),
    text: pickField(it, RE_OBJ_TEXT).trim(),
  })).filter((x) => x.text);
}

/** 自动判格式：能 JSON 就 JSON，否则按 txt */
export function parseHistory(raw) {
  const s = String(raw || '').trim();
  if (!s) return { format: 'empty', messages: [] };
  if (s.startsWith('[') || s.startsWith('{')) {
    const j = parseQQJson(s);
    if (j.length) return { format: 'json', messages: j };
  }
  const t = parseQQText(raw);
  return { format: t.length ? 'qq-text' : 'unknown', messages: t };
}

// ── 脱敏 ────────────────────────────────────────────────────────────────
/**
 * 入库前脱敏。顺序有讲究：先长串（身份证/银行卡）再短串（QQ 号），
 * 否则短模式会把长串切碎，留下残余数字。
 */
export function maskPrivacy(text) {
  let t = String(text || '');
  // 身份证：保留前 6 后 4
  t = t.replace(/(?<!\d)(\d{6})\d{8}(\d{3}[\dXx])(?!\d)/g, '$1********$2');
  // 银行卡：16~19 位连续数字，只留后 4
  t = t.replace(/(?<!\d)\d{12,15}(\d{4})(?!\d)/g, '**** **** **** $1');
  // 手机号
  t = t.replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2');
  // 邮箱：本地部分只留首字符
  t = t.replace(/([\w.+-])[\w.+-]*@([\w-]+\.[\w.]+)/g, '$1***@$2');
  // 剩下的 5~12 位纯数字当 QQ 号处理（年份 4 位不受影响）。
  // 前后不能是数字或 *：否则身份证"保留前6位"留下的那段又会被二次打码。
  t = t.replace(/(?<![\d*])(\d{2})\d{1,8}(\d{2})(?![\d*])/g, '$1***$2');
  return t;
}

// ── 信息量筛选 ──────────────────────────────────────────────────────────
const RE_PLACEHOLDER = /^\s*\[(图片|表情|语音|视频|文件|动画表情|位置|链接|转账|红包)\]\s*$/;
const RE_FILLER = /^(哈+|嗯+|哦+|啊+|呀+|呃+|嘿+|额+|好+|在吗|在不在|在的|收到|好的|行|可以|没事|谢谢|多谢|晚安|早安|早|拜拜|88|666+|\.{2,})$/;
const RE_SIGNAL = /(因为|所以|但是|不过|如果|然后|其实|应该|可能|觉得|认为|喜欢|讨厌|想要|打算|计划|决定|记得|答应|说过|告诉我|发现|感觉|担心|希望|一定要|千万别|注意|小心|推荐|建议|问题|办法|解决|工作|项目|考试|加班|生病|医院|搬家|结婚|生日|旅行|游戏|电影|音乐|咖啡|猫|狗)/;

/**
 * 一句话的"信息量"打分 0~1。
 * 目标不是挑出文采最好的，而是挑出"以后还会用到"的：事实、态度、承诺。
 */
export function infoScore(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  if (RE_PLACEHOLDER.test(t)) return 0;
  const bare = t.replace(/[\s，。！？、；：…—·,.!?;:~"'（）()【】\[\]]/g, '');
  if (bare.length < 6) return 0;
  if (RE_FILLER.test(bare)) return 0;
  // 同一字符重复超过 60%（"哈哈哈哈哈哈"）→ 无信息
  const uniq = new Set(bare).size;
  if (uniq / bare.length < 0.35) return 0;

  let s = Math.min(0.55, bare.length / 40);
  if (RE_SIGNAL.test(t)) s += 0.30;
  if (/\d/.test(t)) s += 0.06;
  if (/[？！?!]/.test(t)) s += 0.05;
  if (bare.length >= 12) s += 0.06;
  return Math.min(1, s);
}

// ── 指定对话：把一个导出文件裁成"我和某个人" ───────────────────────────
/**
 * QQ「导出全部消息记录」得到的是**所有会话混在一起**的一个文件；
 * 「导出单个联系人」才只有一段对话。所以导入前必须先能按人裁。
 *
 * 判定规则：
 *   · peer 是纯数字（≥5 位）→ 只认 QQ 号，昵称一律不匹配（防重名串号）；
 *   · 否则按规范化昵称匹配（"张三(管理员)" 与 "张三" 视为同一人）；
 *   · 自己的消息靠 selfUin / selfNames 认；认不出来时看文件像不像一对一：
 *     非 peer 的发言人 ≤ 2 个 → 当作对话另一侧保留，否则只留 peer 的话并提示补 --self-uin。
 */
function digitsOf(s) {
  return String(s || '').replace(/\D/g, '');
}

function uinOf(m) {
  return digitsOf(m?.uin);
}

function isSelfMsg(m, selfUin, selfNames) {
  const u = uinOf(m);
  if (selfUin && u && u === selfUin) return true;
  const n = normalizeNick(m?.nick);
  return !!(n && selfNames.has(n));
}

function peerMatcher(peer) {
  const p = String(peer || '').trim();
  if (!p) return () => true;
  if (/^\d{5,}$/.test(p)) return (m) => uinOf(m) === p;
  const n = normalizeNick(p);
  return (m) => (n && normalizeNick(m.nick) === n) || uinOf(m) === p;
}

/**
 * @returns {{messages:Array, kept:number, dropped:number, selfCount:number,
 *            others:Array<{nick:string,n:number}>, needSelfUin:boolean, peer:string}}
 */
export function filterConversation(messages, { peer = '', selfUin = '', selfNames = [], keepSelf = true } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const p = String(peer || '').trim();
  if (!p) {
    return { messages: [...list], kept: list.length, dropped: 0, selfCount: 0, others: [], needSelfUin: false, peer: '' };
  }
  const isPeer = peerMatcher(p);
  const su = digitsOf(selfUin);
  const sn = new Set((Array.isArray(selfNames) ? selfNames : [selfNames]).map((x) => normalizeNick(x)).filter(Boolean));

  const peerRows = [];
  const selfRows = [];
  const thirdRows = [];
  const otherNick = new Map();
  for (const m of list) {
    if (isPeer(m)) { peerRows.push(m); continue; }
    if (isSelfMsg(m, su, sn)) { selfRows.push(m); continue; }
    const k = normalizeNick(m.nick) || uinOf(m) || '?';
    otherNick.set(k, (otherNick.get(k) || 0) + 1);
    thirdRows.push(m);
  }

  const others = [...otherNick.entries()].map(([nick, n]) => ({ nick, n })).sort((a, b) => b.n - a.n);
  const selfKnown = selfRows.length > 0;
  // 认得"我" → 这段对话的另一侧就是"我"，文件里其余发言人属于别的会话，一律不要；
  // 认不出"我" → 只有非 peer 发言人恰好只有 1 个（一对一导出）才敢把他当另一侧。
  const useSelf = keepSelf && selfKnown;
  const useThird = keepSelf && !selfKnown && others.length <= 1;
  const out = [];
  for (const m of peerRows) out.push({ ...m, __self: false });
  if (useSelf) for (const m of selfRows) out.push({ ...m, __self: true });
  if (useThird) for (const m of thirdRows) out.push({ ...m, __self: false });
  out.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  return {
    messages: out,
    kept: out.length,
    dropped: list.length - out.length,
    selfCount: useSelf ? selfRows.length : 0,
    others: others.slice(0, 8),
    needSelfUin: keepSelf && !selfKnown && others.length > 1,
    peer: p,
  };
}

/** 把裁好的对话标上方向：peer 侧 in，另一侧 out（供台账/切片/画像共用一套口径） */
function orient(messages, label = '我') {
  return messages.map((m) => ({
    ...m,
    dir: m.__self || m.dir === 'out' ? 'out' : 'in',
    label: m.__self || m.dir === 'out' ? label : '',
  }));
}

// ── 双方画像（统计口径，不依赖模型）───────────────────────────────────
// 二元组跨词边界会产生「个思」（换个思路）这种垃圾词，所以任一字是虚词就整组丢掉。
// 与 profileOf 的 STOP_CHARS 同口径，避免两个画像说两套话。
const STOP1 = new Set('的了吗呢吧啊呀哈嗯哦噢喔是在有我你他她它们这那就都也很不没要会说想去来看给对可以什么怎么一个上下来过还又能得着把被让从到和与或但因为所以时候自己现在知道觉得真的这样那个然后其实只是我们你们他们'.split(''));

function topBigrams(list, { min = 2, limit = 6 } = {}) {
  const m = new Map();
  for (const t of list) {
    const bare = String(t || '').replace(/[^\u4e00-\u9fa5]/g, '');
    for (let i = 0; i + 2 <= bare.length; i += 1) {
      const bg = bare.slice(i, i + 2);
      if (STOP1.has(bg[0]) || STOP1.has(bg[1])) continue;
      m.set(bg, (m.get(bg) || 0) + 1);
    }
  }
  return [...m.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

function statsOf(list) {
  const n = list.length;
  const chars = list.reduce((a, m) => a + String(m.text || '').length, 0);
  const q = list.filter((m) => /[？?]/.test(String(m.text || ''))).length;
  const ex = list.filter((m) => /[！!]/.test(String(m.text || ''))).length;
  const hours = new Array(24).fill(0);
  for (const m of list) {
    const ts = Number(m.ts) || 0;
    if (ts) hours[new Date(ts).getHours()] += 1;
  }
  const topHours = hours.map((c, h) => [h, c]).filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
  return {
    n,
    avgLen: n ? Math.round((chars / n) * 10) / 10 : 0,
    questionRate: n ? Math.round((q / n) * 100) / 100 : 0,
    exclaimRate: n ? Math.round((ex / n) * 100) / 100 : 0,
    topHours,
  };
}

/**
 * 对话双方的画像：谁话多、谁先开口、回得多快、共同话题是什么。
 * 单看一个人说的话只能得出"这人爱聊技术"，看不出"我们俩怎么相处"——
 * 后者恰恰是记忆里最像人的那一层。
 */
export function pairProfileOf(messages, { gapMs = 30 * 60 * 1000 } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && String(m.text || '').trim());
  if (!list.length) return null;
  const a = list.filter((m) => m.dir !== 'out');
  const b = list.filter((m) => m.dir === 'out');
  if (!a.length || !b.length) return null;

  // 会话切分：间隔超过 30 分钟算新一段，用"谁先开口"看主动性
  let sessions = 0;
  let aStart = 0;
  let bStart = 0;
  let prev = null;
  for (const m of list) {
    const ts = Number(m.ts) || 0;
    if (!prev || (ts && prev && ts - prev > gapMs)) {
      sessions += 1;
      if (m.dir === 'out') bStart += 1; else aStart += 1;
    }
    prev = ts || prev;
  }

  // 回应时延：对方说完 → 这一侧开口的间隔中位数（只取 30 分钟内的，跨天才回不算"快"）
  const gaps = { in: [], out: [] };
  for (let i = 1; i < list.length; i += 1) {
    const p = list[i - 1];
    const c = list[i];
    if (p.dir === c.dir) continue;
    const d = (Number(c.ts) || 0) - (Number(p.ts) || 0);
    if (d > 0 && d < gapMs) gaps[c.dir === 'out' ? 'out' : 'in'].push(d);
  }
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((x, y) => x - y);
    return Math.round(s[Math.floor(s.length / 2)] / 60000);
  };

  const sa = statsOf(a);
  const sb = statsOf(b);
  const ta = topBigrams(a.map((m) => m.text), { limit: 40 });
  const tb = topBigrams(b.map((m) => m.text), { limit: 40 });
  const tbSet = new Set(tb);
  const shared = ta.filter((w) => tbSet.has(w)).slice(0, 6);

  const tsList = list.map((m) => Number(m.ts) || 0).filter(Boolean).sort((x, y) => x - y);
  return {
    turns: list.length,
    sessions,
    starts: { other: aStart, me: bStart },
    other: sa,
    me: sb,
    replyMinutes: { other: median(gaps.in), me: median(gaps.out) },
    sharedTopics: shared,
    otherTopics: ta.slice(0, 6),
    spanDays: tsList.length ? Math.max(1, Math.round((tsList[tsList.length - 1] - tsList[0]) / 86400000)) : 0,
    firstTs: tsList[0] || 0,
    lastTs: tsList[tsList.length - 1] || 0,
  };
}

/** 把双方画像写成人话（≤ 200 字），作为一条 kind=relation 的记忆 */
export function describePair(pair, { otherName = 'TA', meName = '我' } = {}) {
  if (!pair) return '';
  const parts = [];
  const day = (ts) => { try { return new Date(ts).toISOString().slice(0, 10); } catch { return ''; } };
  parts.push(`从 ${day(pair.firstTs)} 到 ${day(pair.lastTs)} 约 ${pair.spanDays} 天里，我和${otherName}有 ${pair.turns} 轮对话`);
  parts.push(`${otherName} ${pair.other.n} 条（平均 ${pair.other.avgLen} 字，问句 ${Math.round(pair.other.questionRate * 100)}%），${meName} ${pair.me.n} 条（平均 ${pair.me.avgLen} 字）`);
  if (pair.other.topHours.length) parts.push(`${otherName}常在 ${pair.other.topHours.map((h) => `${h}点`).join('、')} 出现`);
  if (pair.sessions >= 3) {
    const a = pair.starts.other;
    const b = pair.starts.me;
    if (a > b * 1.5) parts.push(`多数是${otherName}先开口（${a}/${pair.sessions} 次）`);
    else if (b > a * 1.5) parts.push(`多数是${meName}先开口（${b}/${pair.sessions} 次）`);
  }
  if (pair.replyMinutes.other > 0) parts.push(`${otherName}平均 ${pair.replyMinutes.other} 分钟内回`);
  if (pair.sharedTopics.length) parts.push(`两人都常聊「${pair.sharedTopics.slice(0, 5).join('」「')}」`);
  else if (pair.otherTopics.length) parts.push(`${otherName}常聊「${pair.otherTopics.slice(0, 4).join('」「')}」`);
  return parts.join('，') + '。';
}

// ── 画像 ────────────────────────────────────────────────────────────────
const STOP_CHARS = new Set('的了吗呢吧啊呀哈嗯哦噢喔是在有我你他她它们这那就都也很不没要会说想去来看给对可以什么怎么一个上下来过还又能得着把被让从到和与或但因为所以时候自己现在知道觉得真的这样那个然后其实只是'.split(''));

/**
 * 统计式画像。不依赖大模型也能稳定：活跃时段、长度、提问率、高频词。
 * 这是"对某个人的印象"的骨架，接本地 LLM 可以在上面补充性格描述。
 */
export function profileOf(messages) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.text) : [];
  const n = list.length;
  if (!n) return null;

  const hours = new Array(24).fill(0);
  let chars = 0;
  let q = 0;
  let ex = 0;
  const bigram = new Map();

  for (const m of list) {
    const t = String(m.text);
    chars += t.length;
    if (m.ts) {
      const h = new Date(m.ts).getHours();
      if (h >= 0 && h < 24) hours[h] += 1;
    }
    if (/[？?]/.test(t)) q += 1;
    if (/[！!]/.test(t)) ex += 1;
    // 用 2-gram 近似分词：中文没有现成词典时，二元组足够看出话题
    const bare = t.replace(/[^\u4e00-\u9fa5]/g, '');
    for (let i = 0; i + 2 <= bare.length && i < 80; i += 1) {
      const bg = bare.slice(i, i + 2);
      if (STOP_CHARS.has(bg[0]) || STOP_CHARS.has(bg[1])) continue;
      bigram.set(bg, (bigram.get(bg) || 0) + 1);
    }
  }

  const topHours = hours.map((c, h) => [h, c]).filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
  const topWords = [...bigram.entries()].filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);

  return {
    count: n,
    avgLen: Math.round((chars / n) * 10) / 10,
    activeHours: topHours,
    topWords,
    questionRate: Math.round((q / n) * 100) / 100,
    exclaimRate: Math.round((ex / n) * 100) / 100,
  };
}

/** 把画像写成人话，作为一条 kind=impression 的记忆 */
export function describeProfile(p, name = 'TA') {
  if (!p) return '';
  const parts = [];
  parts.push(`${name}在记录里出现 ${p.count} 次，平均每次 ${p.avgLen} 字`);
  if (p.activeHours.length) {
    parts.push(`常在 ${p.activeHours.map((h) => `${h}点`).join('、')} 出现`);
  }
  if (p.topWords.length) parts.push(`常聊「${p.topWords.slice(0, 6).join('」「')}」`);
  if (p.questionRate > 0.15) parts.push(`问句占 ${Math.round(p.questionRate * 100)}%，爱追问`);
  if (p.exclaimRate > 0.2) parts.push('语气偏外放');
  else if (p.exclaimRate < 0.05) parts.push('语气偏克制');
  return parts.join('，') + '。';
}

// ── 导入主流程 ──────────────────────────────────────────────────────────
/** 归档到哪个会话 scope：显式给的优先；否则按 peer 推断（QQ 号命名空间与运行时 openid 分开） */
export function archiveScopeOf({ scope = '', peer = '', groupId = '' } = {}) {
  const s = String(scope || '').trim();
  if (s) return s;
  const p = String(peer || '').trim();
  if (/^\d{5,}$/.test(p)) return 'c2c:qq:' + p;
  if (groupId) return 'group:' + String(groupId);
  if (p) return 'c2c:' + (normalizeNick(p) || p);
  return '';
}

/**
 * @param {object} opts
 *   raw / file     聊天记录内容或路径（二选一）
 *   dataRoot       记忆库根目录
 *   groupId        群号（写入 person 归属，可选）
 *   peer           只导入与这个人的对话（QQ 号或昵称）；不传 = 文件里所有人都导入
 *   selfUin        自己的 QQ 号（用于把"我"和"对方"分开，1v1 导出建议传）
 *   selfNames      自己的昵称数组（备用识别）
 *   archive        true 时把**完整**对话写进聊天台账（不筛信息量、放宽截断）
 *   scope          显式指定归档到的会话 scope（默认按 peer 推断）
 *   archiveMaxChars 归档单条上限（默认 2000）
 *   pair           是否生成"双方画像"关系记忆（默认 true，需要识别出两侧）
 *   digest         传入函数时，归档后调用它做历史印象归纳（异步、可失败）
 *   scopeMode      'person'（默认，按人隔离）| 'group'（整群一个 scope）
 *   minScore       信息量门槛（默认 0.55）
 *   limit          单次最多写入多少条记忆（默认 400，防止一次灌爆；不影响归档）
 *   mask           是否脱敏（默认 true，不要关）
 *   dryRun         true 时只出报告不写库
 * @returns {Promise<object>} 导入报告
 */
export async function importHistory(opts = {}) {
  const started = Date.now();
  const report = {
    ok: false, format: 'unknown', parsed: 0, filtered: 0, selfSkipped: 0, kept: 0, masked: 0,
    added: 0, deduped: 0, failed: 0, people: 0, dryRun: !!opts.dryRun, samples: [],
    peer: String(opts.peer || ''), archived: 0, archiveScope: '', pair: '', needSelfUin: false,
  };

  let raw = String(opts.raw || '');
  if (!raw && opts.file) {
    if (!existsSync(opts.file)) return { ...report, error: 'file-not-found: ' + opts.file };
    try {
      raw = readFileSync(opts.file, 'utf8');
    } catch (e) {
      return { ...report, error: 'read-failed: ' + (e?.message ?? e) };
    }
  }
  if (!raw.trim()) return { ...report, error: 'empty-input' };

  const { format, messages: all } = parseHistory(raw);
  report.format = format;
  report.parsed = all.length;
  if (!all.length) return { ...report, error: 'no-messages-parsed' };

  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 0.55;
  const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 400));
  const mask = opts.mask !== false;
  const dataRoot = String(opts.dataRoot || '.');
  const scopeMode = String(opts.scopeMode || 'person');
  // 运行时认人用 openid（person:qq:<openid>），QQ 导出只有 QQ 号。
  // 指定 personScope 时把画像写到运行时能读到的 scope；多人文件由 CLI 保证不传。
  const personScope = String(opts.personScope || '').trim();
  const archiveMaxChars = Number(opts.archiveMaxChars) || 2000;
  const selfUin = String(opts.selfUin || '').replace(/\D/g, '');

  // ① 裁成"这一次对话"
  const cut = filterConversation(all, {
    peer: opts.peer, selfUin, selfNames: opts.selfNames || [],
  });
  report.filtered = cut.kept;
  report.selfSkipped = cut.selfCount;
  report.needSelfUin = cut.needSelfUin;
  if (!cut.messages.length) {
    return { ...report, error: cut.peer ? 'peer-not-found: ' + cut.peer : 'no-messages-parsed' };
  }
  // 方向标记：peer/对手方 → in，我 → out（台账、切片、双方画像共用一套口径）
  const conv = orient(cut.messages, String(opts.selfLabel || '我'));
  const inbound = conv.filter((m) => m.dir !== 'out');

  // ② 人物归一：先把这一批里出现的人都登记进去。
  // **有 QQ 号的先登记**，这样后面无号的同昵称消息能靠 alias 认回同一个人
  // （否则"小周(223344556)"和后来的"小周(老周)"会被拆成两个人）。
  const reg = loadRegistry(dataRoot);
  const pidOf = new Map();          // 昵称|uin → personId
  const ordered = [...inbound].sort((a, b) => (b.uin ? 1 : 0) - (a.uin ? 1 : 0));
  for (const m of ordered) {
    const key = m.uin || m.nick;
    if (!key || pidOf.has(key)) continue;
    const r = registerPerson(reg, { uin: m.uin, nick: m.nick, groupId: opts.groupId });
    if (r.personId) pidOf.set(key, r.personId);
  }
  report.people = new Set(pidOf.values()).size;
  if (selfUin) registerPerson(reg, { uin: selfUin, nick: opts.selfLabel || '', groupId: opts.groupId });

  // ③ 完整归档（可选）：台账要原样，筛哪句值得记是记忆层的事
  if (opts.archive) {
    const sc = archiveScopeOf({ scope: opts.scope, peer: opts.peer, groupId: opts.groupId });
    report.archiveScope = sc;
    if (!sc) return { ...report, error: 'archive-needs-scope' };
    const rows = conv.map((m) => ({
      ts: m.ts,
      dir: m.dir,
      senderId: String(m.uin || ''),
      sender: m.dir === 'out' ? String(opts.selfLabel || '我') : String(m.nick || ''),
      kind: 'text',
      text: m.text,
      msgId: '',
    }));
    if (!opts.dryRun) {
      const ar = archiveMessages(dataRoot, { scope: sc, messages: rows, maxChars: archiveMaxChars, src: 'import' });
      report.archived = ar.added || 0;
      report.archiveDup = ar.skipped || 0;
      if (!ar.ok) report.archiveError = ar.reason || '';
    } else {
      report.archived = rows.length;
    }
  }

  // ④ 筛选 + 脱敏 + 按人分组（只处理"对方"那一侧：自己的话不是关于别人的记忆）
  const byPerson = new Map();
  const seen = new Set();
  for (const m of inbound) {
    let text = String(m.text || '').trim();
    if (mask) {
      const masked = maskPrivacy(text);
      if (masked !== text) report.masked += 1;
      text = masked;
    }
    const score = infoScore(text);
    if (score < minScore) continue;
    const key = (m.uin || m.nick) || '';
    const pid = pidOf.get(key) || personIdOf({ uin: m.uin, nick: m.nick }) || 'unknown';
    const dedupeKey = pid + '|' + text;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (!byPerson.has(pid)) byPerson.set(pid, []);
    byPerson.get(pid).push({ text, score, nick: m.nick, ts: m.ts });
  }
  report.kept = [...byPerson.values()].reduce((a, b) => a + b.length, 0);
  if (personScope && byPerson.size > 1) {
    return { ...report, error: 'person-scope-needs-single-peer' };
  }

  if (opts.dryRun) {
    report.ok = true;
    report.samples = [...byPerson.entries()].slice(0, 3).map(([pid, arr]) => ({
      personId: pid, n: arr.length, examples: arr.slice(0, 3).map((x) => x.text.slice(0, 60)),
    }));
    report.ms = Date.now() - started;
    return report;
  }

  // ⑤ 写入：按人分 scope，串行（SQLite 并发写会锁）
  let budget = limit;
  for (const [pid, arr] of byPerson) {
    if (budget <= 0) break;
    const scope = scopeMode === 'group'
      ? `group:${opts.groupId || 'unknown'}`
      : `person:${personScope || pid}`;
    // 信息量高的先写，额度用完就停
    arr.sort((a, b) => b.score - a.score);
    for (const item of arr) {
      if (budget <= 0) break;
      budget -= 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await remember(dataRoot, scope, { text: item.text, kind: 'say' });
        if (r.ok) {
          if (r.reason === 'deduped' || r.reason === 'deduped-text') report.deduped += 1;
          else report.added += 1;
        } else {
          report.failed += 1;
        }
      } catch {
        report.failed += 1;
      }
    }
  }

  // ⑥ 单边画像：每个人一条 impression，让"对这个人的理解"能被检索到
  for (const [pid, arr] of byPerson) {
    if (scopeMode !== 'person') break;
    const p = profileOf(arr.map((x) => ({ text: x.text, ts: x.ts })));
    // 用真名而不是"TA"：注入时"爸爸常聊…"比"TA常聊…"更像认得这个人
    const name = String(arr[0]?.nick || '').trim() || 'TA';
    const line = describeProfile(p, name);
    if (!line) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await remember(dataRoot, `person:${personScope || pid}`, { text: line, kind: 'impression' });
      report.profile = (report.profile || 0) + 1;
    } catch { /* 画像失败不影响主流程 */ }
  }

  // ⑦ 双方画像：只靠"TA 说了什么"看不出"我们怎么相处"。
  // 这一条写进 peer 的 person scope（不是新开 scope），运行时 [旧识] 就能带上它。
  if (opts.pair !== false && scopeMode === 'person') {
    const pair = pairProfileOf(conv);
    if (pair) {
      const peerRow = inbound[0] || {};
      const peerPid = (peerRow.uin || peerRow.nick)
        ? (pidOf.get(peerRow.uin || peerRow.nick) || personIdOf({ uin: peerRow.uin, nick: peerRow.nick }))
        : '';
      const line = describePair(pair, {
        otherName: String(peerRow.nick || 'TA'),
        meName: String(opts.selfLabel || '我'),
      });
      report.pair = line;
      if (peerPid && line) {
        try {
          // 关系记忆用 relation：它跟 say/fact 是不同性质，检索时也能被"我们/以前/每次"这类问句锚住
          await remember(dataRoot, `person:${personScope || peerPid}`, { text: line, kind: 'relation' });
          report.pairWritten = true;
        } catch { /* 关系画像失败不影响主流程 */ }
      }
      report.pairStats = pair;
    }
  }

  saveRegistry(dataRoot, reg);

  // ⑧ 历史印象归纳（可选）：导入的完整对话已经进台账，digest 能直接读到。
  // 这一步会跑本地模型，慢；失败也只是一张卡没更新，不影响导入结果。
  if (typeof opts.digest === 'function' && report.archived > 0) {
    const peerRow = inbound[0] || {};
    const sid = String(peerRow.uin || '');
    if (sid) {
      try {
        report.digest = await opts.digest({ senderId: sid, scope: report.archiveScope, force: true });
      } catch (e) {
        report.digest = { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  report.ok = true;
  report.ms = Date.now() - started;
  return report;
}

export default {
  parseHistory, parseQQText, parseQQJson, maskPrivacy, infoScore,
  profileOf, describeProfile, importHistory,
  filterConversation, pairProfileOf, describePair, archiveScopeOf,
};
