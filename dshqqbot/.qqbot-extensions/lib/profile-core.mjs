/**
 * profile-core.mjs — 「印象卡」与「心情」的读写 + 注入块
 *
 * 为什么需要：
 *   人格核是"她是谁"，世界书是"设定"，记忆库是"发生过什么"。
 *   还缺一层：**她对当前这个人、此刻状态的即时印象**。
 *   Neuro 那种"像人"的很大一部分来自这层——对熟人更松弛、今天没精神就话更少。
 *
 * 存哪：复用 persona 表（不用新表）
 *   ckey = 'card:<senderId>'  → cvalue = '爸爸：研究生，常熬夜，养猫叫年糕'
 *   ckey = '__mood'            → cvalue = '有点困，但还想聊'
 * 都在同一个聊天 scope 下，所以"群里的印象"和"私聊的印象"天然隔离。
 *
 * 契约：全程 try/catch；读不到就返回空块，绝不阻塞入站。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getPersonaValue, setPersona } from './memory.mjs';
// 兼容：inbound/aa-memory-recall.mjs 等从本模块取 getPersonaValue（2026-10-27 修：原先没再导出，整个记忆注入 hook 加载失败）
export { getPersonaValue };

export const CARD_PREFIX = 'card:';
export const BOND_PREFIX = 'bond:';
/** 统一后的熟识度记录：persona.ckey='fam:<senderId>'，唯一事实源 */
export const FAM_PREFIX = 'fam:';
/** 印象卡切片：persona.ckey='slice:<senderId>:<seq>' */
export const SLICE_PREFIX = 'slice:';
export const MOOD_KEY = '__mood';
/**
 * 个人层伪 scope（跨群统一）：
 *   印象卡 / 熟识度是「这个人是谁」，同一个 QQ 用户在哪都该被认识；
 *   聊天台账 / 记忆 / 心情仍按真实 scope 隔离（A 群的恶言恶语不带坏 B 群）。
 */
export const GLOBAL_SCOPE = '__global__';

export const PROFILE_DEFAULTS = { enabled: true, maxChars: 300 };
export const MOOD_DEFAULTS = { enabled: true, maxChars: 30, ttlMs: 30 * 60 * 1000 };
export const BOND_DEFAULTS = {
  enabled: true, maxChars: 240, startAffinity: 12, startTrust: 10,
  /** 原生 affinity/attitude 同步节流（默认 10 分钟） */
  nativeSyncMs: 10 * 60 * 1000,
  /**
   * 云端缓存优化（2026-10-24）：
   * 默认输出「稳定块」——只放印象卡正文 + 等级，不放每轮都会变的亲近/信任原始分
   * 和「最近：…」备注。这样同一个人的 [印象] 块在数值微调时字符级不变，
   * 云端 prompt 前缀缓存能持续命中。想看数值就把 stable 设 false。
   */
  stable: true,
  showNumbers: false,
  numberStep: 10,
  stableNote: false,
};

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 当前这个人的印象卡（个人层优先 = 跨群统一；退回本会话旧卡兼容历史数据） */
export function getProfileCard(dataRoot, scope, { senderId = '', senderName = '' } = {}) {
  const keys = [];
  if (senderId) keys.push(CARD_PREFIX + String(senderId));
  if (senderName) keys.push(CARD_PREFIX + String(senderName));
  if (!keys.length) return null;
  const scopes = [GLOBAL_SCOPE];
  const local = String(scope || '').trim();
  if (local && local !== GLOBAL_SCOPE) scopes.push(local);
  for (const sc of scopes) {
    for (const k of keys) {
      try {
        const v = getPersonaValue(dataRoot, sc, k);
        if (v && String(v.value || '').trim()) {
          return { key: k, text: String(v.value).trim(), ts: v.ts || 0, scope: sc };
        }
      } catch { /* 换下一个 key */ }
    }
  }
  return null;
}

/** 拼成 [印象] 块（≤120 字，单人一条） */
export function profileBlockFor(dataRoot, scope, who = {}, cfg = {}) {
  const c = { ...PROFILE_DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return '';
  try {
    const card = getProfileCard(dataRoot, scope, who);
    if (!card) return '';
    const text = card.text.replace(/\s+/g, ' ').slice(0, Math.max(20, num(c.maxChars, 120)));
    if (!text) return '';
    return '\n[印象]' + text + '[/印象]';
  } catch { return ''; }
}

/** 取当前心情（过期就不带） */
export function getMood(dataRoot, scope, cfg = {}) {
  const c = { ...MOOD_DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return null;
  try {
    const v = getPersonaValue(dataRoot, scope, MOOD_KEY);
    if (!v || !String(v.value || '').trim()) return null;
    const age = Date.now() - (Number(v.ts) || 0);
    if (age > Math.max(60000, num(c.ttlMs, MOOD_DEFAULTS.ttlMs))) return null;
    return { text: String(v.value).trim(), ts: v.ts || 0 };
  } catch { return null; }
}

/** 写当前心情（由本地记忆分身回合后判定） */
export function saveMood(dataRoot, scope, text, cfg = {}) {
  const c = { ...MOOD_DEFAULTS, ...(cfg || {}) };
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, Math.max(10, num(c.maxChars, 30)));
  if (!t) return { ok: false, reason: 'empty' };
  try {
    const r = setPersona(dataRoot, scope, { ckey: MOOD_KEY, cvalue: t, weight: 1 });
    return r && r.ok ? { ok: true, text: t } : { ok: false, reason: (r && r.reason) || 'write-fail' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 拼成 [状态] 块（≤30 字） */
export function moodBlockFor(dataRoot, scope, cfg = {}) {
  const c = { ...MOOD_DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return '';
  try {
    const m = getMood(dataRoot, scope, c);
    if (!m) return '';
    const text = m.text.slice(0, Math.max(10, num(c.maxChars, 30)));
    return '\n[状态]' + text + '[/状态]';
  } catch { return ''; }
}

// ── 关系温度：亲近 / 信任（0~100，慢慢变，不会一句话就翻天覆地）──────────
// 存 persona：ckey='bond:<senderId>'，cvalue 是 JSON {a,t,note,ts}
// 兼容旧数据：如果 cvalue 不是 JSON，就当作一句备注，数值用起点默认值。

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(num(n, lo))));
}

/** 关系阶段（给 prompt 用的人话，不暴露数字逻辑） */
export function bondPhase(a, t) {
  const v = (num(a, 0) * 0.6) + (num(t, 0) * 0.4);
  if (v >= 80) return '很亲近';
  if (v >= 60) return '亲近';
  if (v >= 40) return '熟悉';
  if (v >= 20) return '认识';
  return '刚认识';
}

function bondKeyOf({ senderId = '', senderName = '' } = {}) {
  if (senderId) return BOND_PREFIX + String(senderId);
  if (senderName) return BOND_PREFIX + String(senderName);
  return '';
}

function parseBond(raw, cfg) {
  const c = { ...BOND_DEFAULTS, ...(cfg || {}) };
  const base = {
    a: clamp(c.startAffinity, 0, 100),
    t: clamp(c.startTrust, 0, 100),
    note: '',
    ts: 0,
  };
  const s = String(raw || '').trim();
  if (!s) return base;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      return {
        a: clamp(o.a, 0, 100),
        t: clamp(o.t, 0, 100),
        note: String(o.note || '').replace(/\s+/g, ' ').trim(),
        ts: num(o.ts, 0),
      };
    } catch { /* 坏 JSON 当备注 */ }
  }
  return { ...base, note: s };
}

function famKeyOf({ senderId = '', senderName = '' } = {}) {
  if (senderId) return FAM_PREFIX + String(senderId);
  if (senderName) return FAM_PREFIX + String(senderName);
  return '';
}

/** 熟识等级（0~6）：只给 UI 和 prompt 用 */
export function levelOf(score) {
  const s = num(score, 0);
  if (s >= 90) return 6;
  if (s >= 75) return 5;
  if (s >= 60) return 4;
  if (s >= 45) return 3;
  if (s >= 30) return 2;
  if (s >= 15) return 1;
  return 0;
}

const LEVEL_LABELS = ['陌生', '眼熟', '认识', '熟悉', '亲近', '很熟', '羁绊'];
export function levelLabel(level) {
  return LEVEL_LABELS[clamp(level, 0, 6)] || '陌生';
}

function parseFam(raw, cfg) {
  const c = { ...BOND_DEFAULTS, ...(cfg || {}) };
  const base = {
    a: clamp(c.startAffinity, 0, 100),
    t: clamp(c.startTrust, 0, 100),
    note: '',
    ts: 0,
    hist: [],
    nativeAt: 0,
  };
  const s = String(raw || '').trim();
  if (!s) return base;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      return {
        a: clamp(o.a, 0, 100),
        t: clamp(o.t, 0, 100),
        note: String(o.note || '').replace(/\s+/g, ' ').trim(),
        ts: num(o.ts, 0),
        hist: Array.isArray(o.hist) ? o.hist.slice(-10) : [],
        nativeAt: num(o.nativeAt, 0),
      };
    } catch { /* 坏 JSON 当备注 */ }
  }
  return { ...base, note: s };
}

// ── 原生熟识度（affinity.json / attitude.json）只做导入源 ──────────────────
const _nativeCache = new Map(); // file → { mtimeMs, map }

function loadNativeMap(file) {
  if (!existsSync(file)) return {};
  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { mtimeMs = Date.now(); }
  const hit = _nativeCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.map;
  let map = {};
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    map = (j && j.map) || {};
  } catch { map = {}; }
  _nativeCache.set(file, { mtimeMs, map });
  return map;
}

/** 读这个人插件原生的亲近/信任（0~100）；没有就 null */
export function readNativeFamiliarity(dataRoot, senderId) {
  const id = String(senderId || '').trim();
  if (!id) return null;
  try {
    const dir = join(String(dataRoot || ''), '.qqbot');
    const key = 'person:' + id;
    const aff = loadNativeMap(join(dir, 'affinity.json'))[key] || null;
    const att = loadNativeMap(join(dir, 'attitude.json'))[key] || null;
    if (!aff && !att) return null;
    const a = clamp((num(att && att.a, 0) || 0) * 100, 0, 100);
    // 信任没有直接字段：用互动量做保守估计（182 条 ≈ 42）
    const msgs = num(aff && aff.msgs, 0);
    const t = clamp(20 + 10 * Math.log10(1 + Math.max(0, msgs)), 0, 100);
    return { a, t, name: String((aff && aff.name) || (att && att.name) || ''), msgs, lastAt: num(aff && aff.lastAt, 0) };
  } catch { return null; }
}

/**
 * persona 里的 fam 记录 — 唯一事实源（读时会做一次 bond: 兼容迁移 + 原生同步）
 *
 * 2026-10-24（用户口径）：熟识度属于「个人层」，同一个 QQ 用户跨群统一。
 *   读：先读 GLOBAL_SCOPE；没有就把本会话的旧 fam（或更老的 bond）提升上来；
 *   写：一律写 GLOBAL_SCOPE。
 *   群级隔离只针对聊天台账/记忆/心情，不针对「你认识这个人到什么程度」。
 */
export function getFamiliarity(dataRoot, scope, who = {}, cfg = {}) {
  const c = { ...BOND_DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return null;
  const key = famKeyOf(who);
  if (!key) return null;
  try {
    let migrated = false;
    const localScope = String(scope || '').trim();
    let v = getPersonaValue(dataRoot, GLOBAL_SCOPE, key);
    let f;
    if (v && String(v.value || '').trim()) {
      f = parseFam(v.value, c);
    } else {
      // 旧数据迁移①：本会话的 fam
      const lv = localScope && localScope !== GLOBAL_SCOPE ? getPersonaValue(dataRoot, localScope, key) : null;
      if (lv && String(lv.value || '').trim()) {
        f = parseFam(lv.value, c);
        migrated = true;
      } else {
        // 旧数据迁移②：更老的 bond（本会话 → 个人层）
        const oldKey = bondKeyOf(who);
        const ov = oldKey
          ? (localScope && localScope !== GLOBAL_SCOPE ? getPersonaValue(dataRoot, localScope, oldKey) : null)
            || getPersonaValue(dataRoot, GLOBAL_SCOPE, oldKey)
          : null;
        f = parseFam(ov && ov.value, c);
        migrated = !!ov;
      }
    }

    const nat = readNativeFamiliarity(dataRoot, who.senderId);
    const now = Date.now();
    let synced = false;
    if (nat && (migrated || !f.nativeAt || now - f.nativeAt > Math.max(60000, num(c.nativeSyncMs, 600000)))) {
      // 只做温和融合，原生数据不能把真实互动累积一把冲掉
      f.a = clamp(f.a * 0.7 + nat.a * 0.3, 0, 100);
      f.t = clamp(f.t * 0.7 + nat.t * 0.3, 0, 100);
      f.nativeAt = now;
      if (!f.note) f.note = '原生互动数据已导入';
      synced = true;
    }

    if (migrated || synced) {
      const rec = { ...f, ts: f.ts || now };
      try { setPersona(dataRoot, GLOBAL_SCOPE, { ckey: key, cvalue: JSON.stringify(rec), weight: 2 }); } catch { /* 写失败只影响下次同步 */ }
    }
    const s = clamp(f.a * 0.6 + f.t * 0.4, 0, 100);
    return {
      key, scope: GLOBAL_SCOPE, a: f.a, t: f.t, s,
      level: levelOf(s), levelLabel: levelLabel(levelOf(s)),
      note: f.note, ts: f.ts || (v && v.ts) || 0, hist: f.hist || [],
      phase: bondPhase(f.a, f.t),
      known: !!(f.ts || f.note || migrated || synced),
    };
  } catch { return null; }
}

/** 写一次完整记录（供 profile-digest 联动 relation 备注；一律写个人层） */
export function setFamiliarity(dataRoot, scope, who = {}, patch = {}, cfg = {}) {
  const c = { ...BOND_DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return { ok: false, reason: 'disabled' };
  const key = famKeyOf(who);
  if (!key) return { ok: false, reason: 'no-who' };
  try {
    const cur = getFamiliarity(dataRoot, scope, who, c) || {
      a: clamp(c.startAffinity, 0, 100), t: clamp(c.startTrust, 0, 100), note: '', ts: 0, hist: [], nativeAt: 0,
    };
    const next = {
      a: clamp(patch.a == null ? cur.a : patch.a, 0, 100),
      t: clamp(patch.t == null ? cur.t : patch.t, 0, 100),
      note: String(patch.note == null ? cur.note : patch.note).replace(/\s+/g, ' ').trim().slice(0, 80),
      ts: Date.now(),
      hist: Array.isArray(cur.hist) ? cur.hist.slice(-10) : [],
      nativeAt: num(patch.nativeAt, cur.nativeAt || 0),
    };
    if (patch.a != null || patch.t != null) {
      next.hist.push({ ts: next.ts, a: next.a, t: next.t, why: String(patch.why || 'set').slice(0, 24) });
      next.hist = next.hist.slice(-10);
    }
    const r = setPersona(dataRoot, GLOBAL_SCOPE, { ckey: key, cvalue: JSON.stringify(next), weight: 2 });
    return r && r.ok ? { ok: true, key, ...next, level: levelOf(next.a * 0.6 + next.t * 0.4) } : { ok: false, reason: (r && r.reason) || 'write-fail' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 微调熟识度（原 bumpBond 的唯一实现）。delta 是 -5..5 的整数。
 * 只做小步变化：一次争吵不会直接归零，一次撒娇也不会直接满格。
 */
export function bumpFamiliarity(dataRoot, scope, who = {}, { delta = 0, note = '', trustDelta } = {}, cfg = {}) {
  const c = { ...BOND_DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return { ok: false, reason: 'disabled' };
  const d = clamp(delta, -5, 5);
  const td = trustDelta == null ? Math.round(d * 0.8) : clamp(trustDelta, -5, 5);
  const cur = getFamiliarity(dataRoot, scope, who, c);
  if (!cur) return { ok: false, reason: 'no-who' };
  const r = setFamiliarity(dataRoot, scope, who, {
    a: cur.a + d,
    t: cur.t + td,
    note: String(note || cur.note || '').slice(0, 80),
    why: (d >= 0 ? '互动 +' : '互动 ') + d,
    nativeAt: cur.note ? undefined : cur.nativeAt,
  }, c);
  return r.ok ? { ...r, phase: bondPhase(r.a, r.t), delta: d } : r;
}

/** 兼容旧名：读关系（现在读统一 fam） */
export function getBond(dataRoot, scope, who = {}, cfg = {}) {
  return getFamiliarity(dataRoot, scope, who, cfg);
}

/** 兼容旧名：bumpBond → fam */
export function bumpBond(dataRoot, scope, who = {}, opts = {}, cfg = {}) {
  return bumpFamiliarity(dataRoot, scope, who, opts, cfg);
}

/**
 * 拼成「印象 + 熟识度」统一块（用户 2026-10-23：两者必须统一）。
 *
 * 2026-10-24（云端缓存）：默认 stable 模式 ——
 *   [印象]爸爸：研究生，常熬夜，养猫叫年糕 · 熟悉[/印象]
 *   · 不再重复昵称（卡片正文本身常以「名字：」开头）；
 *   · 不输出亲近/信任原始分（它们每轮都可能微调，一变整段 prompt 就变）；
 *   · 不输出「最近：…」备注（记忆分身每次回合都可能改写）；
 *   · 等级只在跨档时才变，因此同一人的块在大多数轮次里**字符级一致**。
 * 想看数值/备注：profile/bond 配置里设 stable:false（或 showNumbers:true）。
 */
export function familiarityBlockFor(dataRoot, scope, who = {}, cfg = {}) {
  const c = { ...BOND_DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return '';
  try {
    const card = getProfileCard(dataRoot, scope, who);
    const f = getFamiliarity(dataRoot, scope, who, c);
    if (!card && !f) return '';
    const name = String(who.senderName || '').trim();
    const stable = c.stable !== false;
    const bits = [];

    // 数值段：stable 模式只留等级；非 stable 模式按 numberStep 分桶（showNumbers 才给原值）
    const levelPart = () => {
      if (!f) return '';
      if (stable && c.showNumbers !== true) return f.levelLabel;
      const step = Math.max(1, num(c.numberStep, 10));
      const a = c.showNumbers === true ? f.a : Math.round(f.a / step) * step;
      const t = c.showNumbers === true ? f.t : Math.round(f.t / step) * step;
      return `${f.levelLabel}（亲近 ${a}/100 · 信任 ${t}/100）`;
    };

    if (card && card.text) {
      const body = card.text.replace(/\s+/g, ' ').trim();
      // 卡片常以「爸爸：…」开头；再加一次名字会变成「爸爸 · 爸爸：…」
      const dupName = name && new RegExp('^' + escapeRe(name) + '\\s*[:：]').test(body);
      if (name && !dupName) bits.push(name);
      bits.push(body);
      const lv = levelPart();
      if (lv) bits.push(lv);
    } else if (f) {
      if (name) bits.push(name);
      bits.push('认识程度：' + levelPart());
    }

    if (f && f.note && (!stable || c.stableNote === true)) bits.push('最近：' + f.note);

    const text = bits.join(' · ').replace(/\s+/g, ' ').slice(0, Math.max(40, num(c.maxChars, 240)));
    return text ? '\n[印象]' + text + '[/印象]' : '';
  } catch { return ''; }
}

/**
 * 普通群用的极简「认人块」：只有名字 + 熟识等级（~10 字），不带卡片正文。
 * 目的：水群里也知道"这个人我认识、到什么程度"，但前缀极小且稳定，省 token。
 * 只对真的见过的人输出（有卡或有熟识记录），陌生人一个字都不多花。
 */
export function compactBlockFor(dataRoot, scope, who = {}, cfg = {}) {
  const c = { ...BOND_DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return '';
  try {
    const card = getProfileCard(dataRoot, scope, who);
    const f = getFamiliarity(dataRoot, scope, who, c);
    const known = !!card || !!(f && f.known);
    if (!known) return '';
    const name = String(who.senderName || '').trim()
      || (card ? String(card.text).split(/[:：]/)[0].trim() : '');
    const label = name || (who.senderId ? '用户' + String(who.senderId).slice(-4) : '');
    if (!label) return '';
    const text = (f && f.levelLabel ? label + ' · ' + f.levelLabel : label)
      .replace(/\s+/g, ' ')
      .slice(0, 24);
    return text ? '\n[印象]' + text + '[/印象]' : '';
  } catch { return ''; }
}

/** 兼容旧名：只输出关系那一段（新链路用 familiarityBlockFor，不再重复调用本函数） */
export function bondBlockFor(dataRoot, scope, who = {}, cfg = {}) {
  const c = { ...BOND_DEFAULTS, ...(cfg || {}) };
  if (c.enabled === false) return '';
  try {
    const f = getFamiliarity(dataRoot, scope, who, c);
    if (!f) return '';
    const name = String(who.senderName || who.senderId || '').trim();
    if (!name) return '';
    const bits = [name, '亲近 ' + f.a + '/100', '信任 ' + f.t + '/100', f.levelLabel];
    if (f.note) bits.push('最近：' + f.note);
    const text = bits.join(' · ').replace(/\s+/g, ' ').slice(0, Math.max(40, num(c.maxChars, 240)));
    return '\n[关系]' + text + '[/关系]';
  } catch { return ''; }
}

export default {
  CARD_PREFIX, BOND_PREFIX, FAM_PREFIX, SLICE_PREFIX, MOOD_KEY, GLOBAL_SCOPE, getProfileCard, profileBlockFor, getMood, saveMood, moodBlockFor,
  getBond, bumpBond, bondBlockFor, bondPhase,
  getFamiliarity, setFamiliarity, bumpFamiliarity, familiarityBlockFor, compactBlockFor, readNativeFamiliarity, levelOf, levelLabel,
  PROFILE_DEFAULTS, MOOD_DEFAULTS, BOND_DEFAULTS,
};
