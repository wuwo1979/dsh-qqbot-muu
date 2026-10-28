/**
 * profile-digest.mjs — 把一个人的**全部历史消息**压成可切片、可汇总的印象卡
 *
 * 用户口径（2026-10-24 校准）：
 *   · 历史消息本身就是对一个人的印象；
 *   · **聊天台账 / 记忆 / 心情按会话隔离**：A 群的恶言恶语不带坏 B 群；
 *   · **个人印象卡是个人层、跨群统一**：同一个 QQ 用户在哪都认识，避免普通群"不认人"；
 *     但只吸收私聊 + 特别关心群的对话，普通群水聊不参与（省 token）。
 *
 * 做法（全本地、零云 token）：
 *   1) 把这个人「在允许会话里自己说的话」按时间拼起来（不含小蓝的回复，
 *      防止 A 群里小蓝的坏脾气被写进这个人的全局卡）；
 *   2) 每 60 条切一片（重叠 8 条），每片让小模型写 {summary, traits}；
 *      切片落个人层：scope=GLOBAL_SCOPE，ckey='slice:<senderId>:<seq>'；
 *   3) 所有切片摘要再喂一次模型，合成高维卡 → scope=GLOBAL_SCOPE，ckey='card:<senderId>'；
 *      旧卡作为「已知」输入，保证旧信息不被覆盖掉；
 *   4) 增量：只补新增消息对应的尾部切片，切片有变化才重跑汇总；
 *   5) relation 只写进统一熟识度记录的 note（不直接改分数，避免「读历史就变熟」）。
 */
import { openDb } from './memory-db.mjs';
import { setPersona, getPersonaValue, setChatState, getChatState } from './memory.mjs';
import { chat as llmChat, loadConfig as loadLlmConfig } from './local-llm.mjs';
import { loadAgentCfg } from './memory-agent.mjs';
import { CARD_PREFIX, SLICE_PREFIX, GLOBAL_SCOPE, setFamiliarity, getFamiliarity } from './profile-core.mjs';
import { cleanInjected } from './text-clean.mjs';
import { tierOf, digestAllowedFor } from './group-tiers.mjs';

export const DIGEST_DEFAULTS = {
  sliceSize: 60,
  overlap: 8,
  maxSlicesPerRun: 12,       // 一次最多补多少片（防止首次全量卡死）
  maxSlicesForFinal: 40,     // 汇总时最多喂多少片摘要
  sliceMaxChars: 160,
  cardMaxChars: 300,
  perDayMs: 22 * 60 * 60 * 1000,
  timeoutMs: 60000,          // 切片多，比回合整理给得更宽
  maxTokens: 400,
  temperature: 0.2,
  log: true,
};

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function fmt(ts) {
  try {
    const d = new Date(num(ts) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ''; }
}

function noise(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (/^(❌|⚠️|\[工具|（只 @)/.test(s)) return true;
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(s)) return true;
  if (/^\[(图片|语音|视频|表情|文件)[^\]]*\]$/.test(s)) return true;
  return false;
}

function clip(s, n) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
}

/** 从模型回复里抠出原始 JSON 对象（不做字段白名单，保留 summary/traits/card） */
function parseJsonObj(text) {
  let raw = String(text == null ? '' : text).trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!raw) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryParse(raw);
  if (!obj) {
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(raw.slice(a, b + 1));
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
}

/** 打开 chat 表（只读即可） */
function openChat(dataRoot) {
  const h = openDb(dataRoot);
  return h && h.db ? h.db : null;
}

/** 某个人出现过的 scope（按消息量降序） */
export function scopesOf(dataRoot, senderId) {
  const db = openChat(dataRoot);
  if (!db) return [];
  try {
    return db.prepare('SELECT scope, COUNT(*) AS n, MAX(ts) AS lastTs FROM chat WHERE sender_id = ? GROUP BY scope ORDER BY n DESC')
      .all(String(senderId || ''))
      .map((r) => ({ scope: String(r.scope), n: num(r.n), lastTs: num(r.lastTs) }));
  } catch { return []; }
}

/** 主人 openid：优先最活跃私聊（这台机器没有 settings.yaml 的 owners 配置） */
export function pickOwner(dataRoot) {
  const db = openChat(dataRoot);
  if (!db) return '';
  try {
    const row = db.prepare(
      "SELECT sender_id, COUNT(*) AS n FROM chat WHERE scope LIKE 'c2c:%' AND dir = 'in' AND sender_id != '' GROUP BY sender_id ORDER BY n DESC LIMIT 1",
    ).get();
    return row ? String(row.sender_id) : '';
  } catch { return ''; }
}

/** 可整理的人：可指定 scope（按群隔离），默认全库；主人优先，然后私聊，最后群成员 */
export function listTargets(dataRoot, { limit = 20, scope = '' } = {}) {
  const db = openChat(dataRoot);
  if (!db) return [];
  const owner = pickOwner(dataRoot);
  const wantScope = String(scope || '').trim();
  let rows = [];
  try {
    rows = wantScope
      ? db.prepare(
        "SELECT sender_id, MAX(sender) AS name, COUNT(*) AS n, MAX(ts) AS lastTs, MIN(scope) AS anyScope FROM chat WHERE dir = 'in' AND sender_id != '' AND scope = ? GROUP BY sender_id ORDER BY n DESC LIMIT ?",
      ).all(wantScope, Math.max(1, Math.min(200, num(limit, 20) * 4)))
      : db.prepare(
        "SELECT sender_id, MAX(sender) AS name, COUNT(*) AS n, MAX(ts) AS lastTs, MIN(scope) AS anyScope FROM chat WHERE dir = 'in' AND sender_id != '' GROUP BY sender_id ORDER BY n DESC LIMIT ?",
      ).all(Math.max(1, Math.min(200, num(limit, 20) * 4)));
  } catch { return []; }
  const out = rows.map((r) => {
    const scopes = scopesOf(dataRoot, r.sender_id);
    const primary = wantScope
      ? { scope: wantScope }
      : (scopes.find((s) => s.scope.startsWith('c2c:')) || scopes[0] || { scope: String(r.anyScope || '') });
    const kind = String(primary.scope).startsWith('c2c:') ? 'c2c' : 'group';
    return {
      senderId: String(r.sender_id), name: String(r.name || '').trim() || String(r.sender_id).slice(0, 8),
      msgs: num(r.n), lastTs: num(r.lastTs), scope: primary.scope, kind,
      isOwner: owner && String(r.sender_id) === owner,
    };
  });
  // 排序：主人 > 私聊 > 群；同层按消息量（指定 scope 时只按消息量）
  const rank = (t) => (t.isOwner ? 0 : (t.kind === 'c2c' ? 1 : 2));
  return out.sort((a, b) => (wantScope ? b.msgs - a.msgs : rank(a) - rank(b) || b.msgs - a.msgs))
    .slice(0, Math.max(1, num(limit, 20)));
}

/**
 * 取这个人的对话。
 *   scope       指定时只取该会话（群级记忆隔离）；
 *   personOnly  只取"这个人说的"（不含小蓝的回复）—— 汇总跨群个人卡时用，
 *               避免 A 群里小蓝的坏脾气被当成"这个人的性格"写进全局卡；
 *   scopes      只取这些会话（例如只允许私聊+特别关心群参与个人卡）。
 */
export function conversationOf(dataRoot, senderId, scope = '', opt = {}) {
  const db = openChat(dataRoot);
  if (!db) return [];
  const { personOnly = false, scopes: only = null } = opt || {};
  const wantScope = String(scope || '').trim();
  const scopes = Array.isArray(only) && only.length
    ? only.map(String)
    : (wantScope ? [wantScope] : scopesOf(dataRoot, senderId).map((s) => s.scope));
  if (!scopes.length) return [];
  const marks = scopes.map(() => '?').join(',');
  let rows = [];
  try {
    const cond = personOnly ? 'sender_id = ?' : "(sender_id = ? OR dir = 'out')";
    rows = db.prepare(
      `SELECT scope, ts, dir, sender, sender_id, text FROM chat
       WHERE scope IN (${marks}) AND ${cond} ORDER BY ts ASC`,
    ).all(...scopes, String(senderId));
  } catch { return []; }
  return rows
    .filter((r) => !noise(cleanInjected(r.text)))
    .map((r) => ({
      scope: r.scope, ts: num(r.ts), dir: r.dir,
      who: r.dir === 'out' ? '小蓝' : (String(r.sender || '').trim() || '对方'),
      text: clip(cleanInjected(r.text), 180),
    }));
}

function lineOf(m) {
  return `[${fmt(m.ts)}] ${m.who}${m.dir === 'out' ? '（小蓝）' : ''}：${m.text}`;
}

/** 切片（固定窗口 + 重叠，保证同一序号在增量时内容稳定） */
export function makeSlices(messages, { sliceSize = 60, overlap = 8 } = {}) {
  const step = Math.max(1, sliceSize - overlap);
  const out = [];
  for (let start = 0, seq = 0; start < messages.length; start += step, seq += 1) {
    out.push({ seq, start, end: Math.min(messages.length, start + sliceSize), rows: messages.slice(start, start + sliceSize) });
    if (start + sliceSize >= messages.length) break;
  }
  return out;
}

function sliceKey(senderId, seq) {
  return SLICE_PREFIX + String(senderId) + ':' + String(seq).padStart(3, '0');
}

/** 读已有切片 */
export function loadSlices(dataRoot, scope, senderId) {
  const db = openChat(dataRoot);
  if (!db) return [];
  try {
    const rows = db.prepare(
      "SELECT ckey, cvalue, weight, ts FROM persona WHERE scope = ? AND ckey LIKE ? ORDER BY ckey ASC",
    ).all(String(scope || 'global'), SLICE_PREFIX + String(senderId) + ':%');
    return rows.map((r) => {
      let v = {};
      try { v = JSON.parse(r.cvalue || '{}'); } catch { v = { summary: String(r.cvalue || '') }; }
      return {
        key: r.ckey, seq: num(String(r.ckey).split(':').pop()), summary: String(v.summary || ''),
        traits: Array.isArray(v.traits) ? v.traits : [], period: v.period || '', n: num(r.weight), ts: num(r.ts),
        src: v.src || '',
      };
    });
  } catch { return []; }
}

function buildSlicePrompt(person, slice) {
  const sys = [
    '你是"小蓝"的记忆整理分身，只做客观整理，不聊天。',
    '输入是某个人的一段历史聊天（跨时间切片；"小蓝（你）"是机器人本人）。',
    '请输出一个 JSON 对象，不要 markdown、不要解释：',
    '{"summary":"≤160字：这段时间这个人的状态、关注的事、和小蓝的相处方式","traits":["≤3条，每条≤12字的稳定性格/偏好"],"relation":{"note":"≤24字：这段时间关系的变化"}}',
    '规则：只写有证据的内容；寒暄、表情、复读不写；不确定就不写；summary 要具体（提到宠物、作息、工作、约定等）。',
    '【归属铁律】只提炼「对象」他**自己**的言行与特质：群里别人说的话、别人的事、机器人自己说的话，一律不算他的——这是历次卡片张冠李戴的根源。',
  ].join('\n');
  const user = [
    `对象：${person.name || person.senderId}`,
    `时间：${fmt(slice.rows[0]?.ts)} ~ ${fmt(slice.rows[slice.rows.length - 1]?.ts)}`,
    '对话：',
    slice.rows.map(lineOf).join('\n').slice(0, 5200),
    '',
    '输出 JSON。',
  ].join('\n');
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

function buildFinalPrompt(person, slices, oldCard) {
  const sys = [
    '你是"小蓝"的印象官。输入是某个人多年聊天的分片摘要，请做**高维抽象**。',
    '输出 JSON：{"card":"≤300字，第三人称：身份/性格/长期偏好/和小蓝的关系与相处模式","traits":["5条，每条≤12字"],"relation":{"note":"≤24字"}}',
    '要求：综合所有切片，不只看最近；保留旧卡里仍然成立的信息；不要编造；不要写空话（"是个有趣的人"这类不算）。',
    '【归属铁律】卡上只能写「对象」本人的长期特质：切片里混入的别人的言行（群里其他人、机器人）一律忽略，绝不归到对象头上。',
  ].join('\n');
  const user = [
    `对象：${person.name || person.senderId}`,
    `旧卡：${oldCard || '（无）'}`,
    '分片摘要（按时间顺序）：',
    slices.map((s, i) => `${i + 1}. ${s.period ? '[' + s.period + '] ' : ''}${s.summary}${s.traits.length ? '（' + s.traits.join('、') + '）' : ''}`).join('\n').slice(0, 7000),
    '',
    '输出 JSON。',
  ].join('\n');
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

function llmRun(llmCfg, agentCfg, messages, { maxTokens, timeoutMs } = {}) {
  const model = String(agentCfg.model || '').trim() || undefined;
  return llmChat({
    messages,
    cfg: llmCfg,
    model,
    timeoutMs: num(timeoutMs, DIGEST_DEFAULTS.timeoutMs),
    maxTokens: num(maxTokens, DIGEST_DEFAULTS.maxTokens),
    temperature: DIGEST_DEFAULTS.temperature,
  });
}

/**
 * 整理一个人。
 * @param {object} o
 * @param {string} o.dataRoot
 * @param {string} o.senderId
 * @param {string} [o.scope]     主 scope；不传自动选（私聊优先）
 * @param {object} [o.cfg]       memory-config 全量
 * @param {object} [o.llmCfg]
 * @param {function} [o.chatImpl] 测试注入
 * @param {boolean} [o.force]    忽略每日节流
 */
export async function digestPerson({
  dataRoot, senderId, scope = '', cfg = {}, llmCfg = null, chatImpl = null, force = false, now = Date.now(),
} = {}) {
  const root = String(dataRoot || '').trim();
  const sid = String(senderId || '').trim();
  if (!root || !sid) return { ok: false, reason: 'no-target' };

  const d = { ...DIGEST_DEFAULTS, ...((cfg && cfg.digest) || {}) };
  const agentCfg = loadAgentCfg(cfg);
  const llm = llmCfg || loadLlmConfig(root) || {};

  const targets = listTargets(root, { limit: 200, scope });
  const found = targets.find((t) => t.senderId === sid);
  const person = found || {
    senderId: sid, name: sid.slice(0, 8), msgs: 0, scope: String(scope || ''),
  };
  if (found) person.__realName = true;

  // 个人卡是「个人层」= 跨群统一：同一个 QQ 用户在哪都认识。
  // 但只吸收「私聊 + 特别关心群」的对话；普通群（水群）不参与个人卡（省 token、不区分群成员）。
  const allowedScopes = scopesOf(root, sid)
    .filter((s) => s.scope.startsWith('c2c:') || digestAllowedFor(tierOf(root, s.scope, cfg.groupTiers), cfg.groupTiers));
  if (!allowedScopes.length) {
    const sc0 = String(scope || person.scope || '').trim();
    return { ok: false, reason: 'tier-skip', scope: sc0, tier: tierOf(root, sc0, cfg.groupTiers) };
  }
  const primaryScope = (allowedScopes.find((s) => s.scope.startsWith('c2c:')) || allowedScopes[0]).scope;
  const scopeList = allowedScopes.map((s) => s.scope);

  // 状态按人记（卡已统一，不需要每个群各跑一份）
  const stateKey = 'digest:' + sid;
  const st = getChatState(root, stateKey) || {};
  if (!force && st.lastOk && now - num(st.lastOk) < num(d.perDayMs)) {
    return { ok: false, reason: 'throttled', ms: num(st.lastOk) };
  }

  const t0 = Date.now();
  // 私聊：把"她怎么回应"也算进去（两人的相处方式）；群里只要这个人自己说的话——
  // A 群里小蓝的坏脾气不能被当成"这个人的性格"写进全局卡。
  const conversation = [];
  for (const s of allowedScopes) {
    conversation.push(...conversationOf(root, sid, s.scope, { personOnly: !s.scope.startsWith('c2c:') }));
  }
  conversation.sort((a, b) => num(a.ts) - num(b.ts));
  // 手动重建时可能只给了 senderId（浮窗卡已统一到个人层），名字从台账回填，避免卡里写成 id 前 8 位
  if (!person.__realName) {
    const realName = conversation.map((r) => String(r.sender || '').trim()).find(Boolean);
    if (realName) person.name = realName;
  }
  if (conversation.length < 6) {
    return { ok: false, reason: conversation.length ? 'too-few' : 'no-history', msgs: conversation.length };
  }

  const slices = makeSlices(conversation, { sliceSize: num(d.sliceSize, 60), overlap: num(d.overlap, 8) });
  const existing = loadSlices(root, GLOBAL_SCOPE, sid);
  const existingSeq = new Set(existing.map((s) => s.seq));
  const todo = slices.filter((s) => !existingSeq.has(s.seq)).slice(0, Math.max(1, num(d.maxSlicesPerRun, 12)));

  const added = [];
  const errors = [];
  for (const s of todo) {
    try {
      const messages = buildSlicePrompt(person, s);
      const r = chatImpl
        ? await chatImpl({ messages, timeoutMs: num(d.timeoutMs), maxTokens: num(d.maxTokens) })
        : await llmRun(llm, agentCfg, messages, { timeoutMs: d.timeoutMs, maxTokens: d.maxTokens });
      const obj = r && r.ok !== false ? parseJsonObj(r.text || '') : null;
      if (!obj) { errors.push(`slice#${s.seq}: 模型无有效 JSON`); continue; }
      const summary = clip(obj.summary || (Array.isArray(obj.facts) ? obj.facts.map((f) => f.text).join('；') : ''), d.sliceMaxChars);
      if (!summary) { errors.push(`slice#${s.seq}: 空摘要`); continue; }
      const rec = {
        summary,
        traits: (Array.isArray(obj.traits) ? obj.traits : (Array.isArray(obj.cards) ? [] : [])).map((x) => clip(x, 12)).filter(Boolean).slice(0, 3),
        period: `${fmt(s.rows[0].ts)} ~ ${fmt(s.rows[s.rows.length - 1].ts)}`,
        relation: obj.relation || null,
        src: 'digest',
        ts: now,
      };
      setPersona(root, GLOBAL_SCOPE, { ckey: sliceKey(sid, s.seq), cvalue: JSON.stringify(rec), weight: s.rows.length });
      added.push({ seq: s.seq, ...rec });
    } catch (e) {
      errors.push(`slice#${s.seq}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const allSlices = loadSlices(root, GLOBAL_SCOPE, sid);
  const forFinal = allSlices.slice(-Math.max(1, num(d.maxSlicesForFinal, 40)));
  let card = '';
  let traits = [];
  let relationNote = '';
  if (forFinal.length) {
    try {
      const prev = getPersonaValue(root, GLOBAL_SCOPE, CARD_PREFIX + sid);
      const oldCard = clip(prev && prev.value, 400);
      const messages = buildFinalPrompt(person, forFinal, oldCard);
      const r = chatImpl
        ? await chatImpl({ messages, timeoutMs: num(d.timeoutMs), maxTokens: 500 })
        : await llmRun(llm, agentCfg, messages, { timeoutMs: d.timeoutMs, maxTokens: 500 });
      const obj = r && r.ok !== false ? parseJsonObj(r.text || '') : null;
      if (obj && (obj.card || obj.summary)) {
        card = clip(obj.card || obj.summary, d.cardMaxChars);
        traits = (Array.isArray(obj.traits) ? obj.traits : []).map((x) => clip(x, 12)).filter(Boolean).slice(0, 5);
        relationNote = clip(obj.relation && obj.relation.note, 24);
        // 个人层（跨群统一）：同一个 QQ 用户在所有会话里共用这一张卡
        setPersona(root, GLOBAL_SCOPE, {
          ckey: CARD_PREFIX + sid,
          cvalue: `${person.name}：${card}`,
          weight: 3,
        });
        // 只写统一熟识度：群级聊天/记忆仍各自隔离
        if (relationNote) {
          const fam = getFamiliarity(root, primaryScope, { senderId: sid, senderName: person.name }) || {};
          setFamiliarity(root, GLOBAL_SCOPE, { senderId: sid, senderName: person.name }, {
            a: fam.a, t: fam.t, note: relationNote, why: 'digest',
          });
        }
      } else {
        errors.push('final: 模型无有效 JSON');
      }
    } catch (e) {
      errors.push('final: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  const ok = added.length > 0 || !!card;
  setChatState(root, stateKey, {
    ...st,
    lastTry: now,
    lastOk: ok ? now : num(st.lastOk),
    slices: allSlices.length,
    msgs: conversation.length,
    lastError: errors.slice(0, 3).join('；'),
    ts: now,
  });

  return {
    ok,
    reason: ok ? '' : (errors[0] || 'no-result'),
    senderId: sid,
    name: person.name,
    scope: GLOBAL_SCOPE,
    primaryScope,
    scopes: scopeList,
    msgs: conversation.length,
    slices: allSlices.length,
    slicesAdded: added.length,
    card,
    traits,
    relationNote,
    errors: errors.slice(0, 6),
    ms: Date.now() - t0,
  };
}

/** 允许做历史印象汇总的会话：私聊全要；群聊只有特别关心群（或显式开启普通群） */
export function listDigestScopes(dataRoot, cfg = {}) {
  const db = openChat(dataRoot);
  if (!db) return [];
  let rows = [];
  try {
    rows = db.prepare("SELECT scope, COUNT(*) AS n FROM chat WHERE dir = 'in' GROUP BY scope ORDER BY n DESC").all();
  } catch { return []; }
  const owner = pickOwner(dataRoot);
  const out = [];
  for (const r of rows) {
    const sc = String(r.scope || '');
    if (!sc) continue;
    if (!sc.startsWith('c2c:') && !digestAllowedFor(tierOf(dataRoot, sc, cfg.groupTiers), cfg.groupTiers)) continue;
    out.push({ scope: sc, msgs: num(r.n) });
  }
  const rank = (s) => (s.scope === 'c2c:' + owner ? 0 : (s.scope.startsWith('c2c:') ? 1 : 2));
  return out.sort((a, b) => rank(a) - rank(b) || b.msgs - a.msgs);
}

/**
 * 批量：主人优先；默认最多 3 人，避免一次跑爆本地模型。
 * 卡是个人层（跨群统一），所以按人去重——同一个人只跑一次。
 */
export async function digestAll({
  dataRoot, cfg = {}, llmCfg = null, chatImpl = null, limit = 3, force = false, now = Date.now(),
} = {}) {
  const max = Math.max(1, num(limit, 3));
  const seen = new Set();
  const picked = [];
  for (const sc of listDigestScopes(dataRoot, cfg)) {
    if (picked.length >= max) break;
    // 每个会话最多取 2 个活跃的人；普通群已被 listDigestScopes 过滤
    const targets = listTargets(dataRoot, { limit: 2, scope: sc.scope });
    for (const t of targets) {
      if (picked.length >= max) break;
      if (sc.scope.startsWith('group:') && t.msgs < 12) continue;
      if (seen.has(t.senderId)) continue;
      seen.add(t.senderId);
      picked.push(t);
    }
  }
  const results = [];
  for (const t of picked) {
    // 串行：本地模型一次只跑一个
    // eslint-disable-next-line no-await-in-loop
    const r = await digestPerson({ dataRoot, senderId: t.senderId, cfg, llmCfg, chatImpl, force, now });
    results.push(r);
  }
  return { ok: results.some((r) => r.ok), results, targets: picked.length };
}

export default {
  digestPerson, digestAll, listTargets, listDigestScopes, conversationOf, makeSlices, loadSlices, pickOwner,
};
