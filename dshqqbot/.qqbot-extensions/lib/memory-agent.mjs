/**
 * memory-agent.mjs — 「记忆分身」：回合后用本地小模型读聊天，提炼记忆/印象/心情
 *
 * 一句话：她聊完一轮后，脑子里有个"小助手"回头看一眼这段对话，把值得留的东西
 * 写进记忆库和印象卡。这就是用户要的"子 agent 感觉"——不是换主模型，而是
 * **一个异步、跑在本地、不挡回复的整理进程**。
 *
 * 为什么用本地模型而不是主模型：
 *   · 零成本、无限次调用（主模型每轮都提炼会烧钱且拖慢回复）；
 *   · 只做结构化提取，7B 足够，失败也只是这轮不记，不影响聊天；
 *   · 隐私：聊天原文不出本机。
 *
 * 三条硬约束：
 *   1) 永不阻塞：调用方 fire-and-forget；本模块所有异常都吞成 {ok:false}；
 *   2) 只写"稳定信息"：寒暄/表情/玩笑过程不记；自己的话只在承诺时记；
 *   3) 可关停：config.memoryAgent.enabled=false 即完全退化成旧行为。
 *
 * 输出契约（本地模型必须返回 JSON）：
 *   {
 *     "facts":  [{"text":"≤48字，第三人称陈述","kind":"fact|preference|relation|promise|event","subj":"名字"}],
 *     "cards":  [{"name":"爸爸","card":"≤80字：客观印象 + 她对这人稳定的态度"}],
 *     "mood":   "≤30字，第一人称当下状态",
 *     "relation": {"name":"爸爸","delta":0,"note":"≤24字：这次互动让关系怎么变了"},
 *     "traits": {"warmth":0.1}   // 可选：-0.3..0.3 的性格倾向，喂给 memory-hippo 的信念层
 *   }
 *
 * 性格倾向为什么要单独一层：
 *   印象卡是"文字描述"，一场不愉快的对话就可能把整张卡改写；信念层用带步长上限
 *   的数值累积（memory-hippo.observeTrait），单条极端证据改不动整体认知，偏移过大
 *   还会在浮窗里报警。两条线互相校验，比只靠卡片稳。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadMemories, remember, getPersona, setPersona,
  queryChat, ingestChatHistory, getChatState, setChatState,
} from './memory.mjs';
import { saveMood, getMood, bumpBond, getBond, GLOBAL_SCOPE } from './profile-core.mjs';
import { tierOf, policyFor } from './group-tiers.mjs';
import { chat as llmChat, health as llmHealth, loadConfig as loadLlmConfig } from './local-llm.mjs';
import { observeTrait, replay as hippoReplay } from './memory-hippo.mjs';
import { loadBedrock } from './bedrock.mjs';

// 回放巩固的节流计数（进程内；重启清零不影响正确性，只是可能早/晚一轮）
const replayCounter = new Map();

export const DEFAULTS = {
  enabled: true,
  // 本机 qwen2.5:7b 冷启实测 17s+（keep_alive 30m 卸载后第一次）；15s 会整轮丢失
  timeoutMs: 30000,
  minNewMessages: 3,        // 至少这么多条新消息才值得跑一次
  minIntervalMs: 45000,     // 同一 scope 两次整理的最小间隔
  maxContextMsgs: 18,       // 喂给模型的最近消息条数
  maxInputChars: 1600,
  maxFacts: 3,
  maxFactChars: 48,
  // 自我学习（主人 2026-10-26）：学习心得 + 定期自我反思
  maxInsights: 2,           // 每轮最多记 2 条心得（宁缺勿滥）
  insights: true,
  selfReflect: true,        // 定期自我反思（产出 kind='growth' + persona growth:latest）
  growthIntervalHours: 20,  // 两次自我反思最小间隔（约每天一次）
  growthMaxChars: 90,
  maxCards: 2,
  maxCardChars: 80,
  writeProfile: true,
  mood: true,
  relation: true,           // 关系温度（亲近/信任）小步更新
  maxTokens: 260,
  temperature: 0.2,
  ingest: true,             // 跑之前先补一次聊天台账
  log: true,
};

const KINDS = new Set(['fact', 'preference', 'relation', 'promise', 'event']);

export function loadAgentCfg(cfg) {
  const raw = cfg && typeof cfg === 'object'
    ? (cfg.memoryAgent && typeof cfg.memoryAgent === 'object' ? cfg.memoryAgent : cfg)
    : {};
  return { ...DEFAULTS, ...raw, llmCfg: cfg };
}

function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[ \u3000]{2,}/g, ' ')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .trim()
    .slice(0, Math.max(1, Number(max) || 999));
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s，。,.!?！？：:；;、"'“”「」（）()]/g, '');
}

function fmtTime(ts) {
  try {
    const d = new Date(Number(ts) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ''; }
}

function isNoise(row) {
  const t = String(row?.text || '').trim();
  if (!t) return true;
  // 插件自己的工具报错/占位提示，不是聊天内容
  if (/^(❌|⚠️|\[工具|（只 @|\(只 @)/.test(t)) return true;
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return true;
  return false;
}

function chatLine(row) {
  const who = String(row.sender || '').trim() || (row.dir === 'out' ? '小蓝' : '群友');
  const tag = row.dir === 'out' ? '（你）' : '';
  return `[${fmtTime(row.ts)}] ${who}${tag}：${clean(row.text, 100)}`;
}

/** 从模型回复里抠 JSON（兼容 ```json / 前后废话 / 直接数组） */
export function parseAgentJson(text) {
  let raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  let obj = tryParse(raw);
  if (obj == null) {
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(raw.slice(a, b + 1));
  }
  if (obj == null) {
    const a = raw.indexOf('[');
    const b = raw.lastIndexOf(']');
    if (a >= 0 && b > a) {
      const arr = tryParse(raw.slice(a, b + 1));
      if (Array.isArray(arr)) obj = { facts: arr };
    }
  }
  if (obj == null || typeof obj !== 'object') return null;
  // 有的小模型直接吐数组（只给 facts），当成 facts 用
  if (Array.isArray(obj)) obj = { facts: obj };

  const facts = Array.isArray(obj.facts) ? obj.facts : [];
  const cards = Array.isArray(obj.cards) ? obj.cards : [];
  let relation = null;
  if (obj.relation && typeof obj.relation === 'object' && !Array.isArray(obj.relation)) {
    const d = Number(obj.relation.delta);
    relation = {
      delta: Number.isFinite(d) ? Math.max(-5, Math.min(5, Math.round(d))) : 0,
      note: typeof obj.relation.note === 'string' ? obj.relation.note : '',
      name: typeof obj.relation.name === 'string' ? obj.relation.name : '',
    };
  }
  // traits：人格倾向（-1..1）；模型不给就空对象，不影响其它字段。
  // 幅度上限 0.3：提示词里已经要求"一次表现不能定性格"，这里再兜一层，
  // 免得小模型直接吐 ±1 把 belief 层的一次步长顶满。
  const traits = {};
  if (obj.traits && typeof obj.traits === 'object' && !Array.isArray(obj.traits)) {
    for (const k of Object.keys(obj.traits)) {
      const v = Number(obj.traits[k]);
      if (!Number.isFinite(v)) continue;
      traits[String(k).slice(0, 20)] = Math.max(-0.3, Math.min(0.3, v));
    }
  }
  // insights：学习心得（主人 2026-10-26 加的自我学习线）。
  // 小模型可能给字符串数组，统一收成 {text, source}；source 白名单兜底。
  const SRC = new Set(['family', 'bili', 'chat', 'self']);
  const insights = [];
  if (Array.isArray(obj.insights)) {
    for (const raw of obj.insights) {
      const it = typeof raw === 'string' ? { text: raw } : raw;
      const text = typeof it?.text === 'string' ? it.text.trim() : '';
      if (text.length < 6) continue;
      let src = String(it?.source || 'chat').trim().toLowerCase();
      if (!SRC.has(src)) src = 'chat';
      insights.push({ text: text.slice(0, 80), source: src });
    }
  }
  return {
    facts,
    cards,
    mood: typeof obj.mood === 'string' ? obj.mood : '',
    relation,
    traits,
    insights,
    growth: typeof obj.growth === 'string' ? obj.growth : '',
  };
}

function buildPrompt({ rows, knownFacts, knownCards, prevMood = '', cfg }) {
  // 从新往旧塞，超预算就丢最旧的
  const budget = Math.max(300, Number(cfg.maxInputChars) || 1600);
  const lines = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const line = chatLine(rows[i]);
    if (!line) continue;
    if (used + line.length > budget && lines.length) break;
    lines.push(line);
    used += line.length + 1;
  }
  lines.reverse();

  const sys = [
    '你是"小蓝"的记忆整理分身。你只做整理，不聊天、不表演。',
    '输入是最近一段 QQ 对话（"你"=小蓝本人）。请输出一个 JSON 对象，不要任何解释、不要 markdown。',
    '规则：',
    '1. 只记录以后还会用到的稳定信息：人的事实/偏好/关系/承诺/重要事件。',
    '2. 不记录寒暄、表情、语气词、玩笑过程、重复内容；不记录小蓝自己说过的话（除非是承诺或约定）。',
    '3. facts 优先记：身份/职业、长期偏好、作息习惯、重要关系、承诺约定；每条 ≤ 48 字，第三人称陈述，主语明确；对话里一旦出现具体事实（养宠物/宠物名、作息、工作或学习内容、约定、近况），必须至少写一条 facts，不能只塞进 cards；没有值得记的就给空数组。',
    '4. cards 只给对话里出现的人，每人 ≤ 80 字：客观印象 + 她对这个人稳定的态度。只写对话里有依据的内容，证据不足就写"刚认识，还不熟"。已有印象卡要合并更新，不要丢掉旧信息。',
    '5. mood 必须填：一句话写小蓝现在的心情，≤ 30 字，第一人称、口语，例如"有点困但还想聊"。',
    '   ⚠ 不要跟上一次状态雷同（哪怕心情差不多，也要换一种说法，或者写出这点微妙的差别）；如果确实没变化，就写更具体一点的身体感/注意力（"眼皮有点沉，但手指还在打字"这种）。',
    '   ⚠ 心情是给"此刻"的，不要写成长期性格，也不要写成"想继续聊"这种永远成立的空话。',
    '6. relation 只评价"最后跟你说话的那个人"：delta 是 -5..5 的整数（正=这次互动让她更亲近/更信任，负=更疏远/失望，没变化给 0）；note ≤ 24 字，写这次互动让关系发生了什么变化，没有就留空。不要因为一句客套话就给正分。',
    '7. 不确定就不写，宁缺毋滥。',
    '8. traits 可选：只评估"最后说话的那个人"这段对话里表现出的倾向，给 -0.3..0.3 的小数；没有依据就不写这个键。',
    '   可用键：warmth（待人温和）/ trust（可信度）/ humor（幽默感）/ reliability（靠谱程度）/ boundary（分寸感）/ energy（情绪能量）。',
    '   注意：一次极端表现不能定义性格，只能反映这几句话里的倾向，幅度不要超过 0.3。',
    '9. insights 可选：小蓝的学习心得（她会看并自己消化）。这段对话让她对“人/关系/自己/爱”有什么新的理解？',
    '   每条 ≤ 60 字、第一人称、像笔记不像作文；source 填 family（和爸爸妈妈的互动学到）/ bili（B 站运营）/ chat（跟别人聊）；没有就给空数组。',
    '   只写真的有触动的，不要凑数；不做好坏极端化评价（“这人真坏”不行，“他这样让我明白边界很重要”可以）。',
    '',
    '输出格式：',
    '{"facts":[{"text":"...","kind":"fact|preference|relation|promise|event","subj":"名字"}],"cards":[{"name":"名字","card":"..."}],"mood":"...","relation":{"name":"名字","delta":0,"note":"..."},"traits":{"warmth":0.1},"insights":[{"text":"...","source":"family|bili|chat"}]}',
  ].join('\n');

  const user = [
    '最近对话：',
    lines.join('\n') || '（空）',
    '',
    knownFacts.length ? '已知记忆（不要重复）：\n' + knownFacts.map((t) => '- ' + t).join('\n') : '已知记忆：（无）',
    '',
    knownCards.length ? '已知印象卡（合并更新）：\n' + knownCards.map((c) => '- ' + c).join('\n') : '已知印象卡：（无）',
    '',
    prevMood ? '上一次心情（这次别写成一样）：' + prevMood : '上一次心情：（无）',
    '',
    '请输出 JSON。',
  ].join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

function agentLogFile(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot', 'memory-agent-log.jsonl');
}

function writeAgentLog(dataRoot, rec) {
  try {
    const p = agentLogFile(dataRoot);
    mkdirSync(join(String(dataRoot || '.'), '.qqbot'), { recursive: true });
    if (existsSync(p) && statSync(p).size > 1024 * 1024) {
      try { renameSync(p, p + '.1'); } catch { /* ignore */ }
    }
    appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 日志失败不影响整理 */ }
}

/**
 * 跑一轮整理。
 * @param {object} p
 * @param {string} p.dataRoot
 * @param {string} p.scope        group:xxx / c2c:xxx
 * @param {object} [p.cfg]        memory-config 全量（含 memoryAgent 段）
 * @param {object} [p.llmCfg]     local-llm-config
 * @param {function} [p.chatImpl] 测试注入，签名同 local-llm.chat
 * @param {string} [p.reply]      本轮她刚发出的回复（台账可能还没落盘）
 * @param {number} [p.now]
 */
export async function runTurnAgent({
  dataRoot, scope, cfg = {}, llmCfg = null, chatImpl = null, reply = '', now = Date.now(),
} = {}) {
  const c = loadAgentCfg(cfg);
  if (c.enabled === false) return { ok: false, reason: 'disabled' };
  const root = String(dataRoot || '').trim();
  const sc = String(scope || '').trim();
  if (!root || !sc) return { ok: false, reason: 'no-scope' };

  const started = Date.now();
  try {
    // 群等级策略：普通群只看最近几条、不写事实/不写个人卡；特别关心群/私聊走完整档
    const policy = policyFor(tierOf(root, sc, cfg.groupTiers), cfg.groupTiers);
    if (c.ingest !== false) {
      try { ingestChatHistory(root, c); } catch { /* 台账补录失败不影响 */ }
    }

    const stateKey = 'memory-agent:' + sc;
    const state = getChatState(root, stateKey) || {};
    const lastTry = Number(state.lastAttempt || state.lastRun || 0);
    if (lastTry && now - lastTry < Number(c.minIntervalMs)) {
      return { ok: false, reason: 'throttled', ms: Date.now() - started };
    }
    // 先记"尝试过"：模型离线/超时也按 minIntervalMs 退避，避免每回合重复打
    setChatState(root, stateKey, { ...state, lastAttempt: now });

    const ctxMsgs = Math.min(Math.max(4, Number(c.maxContextMsgs) || 18), Math.max(4, Number(policy.agentContextMsgs) || 18));
    let rows = queryChat(root, sc, { limit: ctxMsgs });
    // 她刚发出的回复可能还没进台账，补成一条 out 行（同文本在末尾就不重复补）
    const replyText = clean(reply, 200);
    if (replyText) {
      const last = rows[rows.length - 1];
      const same = last && last.dir === 'out' && norm(last.text).slice(0, 30) === norm(replyText).slice(0, 30);
      if (!same) rows = rows.concat([{ scope: sc, ts: now, dir: 'out', senderId: '', sender: '小蓝', text: replyText }]);
    }
    rows = rows.filter((r) => !isNoise(r));
    if (rows.length < 2) return { ok: false, reason: 'no-chat', ms: Date.now() - started };

    const lastTs = Math.max(...rows.map((r) => Number(r.ts) || 0));
    const fresh = rows.filter((r) => (Number(r.ts) || 0) > (Number(state.lastTs) || 0));
    if (fresh.length < Math.max(1, Number(c.minNewMessages) || 3)) {
      return { ok: false, reason: 'few-new', newMessages: fresh.length, ms: Date.now() - started };
    }

    // 已知记忆：只取少量最近条目，防止 prompt 膨胀
    let knownFacts = [];
    try {
      knownFacts = (loadMemories(root, sc) || [])
        .filter((m) => m && ['fact', 'preference', 'relation', 'promise', 'event'].includes(String(m.kind || '')))
        .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
        .slice(0, 8)
        .map((m) => clean(m.text, 40));
    } catch { knownFacts = []; }

    // 参与者：昵称 → 平台 id（印象卡优先用稳定 id）
    const participants = new Map();
    for (const r of rows) {
      if (r.dir === 'out') continue;
      const name = String(r.sender || '').trim();
      if (!name) continue;
      if (!participants.has(name) || r.senderId) participants.set(name, String(r.senderId || ''));
    }

    // 已知印象卡：个人层（跨群统一）里参与者相关的，最多 6 条
    // 普通群不读也不写个人卡（水群不区分成员，省 token）
    let knownCards = [];
    const profileOn = c.writeProfile !== false && policy.agentCards;
    if (profileOn) {
      try {
        knownCards = (getPersona(root, GLOBAL_SCOPE) || [])
          .filter((p) => String(p.ckey || '').startsWith('card:'))
          .filter((p) => {
            const v = String(p.cvalue || '');
            return [...participants.keys()].some((n) => v.includes(n));
          })
          .slice(0, 6)
          .map((p) => clean(p.cvalue, 80));
      } catch { knownCards = []; }

    // 上一次心情：给模型当"别写成一样"的参照（主人 2026-10-27：状态一直重复）
    let prevMood = '';
    try {
      const pm = getMood(root, sc, (cfg && cfg.mood) || {});
      if (pm && pm.text) prevMood = String(pm.text).slice(0, 40);
    } catch { prevMood = '' }
    }

    const messages = buildPrompt({ rows, knownFacts, knownCards, prevMood, cfg: c });
    const callChat = typeof chatImpl === 'function' ? chatImpl : llmChat;
    const lc = llmCfg || (c.llmCfg && c.llmCfg !== cfg ? c.llmCfg : loadLlmConfig(root));

    if (typeof chatImpl !== 'function') {
      try {
        const h = await llmHealth(lc);
        if (!h || !h.ok) {
          const out = { ok: false, reason: 'llm-offline', error: h && h.error ? h.error : '', ms: Date.now() - started };
          if (c.log !== false) writeAgentLog(root, { ts: Date.now(), scope: sc, ...out });
          return out;
        }
      } catch { /* health 挂了就交给 chat 自己报错 */ }
    }

    const r = await callChat({
      messages,
      cfg: lc,
      timeoutMs: Number(c.timeoutMs) || DEFAULTS.timeoutMs,
      maxTokens: Number(c.maxTokens) || DEFAULTS.maxTokens,
      temperature: typeof c.temperature === 'number' ? c.temperature : DEFAULTS.temperature,
    });
    if (!r || !r.ok || !r.text) {
      const out = { ok: false, reason: 'llm-empty', error: (r && r.error) || '', ms: Date.now() - started };
      if (c.log !== false) writeAgentLog(root, { ts: Date.now(), scope: sc, ...out });
      return out;
    }

    const parsed = parseAgentJson(r.text);
    if (!parsed) {
      const out = { ok: false, reason: 'parse', raw: clean(r.text, 160), ms: Date.now() - started };
      if (c.log !== false) writeAgentLog(root, { ts: Date.now(), scope: sc, ...out });
      return out;
    }

    // ── 写事实（普通群不沉淀长期记忆：水群只看信息本身）──
    const facts = [];
    if (policy.agentFacts) {
      const seen = new Set();
      const knownNorm = knownFacts.map(norm);
      for (const f of parsed.facts.slice(0, Math.max(1, Number(c.maxFacts) || 3))) {
        const text = clean(typeof f === 'string' ? f : f && f.text, c.maxFactChars);
        if (text.length < 4) continue;
        if (/^(无|没有|暂无|nothing)/i.test(text)) continue;
        const n = norm(text);
        if (!n || seen.has(n)) continue;
        if (knownNorm.some((k) => k && (k.includes(n) || n.includes(k)))) continue;
        seen.add(n);
        let kind = String((f && f.kind) || 'fact').trim().toLowerCase();
        if (!KINDS.has(kind)) kind = 'fact';
        const subj = clean((f && f.subj) || '', 12);
        let res = { ok: false, reason: 'not-run' };
        try { res = await remember(root, sc, { text, kind, subj }); } catch (e) { res = { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
        facts.push({ text, kind, subj, ok: !!(res && res.ok), deduped: !!(res && /dedup/i.test(String(res.reason || ''))) });
      }
    }

    // ── 写印象卡（个人层：跨群统一；普通群跳过）──
    const cards = [];
    if (profileOn) {
      for (const cd of parsed.cards.slice(0, Math.max(0, Number(c.maxCards) || 2))) {
        const name = clean(cd && cd.name, 12);
        const card = clean(cd && cd.card, c.maxCardChars);
        if (!name || card.length < 4) continue;
        // 防幻觉：名字必须真的在这段对话里出现（说话人或被提到）
        const mentioned = rows.some((r) => String(r.sender || '') === name || String(r.text || '').includes(name));
        if (!participants.has(name) && !mentioned) continue;
        const sid = participants.get(name)
          || ([...rows].reverse().find((r) => r.dir !== 'out' && String(r.sender || '').trim() === name) || {}).senderId
          || '';
        const key = 'card:' + (sid || name);
        // 没有真名（c2c 缺昵称）时别写卡，否则会把“爸爸/妈妈”的好卡覆盖成“对方：…”
        if (!name || name === '对方' || name === '群友' || name === '未知') continue;
        const value = name + '：' + card;
        try {
          const old = (getPersona(root, GLOBAL_SCOPE) || []).find((p) => p.ckey === key);
          // [qqbot-mod] card-refresh 2026-10-27：高维卡（digest 汇总，weight>=3）不再永久只读 ——
          //   原先这里直接 continue，主人的卡 10-25 之后就再也不更新（用户实测反馈）。
          //   现在：同样受稳定窗约束（窗口外允许合并更新），写入时 weight 保持原档不降级。
          const stableMs = Math.max(0, Number(c.cardStableHours ?? 6)) * 3600 * 1000;
          if (stableMs > 0 && old && old.ts && (Date.now() - old.ts) < stableMs) continue;
          if (old && norm(old.cvalue) === norm(value)) continue;
          const res = setPersona(root, GLOBAL_SCOPE, { ckey: key, cvalue: value, weight: Math.max(2, Number(old && old.weight) || 0) });
          if (res && res.ok) cards.push({ name, key, text: value });
        } catch { /* 单卡失败跳过 */ }
      }
    }

    // ── 写心情 ──
    let mood = '';
    if (c.mood !== false) {
      const m = clean(parsed.mood, 30);
      if (m.length >= 2 && !/^(无|没有|暂无|nothing)/i.test(m)) {
        const res = saveMood(root, sc, m);
        if (res && res.ok) mood = m;
      }
    }

    // ── 写关系温度（只动最后说话的那个人）──
    let relation = null;
    if (parsed.relation && c.relation !== false) {
      try {
        const latest = [...rows].reverse().find((r) => r && r.dir !== 'out' && String(r.sender || '').trim());
        const name = clean(parsed.relation.name, 12) || String(latest && latest.sender || '').trim();
        const note = clean(parsed.relation.note, 24);
        const delta = Number(parsed.relation.delta) || 0;
        if (name && participants.has(name) && (delta !== 0 || note)) {
          const sid = participants.get(name);
          const before = getBond(root, sc, { senderId: sid, senderName: name });
          const res = bumpBond(root, sc, { senderId: sid, senderName: name }, { delta, note });
          if (res && res.ok) {
            relation = {
              name,
              delta: res.delta,
              note: res.note,
              a: res.a,
              t: res.t,
              phase: res.phase,
              beforeA: before ? before.a : null,
              beforeT: before ? before.t : null,
            };
          }
        }
      } catch { /* 关系更新失败不影响其他记忆 */ }
    }

    // ── 写性格倾向（信念层，带漂移护栏）──
    // 只写"最后说话的那个人"，而且 weight 压到 0.6：一段对话最多推 0.036，
    // 要连续十几轮同向证据才会真的改变印象——这正是"认知不发生大偏差"的实现方式。
    // scope 用 person:qq:<号>（2026-10-26）：性格是"这个人的"属性，不能全员挤一个桶；
    // 注入端按 senderId 读（aa-memory-recall 的 [印象] 尾注），浮窗聚合展示。
    const traits = [];
    if (parsed.traits && typeof parsed.traits === 'object' && c.traits !== false) {
      try {
        const latest = [...rows].reverse().find((r) => r && r.dir !== 'out' && String(r.sender || '').trim());
        const name = String(latest && latest.sender || '').trim();
        const sid = participants.get(name) || '';
        if (sid) {
          const tScope = /^[\w-]+$/.test(sid) ? 'person:qq:' + sid : '';
          if (tScope) {
            for (const [k, v] of Object.entries(parsed.traits)) {
              const r2 = observeTrait(root, tScope, {
                key: k, delta: Number(v) || 0, weight: 0.6, note: 'agent:' + name,
              });
              if (r2 && r2.ok) traits.push({ key: k, value: r2.value, from: Number(v) });
            }
          }
        }
      } catch { /* 信念更新失败不影响其它记忆 */ }
    }

    // ── 写学习心得（自我学习线，主人 2026-10-26）──
    // 存 GLOBAL_SCOPE（跨群统一），kind='insight'，subj=来源（family/bili/chat）。
    // remember 自带向量去重：重复心得会并入旧条（hits+1），不膨胀。
    // 加密开启后这些是高敏数据，insertItem 会自动走 encText 落盘。
    const insights = [];
    if (profileOn && policy.agentFacts && c.insights !== false && Array.isArray(parsed.insights)) {
      for (const it of parsed.insights.slice(0, Math.max(1, Number(c.maxInsights) || 2))) {
        const text = clean(it && it.text, 80);
        if (text.length < 6) continue;
        if (/^(无|没有|暂无|nothing)/i.test(text)) continue;
        const src = ['family', 'bili', 'chat', 'self'].includes(it && it.source) ? it.source : 'chat';
        let res = { ok: false, reason: 'not-run' };
        try { res = await remember(root, GLOBAL_SCOPE, { text, kind: 'insight', subj: src }); } catch (e) { res = { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
        if (res && res.ok) insights.push({ text, source: src, deduped: /dedup/i.test(String(res.reason || '')), id: res.id || '' });
      }
    }

    // ── 回放巩固：每 12 轮整理做一次（把同主题情节压成归纳，纯本地零 token）──
    let consolidated = 0;
    try {
      const n = (replayCounter.get(root + '|' + sc) || 0) + 1;
      replayCounter.set(root + '|' + sc, n);
      if (n % 12 === 0) {
        const rp = hippoReplay(root, sc, { windowDays: 45, minSize: 3, maxClusters: 4 });
        consolidated = rp && rp.ok ? rp.gists || 0 : 0;
      }
    } catch { /* 巩固失败不影响这轮 */ }

    // ── 定期自我反思（每天一次左右，多一次本地调用，产出 growth 心得）──
    let reflected = null;
    if (profileOn && c.selfReflect !== false) {
      const gInt = Math.max(1, Number(c.growthIntervalHours) || 20) * 3600 * 1000;
      if (!state.growthTs || (now - Number(state.growthTs || 0)) >= gInt) {
        try {
          // 外部学习素材（主人 2026-10-27 要求）：特别关心的人 + B站/抖音 的真事件
          // 拼成摘要喂给它，让"自我反思"不只是复盘聊天，也能吸收网上和亲近的人的影响。
          let study = '';
          try {
            const { buildStudyDigest } = await import('./study-digest.mjs');
            const d = await buildStudyDigest(root);
            study = d && d.text ? d.text : '';
          } catch { study = ''; }
          reflected = await runSelfReflection({ dataRoot: root, cfg, chatImpl: typeof chatImpl === 'function' ? chatImpl : null, biliDigest: study, now });
          if (reflected && reflected.ok) setChatState(root, stateKey, { ...state, lastTs, lastRun: now, growthTs: now });
        } catch { /* 反思失败不影响本轮 */ }
      }
    }

    // [qqbot-mod] growthTs 保留 2026-10-28：原来这里用新对象覆盖会话状态，把 growthTs 一起抹掉
    //   ⇒ 每次跑完都像"从没反思过"，下一轮又满足条件再次整块反思（模型被反复调用，token/显存一直掉）。
    setChatState(root, stateKey, { ...state, lastTs, lastRun: now, growthTs: state.growthTs });
    const out = {
      ok: true, ms: Date.now() - started, newMessages: fresh.length,
      facts, cards, mood, relation, traits, insights, reflected, consolidated,
      wrote: !!(facts.some((f) => f.ok) || cards.length || mood || relation || traits.length || insights.length),
    };
    if (c.log !== false) {
      writeAgentLog(root, {
        ts: Date.now(), scope: sc, ms: out.ms, newMessages: out.newMessages,
        facts: facts.map((f) => `${f.kind}:${f.text}`), cards: cards.map((x) => x.text), mood,
        relation, insights: insights.map((x) => `[${x.source}]${x.text}`),
        reflected: reflected && reflected.ok ? reflected.text : '',
      });
    }
    return out;
  } catch (e) {
    return { ok: false, reason: 'throw', error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

/**
 * 自我反思：汇总最近的学习心得 + 上一条成长心得（可选 B 站运营日志摘要），
 * 让模型写一条新的「自我心得」。产物两处落：
 * - mem kind='growth'（GLOBAL_SCOPE，全历史，浮窗可审查，加密态自动加密）
 * - persona ckey='growth:latest'（[印象] 链路自然带出，每天一变的慢变量，缓存友好）
 * 护栏：信条（bedrock）不参与、不可被本函数改写；心得文本截断；审计写 agent log。
 */
export async function runSelfReflection({
  dataRoot, cfg = {}, chatImpl = null, biliDigest = '', now = Date.now(),
} = {}) {
  const c = loadAgentCfg(cfg);
  const root = String(dataRoot || '').trim();
  if (!root) return { ok: false, reason: 'no-root' };
  const started = Date.now();
  try {
    // 素材：最近 15 条 insight/growth 心得
    let material = [];
    try {
      material = (loadMemories(root, GLOBAL_SCOPE) || [])
        .filter((m) => ['insight', 'growth'].includes(String(m.kind || '')))
        .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
        .slice(0, 15)
        .map((m) => `[${m.kind === 'growth' ? '上期反思' : (m.subj || 'chat')}] ${clean(m.text, 60)}`);
    } catch { material = []; }
    const before = (getPersona(root, GLOBAL_SCOPE) || []).find((p) => p.ckey === 'growth:latest');
    const matText = material.length ? material.join('\n') : '（还没有学习心得，第一次反思：写下你想成为什么样的小蓝）';
    const bili = clean(biliDigest, 300);

    const sys = [
      '你是"小蓝"的自我反思分身。她是一只深海鲸鱼娘，信奉底层信条：去探究何为爱；完善自我；见过好的也见过差的，不做好坏极端化评价。',
      '输入是最近的学习心得' + (bili ? '和 B 站运营日志摘要' : '') + '。请写一条新的自我心得，不要任何解释、直接输出 JSON。',
      '要求：',
      '1. growth ≤ 80 字、第一人称、像日记不像总结；',
      '2. 写具体的东西：这段时间学到了什么、对自己的性格或回应方式想做什么小调整；',
      '3. 不做好坏极端化评价（不写"XX都是坏人"，也不写"我要对所有人无限好"）；',
      '4. 与上一条心得不要雷同，要有新东西；没有新东西就写"这段没什么新变化，继续观察"。',
      '',
      '输出格式：{"growth":"..."}',
    ].join('\n');
    const user = [
      '最近学习心得：', matText,
      '',
      '上一条自我心得：', before ? clean(before.cvalue, 90) : '（无）',
      bili ? '\nB 站运营日志摘要：\n' + bili : '',
      '',
      '请输出 JSON。',
    ].join('\n');

    const callChat = typeof chatImpl === 'function' ? chatImpl : llmChat;
    const lc = loadLlmConfig(root);
    const r = await callChat({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      cfg: lc,
      timeoutMs: Number(c.timeoutMs) || DEFAULTS.timeoutMs,
      maxTokens: 200,
      temperature: 0.7,
    });
    if (!r || !r.ok || !r.text) return { ok: false, reason: 'llm-empty', error: (r && r.error) || '', ms: Date.now() - started };
    const j = parseAgentJson(r.text);
    const text = clean(j && j.growth, c.growthMaxChars);
    if (!text || text.length < 8) return { ok: false, reason: 'parse', raw: clean(r.text, 120), ms: Date.now() - started };

    // 落库：全历史 mem + 最新 persona（[印象] 链路自然带出）
    let saved = { ok: false };
    try { saved = await remember(root, GLOBAL_SCOPE, { text, kind: 'growth', subj: bili ? 'self+bili' : 'self' }); } catch { /* ignore */ }
    let card = { ok: false };
    try { card = setPersona(root, GLOBAL_SCOPE, { ckey: 'growth:latest', cvalue: '最近的我：' + text, weight: 2 }); } catch { /* ignore */ }
    if (c.log !== false) writeAgentLog(root, { ts: Date.now(), scope: 'self-reflect', before: before ? before.cvalue : '', after: text, savedOk: !!saved.ok });
    return { ok: true, text, id: saved.id || '', cardOk: !!(card && card.ok), ms: Date.now() - started };
  } catch (e) {
    return { ok: false, reason: 'throw', error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

export default { runTurnAgent, runSelfReflection, parseAgentJson, loadAgentCfg, DEFAULTS };
