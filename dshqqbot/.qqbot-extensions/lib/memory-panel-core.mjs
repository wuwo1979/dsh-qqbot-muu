/**
 * memory-panel-core.mjs — 浮窗「记忆」页的数据源（只读，不写库）
 *
 * 给 hooks/memory-panel.mjs 的 HTTP 路由调用；也可以直接 node 里 import 做自检。
 * 返回：台账统计 / 最近消息 / 提炼记忆 / 印象卡 / 关系温度 / 心情 / 分身日志 / 召回轨迹。
 */
import { openDb, memDecrypt } from './memory-db.mjs';
import { loadConfig } from './memory.mjs';
import { hippoStats, driftReport } from './memory-hippo.mjs';
import { readAgentLog, readTrace } from './memory-trace.mjs';
import { loadConfig as loadLlmConfig } from './local-llm.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── 角色档案（名字 / 关系）──────────────────────────────────────────────
// 主人 2026-10-26：机器人是他起的 MuU、我们这边叫小蓝，是同一个"人"；妈妈=妈妈、
// 爸爸=爸爸 已写在角色档案里，印象卡不该再冒出一条"妈妈"，也不该给同一个人两个称呼。
// 记忆库里 agent 写的卡未必知道这些，所以这里以档案为准做归并展示。
const ROLE_WORDS = ['妈妈', '母亲', '妈咪', '爸爸', '父亲', '爹', '姐姐', '哥哥', '爷爷', '奶奶'];

let _charCache = { at: 0, v: null };

export function loadCharacter(dataRoot) {
  const now = Date.now();
  if (_charCache.v && now - _charCache.at < 60000) return _charCache.v;
  const cands = [];
  try { cands.push(join(dirname(dirname(dataRoot)), 'qqbot-mod', 'persona', 'character.json')); } catch { /* ignore */ }
  cands.push('F:/qqbot/qqbot-mod/persona/character.json');
  let v = { name: '', aliases: [], display: '', relations: [], relationOf: {}, roleOwner: {}, influences: [] };
  for (const p of cands) {
    try {
      if (!existsSync(p)) continue;
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const name = String(j.name || '').trim();
      const aliases = Array.isArray(j.aliases) ? j.aliases.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const relations = Array.isArray(j.relations)
        ? j.relations.map((r) => ({ who: String((r && r.who) || '').trim(), role: String((r && r.role) || '').trim() })).filter((r) => r.who)
        : [];
      const relationOf = {};
      const roleOwner = {};
      for (const r of relations) {
        relationOf[r.who] = r.role;
        for (const w of ROLE_WORDS) {
          if (r.role.includes(w) && !roleOwner[w]) roleOwner[w] = r.who;
        }
      }
      const influences = Array.isArray(j.influences) ? j.influences : [];
      const strList = (a) => (Array.isArray(a) ? a.map((x) => String(x || '').trim()).filter(Boolean) : []);
      v = {
        name, aliases, relations, relationOf, roleOwner, influences,
        // 2026-10-26：自己的印象卡不能靠"熟识度"算（"刚认识"对自己没有意义），
        // 所以把档案里这些自我描述一起带出来，由 buildSelfCard() 合成。
        species: String(j.species || '').trim(),
        origin: String(j.origin || '').trim(),
        ageFeel: String(j.age_feel || '').trim(),
        selfCall: strList(j.selfCall),
        core: strList(j.core),
        likes: strList(j.likes),
        dislikes: strList(j.dislikes),
        quirks: strList(j.quirks),
        tics: strList(j.speech && j.speech.tics),
        display: [name, ...aliases].filter(Boolean).join('/'),
      };
      break;
    } catch { /* 下一个候选 */ }
  }
  _charCache = { at: now, v };
  return v;
}

function isRoleWord(s) {
  const t = String(s || '').trim();
  return ROLE_WORDS.some((w) => t === w || t === w + '妈' || t === w + '咪');
}

/** 卡片名里的"关系后缀"：`妈妈（妈妈·管理员）` → `妈妈`、`妈妈妈妈` → `妈妈` + 妈妈 */
export function splitRelationName(s) {
  let t = String(s || '').trim();
  let roleHint = '';
  const m = t.match(/[（(]([^）)]*)[）)]\s*$/);
  if (m) { roleHint = m[1].trim(); t = t.slice(0, m.index).trim(); }
  if (!roleHint) {
    const hit = ROLE_WORDS.find((w) => t.length > w.length && t.endsWith(w));
    if (hit) { roleHint = hit; t = t.slice(0, t.length - hit.length).trim(); }
  }
  return { base: t, roleHint };
}

/**
 * 把"卡名"归到人身上。
 *
 * 主人反复提的问题：妈妈是妈妈这件事老是归不好 —— 数据库里同时存在
 * `card:妈妈（妈妈·管理员）`、`card:妈妈`、`card:妈妈妈妈`，还有 `card:小蓝`。
 * 只做"整串等于角色词"的判断永远合不掉 `妈妈妈妈` 这种写法。
 */
export function resolveCardIdentity(rawName, ctx) {
  const { roleOwner = {}, relationOf = {}, selfNames = new Set(), display = '' } = ctx || {};
  const nm = String(rawName || '').trim();
  if (!nm) return { name: nm, role: '', kind: 'other' };

  const { base, roleHint } = splitRelationName(nm);
  const roleWordOf = (hint) => ROLE_WORDS.find((w) => String(hint || '').includes(w)) || '';
  const hintWord = roleWordOf(roleHint);

  // ① 自己：小蓝 / MuU / 带后缀的"小蓝（鲸鱼娘）"
  const isSelfName = (x) => !!x && (selfNames.has(x) || [...selfNames].some((s) => s && (x === s || x.startsWith(s))));
  if (isSelfName(nm) || isSelfName(base)) return { name: display || nm, role: '我自己', kind: 'self' };

  // ② 光一个角色词（妈妈 / 妈妈妈 / 妈妈妈妈 的后者已在上一步拆出 base=妈妈）
  if (isRoleWord(nm) && roleOwner[nm]) {
    return { name: roleOwner[nm], role: relationOf[roleOwner[nm]] || nm, kind: 'owner', hint: nm };
  }
  if (hintWord && roleOwner[hintWord]) {
    // 有前缀且前缀是档案里的人（妈妈妈妈），或前缀为空（妈妈（管理员））都归过去
    const owner = roleOwner[hintWord];
    if (!base || base === owner || relationOf[base]) {
      return { name: owner, role: relationOf[owner] || hintWord, kind: 'owner', hint: nm };
    }
  }

  // ③ 档案里登记过的名字
  if (relationOf[nm]) return { name: nm, role: relationOf[nm], kind: 'declared' };
  if (base && relationOf[base]) return { name: base, role: relationOf[base], kind: 'declared' };
  if (base && base !== nm) return { name: base, role: roleHint, kind: 'other' };
  return { name: nm, role: '', kind: 'other' };
}

/**
 * 自己的印象卡（2026-10-26）
 *
 * 主人原话："印象卡里关于自己的小蓝：刚认识，还不熟，怎么对自己还能不熟？
 * 这里应该是关于自己的印象，比如自己的喜好、性格等，参考爸爸妈妈的来。"
 *
 * 所以自己的卡不再从熟识度算，而是直接从 persona/character.json 合成：
 * 身份 + 性格 + 喜欢/受不了 + 口癖 + 脾气从谁身上长出来的。
 */
export function buildSelfCard(char) {
  if (!char || !char.name) return null;
  const parts = [];
  const who = [char.species, char.origin ? '从' + char.origin + (char.origin.endsWith('沟') ? '游' : '来') + '到人类网络' : '']
    .filter(Boolean).join('，');
  if (who) parts.push(who);
  if (char.core.length) parts.push('性格：' + char.core.join('、'));
  if (char.likes.length) parts.push('喜欢：' + char.likes.join('、'));
  if (char.dislikes.length) parts.push('受不了：' + char.dislikes.join('、'));
  if (char.quirks.length) parts.push('小毛病：' + char.quirks.slice(0, 2).join('；'));
  if (char.tics.length) parts.push('说话偶尔带「' + char.tics[0] + '」');
  const from = (char.influences || [])
    .map((i) => String((i && i.who) || '').trim() + (i && i.role ? '（' + i.role + '）' : ''))
    .filter(Boolean);
  if (from.length) parts.push('脾气一半是自己的，一半是从' + from.join('、') + '身上长出来的');
  return {
    name: char.name,
    display: char.display,
    species: char.species,
    origin: char.origin,
    ageFeel: char.ageFeel,
    core: char.core,
    likes: char.likes,
    dislikes: char.dislikes,
    quirks: char.quirks,
    tics: char.tics,
    influences: (char.influences || []).map((i) => ({
      who: String((i && i.who) || ''), role: String((i && i.role) || ''),
      trait: String((i && i.trait) || ''), effect: String((i && i.effect) || ''),
    })),
    text: parts.join('；') + '。',
  };
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function scopeKind(scope) {
  const s = String(scope || '');
  if (s.startsWith('c2c:')) return '私聊';
  if (s.startsWith('group:')) return '群聊';
  return '其他';
}

function parseBond(v) {
  const s = String(v || '').trim();
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      return {
        a: Math.round(num(o.a)), t: Math.round(num(o.t)),
        note: String(o.note || '').trim(), ts: num(o.ts),
      };
    } catch { /* 当备注 */ }
  }
  return { a: null, t: null, note: s, ts: 0 };
}

export function collectMemoryPanel(dataRoot, { scope = '', limit = 30 } = {}) {
  const root = String(dataRoot || '').trim();
  const out = {
    ok: true,
    dataRoot: root,
    ts: Date.now(),
    stats: { chatTotal: 0, memTotal: 0, personaTotal: 0, scopes: [] },
    chat: [],
    memories: [],
    cards: [],
    bonds: [],
    familiarity: [],
    digest: [],
    models: {},
    moods: [],
    agent: { enabled: null, intervalMs: 0, minNewMessages: 0, model: '', states: [], log: [] },
    recall: [],
    errors: [],
  };
  if (!root) {
    out.ok = false;
    out.errors.push('缺少 dataRoot');
    return out;
  }

  const lim = Math.max(1, Math.min(200, num(limit, 30)));
  const sc = String(scope || '').trim();
  const where = sc ? ' WHERE scope = ?' : '';
  const args = sc ? [sc] : [];
  // 印象卡/熟识度/状态是"人"的事实，不是"某个群"的事实：
  // 按会话过滤会把 妈妈/爸爸 整张卡筛掉（面板里只剩"自己"），所以名单类一律跨 scope 读。
  const pWhere = '';

  let db = null;
  try {
    db = openDb(root);
    db = db && db.db;
  } catch (e) {
    out.ok = false;
    out.errors.push('打开数据库失败: ' + (e instanceof Error ? e.message : String(e)));
    return out;
  }

  const q = (sql, ...a) => {
    try { return db.prepare(sql).all(...a); } catch (e) {
      out.errors.push(String(e && e.message || e).slice(0, 120));
      return [];
    }
  };

  try {
    const c = q('SELECT COUNT(*) AS n, MAX(ts) AS lastTs FROM chat' + where, ...args)[0] || {};
    out.stats.chatTotal = num(c.n);
    out.stats.chatLastTs = num(c.lastTs);

    out.stats.scopes = q(
      'SELECT scope, COUNT(*) AS n, MAX(ts) AS lastTs FROM chat' + where + ' GROUP BY scope ORDER BY lastTs DESC LIMIT 20',
      ...args,
    ).map((r) => ({ scope: r.scope, kind: scopeKind(r.scope), n: num(r.n), lastTs: num(r.lastTs) }));

    out.stats.memTotal = num((q('SELECT COUNT(*) AS n FROM mem' + where, ...args)[0] || {}).n);
    out.stats.personaTotal = num((q('SELECT COUNT(*) AS n FROM persona' + where, ...args)[0] || {}).n);
    out.stats.famTotal = num((q("SELECT COUNT(*) AS n FROM persona WHERE ckey LIKE 'fam:%'")[0] || {}).n);
    try {
      const em = q("SELECT v FROM meta WHERE k = 'embedding_model'")[0];
      if (em && em.v) out.models.indexed = JSON.parse(em.v);
    } catch { /* ignore */ }

    out.chat = q(
      'SELECT scope, ts, dir, sender, kind, text FROM chat' + where + ' ORDER BY ts DESC, rowid DESC LIMIT ?',
      ...args, lim,
    ).map((r) => ({
      scope: r.scope, kind: scopeKind(r.scope), ts: num(r.ts), dir: r.dir,
      sender: String(r.sender || '').trim() || (r.dir === 'out' ? '小蓝' : '群友'),
      text: clip(r.text, 160),
    }));

    out.memories = q(
      'SELECT scope, kind, subj, text, ts, hits FROM mem' + where + ' ORDER BY ts DESC LIMIT ?',
      ...args, lim,
    ).map((r) => ({
      scope: r.scope, kind: String(r.kind || 'fact'), subj: String(r.subj || ''),
      text: clip(memDecrypt(dataRoot, r.text), 160), ts: num(r.ts), hits: num(r.hits),
    }));

    const ps = q(
      'SELECT scope, ckey, cvalue, weight, ts FROM persona' + pWhere + ' ORDER BY ts DESC LIMIT ?',
      Math.max(60, lim * 2),
    );
    for (const p of ps) {
      const key = String(p.ckey || '');
      if (key.startsWith('card:')) {
        out.cards.push({ scope: p.scope, key, text: clip(p.cvalue, 320), ts: num(p.ts) });
      } else if (key.startsWith('slice:')) {
        let v = {};
        try { v = JSON.parse(p.cvalue || '{}'); } catch { v = { summary: String(p.cvalue || '') }; }
        out.digest.push({
          scope: p.scope, key, senderId: key.split(':')[1] || '', seq: num(key.split(':')[2]),
          summary: clip(v.summary, 200), traits: Array.isArray(v.traits) ? v.traits : [],
          period: String(v.period || ''), n: num(p.weight), ts: num(p.ts),
        });
      } else if (key.startsWith('fam:')) {
        let v = {};
        try { v = JSON.parse(p.cvalue || '{}'); } catch { v = {}; }
        out.familiarity.push({
          scope: p.scope, key, senderId: key.slice('fam:'.length),
          a: Math.round(num(v.a)), t: Math.round(num(v.t)),
          s: Math.round(num(v.a) * 0.6 + num(v.t) * 0.4),
          note: clip(v.note, 80), ts: num(p.ts), source: 'fam',
        });
      } else if (key.startsWith('bond:')) {
        const b = parseBond(p.cvalue);
        out.bonds.push({
          scope: p.scope, key, name: key.slice('bond:'.length),
          a: b.a, t: b.t, note: clip(b.note, 60), ts: b.ts || num(p.ts),
        });
      } else if (key === '__mood') {
        out.moods.push({ scope: p.scope, text: clip(p.cvalue, 60), ts: num(p.ts) });
      }
    }
    // 印象卡 cvalue 形如 "名字：内容"，拆出名字方便 UI
    for (const c of out.cards) {
      const v = String(c.text || '');
      const i = v.indexOf('：');
      c.name = i > 0 ? v.slice(0, i) : '';
      c.text = i > 0 ? v.slice(i + 1) : v;
    }
    // ── 以角色档案归并印象卡 / 熟识度（主人 2026-10-26）──
    // ①卡片名字是"妈妈/爸爸"这种角色词，而档案里已把这个人记成某某（妈妈）→ 合并到那个人身上，不再单列；
    // ②档案里声明过的人（妈妈/爸爸）在卡上打 declared 标记 + 关系名，UI 只显示一次；
    // ③同一个人在卡和熟识度里都出现时，留下信息多的那份。
    const char = loadCharacter(root);
    const selfCard = buildSelfCard(char);
    const selfNames = new Set([String(char.name || '').trim(), ...(char.aliases || []).map((x) => String(x || '').trim())].filter(Boolean));
    out.persona = {
      name: char.name,
      aliases: char.aliases,
      display: char.display,
      relations: char.relations,
      influences: char.influences,
      selfCard,
    };
    const roleOwner = char.roleOwner || {};
    const relationOf = char.relationOf || {};
    const idCtx = { roleOwner, relationOf, selfNames, display: char.display || char.name || '' };
    const byName = new Map();
    let droppedCards = 0;
    for (const c of out.cards) {
      const nm = String(c.name || '').trim();
      // 归并身份：自己 / 角色词（妈妈、妈妈妈妈、妈妈（管理员））/ 档案里登记的人
      const id = resolveCardIdentity(nm, idCtx);
      c.orig = nm;
      c.name = id.name || nm;
      if (id.kind === 'self') {
        c.self = true;
        c.role = '我自己';
        c.text = selfCard ? selfCard.text : (c.text || '（还没写 character.json 里的性格/喜好）');
      } else {
        if (id.role) c.role = id.role;
        c.declared = id.kind === 'declared' || id.kind === 'owner';
        if (id.kind === 'owner') c.mergedInto = id.name;
      }
      const k = c.name + (c.self ? '|self' : '');
      const prev = byName.get(k);
      if (!prev) { byName.set(k, c); continue; }
      // 同名（妈妈 / 妈妈 / 妈妈妈妈）合并成一张：文字拼起来，别丢信息
      droppedCards += 1;
      const t1 = String(prev.text || '').trim();
      const t2 = String(c.text || '').trim();
      const body2 = t2.includes('：') ? t2.slice(t2.indexOf('：') + 1).trim() : t2;
      if (body2 && t1.indexOf(body2) < 0) prev.text = (t1 ? t1 + '　' : '') + body2;
      prev.ts = Math.max(Number(prev.ts) || 0, Number(c.ts) || 0);
      if (!prev.role && c.role) prev.role = c.role;
      prev.merged = (Number(prev.merged) || 1) + 1;
      if (c.self) prev.self = true;
    }
    out.cards = [...byName.values()];
    out.cardsMerged = droppedCards;
    // 数据库里还没有"关于自己"那张卡时，也把合成好的自我描述顶上，
    // 免得印象卡区里"自己"是空白（主人 2026-10-26）
    if (selfCard && !out.cards.some((c) => c.self)) {
      out.cards.unshift({
        scope: 'self', key: 'card:__self__', self: true,
        name: char.display || char.name, text: selfCard.text, role: '我自己', ts: 0,
      });
    }
    // 关系温度按 openid 存；从台账里找到这个人的昵称（找不到就显示 id 前 8 位）
    const nameOf = (id0) => {
      const id = String(id0 || '');
      if (!id) return '';
      if (id.length < 16) return id;
      const row = q('SELECT sender FROM chat WHERE sender_id = ? AND dir = ? AND sender != ? ORDER BY ts DESC LIMIT 1', id, 'in', id)[0];
      return row && row.sender ? String(row.sender) : id.slice(0, 8) + '…';
    };
    for (const b of out.bonds) b.name = nameOf(b.name) || b.name;

    // ── 统一熟识度：fam: 为唯一事实源；老 bond: 作为兜底展示 ──
    const LEVELS = ['陌生', '眼熟', '认识', '熟悉', '亲近', '很熟', '羁绊'];
    const levelOf = (s) => (s >= 90 ? 6 : s >= 75 ? 5 : s >= 60 ? 4 : s >= 45 ? 3 : s >= 30 ? 2 : s >= 15 ? 1 : 0);
    // 熟识度也按档案归并：角色词（妈妈/爸爸）不是独立的人，挂到档案里那位名下
    const seenFam = new Set();
    const mergedFam = [];
    for (const f of out.familiarity) {
      f.name = nameOf(f.senderId);
      // 熟识度只对人算；对"自己"算熟识度没有意义（就是之前那张"刚认识，还不熟"的来源）
      if (selfNames.has(String(f.name || '').trim())) continue;
      f.level = levelOf(f.s);
      f.levelLabel = LEVELS[f.level];
      const nm = String(f.name || '').trim();
      if (isRoleWord(nm) && roleOwner[nm]) {
        f.role = relationOf[roleOwner[nm]] || nm;
        f.name = roleOwner[nm];
      }
      if (relationOf[f.name]) {
        f.declared = true;
        f.role = f.role || relationOf[f.name];
      }
      const key = f.name || f.senderId || f.key;
      if (seenFam.has(key)) continue;
      seenFam.add(key);
      mergedFam.push(f);
    }
    out.familiarity = mergedFam;

    for (const b of out.bonds) {
      if (out.familiarity.some((f) => f.senderId === b.name || f.name === b.name)) continue;
      const s = Math.round((num(b.a) * 0.6) + (num(b.t) * 0.4));
      out.familiarity.push({
        scope: b.scope, key: b.key, senderId: String(b.name || ''), name: b.name,
        a: num(b.a), t: num(b.t), s, level: levelOf(s), levelLabel: LEVELS[levelOf(s)],
        note: b.note, ts: b.ts, source: 'bond',
      });
    }
    out.familiarity.sort((x, y) => y.s - x.s);

    out.agent.states = q(
      "SELECT k, v FROM chat_meta WHERE k LIKE 'memory-agent:%' ORDER BY rowid DESC LIMIT 12",
    ).map((r) => {
      let st = {};
      try { st = JSON.parse(r.v || '{}'); } catch { /* ignore */ }
      return {
        scope: String(r.k || '').replace('memory-agent:', ''),
        lastAttempt: num(st.lastAttempt), lastRun: num(st.lastRun), lastTs: num(st.lastTs),
      };
    });

    // ── 历史印象整理进度（digest:<senderId>）──
    out.digestStates = q(
      "SELECT k, v FROM chat_meta WHERE k LIKE 'digest:%' ORDER BY rowid DESC LIMIT 40",
    ).map((r) => {
      let st = {};
      try { st = JSON.parse(r.v || '{}'); } catch { /* ignore */ }
      const key = String(r.k || '');
      const cut = key.lastIndexOf(':');
      const senderId = cut > 'digest:'.length ? key.slice(cut + 1) : key.slice('digest:'.length);
      const scope = cut > 'digest:'.length ? key.slice('digest:'.length, cut) : '';
      return {
        senderId, scope, name: nameOf(senderId),
        lastOk: num(st.lastOk), slices: num(st.slices), msgs: num(st.msgs),
        lastError: String(st.lastError || ''),
      };
    }).filter((x) => x.slices > 0 || x.lastOk > 0);
    // 同名切片的数量汇总，便于 UI 显示「3 片 / 180 条」
    for (const d of out.digestStates) {
      const own = out.digest.filter((s) => s.senderId === d.senderId
        && (!d.scope || !s.scope || s.scope === d.scope || s.scope === '__global__'));
      if (own.length) {
        d.sliceCount = own.length;
        d.covered = own.reduce((n, s) => n + (s.n || 0), 0);
      }
    }
  } catch (e) {
    out.errors.push('查询失败: ' + (e instanceof Error ? e.message : String(e)));
  }

  try {
    const cfg = loadConfig(root) || {};
    const ma = cfg.memoryAgent || {};
    out.agent.enabled = ma.enabled !== false;
    out.agent.intervalMs = num(ma.minIntervalMs, 45000);
    out.agent.minNewMessages = num(ma.minNewMessages, 3);
    try {
      const lc = loadLlmConfig(root) || {};
      out.agent.model = String(ma.model || lc.model || lc.chatModel || '') || '';
      out.agent.provider = String(lc.provider || lc.baseUrl || '') || '';
      out.models.llm = { model: String(lc.model || lc.chatModel || ''), baseUrl: String(lc.baseUrl || '') };
    } catch { /* ignore */ }
    out.models.retrieval = cfg.retrieval || {};
    out.models.agentModel = String(ma.model || '');
    out.models.digest = cfg.digest || {};
  } catch { /* 配置读不到不影响数据 */ }

  out.agent.log = readAgentLog(root, 12).map((r) => ({
    ts: num(r.ts), scope: r.scope, ok: r.ok !== false,
    reason: r.reason || '', ms: num(r.ms), newMessages: num(r.newMessages),
    facts: Array.isArray(r.facts) ? r.facts.length : 0,
    cards: Array.isArray(r.cards) ? r.cards.length : 0,
    mood: String(r.mood || ''),
    relation: r.relation || null,
  }));
  out.recall = readTrace(root, { limit: 12, kind: 'recall' }).map((r) => ({
    ts: num(r.ts), scope: r.scope, query: String(r.query || ''),
    raw: num(r.raw), hits: num(r.hits), rewritten: r.rewritten === true,
    ok: r.ok !== false, error: String(r.error || ''), ms: num(r.ms),
  }));

  // ── 类海马体层：归纳（gist）/ 认知稳定度（人格漂移护栏）──
  // 失败不影响整页：面板最怕"某一块挂了整页空白"。
  try {
    out.hippo = hippoStats(root, sc || '__global__');
  } catch (e) {
    out.hippo = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  try {
    out.drift = driftReport(root, '__global__');
  } catch {
    out.drift = { rows: [], stability: 100, worst: null, alarm: 0 };
  }

  return out;
}

export default { collectMemoryPanel };
