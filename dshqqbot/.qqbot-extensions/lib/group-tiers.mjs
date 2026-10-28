// 群等级：特别关心群（priority）才会注入/沉淀个人印象卡；普通群只看群级信息。
// 配置文件：<dataRoot>/.qqbot-extensions/data/group-tiers.json，同时支持 memory-config.json 的 groupTiers 覆盖。
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-write.mjs';
import { join, dirname } from 'node:path';

export const TIERS_FILE = 'group-tiers.json';
export const TIER_DEFAULTS = {
  defaultTier: 'normal',   // 未列出的群默认普通群
  priority: [],            // 特别关心群（群 openid 或 group:<openid>）
  priorityPeople: [],      // 特别关心的人（QQ openid；普通群里遇到 TA 也按 priority 档：完整卡+召回）
  normal: [],              // 显式普通群（优先级低于 priority）
  profileInNormal: false,  // 普通群是否注入「完整」个人印象卡（默认只给精简认人块）
  digestNormal: false,     // 普通群是否参与历史印象汇总（默认不参与）
};

/**
 * 两层记忆的分工：
 *   · 个人层（跨群统一）：印象卡、熟识度 —— 同一个人在哪都认识；
 *   · 群层（按 scope 隔离）：聊天台账、记忆、心情 —— A 群的恶言恶语不带坏 B 群。
 *
 * 普通群（水群）默认「只看信息本身」：
 *   不召回长期记忆、不沉淀长期记忆、不写个人卡；但保留一个极短的认人块（名字+熟识等级），
 *   避免换群就不认人。特别关心群 / 私聊才是完整档。
 */
export const TIER_POLICY_DEFAULTS = {
  c2c: {
    profile: 'full', recall: true, capture: true, digest: true,
    agentFacts: true, agentCards: true, agentContextMsgs: 18,
  },
  priority: {
    profile: 'full', recall: true, capture: true, digest: true,
    agentFacts: true, agentCards: true, agentContextMsgs: 18,
  },
  normal: {
    profile: 'compact', recall: false, capture: false, digest: false,
    agentFacts: false, agentCards: false, agentContextMsgs: 5,
  },
};

function pickBool(v, d) {
  return v === true ? true : (v === false ? false : d);
}

/** 某个等级的实际策略（config 的 tierPolicy 可覆盖，旧开关也兼容） */
export function policyFor(tier, cfg = {}) {
  const t = String(tier || 'normal');
  const key = t === 'c2c' || t === 'priority' ? t : 'normal';
  const base = { ...TIER_POLICY_DEFAULTS[key] };
  const cfgObj = isPlain(cfg) ? cfg : {};
  const override = isPlain(cfgObj.tierPolicy) && isPlain(cfgObj.tierPolicy[key]) ? cfgObj.tierPolicy[key] : {};
  const legacy = loadGroupTiers('', cfgObj);
  const merged = {
    profile: String(override.profile || base.profile),
    recall: pickBool(override.recall, base.recall),
    capture: pickBool(override.capture, base.capture),
    digest: pickBool(override.digest, base.digest),
    agentFacts: pickBool(override.agentFacts, base.agentFacts),
    agentCards: pickBool(override.agentCards, base.agentCards),
    agentContextMsgs: Number(override.agentContextMsgs) > 0 ? Number(override.agentContextMsgs) : base.agentContextMsgs,
  };
  if (merged.profile !== 'off' && merged.profile !== 'compact') merged.profile = 'full';
  // 旧开关：profileInNormal=true → 普通群也 injection 完整卡；digestNormal=true → 普通群也参与汇总
  if (key === 'normal') {
    if (legacy.profileInNormal === true) merged.profile = 'full';
    if (legacy.digestNormal === true) merged.digest = true;
  }
  return merged;
}

export function tiersPathOf(dataRoot) {
  const root = String(dataRoot || '').trim();
  return root ? join(root, '.qqbot-extensions', 'data', TIERS_FILE) : '';
}

function normList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = String(x == null ? '' : x).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function isPlain(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function loadGroupTiers(dataRoot, cfg = {}) {
  let file = {};
  const p = tiersPathOf(dataRoot);
  if (p && existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      if (isPlain(raw)) file = raw;
    } catch { file = {}; }
  }
  const c = isPlain(cfg) ? cfg : {};
  const pick = (k) => (c[k] !== undefined ? c[k] : file[k]);
  return {
    defaultTier: String(pick('defaultTier') || TIER_DEFAULTS.defaultTier) === 'priority' ? 'priority' : 'normal',
    priority: normList(pick('priority')),
    priorityPeople: normList(pick('priorityPeople')),
    normal: normList(pick('normal')),
    profileInNormal: pick('profileInNormal') === true,
    digestNormal: pick('digestNormal') === true,
  };
}

export function saveGroupTiers(dataRoot, patch = {}) {
  const cur = loadGroupTiers(dataRoot, {});
  const next = { ...cur };
  for (const k of ['defaultTier', 'priority', 'priorityPeople', 'normal', 'profileInNormal', 'digestNormal']) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  next.priority = normList(next.priority);
  next.priorityPeople = normList(next.priorityPeople);
  next.normal = normList(next.normal);
  next.defaultTier = String(next.defaultTier) === 'priority' ? 'priority' : 'normal';
  next.profileInNormal = next.profileInNormal === true;
  next.digestNormal = next.digestNormal === true;
  const p = tiersPathOf(dataRoot);
  if (!p) return { ok: false, reason: 'no-data-root' };
  try {
    mkdirSync(dirname(p), { recursive: true });
    if (existsSync(p)) {
      try { copyFileSync(p, p + '.bak'); } catch { /* 备份失败不阻塞 */ }
    }
    // [qqbot-mod] atomic-write 2026-10-27：原子写（这份台账被 BOM 事故摚过一次，别再半截写）
    writeJsonAtomic(p, next);
    return { ok: true, path: p, tiers: next };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function groupIdOf(scope) {
  const s = String(scope || '').trim();
  return s.startsWith('group:') ? s.slice('group:'.length) : '';
}

export function tierOf(dataRoot, scope, cfg = {}) {
  const s = String(scope || '').trim();
  if (!s.startsWith('group:')) return 'c2c';
  const t = loadGroupTiers(dataRoot, cfg);
  const id = groupIdOf(s);
  if (t.priority.includes(id) || t.priority.includes(s)) return 'priority';
  if (t.normal.includes(id) || t.normal.includes(s)) return 'normal';
  return t.defaultTier;
}

// 兼容旧调用：现在统一走 tierPolicy
export function profileAllowedFor(tier, cfg = {}) {
  return policyFor(tier, cfg).agentCards;
}

export function digestAllowedFor(tier, cfg = {}) {
  return policyFor(tier, cfg).digest;
}

// 批量设置：把若干群设为 priority/normal
export function setGroupTier(dataRoot, ids = [], tier = 'priority') {
  const t = loadGroupTiers(dataRoot, {});
  const list = normList(ids);
  const want = tier === 'priority' ? 'priority' : 'normal';
  const other = want === 'priority' ? 'normal' : 'priority';
  const next = { ...t };
  next[want] = normList([...t[want], ...list]);
  next[other] = t[other].filter((x) => !list.includes(x) && !list.includes(String(x).replace(/^group:/, '')));
  return saveGroupTiers(dataRoot, next);
}

// 把群从两个名单中移除，回落到 defaultTier
export function clearGroupTier(dataRoot, ids = []) {
  const t = loadGroupTiers(dataRoot, {});
  const list = normList(ids).map((x) => String(x).replace(/^group:/, ''));
  const keep = (arr) => arr.filter((x) => !list.includes(String(x).replace(/^group:/, '')));
  return saveGroupTiers(dataRoot, { ...t, priority: keep(t.priority), normal: keep(t.normal) });
}

// ── 特别关心的人（2026-10-25 主人：印象卡/群聊也能设特别关心，名单可自行添加）──
//   语义：普通群里遇到名单里的 QQ，也按 priority 档处理（完整印象卡 + 长期记忆召回/沉淀）。
//   群级名单仍然是 priority/normal，人级名单独立存 priorityPeople，互不覆盖。
export function isPriorityPerson(dataRoot, senderId, cfg = {}) {
  const sid = String(senderId || '').trim();
  if (!sid) return false;
  const t = loadGroupTiers(dataRoot, cfg);
  return t.priorityPeople.includes(sid);
}

export function setPersonTier(dataRoot, ids = [], tier = 'priority') {
  const t = loadGroupTiers(dataRoot, {});
  const list = normList(ids).map((x) => String(x).replace(/^c2c:/, ''));
  const pri = normList(t.priorityPeople);
  const next = tier === 'clear'
    ? pri.filter((x) => !list.includes(x))
    : normList([...pri, ...list]);
  return saveGroupTiers(dataRoot, { ...t, priorityPeople: next });
}

export function clearPersonTier(dataRoot, ids = []) {
  return setPersonTier(dataRoot, ids, 'clear');
}

// ── 显示名 / 按名字加入（2026-10-25 主人：别显示 openid，用群号和 QQ 号，或者在聊天里点）──
//   现实约束：QQ 官方机器人接口只给 openid，不给群号/QQ 号，本地也没有 openid→号 的映射。
//   所以这里能拿到的稳定人话标识是：群名（.qqbot/groups.json）+ 昵称（msg-history 台账每行的 n）。
//   输入如果本来就是 openid，也照收（老用法不破坏）。
export function displayNameOf(dataRoot, kind, id) {
  const sid = String(id || '').replace(/^(group:|c2c:)/, '');
  if (!sid) return '';
  try {
    if (kind === 'group') {
      // [qqbot-mod] groups-bom-tolerant 2026-10-27：容忍 UTF-8 BOM
      const j = JSON.parse(String(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')).replace(/^\uFEFF/, ''));
      const rec = j && j[sid];
      if (rec && rec.name) return String(rec.name);
    }
  } catch { /* 没有群名就退回短码 */ }
  return '';
}

let NICK_CACHE = { at: 0, key: '', map: {} };

/** 从 msg-history 台账抓 { openid → 昵称 }（每个会话目录读最新文件的前若干行，5 分钟缓存） */
export function nickIndexOf(dataRoot) {
  const root = join(String(dataRoot), '.qqbot', 'msg-history');
  const key = root;
  const now = Date.now();
  if (NICK_CACHE.key === key && now - NICK_CACHE.at < 5 * 60 * 1000) return NICK_CACHE.map;
  const map = {};
  try {
    if (existsSync(root)) {
      for (const dir of readdirSync(root)) {
        const p = join(root, dir);
        let files = [];
        try { files = readdirSync(p).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2); } catch { continue; }
        for (const f of files) {
          let lines = [];
          try {
            const st = statSync(join(p, f));
            if (st.size > 4 * 1024 * 1024) continue;
            lines = readFileSync(join(p, f), 'utf8').split('\n');
          } catch { continue; }
          for (const ln of lines) {
            if (!ln || ln.charCodeAt(0) !== 123) continue;
            try {
              const o = JSON.parse(ln);
              const sid = String(o.s || '');
              const nk = String(o.n || '').trim();
              // 有些会话（尤其私聊）台账里的 n 直接就是 openid 本身，这种不算昵称，别拿它当显示名
              if (sid && nk && !/^[0-9A-Fa-f]{32}$/.test(nk) && nk !== sid) map[sid] = nk;
            } catch { /* 跳过坏行 */ }
          }
        }
      }
    }
  } catch { /* 台账不可读就空着 */ }
  NICK_CACHE = { at: now, key, map };
  return map;
}

/** 昵称 → openid（唯一命中才返回；命中多个返回 null 由调用方提示） */
export function openIdByNick(dataRoot, nick) {
  const want = String(nick || '').trim();
  if (!want) return { id: '', ambiguous: [] };
  const map = nickIndexOf(dataRoot);
  const hit = Object.keys(map).filter((sid) => map[sid] === want);
  if (hit.length === 1) return { id: hit[0], ambiguous: [] };
  if (hit.length > 1) return { id: '', ambiguous: hit };
  const fuzzy = Object.keys(map).filter((sid) => map[sid].includes(want) || want.includes(map[sid]));
  if (fuzzy.length === 1) return { id: fuzzy[0], ambiguous: [] };
  return { id: '', ambiguous: fuzzy };
}

/** 群名 → openid */
export function groupIdByName(dataRoot, name) {
  const want = String(name || '').trim();
  if (!want) return { id: '', ambiguous: [] };
  let j = {};
  try { j = JSON.parse(String(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')).replace(/^\uFEFF/, '')) || {}; } catch { return { id: '', ambiguous: [] }; }
  const all = Object.keys(j);
  const exact = all.filter((id) => String(j[id] && j[id].name || '') === want);
  if (exact.length === 1) return { id: exact[0], ambiguous: [] };
  if (exact.length > 1) return { id: '', ambiguous: exact };
  const fuzzy = all.filter((id) => String(j[id] && j[id].name || '').includes(want) || want.includes(String(j[id] && j[id].name || '')));
  if (fuzzy.length === 1) return { id: fuzzy[0], ambiguous: [] };
  return { id: '', ambiguous: fuzzy };
}

/**
 * 把一串「用户输入」解析成 peer id 列表。
 *   kind='group'  → 先当 openid（命中 groups.json 或看起来像 openid），否则当群名查 groups.json
 *   kind='person' → 先当 openid（在 msg-history 出现过的 id），否则当昵称查台账
 * 返回 { ids, unresolved: [原文...], ambiguous: [原文...] }
 */
export function resolveTierTargets(dataRoot, kind, input) {
  const parts = String(input || '')
    .split(/[,，\s]+/)
    .map((x) => String(x).replace(/^(group:|c2c:)/, '').trim())
    .filter(Boolean);
  const groups = (() => { try { return JSON.parse(String(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')).replace(/^\uFEFF/, '')) || {}; } catch { return {}; } })();
  const nicks = kind === 'group' ? {} : nickIndexOf(dataRoot);
  const ids = [];
  const unresolved = [];
  const ambiguous = [];
  for (const raw of parts) {
    if (kind === 'group') {
      if (groups[raw]) { ids.push(raw); continue; }
      const r = groupIdByName(dataRoot, raw);
      if (r.id) ids.push(r.id); else if (r.ambiguous.length) ambiguous.push(raw); else unresolved.push(raw);
    } else {
      if (nicks[raw]) { ids.push(raw); continue; }
      const r = openIdByNick(dataRoot, raw);
      if (r.id) ids.push(r.id); else if (r.ambiguous.length) ambiguous.push(raw); else unresolved.push(raw);
    }
  }
  return { ids: [...new Set(ids)], unresolved, ambiguous };
}

/** 面板用：把名单翻成「名字」（查不到就给短码，绝不吐完整 openid） */
export function nameMapFor(dataRoot, kind, ids = []) {
  const nicks = kind === 'group' ? {} : nickIndexOf(dataRoot);
  const out = {};
  for (const raw of ids) {
    const sid = String(raw).replace(/^(group:|c2c:)/, '');
    const nm = kind === 'group' ? displayNameOf(dataRoot, 'group', sid) : (nicks[sid] || '');
    out[sid] = nm ? nm : ('#' + sid.slice(-4));
  }
  return out;
}
