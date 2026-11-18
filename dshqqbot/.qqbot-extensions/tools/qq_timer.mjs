/**
 * qq_timer — 小蓝的「任务管理」（落盘 `{dataRoot}/.qqbot/timers.json`，重启不丢）
 *
 * 为什么叫任务管理而不是定时任务：
 *   到点开口只是其中一种。更需要的是「说一次就记住，遇到合适的时候再说」——
 *   比如她答应「你加班到很晚我来陪你」，不是每晚 22:00 打卡，而是看到你又熬夜才开口。
 *   所以任务分三类：定时（once/daily/window）+ 事件触发（event）+ 权重（说多了就淡下去）。
 *   面板只做只读汇总，新建/改任务一律走 QQ 会话里的这个工具，不往浮窗堆。
 *
 * 任务形状（与 dist/features/schedule-store.js 完全一致，别改字段名）：
 *   { id, kind:'once'|'daily'|'window'|'event', scope:'c2c'|'group', peerId, prompt,
 *     createdAt, enabled, atTime?, dueAt?, from?, to?, perDay?, minGapMin?, guard?,
 *     event?:{ keywords:string[], match:'any'|'all', withinMin:number, cooldownMin:number },
 *     weight?:number, decay?:{ step:number, min:number }, lastFiredAt?, firedCount? }
 *
 * 动作：
 *   · add    —— 建一条（默认 daily；seconds=一次性；atTime='HH:MM' 每天）
 *   · window —— 一段时间里随机挑点（拟人）
 *   · event  —— 事件触发：聊天里出现关键词时，在 withinMin 内找机会开口（可配冷却/权重）
 *   · list   —— 看全部（含事件任务、权重、冷却）
 *   · update —— 改已有任务的内容 / 时间（面板「任务管理」里的「编辑」是同一套规则）
 *   · rm / on / off —— 删 / 开关
 *
 * 纪律：
 *   ⛔ prompt 是「到点时对你自己说的话」，不是发给对方原文；
 *   ⛔ peerId 必须是 openid，不接受昵称；
 *   ✅ 事件任务别写成「只要出现这个词就说」——配好冷却，说过了就淡。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIN_SECONDS = 60;
const MAX_JOBS = 200;

function dataRootOf(env) {
  return String((env && (env.caps && env.caps.dataRoot)) || process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot');
}
/** 调度器（bootstrap）读的是 {dataRoot}/.qqbot/timers.json */
function timersDir(root) {
  return basename(String(root).replace(/[\\/]+$/, '')) === '.qqbot' ? String(root) : join(root, '.qqbot');
}
function timersPath(root) {
  return join(timersDir(root), 'timers.json');
}
/** 旧版工具/面板写在 {dataRoot}/timers.json，首次读时接管，避免已有任务凭空消失 */
function legacyPath(root) {
  return join(String(root).replace(/[\\/]+$/, ''), 'timers.json');
}
function readJson(p) {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j && Array.isArray(j.jobs)) return j.jobs;
  } catch { /* 没有 / 坏了 */ }
  return null;
}
function readDb(root) {
  const canonical = timersPath(root);
  const jobs = readJson(canonical) || [];
  if (jobs.length) return { version: 1, jobs };
  const legacy = readJson(legacyPath(root));
  if (legacy && legacy.length) {
    const db = { version: 2, jobs: legacy };
    writeDb(root, db);
    return db;
  }
  return { version: 2, jobs: [] };
}
function writeDb(root, db) {
  const p = timersPath(root);
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* ignore */ }
  writeFileSync(p, JSON.stringify({ version: 2, jobs: db.jobs.slice(-MAX_JOBS) }, null, 2), 'utf8');
}
/**
 * 收件人 id 校验/补全（2026-11-14）：
 * 只给尾号（例如 62F0C901）时注入永远找不到会话 → 连续失败被停用，
 * 人看到的就是「任务没发就没了」。这里按尾号在台账/聊天库里找唯一命中并补全。
 */
function looksFullPeer(id) {
  return /^[0-9A-Za-z_@.-]{16,64}$/.test(String(id || '').trim());
}
function resolvePeerId(root, scope, raw) {
  const v = String(raw || '').trim();
  if (looksFullPeer(v)) return { ok: true, id: v };
  if (v.length < 4) return { ok: false, msg: 'peerId 太短：要给完整 openid，不是尾号' };
  const cands = new Set();
  try {
    const p = join(String(root).replace(/[\\/]+$/, ''), 'known-chats.jsonl');
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.scope === scope && typeof o.id === 'string') cands.add(o.id);
      } catch { /* 坏行 */ }
    }
  } catch { /* 没台账 */ }
  try {
    const db = new DatabaseSync(join(timersDir(root), 'memory.db'), { readOnly: true });
    try {
      for (const r of db.prepare('select distinct scope from chat where scope like ?').all(scope + ':%')) {
        cands.add(String(r.scope).slice(scope.length + 1));
      }
    } finally { db.close(); }
  } catch { /* 没库/读取失败 */ }
  const hit = [...cands].filter((id) => id.toLowerCase().endsWith(v.toLowerCase()));
  if (hit.length === 1) return { ok: true, id: hit[0] };
  if (hit.length > 1) return { ok: false, msg: '尾号 ' + v + ' 命中多个会话（' + hit.map((x) => x.slice(-8)).join('、') + '），请给完整 id' };
  return { ok: false, msg: '找不到收件人 ' + v + ' —— 要给完整 openid（不是尾号），可以先 list 任务看目标' };
}
function pad(n) {
  return String(n).padStart(2, '0');
}
/** 'HH:MM' → 今天这个点的毫秒时间戳（已过则明天的） */
function dueAtFromHHMM(hhmm, base = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  const d = new Date(base);
  d.setSeconds(0, 0);
  d.setHours(h, mi, 0, 0);
  let t = d.getTime();
  if (t <= base) t += 86400_000;
  return t;
}
function fmt(ts) {
  try {
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '?';
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return '?'; }
}
function nextOf(job) {
  if (!job || job.enabled === false) return null;
  if (job.kind === 'event') return null;
  if (job.kind === 'daily') return dueAtFromHHMM(job.atTime, Date.now());
  if (job.kind === 'window') return Number(job.nextAt) || null;
  return Number(job.dueAt) || null;
}
function weightOf(job) {
  const w = Number(job && job.weight);
  if (!Number.isFinite(w)) return 1;
  return Math.max(0.05, Math.min(1, w));
}
function describeWhen(job) {
  if (job.kind === 'event') {
    const ev = job.event || {};
    const kws = Array.isArray(ev.keywords) ? ev.keywords.join('/') : '';
    return `事件「${kws || '?'}」${ev.match === 'all' ? '全中' : '任一'} · ${Math.round((Number(ev.withinMin) || 720) / 60)}h 内 · 冷却 ${Number(ev.cooldownMin) || 180} 分`;
  }
  if (job.kind === 'daily') return `每天 ${job.atTime}`;
  if (job.kind === 'window') return `窗口 ${job.from}-${job.to}（随机 ${job.perDay || 1} 次）`;
  return fmt(job.dueAt);
}

export default {
  name: 'qq_timer',
  expose: 'all',
  description: '小蓝的任务管理（落盘 .qqbot/timers.json，重启不丢）：到点开口、窗口随机、或「聊天里出现某件事」时开口；any=时间窗或事件任一都行。add=每天/一次性；window=一段时间随机；event=事件触发（关键词，可冷却、可衰减）；any=时间窗+事件组合；update=改已有任务的时间或内容；list/rm/on/off。新建任务走这里，不要往浮窗面板堆',
  inputSchema: {
    action: { type: 'string', enum: ['add', 'list', 'rm', 'on', 'off', 'window', 'event', 'any', 'update'], description: 'add=定时；window=窗口随机；event=聊天里出现关键词时触发；any=时间窗或事件任一触发；update=改已有任务的内容/时间；list/rm/on/off' },
    from: { type: 'string', description: 'window/any 用：窗口开始 HH:MM（如 19:00）' },
    to: { type: 'string', description: 'window/any 用：窗口结束 HH:MM（如 22:30）' },
    perDay: { type: 'integer', description: 'window/any 用：今天说几次（默认 1，最多 6）' },
    minGapMin: { type: 'integer', description: 'window/any 用：两次之间至少隔多少分钟（默认 0）' },
    guardCity: { type: 'string', description: '可选：按天气决定说不说，填城市名（如 西安）。查不到就跳过这一次' },
    guardWhen: { type: 'string', description: '可选：cold/hot/rain/snow/any，逗号分隔；默认 any' },
    keywords: { type: 'string', description: 'event/any 用：触发词，逗号分隔（如「累,加班,熬夜」）' },
    match: { type: 'string', enum: ['any', 'all'], description: 'event/any 用：任一命中还是全部命中（默认 any）' },
    withinMin: { type: 'integer', description: 'event/any 用：命中后多少分钟内开口（默认 720，即半天）' },
    cooldownMin: { type: 'integer', description: 'event/any 用：说过了至少隔多久才再说（默认 180）' },
    weight: { type: 'number', description: '可选：触发权重 0.05–1（默认 1，越小越少开口；入站互动会自动回涨）' },
    decayStep: { type: 'number', description: '可选：每次说完权重减多少（默认 0.2）' },
    decayMin: { type: 'number', description: '可选：权重下限（默认 0.1，别彻底哑掉）' },
    scope: { type: 'string', enum: ['c2c', 'group'], description: 'add 用：发给私聊还是群' },
    peerId: { type: 'string', description: 'add 用：目标 openid（私聊=对方 openid，群=群 openid）' },
    prompt: { type: 'string', description: 'add 用：到点时**对你自己说的话**（要说什么、什么分寸），不是发给对方的死文案' },
    atTime: { type: 'string', description: 'add 用：HH:MM（24 小时制，本地时区）；不给则用 seconds' },
    seconds: { type: 'integer', description: 'add 用：N 秒后触发一次（>=60）；给了 seconds 就是一次性任务' },
    daily: { type: 'boolean', description: 'add 用：true=每天这个点（默认，需 atTime）；false=一次性' },
    id: { type: 'string', description: 'rm/on/off/update 用：任务 id' },
    enabled: { type: 'boolean', description: 'on/off 用（on=true）' },
  },
  run: async (args, env) => {
    const root = dataRootOf(env);
    const db = readDb(root);
    const action = String(args.action || 'list');
    const weight = Number(args.weight) > 0 ? Math.max(0.05, Math.min(1, Number(args.weight))) : 1;
    const decay = {
      step: args.decayStep != null && Number.isFinite(Number(args.decayStep)) ? Math.max(0, Math.min(1, Number(args.decayStep))) : 0.2,
      min: Number(args.decayMin) > 0 ? Math.max(0.05, Math.min(1, Number(args.decayMin))) : 0.1,
    };

    if (action === 'list') {
      if (!db.jobs.length) return { ok: true, msg: '现在没有任何任务（.qqbot/timers.json 是空的）' };
      const now = Date.now();
      const rows = db.jobs.slice(-40).map((j) => {
        const nx = nextOf(j);
        const when = describeWhen(j);
        const state = j.enabled === false ? '（关着）' : nx && nx < now ? '（已过期待跑）' : '';
        const w = weightOf(j);
        const wt = w < 0.999 ? ` · 权重 ${w.toFixed(2)}` : '';
        return `${j.id} · ${when}${wt}${state} · ${j.scope}:${String(j.peerId || '').slice(-8)} · ${String(j.prompt || '').slice(0, 40)}`;
      });
      return { ok: true, msg: `任务 ${db.jobs.length} 条（最多显示 40）：\n` + rows.join('\n') };
    }

    if (action === 'add') {
      const scope = String(args.scope || '').trim();
      let peerId = String(args.peerId || '').trim();
      const prompt = String(args.prompt || '').trim();
      if (scope !== 'c2c' && scope !== 'group') return { ok: false, msg: 'scope 只能是 c2c 或 group' };
      if (!peerId) return { ok: false, msg: 'peerId 必填（openid，不接受昵称）' };
      const _rp = resolvePeerId(root, scope, peerId);
      if (!_rp.ok) return { ok: false, msg: _rp.msg };
      peerId = _rp.id;
      if (!prompt) return { ok: false, msg: 'prompt 必填：到点要跟你说什么' };
      const hasSec = Number.isFinite(Number(args.seconds)) && Number(args.seconds) > 0;
      const wantOnce = args.daily === false || (hasSec && !args.atTime);
      const kind = wantOnce ? 'once' : 'daily';
      const atTime = String(args.atTime || '').trim();
      if (kind === 'daily' && !dueAtFromHHMM(atTime, Date.now())) return { ok: false, msg: 'daily 任务需要合法的 atTime（HH:MM）' };
      if (kind === 'once' && !hasSec && !dueAtFromHHMM(atTime, Date.now())) return { ok: false, msg: '一次性任务需要 seconds 或 atTime' };
      if (hasSec && Number(args.seconds) < MIN_SECONDS) return { ok: false, msg: `seconds 最少 ${MIN_SECONDS} 秒` };

      const key = `${scope}:${peerId}`;
      if (kind === 'daily') {
        const dup = db.jobs.find((j) => j.kind === 'daily' && `${j.scope}:${j.peerId}` === key && j.atTime === atTime && j.enabled !== false);
        if (dup) return { ok: false, msg: `已经有一条同样的每日任务了：${dup.id}（每天 ${dup.atTime}），要改先 rm 它` };
      }
      const job = {
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind,
        scope,
        peerId,
        prompt: prompt.slice(0, 800),
        createdAt: Date.now(),
        enabled: true,
        weight,
        decay,
      };
      if (atTime && dueAtFromHHMM(atTime, Date.now())) job.atTime = atTime;
      if (kind === 'once') {
        job.dueAt = hasSec && atTime
          ? Math.min(Date.now() + Number(args.seconds) * 1000, dueAtFromHHMM(atTime, Date.now()) || Infinity)
          : hasSec
            ? Date.now() + Number(args.seconds) * 1000
            : dueAtFromHHMM(atTime, Date.now());
      }
      db.jobs.push(job);
      writeDb(root, db);
      const when = job.kind === 'daily' ? `每天 ${job.atTime}` : fmt(job.dueAt);
      return { ok: true, msg: `建好了 ${job.id}：${when} → ${scope}:${String(peerId).slice(-8)}（落盘在 .qqbot/timers.json，重启不丢）` };
    }

    if (action === 'window') {
      const scope = String(args.scope || '').trim();
      let peerId = String(args.peerId || '').trim();
      const prompt = String(args.prompt || '').trim();
      if (scope !== 'c2c' && scope !== 'group') return { ok: false, msg: 'scope 只能是 c2c 或 group' };
      if (!peerId) return { ok: false, msg: 'peerId 必填（openid，不接受昵称）' };
      const _rp = resolvePeerId(root, scope, peerId);
      if (!_rp.ok) return { ok: false, msg: _rp.msg };
      peerId = _rp.id;
      if (!prompt) return { ok: false, msg: 'prompt 必填：到点要跟你说什么' };
      const from = String(args.from || '').trim();
      const to = String(args.to || '').trim();
      if (!dueAtFromHHMM(from, Date.now()) || !dueAtFromHHMM(to, Date.now())) return { ok: false, msg: 'from / to 需要合法的 HH:MM' };
      const perDay = Math.max(1, Math.min(6, Number(args.perDay) || 1));
      const minGapMin = Math.max(0, Math.min(720, Number(args.minGapMin) || 0));
      const key = `${scope}:${peerId}`;
      const dup = db.jobs.find((j) => j.kind === 'window' && `${j.scope}:${j.peerId}` === key && j.from === from && j.to === to && j.enabled !== false);
      if (dup) return { ok: false, msg: `已经有一条同样的窗口任务了：${dup.id}（${from}-${to}）` };
      const guardCity = String(args.guardCity || '').trim();
      const when = String(args.guardWhen || 'any').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      // 先在本地排一次点（和 schedule-store 里的算法一致），好把"下一个点"告诉模型
      const now = new Date();
      const [fh, fm] = from.split(':').map(Number);
      const [th, tm] = to.split(':').map(Number);
      const fromMin = fh * 60 + fm;
      const toMin = th * 60 + tm;
      const slots = [];
      let cursor = fromMin;
      for (let i = 0; i < perDay; i++) {
        const latest = toMin - (perDay - 1 - i) * minGapMin;
        if (latest < cursor) break;
        const t = cursor + Math.floor(Math.random() * (latest - cursor + 1));
        const d = new Date(now);
        d.setHours(Math.floor(t / 60), t % 60, 0, 0);
        slots.push(d.getTime());
        cursor = t + minGapMin + 1;
      }
      slots.sort((a, b) => a - b);
      const nextAt = slots.find((t) => t > Date.now() + 30_000) || slots[slots.length - 1];
      const job = {
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind: 'window',
        scope,
        peerId,
        prompt: prompt.slice(0, 800),
        createdAt: Date.now(),
        enabled: true,
        from,
        to,
        perDay,
        minGapMin,
        slotsDay: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
        slots,
        nextAt,
        weight,
        decay,
      };
      if (guardCity) job.guard = { type: 'weather', city: guardCity, when: when.length ? when : ['any'] };
      db.jobs.push(job);
      writeDb(root, db);
      const hh = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
      return {
        ok: true,
        msg: `建好了 ${job.id}：${from}–${to} 之间随机 ${perDay} 次（今天排到 ${slots.map(hh).join('、')}）`
          + `${guardCity ? `，只在天气命中(${when.join('/')})时才开口` : ''} → ${scope}:${String(peerId).slice(-8)}。到点不合适会自动顺延，不会天天准点打卡。`,
      };
    }

    if (action === 'event') {
      const scope = String(args.scope || '').trim();
      let peerId = String(args.peerId || '').trim();
      const prompt = String(args.prompt || '').trim();
      if (scope !== 'c2c' && scope !== 'group') return { ok: false, msg: 'scope 只能是 c2c 或 group' };
      if (!peerId) return { ok: false, msg: 'peerId 必填（openid，不接受昵称）' };
      const _rp = resolvePeerId(root, scope, peerId);
      if (!_rp.ok) return { ok: false, msg: _rp.msg };
      peerId = _rp.id;
      if (!prompt) return { ok: false, msg: 'prompt 必填：真出现这件事时你要怎么开口' };
      const keywords = String(args.keywords || '')
        .split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
      if (!keywords.length) return { ok: false, msg: 'keywords 必填：拿什么词触发（逗号分隔，如「累,加班,熬夜」）' };
      const ev = {
        keywords,
        match: args.match === 'all' ? 'all' : 'any',
        withinMin: Math.max(5, Math.min(10080, Number(args.withinMin) || 720)),
        cooldownMin: Math.max(5, Math.min(10080, Number(args.cooldownMin) || 180)),
      };
      const key = `${scope}:${peerId}`;
      const dup = db.jobs.find((j) => j.kind === 'event' && `${j.scope}:${j.peerId}` === key
        && j.enabled !== false && (j.event && Array.isArray(j.event.keywords) ? j.event.keywords.join('|') : '') === keywords.join('|'));
      if (dup) return { ok: false, msg: `已经有同样的事件任务了：${dup.id}（${keywords.join('/')}），要改先 rm 它` };
      const job = {
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind: 'event',
        scope,
        peerId,
        prompt: prompt.slice(0, 800),
        createdAt: Date.now(),
        enabled: true,
        event: ev,
        weight,
        decay,
        lastFiredAt: 0,
        firedCount: 0,
      };
      db.jobs.push(job);
      writeDb(root, db);
      return {
        ok: true,
        msg: `记下了 ${job.id}：聊天里出现「${keywords.join('/')}」${ev.match === 'all' ? '全中' : '任一'}，`
          + `${Math.round(ev.withinMin / 60)} 小时内我会找机会开口；说过了至少隔 ${ev.cooldownMin} 分钟再说。`
          + `权重 ${weight.toFixed(2)}，每次说完淡一点，你跟我说话它会回涨。`,
      };
    }

    if (action === 'any') {
      const scope = String(args.scope || '').trim();
      let peerId = String(args.peerId || '').trim();
      const prompt = String(args.prompt || '').trim();
      if (scope !== 'c2c' && scope !== 'group') return { ok: false, msg: 'scope 只能是 c2c 或 group' };
      if (!peerId) return { ok: false, msg: 'peerId 必填（openid，不接受昵称）' };
      const _rp = resolvePeerId(root, scope, peerId);
      if (!_rp.ok) return { ok: false, msg: _rp.msg };
      peerId = _rp.id;
      if (!prompt) return { ok: false, msg: 'prompt 必填：真到那个时候你要怎么开口' };
      const from = String(args.from || '').trim();
      const to = String(args.to || '').trim();
      if (!dueAtFromHHMM(from, Date.now()) || !dueAtFromHHMM(to, Date.now())) return { ok: false, msg: 'from / to 需要合法的 HH:MM' };
      const keywords = String(args.keywords || '')
        .split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
      if (!keywords.length) return { ok: false, msg: 'keywords 必填：拿什么词触发（逗号分隔）' };
      const perDay = Math.max(1, Math.min(6, Number(args.perDay) || 1));
      const minGapMin = Math.max(0, Math.min(720, Number(args.minGapMin) || 0));
      const key = `${scope}:${peerId}`;
      const dup = db.jobs.find((j) => j.kind === 'any' && `${j.scope}:${j.peerId}` === key && j.enabled !== false
        && j.from === from && j.to === to
        && (j.event && Array.isArray(j.event.keywords) ? j.event.keywords.join('|') : '') === keywords.join('|'));
      if (dup) return { ok: false, msg: `已经有同样的「时间窗或事件」任务了：${dup.id}，要改先 rm 它` };
      const now = new Date();
      const [fh, fm] = from.split(':').map(Number);
      const [th, tm] = to.split(':').map(Number);
      const fromMin = fh * 60 + fm;
      const toMin = th * 60 + tm;
      const slots = [];
      let cursor = fromMin;
      for (let i = 0; i < perDay; i++) {
        const latest = toMin - (perDay - 1 - i) * minGapMin;
        if (latest < cursor) break;
        const t = cursor + Math.floor(Math.random() * (latest - cursor + 1));
        const d = new Date(now);
        d.setHours(Math.floor(t / 60), t % 60, 0, 0);
        slots.push(d.getTime());
        cursor = t + minGapMin + 1;
      }
      slots.sort((a, b) => a - b);
      const ev = {
        keywords,
        match: args.match === 'all' ? 'all' : 'any',
        withinMin: Math.max(5, Math.min(10080, Number(args.withinMin) || 720)),
        cooldownMin: Math.max(5, Math.min(10080, Number(args.cooldownMin) || 180)),
      };
      const job = {
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind: 'any',
        scope,
        peerId,
        prompt: prompt.slice(0, 800),
        createdAt: Date.now(),
        enabled: true,
        from,
        to,
        perDay,
        minGapMin,
        slotsDay: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
        slots,
        nextAt: slots.find((t) => t > Date.now() + 30_000) || slots[slots.length - 1],
        event: ev,
        weight,
        decay,
        lastFiredAt: 0,
        firedCount: 0,
      };
      db.jobs.push(job);
      writeDb(root, db);
      return {
        ok: true,
        msg: `建好了 ${job.id}：${from}–${to} 之间随机 ${perDay} 次，`
          + `或者聊天里出现「${keywords.join('/')}」${ev.match === 'all' ? '全中' : '任一'}时开口（两者任一即可，说过了至少隔 ${ev.cooldownMin} 分钟）。`,
      };
    }

    const id = String(args.id || '').trim();
    if (!id) return { ok: false, msg: '要指定 id（先用 action=list 看）' };
    const i = db.jobs.findIndex((j) => String(j.id) === id);
    if (i < 0) return { ok: false, msg: `没有这个任务：${id}` };

    if (action === 'rm') {
      const gone = db.jobs.splice(i, 1)[0];
      writeDb(root, db);
      return { ok: true, msg: `删掉了 ${gone.id}（${describeWhen(gone)}）` };
    }
    if (action === 'on' || action === 'off') {
      const want = action === 'on' ? args.enabled !== false : false;
      db.jobs[i].enabled = want;
      writeDb(root, db);
      return { ok: true, msg: `${db.jobs[i].id} 已${want ? '打开' : '关掉'}` };
    }

    // update：改内容 / 改时间（面板「任务管理」的「编辑」走同一套校验；这里给她自己在聊天里改）
    if (action === 'update') {
      const j = db.jobs[i];
      const changed = [];
      const wantPrompt = String(args.prompt || '').trim();
      if (wantPrompt) { j.prompt = wantPrompt.slice(0, 800); changed.push('内容'); }
      const at = String(args.atTime || '').trim();
      if (at && (j.kind === 'daily' || j.kind === 'once')) {
        if (!dueAtFromHHMM(at, Date.now())) return { ok: false, msg: '时间要写成 HH:MM（例如 21:30）' };
        j.atTime = at;
        if (j.kind === 'once') j.dueAt = dueAtFromHHMM(at, Date.now());
        else {
          // 改成今天已经过去的点：今天不补跑，等明天
          const d = new Date();
          const [h, mi] = at.split(':').map(Number);
          if (h * 60 + mi <= d.getHours() * 60 + d.getMinutes()) j.lastRunDate = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
          else delete j.lastRunDate;
        }
        changed.push('时间');
      }
      if (args.from || args.to) {
        if (j.kind !== 'window' && j.kind !== 'any') return { ok: false, msg: '这条不是时间窗任务，改不了窗口' };
        const from = String(args.from || j.from || '').trim();
        const to = String(args.to || j.to || '').trim();
        if (!dueAtFromHHMM(from, Date.now()) || !dueAtFromHHMM(to, Date.now())) return { ok: false, msg: 'from / to 需要合法的 HH:MM' };
        const fromMin = Number(from.split(':')[0]) * 60 + Number(from.split(':')[1]);
        const toMin = Number(to.split(':')[0]) * 60 + Number(to.split(':')[1]);
        if (toMin - fromMin < 1) return { ok: false, msg: '结束时间要晚于开始时间' };
        const perDay = Math.max(1, Math.min(6, Number(args.perDay) || j.perDay || 1));
        const minGapMin = Math.max(0, Math.min(720, Number(args.minGapMin != null ? args.minGapMin : j.minGapMin) || 0));
        const now = new Date();
        const slots = [];
        let cursor = fromMin;
        for (let k = 0; k < perDay; k++) {
          const latest = toMin - (perDay - 1 - k) * minGapMin;
          if (latest < cursor) break;
          const t = cursor + Math.floor(Math.random() * (latest - cursor + 1));
          const dd = new Date(now);
          dd.setHours(Math.floor(t / 60), t % 60, 0, 0);
          slots.push(dd.getTime());
          cursor = t + minGapMin + 1;
        }
        slots.sort((a, b) => a - b);
        j.from = from; j.to = to; j.perDay = perDay; j.minGapMin = minGapMin;
        j.slotsDay = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
        j.slots = slots;
        j.nextAt = slots.find((t) => t > Date.now() + 30_000) || slots[slots.length - 1];
        changed.push('时间窗');
      }
      if (args.keywords !== undefined || args.cooldownMin !== undefined || args.match !== undefined || args.withinMin !== undefined) {
        if (j.kind !== 'event' && j.kind !== 'any') return { ok: false, msg: '这条不是事件任务，改不了触发词' };
        const ev = { ...(j.event || {}) };
        if (args.keywords !== undefined) {
          const kws = String(args.keywords || '').split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
          if (!kws.length) return { ok: false, msg: 'keywords 不能为空' };
          ev.keywords = kws;
        }
        if (args.match !== undefined) ev.match = args.match === 'all' ? 'all' : 'any';
        if (args.withinMin !== undefined) ev.withinMin = Math.max(5, Math.min(10080, Number(args.withinMin) || 720));
        if (args.cooldownMin !== undefined) ev.cooldownMin = Math.max(5, Math.min(10080, Number(args.cooldownMin) || 180));
        ev.keywords = Array.isArray(ev.keywords) ? ev.keywords : [];
        ev.match = ev.match === 'all' ? 'all' : 'any';
        ev.withinMin = Math.max(5, Math.min(10080, Number(ev.withinMin) || 720));
        ev.cooldownMin = Math.max(5, Math.min(10080, Number(ev.cooldownMin) || 180));
        j.event = ev;
        changed.push('触发条件');
      }
      if (!changed.length) return { ok: false, msg: '没给要改的东西（prompt / atTime / from,to / keywords 至少给一个）' };
      writeDb(root, db);
      return { ok: true, msg: `改好了 ${j.id}：${changed.join('、')} → ${describeWhen(j)}（后台「任务管理」里也能直接改）` };
    }

    return { ok: false, msg: `不认识的 action：${action}` };
  },
};
