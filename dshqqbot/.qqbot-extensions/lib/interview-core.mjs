/**
 * lib/interview-core.mjs — 「面试官」通话的流程状态机（零新依赖）
 *
 * 目标：陪练教师面试（试讲 / 结构化面试 / 学科问答）。
 *
 * 省 token 的四条硬规矩（都写死在核心逻辑里，不靠调用方自觉）：
 *   ① 题目只从题库文件取，模型不现场编题；
 *   ② 评分只走结构化 rubric（关键词覆盖 + 结构判断），**不调模型**；
 *   ③ 只有「追问」和「点评」调模型，且各带 maxTokens 与字数上限；
 *      模型失败 / 超时 / 超预算 → 直接换 templates.json 的模板句；
 *   ④ 每轮只带「滚动摘要 + 当前题 + 考生回答」，**从不整段重发历史**。
 *
 * 可回退：每次状态变更前压一份快照，back() 弹回上一步。
 *
 * 隐私：会话记录、评分、转写全部落在 secrets/interview/sessions/<sid>/。
 * 本模块只负责流程与落盘，HTTP / TTS / 录音由 hooks/interview-panel.mjs 负责。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { chat, loadConfig as loadLlmConfig } from './local-llm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));            // {dataRoot}/.qqbot-extensions/lib
const EXT_DIR = dirname(HERE);                                    // {dataRoot}/.qqbot-extensions
const DATA_ROOT_FALLBACK = dirname(EXT_DIR);                      // {dataRoot}

const SID_RE = /^[a-f0-9]{24,40}$/;
const MAX_ANSWER_CHARS = 2000;
const MAX_HISTORY = 12;

const num = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const str = (v) => String(v == null ? '' : v).trim();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const nowIso = () => new Date().toISOString();

// ── 路径 ────────────────────────────────────────────────────────────────
/** 仓库根（含 secrets/ 的那层）：优先环境变量，其次 dataRoot 的上一级。 */
export function repoRootOf(dataRoot) {
  const env = str(process.env.QQBOT_INTERVIEW_REPO_ROOT);
  if (env) return resolve(env);
  const dr = str(dataRoot) || str(process.env.QQBOT_MEMORY_DATA_ROOT) || DATA_ROOT_FALLBACK;
  return resolve(dirname(resolve(dr)));
}

/** 隐私根：面试记录、评分、录音、转写一律落这里。 */
export function secretsRootOf(dataRoot) {
  const env = str(process.env.QQBOT_INTERVIEW_SECRETS_DIR);
  if (env) return resolve(env);
  const repo = repoRootOf(dataRoot);
  const cands = [join(repo, 'secrets'), join(str(dataRoot) || DATA_ROOT_FALLBACK, 'secrets')];
  for (const p of cands) {
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return cands[0];
}

export function interviewRootOf(dataRoot) {
  return join(secretsRootOf(dataRoot), 'interview');
}
export function sessionDirOf(dataRoot, sid) {
  if (!SID_RE.test(String(sid || ''))) throw new Error('bad session id');
  // secrets/ 在本机被打成只读（低完整性 + NW），沙箱里起的服务建不了 sessions/<sid>；
  // 允许用 QQBOT_INTERVIEW_SESSIONS_DIR 把会话落盘目录单独挪到可写位置。
  const alt = str(process.env.QQBOT_INTERVIEW_SESSIONS_DIR);
  if (alt) return join(resolve(alt), String(sid));
  return join(interviewRootOf(dataRoot), 'sessions', sid);
}

function readJson(p, def) {
  try {
    if (!existsSync(p)) return def;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return def; }
}

function writeJsonAtomic(p, obj) {
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  // 本机单进程写入，直接覆盖即可；先写临时文件再改名对 Windows 覆盖不友好
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ── 配置 / 题库 / 评分表 / 模板 ─────────────────────────────────────────
const DEFAULTS = {
  questionsPerCategory: 1,
  maxFollowups: 2,
  model: '',
  modelTimeoutMs: 20000,
  limits: { followupChars: 40, commentChars: 60, followupTokens: 70, commentTokens: 90 },
  summaryChars: 480,
  tts: { enabled: true, timeoutMs: 60000, maxChars: 160 },
  recordAnswers: true,
  // 视频输入：任意客户端上传/录制，服务端转写 + 可选抽帧；原始视频不送模型
  video: {
    enabled: true,
    maxBytes: 48 * 1024 * 1024,
    maxSessionBytes: 120 * 1024 * 1024,
    chunkBytes: 2 * 1024 * 1024,
    maxSeconds: 120,
    maxFrames: 4,
    analyze: 'transcript',
    visionModel: '',
    asrTimeoutMs: 300000,
  },
  // 隐私默认全留；界面上的开关关掉哪一项，就把哪一项当场删掉
  privacy: { keepSession: true, keepAudio: true, keepVideo: true, keepTranscript: true },
  // 超期会话：默认 14 天后归档到 secrets/interview/archive/，days=0 表示不清理
  retention: { days: 14, action: 'archive' },
  voice: { provider: '', voice: '', model: '', endpoint: '', speed: 0 },
};

/** 默认模式：题库里没写 modes 时，退回单一教师面试模式。 */
const DEFAULT_MODE = {
  id: 'teacher',
  label: '考研复试 / 教资面试',
  short: '教师面试',
  tagline: '教学能力 · 学科专业 · 情景应变 · 自我认知',
  description: '',
  categoryIds: ['teaching', 'subject', 'scenario', 'self'],
  rubricFile: 'rubric.json',
  feedback: 'score',
  questionsPerCategory: 1,
  maxFollowups: 2,
  codeInput: false,
  rules: [],
};

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(dataRoot) {
  const official = join(interviewRootOf(dataRoot), 'config.json');
  const fallback = join(EXT_DIR, 'interview', 'config.default.json');
  const cfg = deepMerge(DEFAULTS, readJson(fallback, {}));
  const over = readJson(official, {});
  const merged = deepMerge(cfg, over);
  merged.questionsPerCategory = clamp(num(merged.questionsPerCategory, 1), 1, 4);
  merged.maxFollowups = clamp(num(merged.maxFollowups, 2), 0, 3);
  merged.modelTimeoutMs = clamp(num(merged.modelTimeoutMs, 20000), 3000, 120000);
  merged.summaryChars = clamp(num(merged.summaryChars, 480), 160, 2000);
  merged.privacy = {
    keepSession: (merged.privacy && merged.privacy.keepSession) !== false,
    keepAudio: (merged.privacy && merged.privacy.keepAudio) !== false,
    keepVideo: (merged.privacy && merged.privacy.keepVideo) !== false,
    keepTranscript: (merged.privacy && merged.privacy.keepTranscript) !== false,
  };
  merged.retention = {
    days: clamp(num(merged.retention && merged.retention.days, 14), 0, 365),
    action: str(merged.retention && merged.retention.action) === 'delete' ? 'delete' : 'archive',
  };
  const v = merged.video || {};
  merged.video = {
    enabled: v.enabled !== false,
    maxBytes: clamp(num(v.maxBytes, 48 * 1024 * 1024), 2 * 1024 * 1024, 200 * 1024 * 1024),
    maxSessionBytes: clamp(num(v.maxSessionBytes, 120 * 1024 * 1024), 4 * 1024 * 1024, 400 * 1024 * 1024),
    chunkBytes: clamp(num(v.chunkBytes, 2 * 1024 * 1024), 256 * 1024, 8 * 1024 * 1024),
    maxSeconds: clamp(num(v.maxSeconds, 120), 5, 300),
    maxFrames: clamp(num(v.maxFrames, 4), 0, 8),
    analyze: str(v.analyze) === 'frames' ? 'frames' : 'transcript',
    visionModel: str(v.visionModel),
    asrTimeoutMs: clamp(num(v.asrTimeoutMs, 300000), 30000, 600000),
  };
  merged.source = existsSync(official) ? 'secrets' : 'default';
  return merged;
}

/** 正式文件优先（secrets/interview/*.json），缺失时用扩展目录里的占位文件。 */
function loadContract(dataRoot, officialName, placeholderName) {
  const official = join(interviewRootOf(dataRoot), officialName);
  const fallback = join(EXT_DIR, 'interview', placeholderName);
  const officialJson = readJson(official, null);
  if (officialJson && typeof officialJson === 'object') {
    return { data: officialJson, source: 'secrets', path: official, warning: '' };
  }
  const fallbackJson = readJson(fallback, null);
  if (fallbackJson && typeof fallbackJson === 'object') {
    return { data: fallbackJson, source: 'placeholder', path: fallback, warning: '正式文件缺失，正在使用占位数据' };
  }
  return { data: null, source: 'missing', path: official, warning: '题库/评分表文件缺失且占位文件也读不到' };
}

function validBank(b) {
  return b && Array.isArray(b.categories) && b.categories.length > 0
    && b.categories.every((c) => c && typeof c.id === 'string' && Array.isArray(c.questions) && c.questions.length > 0);
}
function validRubric(r) {
  return r && Array.isArray(r.dimensions) && r.dimensions.length > 0
    && r.dimensions.every((d) => d && typeof d.id === 'string' && Array.isArray(d.keywords));
}

export function loadQuestionBank(dataRoot) {
  const r = loadContract(dataRoot, 'question-bank.json', 'question-bank.placeholder.json');
  if (!validBank(r.data)) {
    return { data: { categories: [], rules: [] }, source: 'invalid', path: r.path, warning: '题库格式不合法（需要 categories[].questions[]）' };
  }
  // 补充题库：secrets/ 在本机被打成低完整性只读，改不动官方题库；
  // 允许往可写的 <dataRoot>/data/interview-bank/*.json 放增量分类/模式，按 id 覆盖或追加。
  const extras = loadBankExtras(dataRoot);
  if (extras.length) {
    const merged = { ...r.data, categories: [...r.data.categories.map((c) => ({ ...c }))] };
    merged.modes = Array.isArray(r.data.modes) ? r.data.modes.map((m) => ({ ...m })) : [];
    for (const pack of extras) {
      for (const c of Array.isArray(pack.categories) ? pack.categories : []) {
        if (!c || typeof c.id !== 'string' || !Array.isArray(c.questions)) continue;
        const i = merged.categories.findIndex((x) => x.id === c.id);
        if (i >= 0) merged.categories[i] = c; else merged.categories.push(c);
      }
      for (const m of Array.isArray(pack.modes) ? pack.modes : []) {
        if (!m || typeof m.id !== 'string') continue;
        const i = merged.modes.findIndex((x) => x.id === m.id);
        if (i >= 0) merged.modes[i] = m; else merged.modes.push(m);
      }
    }
    return { ...r, data: merged, extras: extras.length };
  }
  return r;
}

/** <dataRoot>/data/interview-bank/*.json，按文件名排序合并。 */
function loadBankExtras(dataRoot) {
  const dir = join(dataRoot, 'data', 'interview-bank');
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')).sort(); } catch { return []; }
  const packs = [];
  for (const n of names) {
    const j = readJson(join(dir, n), null);
    if (j && typeof j === 'object') packs.push(j);
  }
  return packs;
}

export function loadRubric(dataRoot, fileName = 'rubric.json') {
  const r = loadContract(dataRoot, fileName, 'rubric.placeholder.json');
  if (!validRubric(r.data)) {
    return { data: { dimensions: [], levels: [] }, source: 'invalid', path: r.path, warning: '评分表格式不合法（需要 dimensions[].keywords[]）' };
  }
  return r;
}

/** 模式清单：题库里的 modes 优先；缺失时退回单一教师模式。 */
export function loadModes(dataRoot) {
  const bank = loadQuestionBank(dataRoot);
  const raw = Array.isArray(bank.data && bank.data.modes) ? bank.data.modes : [];
  const list = raw.filter((m) => m && typeof m.id === 'string').map((m) => ({
    id: str(m.id),
    label: str(m.label) || str(m.id),
    short: str(m.short) || str(m.label) || str(m.id),
    tagline: str(m.tagline),
    description: str(m.description),
    categoryIds: Array.isArray(m.categoryIds) ? m.categoryIds.map(str).filter(Boolean) : [],
    rubricFile: str(m.rubricFile) || 'rubric.json',
    feedback: str(m.feedback) === 'verdict' ? 'verdict' : 'score',
    questionsPerCategory: num(m.questionsPerCategory, 1),
    itemCount: num(m.itemCount, 0),
    maxFollowups: num(m.maxFollowups, 2),
    codeInput: m.codeInput === true,
    rules: Array.isArray(m.rules) ? m.rules.map(str).filter(Boolean) : [],
  }));
  return list.length ? list : [{ ...DEFAULT_MODE }];
}

export function modeOf(dataRoot, id) {
  const modes = loadModes(dataRoot);
  return modes.find((m) => m.id === str(id)) || modes[0];
}

export function loadTemplates(dataRoot) {
  const r = loadContract(dataRoot, 'templates.json', 'templates.json');
  return r.data || {};
}

// ── 问答式资料包 ────────────────────────────────────────────────────────
// 资料放 secrets/interview/materials/<id>.json：
//   { id, title, source, text, items:[{ id, topic, text, keywords, avoid,
//     answer, correction, supplement, sourceQuote }] }
// 硬约束：每条题目的 sourceQuote 必须能在 text 里原文找到，找不到就丢弃，
// 保证「不编资料里没有的东西」。
const normText = (v) => String(v || '').replace(/\s+/g, '');

function materialsDirOf(dataRoot) {
  return join(interviewRootOf(dataRoot), 'materials');
}

export function loadMaterials(dataRoot) {
  const dir = materialsDirOf(dataRoot);
  let names = [];
  try { names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []; } catch { names = []; }
  return names.map((f) => {
    const raw = readJson(join(dir, f), null);
    if (!raw || typeof raw !== 'object') return null;
    const id = str(raw.id) || f.replace(/\.json$/i, '');
    const items = Array.isArray(raw.items) ? raw.items : [];
    const grounded = items.filter((it) => {
      const quote = normText(it && it.sourceQuote);
      return quote && normText(raw.text).includes(quote) && str(it.text);
    }).length;
    return {
      id,
      title: str(raw.title) || id,
      source: str(raw.source),
      questionCount: grounded,
      total: items.length,
    };
  }).filter(Boolean);
}

export function loadMaterial(dataRoot, id) {
  const want = str(id);
  if (!want) return null;
  const dir = materialsDirOf(dataRoot);
  let names = [];
  try { names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []; } catch { names = []; }
  for (const f of names) {
    const raw = readJson(join(dir, f), null);
    if (!raw || typeof raw !== 'object') continue;
    const mid = str(raw.id) || f.replace(/\.json$/i, '');
    if (mid !== want) continue;
    const text = str(raw.text);
    const title = str(raw.title) || mid;
    const items = (Array.isArray(raw.items) ? raw.items : []).filter((it) => {
      const quote = str(it && it.sourceQuote);
      return quote && normText(text).includes(normText(quote)) && str(it.text);
    }).map((it) => ({
      ...it,
      id: str(it.id),
      source: `${title}${it.topic ? ` · ${str(it.topic)}` : ''}`,
    }));
    if (!items.length) continue;
    return { id: mid, title, source: str(raw.source), text, items };
  }
  return null;
}

// ── 评分（纯函数，不调模型）────────────────────────────────────────────
// 2026-11-08 改口径：以 rubric 锚点条件为准，不再按“说了几个词”给分。
//   ① 评分规则写在 rubric.dimensions[].scoring（checks 检查项 + gates 档位条件 + minChars 字数门槛），
//      core 只做通用求值，锚点改动不需要改代码；
//   ② 关键词只作为检查项里的信号之一，覆盖不再单独占 45 分；
//   ③ 3 档必须同时有分层和具体例子，长度够但没例子最多 2 档；
//   ④ 学科关键错误命中即 0（一票否决先判）。
//   没有 scoring 的评分表（占位文件）仍走旧的关键词公式，保证回落可用。
const LEGACY_STRUCTURE_RE = /(首先|其次|然后|接下来|最后|第一|第二|第三|因为|所以|例如|比如|如果|那么|一是|二是)/;

function compilePatterns(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => { try { return new RegExp(String(p)); } catch { return null; } })
    .filter(Boolean);
}

/** 按锚点检查项求档位：返回 { level(0–3), score(0–100), gaps(离上一档还缺什么) } */
function evalAnchorScoring(dim, t) {
  const sc = dim && dim.scoring;
  if (!sc || !Array.isArray(sc.checks) || sc.checks.length === 0) return null;

  const passed = {};
  const labelOf = {};
  for (const c of sc.checks) {
    if (!c || typeof c.id !== 'string') continue;
    const pats = compilePatterns(c.patterns);
    const need = Math.max(1, num(c.need, 1));
    let hits = 0;
    if (c.count) {
      for (const re of pats) {
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        const m = t.match(g);
        if (m) hits += m.length;
      }
    } else {
      hits = pats.filter((re) => re.test(t)).length;
    }
    passed[c.id] = hits >= need;
    labelOf[c.id] = str(c.label) || c.id;
  }

  const minChars = sc.minChars || {};
  let level = 0;
  for (const lv of [3, 2, 1]) {
    const gates = Array.isArray(sc.gates && sc.gates[lv]) ? sc.gates[lv] : [];
    if (t.length < num(minChars[lv], 0)) continue;
    // 2/3 档必须有明确条件；空条件不许白给高档（1 档允许作为“答了但没做到”的兜底档）
    if (gates.length === 0 && lv > 1) continue;
    if (gates.every((id) => passed[id] === true)) { level = lv; break; }
  }

  const gaps = [];
  const next = level + 1;
  if (next <= 3) {
    const gates = Array.isArray(sc.gates && sc.gates[next]) ? sc.gates[next] : [];
    for (const id of gates) {
      if (passed[id] !== true && labelOf[id] && !gaps.includes(labelOf[id])) gaps.push(labelOf[id]);
    }
  }
  return { level, score: Math.round((level * 100) / 3), gaps: gaps.slice(0, 4) };
}

/** 把一段回答按某个 rubric 维度打分（锚点档位制；无 scoring 时回落旧公式）。 */
export function scoreText(rubric, dimensionId, text) {
  const t = str(text);
  const dim = (rubric.dimensions || []).find((d) => d.id === dimensionId) || { keywords: [] };
  const keywords = Array.isArray(dim.keywords) ? dim.keywords : [];
  const hit = keywords.filter((k) => t.includes(k));
  const missing = keywords.filter((k) => !hit.includes(k)).slice(0, 4);

  // 一票否决先判：学科关键错误命中即 0（引用/纠正常见误解的说法不算命中，靠 guard 排除）
  const keyErr = (Array.isArray(dim.keyErrorPatterns) ? dim.keyErrorPatterns : [])
    .find((p) => {
      const re = compilePatterns([p && p.pattern])[0];
      if (!re) return false;
      const m = re.exec(t);
      if (!m) return false;
      if (p.guard) {
        const from = Math.max(0, m.index - 14);
        const to = Math.min(t.length, m.index + m[0].length + 14);
        const g = compilePatterns([p.guard])[0];
        if (g && g.test(t.slice(from, to))) return false;
      }
      return true;
    });

  let score = 0;
  let level = 0;
  let gaps = [];
  const anchored = evalAnchorScoring(dim, t);
  if (keyErr) {
    score = 0; level = 0;
    gaps = [`命中学科关键错误：${str(keyErr.label) || '关键概念错误'}`];
  } else if (anchored) {
    score = anchored.score;
    level = anchored.level;
    gaps = anchored.gaps;
  } else {
    const denom = Math.max(1, Math.min(4, keywords.length));
    score = 25 + Math.min(1, hit.length / denom) * 45
      + (LEGACY_STRUCTURE_RE.test(t) ? 1 : 0.35) * 15
      + Math.min(1, t.length / 100) * 15;
    if (t.length < 15) score = Math.min(score, 45);
  }
  if (!t) { score = 0; level = 0; }
  return { score: clamp(Math.round(score), 0, 100), level, gaps, hits: hit, missing };
}

/** 问答式判定：只判对错 + 给依据出处，不评分、不调模型。 */
export function judgeQuiz(item, text) {
  const t = str(text);
  const keywords = Array.isArray(item && item.keywords) ? item.keywords : [];
  const avoid = compilePatterns(item && item.avoid);
  const hit = keywords.filter((p) => compilePatterns([p]).some((re) => re.test(t)));
  const need = Math.max(1, Math.ceil(keywords.length * 0.6));
  const bad = avoid.find((re) => re.test(t));
  const correct = !!t && !bad && hit.length >= need;
  return {
    correct,
    verdict: correct ? '对' : '错',
    hit: hit.length,
    need,
    matched: hit,
    wrong: bad ? String(bad) : '',
    feedback: correct
      ? (str(item && item.supplement) || `答对了。${str(item && item.answer)}`)
      : (str(item && item.correction) || `不对。${str(item && item.answer)}`),
    reference: str(item && item.answer),
    source: str(item && item.source),
  };
}

// ── 会话读写 ────────────────────────────────────────────────────────────
/** 「不留会话日志」时靠内存撑住状态机（进程重启即丢，符合“不保留”的语义）。 */
const MEM_SESSIONS = new Map();

function sessionFile(dataRoot, sid) {
  return join(sessionDirOf(dataRoot, sid), 'session.json');
}

export function saveSession(dataRoot, s) {
  s.updatedAt = nowIso();
  MEM_SESSIONS.set(s.sid, s);
  if (MEM_SESSIONS.size > 40) {
    const oldest = MEM_SESSIONS.keys().next().value;
    MEM_SESSIONS.delete(oldest);
  }
  // keepSession=false：状态只在内存里，磁盘上不留 session.json
  if (s.policy && s.policy.keepSession === false) {
    try { unlinkSync(sessionFile(dataRoot, s.sid)); } catch { /* 本来就没有 */ }
    return s;
  }
  const dir = sessionDirOf(dataRoot, s.sid);
  mkdirSync(dir, { recursive: true });
  // 会话 id 本身是随机 128bit，落盘文件名固定 session.json，避免路径注入
  writeJsonAtomic(join(dir, 'session.json'), s);
  return s;
}

export function loadSession(dataRoot, sid) {
  if (!SID_RE.test(String(sid || ''))) return null;
  const mem = MEM_SESSIONS.get(sid);
  if (mem && mem.sid === sid) return mem;
  const j = readJson(sessionFile(dataRoot, sid), null);
  return j && j.sid === sid ? j : null;
}

// ── 视频/音频输入（服务端只收文件与转写结果，不假设本机有摄像头）──────────
const MEDIA_ID_RE = /^[a-f0-9]{16,40}$/;

export function mediaDirOf(dataRoot, sid) {
  return join(sessionDirOf(dataRoot, sid), 'media');
}

/** 上传成功后登记一份媒体元数据：{uploadId,kind,mime,bytes,durationSec,analyze,transcript,frames,visionNote} */
export function recordMedia(dataRoot, sid, meta) {
  const s = loadSession(dataRoot, sid);
  if (!s) throw new Error('会话不存在');
  if (!meta || !MEDIA_ID_RE.test(String(meta.uploadId || ''))) throw new Error('媒体 id 不合法');
  // 单场总容量上限，避免一次会话塞爆磁盘
  const cap = num(s.cfg && s.cfg.video && s.cfg.video.maxSessionBytes, 120 * 1024 * 1024);
  const used = (s.media || []).filter((m) => m && m.uploadId !== str(meta.uploadId))
    .reduce((n, m) => n + num(m && m.bytes, 0), 0);
  if (used + num(meta.bytes, 0) > cap) throw new Error('本场媒体总量已超上限');
  s.media = Array.isArray(s.media) ? s.media : [];
  const clean = {
    uploadId: str(meta.uploadId),
    kind: str(meta.kind) === 'audio' ? 'audio' : 'video',
    mime: str(meta.mime),
    bytes: num(meta.bytes, 0),
    durationSec: num(meta.durationSec, 0),
    analyze: str(meta.analyze) === 'frames' ? 'frames' : 'transcript',
    transcript: str(meta.transcript).slice(0, MAX_ANSWER_CHARS * 4),
    frames: Array.isArray(meta.frames) ? meta.frames.map(str).filter(Boolean).slice(0, 8) : [],
    visionNote: str(meta.visionNote).slice(0, 600),
    createdAt: nowIso(),
  };
  s.media = s.media.filter((m) => m && m.uploadId !== clean.uploadId).concat([clean]);
  saveSession(dataRoot, s);
  return clean;
}

export function getMedia(dataRoot, sid, uploadId) {
  if (!MEDIA_ID_RE.test(String(uploadId || ''))) return null;
  return readJson(join(mediaDirOf(dataRoot, sid), `${uploadId}.json`), null);
}

/** 只删原始视频/音频与抽帧，保留元数据；隐私开关「不留视频」时用。 */
function purgeMediaPayloads(dataRoot, sid) {
  const dir = mediaDirOf(dataRoot, sid);
  let names = [];
  try { names = existsSync(dir) ? readdirSync(dir) : []; } catch { names = []; }
  for (const n of names) {
    if (/\.json$/.test(n)) continue;
    try { unlinkSync(join(dir, n)); } catch { /* ignore */ }
  }
  removeDir(join(dir, 'frames'));
}

/** 把 media/<uploadId>.json 里的转写正文/帧清单也抹掉，避免只清了 session.json。 */
function redactMediaFiles(dataRoot, sid, opts = {}) {
  const dir = mediaDirOf(dataRoot, sid);
  let names = [];
  try { names = existsSync(dir) ? readdirSync(dir) : []; } catch { names = []; }
  for (const n of names) {
    if (!MEDIA_ID_RE.test(n.replace(/\.json$/, '')) || !/\.json$/.test(n)) continue;
    const p = join(dir, n);
    const m = readJson(p, null);
    if (!m) continue;
    if (opts.transcript) { m.transcript = ''; m.transcriptRedacted = true; }
    if (opts.frames) { m.frames = []; m.discarded = true; }
    try { writeFileSync(p, JSON.stringify(m, null, 2), 'utf8'); } catch { /* ignore */ }
  }
}

export function listSessions(dataRoot, limit = 10) {
  const root = join(interviewRootOf(dataRoot), 'sessions');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SID_RE.test(d.name))
      .map((d) => {
        const j = readJson(join(root, d.name, 'session.json'), null);
        return j ? { sid: j.sid, createdAt: j.createdAt, updatedAt: j.updatedAt, stage: j.stage, overall: j.review ? j.review.overall : null } : null;
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  } catch { return []; }
}

// ── 公开状态（给页面用）────────────────────────────────────────────────
function currentQuestion(s) {
  const q = s.queue && s.queue[s.qi];
  if (!q) return null;
  return { index: s.qi + 1, total: s.queue.length, qid: q.qid, category: q.categoryName, text: q.text };
}

function lastInterviewerSay(s) {
  for (let i = (s.turns || []).length - 1; i >= 0; i -= 1) {
    if (s.turns[i].role === 'interviewer') return s.turns[i].text;
  }
  return '';
}

export function publicState(s, extra = {}) {
  const q = currentQuestion(s);
  const say = extra.say != null ? extra.say : lastInterviewerSay(s);
  return {
    ok: true,
    sid: s.sid,
    stage: s.stage,
    question: (s.stage === 'asking' || s.stage === 'followup') ? q : null,
    say,
    // speak 是给 TTS 的短版（规则列表不上语音，避免开场念太久）
    speak: extra.speak != null ? extra.speak : say,
    review: s.review || null,
    followupDepth: s.followupDepth || 0,
    maxFollowups: s.cfg ? s.cfg.maxFollowups : 2,
    mode: s.mode || { id: 'teacher', label: '考研复试 / 教资面试', short: '教师面试', feedback: 'score', codeInput: false },
    material: s.material || null,
    policy: s.policy || {},
    // 媒体只回元数据（不含转写正文），正文在回答里；页面上传成功后另行拿到
    media: (s.media || []).map((m) => ({
      uploadId: m.uploadId, kind: m.kind, bytes: m.bytes, durationSec: m.durationSec,
      analyze: m.analyze, frames: (m.frames || []).length, hasTranscript: !!str(m.transcript),
    })),
    video: s.cfg && s.cfg.video
      ? {
        enabled: s.cfg.video.enabled !== false,
        chunkBytes: num(s.cfg.video.chunkBytes, 2 * 1024 * 1024),
        maxBytes: num(s.cfg.video.maxBytes, 48 * 1024 * 1024),
        maxSeconds: num(s.cfg.video.maxSeconds, 120),
        maxFrames: num(s.cfg.video.maxFrames, 4),
        analyze: str(s.cfg.video.analyze) === 'frames' ? 'frames' : 'transcript',
      }
      : null,
    ttsEnabled: s.ttsEnabled !== false,
    recordAnswers: s.recordAnswers !== false,
    metrics: s.metrics || {},
    warning: extra.warning || '',
    ...extra,
  };
}

function pushHistory(s) {
  s.history = s.history || [];
  s.history.push({
    stage: s.stage, qi: s.qi, followupDepth: s.followupDepth,
    turnsLen: (s.turns || []).length,
    answers: JSON.parse(JSON.stringify(s.answers || [])),
    summary: s.summary || '',
    metrics: { ...(s.metrics || {}) },
  });
  if (s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
}

function popHistory(s) {
  if (!s.history || s.history.length === 0) return false;
  const h = s.history.pop();
  s.stage = h.stage; s.qi = h.qi; s.followupDepth = h.followupDepth;
  s.turns = (s.turns || []).slice(0, h.turnsLen);
  s.answers = h.answers;
  s.summary = h.summary;
  s.metrics = h.metrics;
  s.review = null;
  return true;
}

function addTurn(s, role, text) {
  s.turns = Array.isArray(s.turns) ? s.turns : [];
  s.turns.push({ role, text: str(text).slice(0, MAX_ANSWER_CHARS), at: nowIso() });
  // 只保留最近 80 轮作记录；模型永远看不到整段 turns
  if (s.turns.length > 80) s.turns = s.turns.slice(-80);
}

/** 滚动摘要：确定性拼接，不调模型。超过上限就从头丢最旧的。 */
function appendSummary(s, line) {
  const cap = num(s.cfg && s.cfg.summaryChars, 480);
  const next = (s.summary ? s.summary + '\n' : '') + str(line);
  if (next.length <= cap) { s.summary = next; return; }
  const lines = next.split('\n');
  while (lines.length > 1 && lines.join('\n').length > cap) lines.shift();
  s.summary = lines.join('\n').slice(-cap);
}

function estTokens(chars) { return Math.ceil(Math.max(0, chars) / 1.6); }

/** 记账：优先用 Ollama 回传的真实 token（prompt_eval_count / eval_count），拿不到才按字数估算。 */
function noteModelCall(s, promptChars, completionChars, ok, usage) {
  s.metrics = s.metrics || { modelCalls: 0, modelFailures: 0, promptTokens: 0, completionTokens: 0, ttsCalls: 0 };
  s.metrics.modelCalls += 1;
  if (!ok) s.metrics.modelFailures += 1;
  const up = num(usage && usage.promptTokens, 0);
  const uc = num(usage && usage.completionTokens, 0);
  if (up || uc) {
    s.metrics.promptTokens += up;
    s.metrics.completionTokens += uc;
    if (!s.metrics.tokenSource) s.metrics.tokenSource = 'ollama';
  } else {
    s.metrics.promptTokens += estTokens(promptChars);
    s.metrics.completionTokens += estTokens(completionChars);
    s.metrics.tokenSource = s.metrics.tokenSource === 'ollama' ? 'mixed' : 'estimate';
  }
}

/** 让模型说一句短话；失败 / 超时 / 超字数 → null（由调用方换模板句）。 */
async function modelLine(dataRoot, s, { system, user, maxTokens, charLimit, kind }) {
  const cfg = s.cfg || {};
  const promptChars = str(system).length + str(user).length;
  const llmCfg = loadLlmConfig(str(dataRoot) || s.dataRoot);
  let r = null;
  try {
    r = await chat({
      messages: [
        { role: 'system', content: str(system) },
        { role: 'user', content: str(user) },
      ],
      cfg: llmCfg,
      model: cfg.model || undefined,
      maxTokens: clamp(num(maxTokens, 70), 8, 200),
      timeoutMs: clamp(num(cfg.modelTimeoutMs, 20000), 3000, 120000),
      temperature: 0.6,
    });
  } catch { r = null; }
  const text = r && r.ok ? str(r.text) : '';
  const oneLine = text.replace(/[\r\n]+/g, ' ').replace(/^["'“”「」]+|["'“”「」]+$/g, '').trim();
  const over = oneLine.length > clamp(num(charLimit, 40), 8, 200);
  const ok = !!oneLine && !over;
  noteModelCall(s, promptChars, oneLine.length, ok, r && r.usage);
  if (!ok) return null;
  return oneLine;
}

// ── 题库转任务队列（按模式筛类别）──────────────────────────────────────
function modeCategories(bank, mode) {
  const cats = Array.isArray(bank.categories) ? bank.categories : [];
  const ids = Array.isArray(mode.categoryIds) ? mode.categoryIds : [];
  if (!ids.length) return cats;
  const picked = ids.map((id) => cats.find((c) => c && str(c.id) === id)).filter(Boolean);
  return picked.length ? picked : cats;
}

function queueItem(cat, q, i) {
  return {
    qid: str(q.id) || `${str(cat.id)}-${i + 1}`,
    categoryId: str(cat.id),
    categoryName: str(cat.name) || str(cat.id),
    text: str(q.text),
    probeHints: Array.isArray(q.probeHints) ? q.probeHints.map(str).filter(Boolean) : [],
    rubricDimension: str(cat.rubricDimension) || str(cat.id),
    // 问答式专用字段：参考答案、依据出处、关键词/反例、纠正与补充句
    keywords: Array.isArray(q.keywords) ? q.keywords : [],
    avoid: Array.isArray(q.avoid) ? q.avoid : [],
    answer: str(q.answer),
    source: str(q.source),
    sourceQuote: str(q.sourceQuote),
    topic: str(q.topic),
    // 单题走判定不评分（如复试口语）：在教师模式里也能用
    scored: q.scored !== false,
    correction: str(q.correction),
    supplement: str(q.supplement),
  };
}

function buildQueue(bank, mode, material) {
  // 问答式优先用资料包：题目全部来自资料原文，只判对错+出处
  if (mode.feedback === 'verdict' && material && Array.isArray(material.items) && material.items.length) {
    const cat = { id: 'material', name: material.title, rubricDimension: 'quiz' };
    const items = material.items.map((q, i) => queueItem(cat, q, i));
    const n = clamp(num(mode.itemCount, 8), 1, items.length);
    return items.slice(0, n);
  }
  const cats = modeCategories(bank, mode);
  const out = [];
  if (mode.feedback === 'verdict') {
    const all = [];
    for (const cat of cats) {
      for (const q of (cat.questions || [])) all.push(queueItem(cat, q, all.length));
    }
    const n = clamp(num(mode.itemCount, 8), 1, Math.max(1, all.length));
    return all.slice(0, n);
  }
  const perCat = clamp(num(mode.questionsPerCategory, 1), 1, 4);
  for (const cat of cats) {
    const n = clamp(perCat, 1, (cat.questions || []).length);
    for (let i = 0; i < n; i += 1) out.push(queueItem(cat, cat.questions[i], i));
  }
  return out;
}

// ── 开场 ────────────────────────────────────────────────────────────────
function normalizePolicy(base, patch) {
  const out = { ...(base || {}) };
  for (const k of ['keepSession', 'keepAudio', 'keepVideo', 'keepTranscript']) {
    if (patch && patch[k] !== undefined) out[k] = patch[k] !== false;
    else out[k] = out[k] !== false;
  }
  return out;
}

export function createSession(dataRoot, opts = {}) {
  const cfg = loadConfig(dataRoot);
  const mode = modeOf(dataRoot, opts.mode);
  const bank = loadQuestionBank(dataRoot);
  const rubric = mode.feedback === 'verdict'
    ? { data: { dimensions: [], levels: [] }, source: 'none', warning: '' }
    : loadRubric(dataRoot, mode.rubricFile);
  const templates = loadTemplates(dataRoot);
  if (!bank.data.categories.length) throw new Error(bank.warning || '题库为空');
  if (mode.feedback !== 'verdict' && !rubric.data.dimensions.length) throw new Error(rubric.warning || '评分表为空');

  // 问答式可以选一份资料包；没有资料时退回内置问答题库
  const material = mode.feedback === 'verdict' ? loadMaterial(dataRoot, opts.materialId) : null;
  const queue = buildQueue(bank.data, mode, material);
  if (!queue.length) throw new Error('题库里没有可用题目');
  cleanupSessions(dataRoot);

  const rules = mode.rules.length ? mode.rules : (Array.isArray(bank.data.rules) ? bank.data.rules.map(str).filter(Boolean) : []);
  const greeting = str(templates.modeGreeting && templates.modeGreeting[mode.id]) || str(templates.greeting) || '你好，我是今天的模拟面试官。';
  const ready = str(templates.readyPrompt) || '准备好了我们就开始。';
  const say = [
    greeting,
    str(templates.rulesIntro) || '规则我先说清楚：',
    ...rules.map((r) => `· ${r}`),
    ready,
  ].join('\n');
  // 语音只念开场 + 提示，规则留在屏幕上看，避免开场 TTS 太长
  const speak = `${greeting}${ready}`;

  const s = {
    sid: randomBytes(16).toString('hex'),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    dataRoot: str(dataRoot),
    stage: 'opening',
    qi: 0,
    followupDepth: 0,
    queue,
    answers: [],
    turns: [],
    summary: '',
    history: [],
    mode: {
      id: mode.id,
      label: mode.label,
      short: mode.short,
      tagline: mode.tagline,
      feedback: mode.feedback,
      codeInput: mode.codeInput,
      maxFollowups: mode.maxFollowups,
    },
    policy: normalizePolicy(cfg.privacy, opts.policy),
    material: material ? { id: material.id, title: material.title, source: material.source } : null,
    quizResults: [],
    media: [],
    cfg: {
      questionsPerCategory: cfg.questionsPerCategory,
      maxFollowups: mode.maxFollowups,
      model: cfg.model,
      modelTimeoutMs: cfg.modelTimeoutMs,
      limits: cfg.limits,
      summaryChars: cfg.summaryChars,
      video: cfg.video,
    },
    bankSource: bank.source,
    rubricSource: rubric.source,
    warning: [bank.warning, rubric.warning].filter(Boolean).join('；'),
    rubric: rubric.data,
    templates,
    ttsEnabled: cfg.tts ? cfg.tts.enabled !== false : true,
    recordAnswers: cfg.recordAnswers !== false,
    metrics: { modelCalls: 0, modelFailures: 0, promptTokens: 0, completionTokens: 0, ttsCalls: 0 },
    review: null,
  };
  addTurn(s, 'interviewer', say);
  saveSession(dataRoot, s);
  return publicState(s, { say, speak });
}

// ── 进入下一题 ──────────────────────────────────────────────────────────
function beginQuestion(dataRoot, s) {
  const q = s.queue[s.qi];
  if (!q) return buildReview(dataRoot, s);
  s.stage = 'asking';
  s.followupDepth = 0;
  s.answers[s.qi] = {
    qid: q.qid,
    categoryId: q.categoryId,
    rubricDimensionId: q.rubricDimension,
    categoryName: q.categoryName,
    questionText: q.text,
    chunks: [],
    score: 0,
    hits: [],
    missing: [],
    comment: '',
    verdict: '',
    source: q.source || '',
    reference: q.answer || '',
  };
  const t = s.templates || {};
  const intro = str(t.questionIntro).replace('{n}', String(s.qi + 1)).replace('{category}', q.categoryName) || `第 ${s.qi + 1} 题，${q.categoryName}。`;
  const say = `${intro}\n${q.text}\n${str(t.questionOutro) || ''}`.trim();
  // 语音念题目和类别；「你可以慢慢说」留在字幕里
  const speak = `${intro}${q.text}`;
  addTurn(s, 'interviewer', say);
  return publicState(s, { say, speak });
}

export function proceed(dataRoot, sid) {
  const s = loadSession(dataRoot, sid);
  if (!s) throw new Error('会话不存在');
  if (s.stage === 'opening') {
    pushHistory(s);
    const r = beginQuestion(dataRoot, s);
    saveSession(dataRoot, s);
    return r;
  }
  if (s.stage === 'comment') {
    pushHistory(s);
    s.qi += 1;
    if (s.qi >= s.queue.length) {
      const r = buildReview(dataRoot, s);
      saveSession(dataRoot, s);
      return r;
    }
    const r = beginQuestion(dataRoot, s);
    saveSession(dataRoot, s);
    return r;
  }
  if (s.stage === 'ended') return publicState(s);
  return publicState(s);
}

// ── 追问 / 点评 ────────────────────────────────────────────────────────
function combinedAnswer(a) {
  return (a.chunks || []).map((c) => c.text).join('\n').trim();
}

async function askFollowup(dataRoot, s, q, a, depth) {
  const cfg = s.cfg || {};
  const limits = cfg.limits || {};
  const t = s.templates || {};
  const fallbackPool = Array.isArray(t.followupFallback) ? t.followupFallback : [];
  const hint = q.probeHints && q.probeHints[depth - 1];
  const last = str((a.chunks || [])[a.chunks.length - 1] && a.chunks[a.chunks.length - 1].text);
  const algo = s.mode && s.mode.id === 'algo';

  const system = algo
    ? `你是算法面试官。只输出一句追问，不超过 ${num(limits.followupChars, 40)} 个字。优先追问时间复杂度、空间复杂度、边界条件或能否优化；不要给答案、不要重复原题。`
    : `你是教师面试考官。只输出一句追问，不超过 ${num(limits.followupChars, 40)} 个字。不要解释、不要评价、不要重复原题。追问要针对考生刚才的回答，逼出一个具体做法。`;
  const user = algo
    ? `题目：${q.text}\n考生刚才说：${last.slice(0, 200)}\n滚动摘要：${(s.summary || '').slice(-240)}`
    : `原题：${q.text}\n考生刚才说：${last.slice(0, 180)}\n滚动摘要：${(s.summary || '').slice(-240)}`;

  const modelText = await modelLine(dataRoot, s, {
    system,
    user,
    maxTokens: limits.followupTokens,
    charLimit: limits.followupChars,
    kind: 'followup',
  });
  const algoFallback = algo ? '时间复杂度和空间复杂度分别是多少？边界条件有哪些？' : '';
  const say = modelText || hint || algoFallback || (fallbackPool[(depth - 1) % Math.max(1, fallbackPool.length)]) || '能再具体说一个课堂上的例子吗？';
  s.stage = 'followup';
  s.followupDepth = depth;
  addTurn(s, 'interviewer', say);
  return say;
}

function needsAnotherFollowup(a, rubric, q) {
  const text = combinedAnswer(a);
  const r = scoreText(rubric, q.rubricDimension, text);
  // 按锚点缺口判断：没到 3 档且还差条件 → 再追一层；答得很短也再追一层
  return text.length < 30 || (r.gaps || []).length > 0;
}

async function makeComment(dataRoot, s, q, a, score) {
  const cfg = s.cfg || {};
  const limits = cfg.limits || {};
  const t = s.templates || {};
  const algo = s.mode && s.mode.id === 'algo';
  const fb = algo
    ? (score >= 92 ? '思路、复杂度和边界都说清了，代码也读得懂，可以。' : score >= 67 ? '思路成立，复杂度和例子有；把边界和代码补上就更完整。' : '先把思路和复杂度说清，再补边界，最后贴代码。')
    : ((t.commentFallback && (score >= 75 ? t.commentFallback.high : score >= 55 ? t.commentFallback.mid : t.commentFallback.low)) || '方向是对的，再补一点具体做法就更完整。');
  const answer = combinedAnswer(a);

  const system = algo
    ? `你是算法面试官。只输出一句点评，不超过 ${num(limits.commentChars, 60)} 个字。先肯定思路，再指出复杂度或边界上的一个缺口，最后给一个下一轮动作。不要展开讲解。`
    : `你是教师面试考官。只输出一句点评，不超过 ${num(limits.commentChars, 60)} 个字。先肯定一个具体点，再指出一个最该改的地方。不要写长段评价。`;

  const modelText = await modelLine(dataRoot, s, {
    system,
    user: `题目：${q.text}\n考生回答：${answer.slice(0, 220)}\n本题得分：${score}\n本题离上一档还缺：${(a.gaps || []).join('、') || '（无）'}`,
    maxTokens: limits.commentTokens,
    charLimit: limits.commentChars,
    kind: 'comment',
  });
  const say = modelText || fb;
  s.stage = 'comment';
  addTurn(s, 'interviewer', say);
  return say;
}

// ── 提交回答 ────────────────────────────────────────────────────────────
/** 转写不留存：答完就地把考生原话抹掉，只保留分数与结论。 */
function applyTranscriptPolicy(s) {
  if (!(s.policy && s.policy.keepTranscript === false)) return;
  for (const a of (s.answers || [])) {
    if (!a) continue;
    a.redacted = true;
    for (const c of (a.chunks || [])) { c.text = ''; c.redacted = true; }
  }
  for (const t of (s.turns || [])) {
    if (t.role === 'candidate') t.text = '（转写未留存）';
  }
  for (const m of (s.media || [])) {
    if (!m) continue;
    m.transcript = '';
    m.redacted = true;
  }
}

export async function submitAnswer(dataRoot, sid, text, opts = {}) {
  const s = loadSession(dataRoot, sid);
  if (!s) throw new Error('会话不存在');
  if (s.stage !== 'asking' && s.stage !== 'followup') throw new Error('当前不是答题阶段');
  pushHistory(s);

  const q = s.queue[s.qi];
  const a = s.answers[s.qi] || (s.answers[s.qi] = {
    qid: q.qid, categoryId: q.categoryId, rubricDimensionId: q.rubricDimension, categoryName: q.categoryName, questionText: q.text,
    chunks: [], score: 0, hits: [], missing: [], comment: '',
  });
  const answer = str(text).slice(0, MAX_ANSWER_CHARS);
  // 视频/音频作为「本轮输入方式」挂到这条回答上：只留元数据，不留原片
  let mediaRef = null;
  const mediaId = str(opts.mediaId);
  if (mediaId && MEDIA_ID_RE.test(mediaId)) {
    const m = getMedia(dataRoot, sid, mediaId) || (s.media || []).find((x) => x && x.uploadId === mediaId);
    if (m) {
      mediaRef = {
        uploadId: mediaId, kind: m.kind || 'video', mime: str(m.mime),
        durationSec: num(m.durationSec, 0), analyze: m.analyze || 'transcript',
        frames: (m.frames || []).length, transcriptChars: str(m.transcript).length,
      };
    }
  }
  a.chunks.push({ text: answer, at: nowIso(), depth: s.followupDepth || 0, audio: str(opts.audioName) || '', media: mediaRef });
  if (mediaRef) a.media = mediaRef;
  addTurn(s, 'candidate', answer);

  // ── 问答式 / 单题判定（如复试口语）：只判对错 + 给依据出处，不评分、不调模型 ──
  const verdictCheck = (s.mode && s.mode.feedback === 'verdict') || q.scored === false;
  if (verdictCheck) {
    const j = judgeQuiz(q, answer);
    a.score = 0;
    a.scored = false;
    a.verdict = j.verdict;
    a.correct = j.correct;
    a.hits = j.hit;
    a.source = j.source;
    a.reference = j.reference;
    a.comment = j.feedback;
    s.stage = 'comment';
    s.quizResults = (s.quizResults || []).concat([{
      qid: q.qid, category: q.categoryName, correct: j.correct, source: j.source,
      reference: j.reference, question: q.text,
    }]);
    addTurn(s, 'interviewer', j.feedback);
    appendSummary(s, `【问答】${q.text.slice(0, 24)} → ${j.verdict}（${j.hit}/${j.need} 要点）`);
    applyTranscriptPolicy(s);
    saveSession(dataRoot, s);
    const speak = j.feedback.length > 80 ? `${j.feedback.slice(0, 80)}…` : j.feedback;
    return publicState(s, {
      say: j.feedback,
      speak,
      quizFeedback: {
        verdict: j.verdict, correct: j.correct, hit: j.hit, need: j.need,
        source: j.source, reference: j.reference,
      },
    });
  }

  // 结构化评分（不调模型）
  const scored = scoreText(s.rubric || {}, q.rubricDimension, combinedAnswer(a));
  a.scored = true;
  a.score = scored.score;
  a.level = scored.level;
  a.gaps = scored.gaps;
  a.hits = scored.hits;
  a.missing = scored.missing;

  const maxFollowups = num((s.cfg && s.cfg.maxFollowups), 2);
  const nextDepth = (s.followupDepth || 0) + 1;

  let say;
  if (nextDepth <= maxFollowups && (s.stage === 'asking' || needsAnotherFollowup(a, s.rubric || {}, q))) {
    say = await askFollowup(dataRoot, s, q, a, nextDepth);
  } else {
    say = await makeComment(dataRoot, s, q, a, a.score);
    appendSummary(s, `【${q.categoryName}】${q.text.slice(0, 30)} → ${combinedAnswer(a).slice(0, 48)}（${a.score}分）`);
    a.comment = say;
  }
  applyTranscriptPolicy(s);
  saveSession(dataRoot, s);
  return publicState(s, { say });
}

// ── 复盘 ────────────────────────────────────────────────────────────────
function levelOf(rubric, score) {
  const levels = (rubric.levels || []).slice().sort((a, b) => num(b.min, 0) - num(a.min, 0));
  for (const l of levels) if (score >= num(l.min, 0)) return str(l.label) || '合格';
  return '待提升';
}

function buildDemo(templates, dimension, bestAnswer) {
  const t = templates || {};
  const k = (dimension && dimension.keywords ? dimension.keywords : []).slice(0, 4);
  // 按维度给一句能照着做的示范（对齐锚点条件，避免把关键词硬塞进句子）
  const demoLines = {
    teaching: '我会先点题，说清这节课要解决什么；再按「导入—新授—练习—小结—作业」五步讲，目标写成“能说出/能解释”的可测句；中间留两次提问，准备好学生答错时怎么纠正；最后用对比表收束，作业分层。',
    subject: '我会先用一句话讲清概念，再给因果推导，配一个生活或实验例子；然后说清怎么讲给学生（类比、示意图、让他们自己填）；最后指出学生最容易混淆的地方，以及我会怎么纠正。',
    scenario: '我会先接住情绪或先保安全，再按顺序做三件事，然后说清向谁上报或跟谁沟通；最后补一句事后怎么跟进、怎么验证效果。',
    self: '我会先讲一段具体经历和结果，再承认一个短板并给证据；然后说计划的时间、动作和验证方式；最后落到这个岗位最需要什么。',
  };
  const line = demoLines[dimension && dimension.id] || '';
  if (bestAnswer && bestAnswer.questionText) {
    const head = `${str(t.demoIntro) || '如果这题让我示范，我会这样说：'}\n「${bestAnswer.questionText}」`;
    const body = line || (k.length
      ? `我会先点题，把「${k[0]}」和「${k[2] || k[0]}」写清楚；再按「${k[1] || k[0]}」设计学生能参与的活动；最后用一句话收束。`
      : str(t.demoPrefix) || '先点题，再给做法，最后说判断标准。');
    return `${head}\n${body}`;
  }
  return line || str(t.noAnswerDemo) || '我会先了解学生的情况，再定一个可执行的小目标，最后用课堂反馈验证。';
}

/** 问答式复盘：不评分，只统计对错 + 逐题依据出处。 */
function buildQuizReview(dataRoot, s) {
  const templates = s.templates || {};
  const results = (s.answers || []).filter(Boolean).map((a) => ({
    qid: a.qid,
    question: a.questionText,
    answer: combinedAnswer(a),
    redacted: !!a.redacted,
    correct: !!a.correct,
    verdict: str(a.verdict) || (a.correct ? '对' : '错'),
    source: str(a.source),
    reference: str(a.reference),
    comment: str(a.comment),
  }));
  const correct = results.filter((r) => r.correct).length;
  const wrong = results.filter((r) => !r.correct);
  const improvements = wrong.length
    ? wrong.slice(0, 3).map((r) => `错题 ${r.qid}：${r.question} —— 依据出处：${r.source || '题库'}。先把参考答案复述一遍，再记出处。`)
    : ['本组全对。下一轮可以只做错题本里的题，或者换一组知识点。'];
  const review = {
    scored: false,
    mode: s.mode ? s.mode.id : 'quiz',
    modeLabel: s.mode ? s.mode.label : '问答式',
    overall: null,
    level: '',
    total: results.length,
    correct,
    results,
    dimensions: [],
    improvements,
    demoAnswer: '',
    questions: results,
    material: s.material || null,
    metrics: { ...(s.metrics || {}) },
    generatedAt: nowIso(),
  };
  s.review = review;
  s.stage = 'review';
  const intro = str(templates.quizReviewIntro)
    || `这一组 ${results.length} 题，答对 ${correct} 题。对错和依据都标在屏幕上了。`;
  addTurn(s, 'interviewer', intro);
  writeReport(dataRoot, s, review);
  const speak = `这一组 ${results.length} 题，答对 ${correct} 题。${wrong.length ? '错题的依据我放在屏幕上了。' : '全对，下一组继续。'}`;
  return publicState(s, { say: intro, speak });
}

export function buildReview(dataRoot, s) {
  if (s.mode && s.mode.feedback === 'verdict') return buildQuizReview(dataRoot, s);
  const rubric = s.rubric || {};
  const templates = s.templates || {};
  const dims = (rubric.dimensions || []).map((d) => {
    const rel = (s.answers || []).filter((a) => a && a.scored !== false && (a.rubricDimensionId === d.id || a.categoryId === d.id));
    const scores = rel.map((a) => num(a.score, 0));
    const score = scores.length ? Math.round(scores.reduce((x, y) => x + y, 0) / scores.length) : 0;
    const missing = [];
    const gaps = [];
    for (const a of rel) {
      for (const m of (a.missing || [])) if (!missing.includes(m)) missing.push(m);
      for (const g of (a.gaps || [])) if (!gaps.includes(g)) gaps.push(g);
    }
    return {
      id: d.id,
      name: str(d.name) || d.id,
      weight: num(d.weight, 0),
      score,
      level: Math.round((score * 3) / 100),
      missing: missing.slice(0, 5),
      gaps: gaps.slice(0, 4),
      focus: str(d.focus),
      keywords: Array.isArray(d.keywords) ? d.keywords.map(str).filter(Boolean) : [],
    };
  });

  const weightSum = dims.reduce((x, d) => x + d.weight, 0) || dims.length || 1;
  const overall = dims.length
    ? Math.round(dims.reduce((x, d) => x + d.score * (d.weight || (1 / dims.length)), 0) / (dims.length ? weightSum : 1))
    : 0;

  const weakest = dims.slice().sort((a, b) => a.score - b.score).slice(0, 3);
  const difficultyTips = {
    teaching: '压缩备课时间到 20 分钟，或把学情改成“一半学生基础薄弱”，重讲一遍。',
    subject: '换一道跨模块题（光合作用联动细胞呼吸），或要求现场画图讲解。',
    scenario: '把对象从家长换成学生本人或年级组长，同一套动作重答一遍。',
    self: '追问“如果这学期没考下教资，计划怎么改”，看你的备选方案。',
  };
  const improvements = [];
  for (const d of weakest) {
    if (d.score >= 100) {
      improvements.push(`「${d.name}」：已经满档，下一轮加难度——${difficultyTips[d.id] || '压缩准备时间或多加一层追问，再看能不能守住。'}`);
      continue;
    }
    // 以锚点缺口为准：说清“现在几档、升一档还缺什么”，而不是只报关键词
    if (d.gaps.length) {
      improvements.push(`「${d.name}」：现在 ${d.level} 档，升到 ${d.level + 1} 档还缺——${d.gaps.slice(0, 2).join('；')}。`);
      continue;
    }
    const miss = d.missing.slice(0, 2).join('、');
    improvements.push(miss
      ? `「${d.name}」：缺少「${miss}」的具体描述，回答容易停在原则上。`
      : `「${d.name}」：做法可以再具体一层，补上判断标准和学生反应。`);
  }
  // 维度少于 3 条时补通用建议；按模式各说各的，避免把同一句复读三遍
  const fillers = (s.mode && s.mode.id === 'algo')
    ? [
        '答算法题先报复杂度：先说时间复杂度，再说空间复杂度，最后补空输入 / 重复元素 / 超大输入三个边界。',
        '代码只贴核心循环和关键变量，别贴整段模板；贴完用一个小用例走一遍，确认返回值。',
        '思路卡住时先画数据结构每一步的变化，再讲每一步在做什么，比直接背结论好讲。',
      ]
    : [
        '回答时先给结论，再给一个课堂里的具体例子，最后说你怎么判断有效。',
        '把「学生可能怎么错」先说一句，再给对应的应对动作。',
        '结尾补一句自评：这节课最想改进的一点是什么。',
      ];
  let fi = 0;
  while (improvements.length < 3 && fi < fillers.length * 2) {
    improvements.push(fillers[fi % fillers.length]);
    fi += 1;
  }

  const answered = (s.answers || []).filter((a) => a && a.scored !== false && combinedAnswer(a).length > 0);
  const best = answered.slice().sort((a, b) => num(b.score, 0) - num(a.score, 0))[0] || null;
  const bestDim = best ? dims.find((d) => d.id === best.categoryId) : dims[0];
  const demoAnswer = buildDemo(templates, bestDim, best);

  const questions = (s.answers || []).filter((a) => a && a.scored !== false).map((a) => ({
    qid: a.qid, category: a.categoryName, question: a.questionText,
    answer: combinedAnswer(a), score: a.score, comment: a.comment, missing: a.missing,
    media: a.media || null,
  }));

  const review = {
    overall,
    level: levelOf(rubric, overall),
    dimensions: dims,
    improvements: improvements.slice(0, 3),
    demoAnswer,
    questions,
    // 教师模式里的单题判定项（如复试口语）：不评分，只给对错与依据
    extras: (s.mode && s.mode.feedback !== 'verdict') ? (s.quizResults || []).slice() : [],
    material: s.material || null,
    media: (s.media || []).map((m) => ({
      uploadId: m.uploadId, kind: m.kind, bytes: m.bytes, durationSec: m.durationSec,
      analyze: m.analyze, frames: (m.frames || []).length, redacted: !!m.redacted,
    })),
    metrics: { ...(s.metrics || {}) },
    generatedAt: nowIso(),
  };
  s.review = review;
  s.stage = 'review';
  const intro = str(templates.reviewIntro) || '这场练完啦，我给你一份复盘。';
  addTurn(s, 'interviewer', intro);
  writeReport(dataRoot, s, review);
  const speak = `${intro}总分 ${review.overall} 分，${review.level}。三条建议放在屏幕上了。`;
  return publicState(s, { say: intro, speak });
}

function writeReport(dataRoot, s, review) {
  try {
    const dir = sessionDirOf(dataRoot, s.sid);
    mkdirSync(dir, { recursive: true });
    const modeLabel = (s.mode && s.mode.label) || '教师面试';
    const scored = review.scored !== false;
    writeJsonAtomic(join(dir, 'report.json'), {
      sid: s.sid, createdAt: s.createdAt, finishedAt: nowIso(),
      mode: s.mode ? s.mode.id : 'teacher', modeLabel, scored,
      overall: review.overall, level: review.level,
      correct: review.correct, total: review.total,
      dimensions: review.dimensions || [], improvements: review.improvements || [],
      demoAnswer: review.demoAnswer || '', questions: review.questions || [],
      extras: review.extras || [], material: s.material || null,
      // 视频输入只归档元数据与转写状态，原始视频按隐私开关另行留存/删除
      media: (s.media || []).map((m) => ({
        uploadId: m.uploadId, kind: m.kind, bytes: m.bytes, durationSec: m.durationSec,
        analyze: m.analyze, frames: (m.frames || []).length, redacted: !!m.redacted,
      })),
      metrics: review.metrics, policy: s.policy || {}, summary: s.summary,
    });
    const usage = [
      '## 用量（真实回传，非估算）',
      `- 模型调用：${review.metrics.modelCalls || 0} 次（失败 ${review.metrics.modelFailures || 0} 次）`,
      `- prompt token：${review.metrics.promptTokens || 0}`,
      `- completion token：${review.metrics.completionTokens || 0}`,
      `- token 来源：${review.metrics.tokenSource || 'estimate'}`,
      `- 滚动摘要：${s.summary || '（空）'}`,
    ];
    if (!scored) {
      const lines = [
        `# ${modeLabel}陪练复盘`,
        '',
        `- 会话：${s.sid}`,
        `- 时间：${s.createdAt}`,
        `- 结果：答对 ${review.correct} / ${review.total}（不评分，只判对错）`,
        `- 留存策略：${JSON.stringify(s.policy || {})}`,
        '',
        '## 逐题判定与依据',
        ...review.results.map((r, i) => [
          `${i + 1}. ${r.verdict}｜${r.question}`,
          `   - 依据出处：${r.source || '（未标注）'}`,
          `   - 参考答案：${r.reference || '（无）'}`,
          `   - 你的回答：${r.redacted ? '（转写未留存）' : (r.answer || '（未作答）')}`,
        ].join('\n')),
        '',
        '## 错题回顾建议',
        ...review.improvements.map((x, i) => `${i + 1}. ${x}`),
        '',
        ...usage,
      ];
      writeFileSync(join(dir, 'report.md'), lines.join('\n') + '\n', 'utf8');
      return true;
    }
    const lines = [
      `# ${modeLabel}陪练复盘`,
      '',
      `- 会话：${s.sid}`,
      `- 时间：${s.createdAt}`,
      `- 总分：${review.overall}（${review.level}）`,
      `- 留存策略：${JSON.stringify(s.policy || {})}`,
      '',
      '## 各维度',
      ...review.dimensions.map((d) => `- ${d.name}：${d.score} 分${d.missing.length ? `（缺：${d.missing.join('、')}）` : ''}`),
      '',
      '## 三条最该改的地方',
      ...review.improvements.map((x, i) => `${i + 1}. ${x}`),
      '',
      '## 示范答法',
      review.demoAnswer,
      '',
      '## 逐题记录',
      ...review.questions.map((q, i) => [
        `### ${i + 1}. [${q.category}] ${q.question}`,
        `- 得分：${q.score}`,
        `- 点评：${q.comment || '（无）'}`,
        `- 回答：${q.answer || '（未作答）'}`,
      ].join('\n')),
      '',
      ...usage,
    ];
    writeFileSync(join(dir, 'report.md'), lines.join('\n') + '\n', 'utf8');
    return true;
  } catch { return false; }
}

// ── 回退 / 结束 / 查询 ──────────────────────────────────────────────────
export function stepBack(dataRoot, sid) {
  const s = loadSession(dataRoot, sid);
  if (!s) throw new Error('会话不存在');
  if (!popHistory(s)) return publicState(s, { warning: '已经回到最初，不能再退' });
  saveSession(dataRoot, s);
  return publicState(s, { say: lastInterviewerSay(s) });
}

export function endSession(dataRoot, sid) {
  const s = loadSession(dataRoot, sid);
  if (!s) throw new Error('会话不存在');
  s.stage = 'ended';
  const say = str(s.templates && s.templates.closing) || '这场就到这里，辛苦啦。';
  addTurn(s, 'interviewer', say);
  saveSession(dataRoot, s);
  return publicState(s, { say });
}

function removeDir(p) {
  try { rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
}

let _lastCleanupAt = 0;
/**
 * 超期会话清理：默认 14 天后归档到 secrets/interview/archive/；
 * retention.action=delete 时直接删。每 1 小时最多跑一次，force=true 立即跑。
 */
export function cleanupSessions(dataRoot, opts = {}) {
  const cfg = loadConfig(dataRoot);
  const ret = cfg.retention || { days: 14, action: 'archive' };
  const days = num(ret.days, 14);
  if (days <= 0) return { skipped: 'disabled' };
  const now = Date.now();
  if (!opts.force && now - _lastCleanupAt < 3600000) return { skipped: 'throttle' };
  _lastCleanupAt = now;

  const base = join(interviewRootOf(dataRoot), 'sessions');
  let names = [];
  try { names = existsSync(base) ? readdirSync(base) : []; } catch { names = []; }
  const cutoff = now - days * 86400000;
  const archived = [];
  const removed = [];
  for (const name of names) {
    if (!SID_RE.test(name)) continue;
    const src = join(base, name);
    let st;
    try { st = statSync(src); } catch { continue; }
    if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
    if (ret.action === 'delete') { removeDir(src); removed.push(name); continue; }
    try {
      const dstDir = join(interviewRootOf(dataRoot), 'archive');
      mkdirSync(dstDir, { recursive: true });
      renameSync(src, join(dstDir, `${name}-${new Date(st.mtimeMs).toISOString().slice(0, 10)}`));
      archived.push(name);
    } catch { /* 跨卷或占用：下次再试 */ }
  }
  return { days, action: ret.action, archived, removed };
}

/** 界面开关：关掉哪一项，就把本场已落盘的那一项当场删掉。 */
export function applyPolicy(dataRoot, sid, patch = {}) {
  const s = loadSession(dataRoot, sid);
  if (!s) throw new Error('会话不存在');
  const before = { ...(s.policy || {}) };
  const next = normalizePolicy(before, patch);
  const dir = sessionDirOf(dataRoot, sid);
  const changed = [];
  if (before.keepAudio !== false && next.keepAudio === false) {
    removeDir(join(dir, 'answers'));
    changed.push('录音');
  }
  if (before.keepVideo !== false && next.keepVideo === false) {
    removeDir(join(dir, 'video'));
    purgeMediaPayloads(dataRoot, sid);
    // 元数据里的帧数也要归零，避免状态里还显示有帧
    for (const m of (s.media || [])) { if (m) { m.frames = []; m.discarded = true; } }
    for (const a of (s.answers || [])) {
      if (!a) continue;
      if (a.media) a.media.frames = 0;
      for (const c of (a.chunks || [])) if (c.media) c.media.frames = 0;
    }
    redactMediaFiles(dataRoot, sid, { frames: true });
    changed.push('视频帧');
  }
  s.policy = next;
  if (before.keepTranscript !== false && next.keepTranscript === false) {
    applyTranscriptPolicy(s);
    redactMediaFiles(dataRoot, sid, { transcript: true });
    changed.push('转写文本');
  }
  if (before.keepSession !== false && next.keepSession === false) {
    removeDir(dir);
    changed.push('会话日志');
  }
  saveSession(dataRoot, s);
  return { policy: next, changed, state: publicState(s, {}) };
}

export function getState(dataRoot, sid) {
  const s = loadSession(dataRoot, sid);
  if (!s) throw new Error('会话不存在');
  return publicState(s);
}

/** 生成一轮 TTS 的文件名（同文本复用，避免重复合成）。 */
export function ttsNameFor(text) {
  const h = createHash('sha1').update(str(text)).digest('hex').slice(0, 12);
  return `tts-${h}.mp3`;
}

export default {
  repoRootOf, secretsRootOf, interviewRootOf, sessionDirOf,
  loadConfig, loadQuestionBank, loadRubric, loadTemplates, loadModes, modeOf,
  loadMaterials, loadMaterial,
  createSession, proceed, submitAnswer, stepBack, endSession, getState, applyPolicy,
  cleanupSessions,
  mediaDirOf, recordMedia, getMedia,
  buildReview, scoreText, judgeQuiz, publicState, listSessions, ttsNameFor,
};
