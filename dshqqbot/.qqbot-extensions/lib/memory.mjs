/**
 * memory.mjs — 记忆门面（调用方只认这一个入口）
 *
 * 为什么需要门面：
 *   我们有两套实现 —— memory-db.mjs（SQLite，正式）和 memory-core.mjs（JSONL，回退）。
 *   调用方不该关心用哪套，也不该因为宿主没编 node:sqlite 就整个记忆功能崩掉。
 *
 * 策略：
 *   模块加载时先 try 一次 memory-db.mjs，并调用一次 openDb() 探测（内存库，不碰磁盘）。
 *   成功 → 全部 re-export db 版；失败 → 全部 re-export core 版。
 *   两套的导出**同名同签名**，所以调用方只需把 import 路径改成 ../lib/memory.mjs，逻辑一行不动。
 */

let _impl = null;
let _backend = 'jsonl';
let _note = '';

// 调试开关：QQBOT_MEMORY_BACKEND=jsonl 可强制走老的 JSONL 实现（不需要改代码）
const _force = String(process.env.QQBOT_MEMORY_BACKEND || '').trim().toLowerCase();

if (_force === 'jsonl') {
  _note = '环境变量 QQBOT_MEMORY_BACKEND=jsonl，强制走 JSONL';
} else {
  try {
    const db = await import('./memory-db.mjs');
    const probe = db.openDb();          // 无参 = 只探测 node:sqlite 可用性
    if (probe && probe.ok) {
      _impl = db;
      _backend = 'sqlite';
      _note = probe.fts ? 'sqlite+FTS5' : 'sqlite(无 FTS5)';
    } else {
      _note = 'sqlite 探测失败，回退 JSONL';
    }
  } catch (e) {
    _note = 'node:sqlite 不可用，回退 JSONL：' + (e instanceof Error ? e.message : String(e));
  }
}

if (!_impl) {
  _impl = await import('./memory-core.mjs');
  _backend = 'jsonl';
}

/** 当前生效的后端名：'sqlite' | 'jsonl' */
export const backendName = _backend;
/** 换后端的原因（调试用，空字符串 = 一次就成功） */
export const backendNote = _note;
/** 后端自述 */
export function memoryBackend() {
  return { backend: _backend, note: _note || 'sqlite 正常' };
}

// ── 聊天原始台账（chatlog-db，和 mem 共用一个 SQLite 文件）──────────────
// 只在 sqlite 后端可用；JSONL 回退时给安全空实现，保证入站/出站链路不炸。
let _chat = null;
if (_backend === 'sqlite') {
  try { _chat = await import('./chatlog-db.mjs'); } catch { _chat = null; }
}
const chatFn = (name, fallback) => (_chat && _chat[name]) || fallback;

export const ingestChatHistory = chatFn('ingestChatHistory', () => ({ ok: false, imported: 0, reason: 'chatlog 只在 sqlite 后端可用' }));
export const archiveMessages = chatFn('archiveMessages', () => ({ ok: false, added: 0, reason: 'chatlog 只在 sqlite 后端可用' }));
export const appendChat = chatFn('appendChat', () => false);
export const queryChat = chatFn('queryChat', () => []);
export const searchChat = chatFn('searchChat', () => []);
export const chatStats = chatFn('chatStats', () => ({ backend: 'jsonl', total: 0, scopes: [] }));
export const pruneChat = chatFn('pruneChat', () => ({ ok: false, deleted: 0, reason: 'chatlog 只在 sqlite 后端可用' }));
export const dropChatScope = chatFn('dropChatScope', () => 0);
export const getChatState = chatFn('getChatState', () => ({}));
export const setChatState = chatFn('setChatState', () => false);
export const cleanChatText = chatFn('cleanChatText', (t) => String(t ?? '').replace(/\s+/g, ' ').trim());

const pick = (name) => _impl[name];

// ── 类海马体层（只在 sqlite 后端有意义；JSONL 后端退回原始召回）──────────
let _hippo = null;
if (_backend === 'sqlite') {
  try { _hippo = await import('./memory-hippo.mjs'); } catch { _hippo = null; }
}

// ── 与 memory-core 完全同名的 18 个函数 ─────────────────────────────────
export const loadConfig = pick('loadConfig');
export const memoryDir = pick('memoryDir');
export const memoryFile = pick('memoryFile');
export const embedderMode = pick('embedderMode');
export const cos = pick('cos');
export const loadMemories = pick('loadMemories');
export const remember = pick('remember');
export const forget = pick('forget');
// 召回默认走类海马体版：先多路召回拿候选，再做时间邻近扩散 + 归纳补全 + MMR 去重。
// 失败会自己降级回原始 recall，签名不变，调用方无感。
export const recall = (_hippo && _hippo.hippoRecall) || pick('recall');
export const recallRaw = pick('recall');
export const formatRecallBlock = pick('formatRecallBlock');
// 历史聊天记录导入后的人物画像：只在 sqlite 后端有（JSONL 没有 scope 分表的概念），
// 回退时给安全空实现，保证入站链路不炸。
export const personProfile = pick('personProfile')
  || (() => ({ ok: false, scope: '', impression: '', say: 0, first: 0, last: 0 }));
export const stats = pick('stats');
export const inboxFile = pick('inboxFile');
export const pushInbox = pick('pushInbox');
export const drainInbox = pick('drainInbox');
export const listAll = pick('listAll');
export const forgetAnywhere = pick('forgetAnywhere');
export const digestScope = pick('digestScope');
export const shouldDigest = pick('shouldDigest');

// ── SQLite 后端专属（JSONL 后端下是安全空实现，不会抛）──────────────────
const noop = (reason) => () => { throw new Error(reason); };
const emptyArr = () => [];
const falseRet = () => false;

export const openDb = _impl.openDb || noop('当前是 JSONL 后端，没有 openDb');
export const closeDb = _impl.closeDb || falseRet;
export const migrateJsonl = _impl.migrateJsonl || (() => ({ ok: false, reason: '当前是 JSONL 后端，无需迁移' }));
export const searchText = _impl.searchText || emptyArr;
export const vecToBlob = _impl.vecToBlob || (() => null);
export const blobToVec = _impl.blobToVec || emptyArr;

export const rebuildEmbeddings = _impl.rebuildEmbeddings || (async () => ({ ok: false, reason: '向量重嵌只在 sqlite 后端可用' }));
export const embeddingModelInfo = _impl.embeddingModelInfo || (() => ({ model: '', mode: '', rows: 0, ts: 0 }));
export const currentEmbedderInfo = _impl.currentEmbedderInfo || (async () => ({ model: '', mode: 'unknown', dim: 0, error: 'jsonl 后端' }));

export const setPersona = _impl.setPersona || (() => ({ ok: false, reason: 'persona 只在 sqlite 后端可用' }));
export const getPersona = _impl.getPersona || emptyArr;
export const getPersonaValue = _impl.getPersonaValue || (() => null);
export const listPersona = _impl.listPersona || emptyArr;
export const forgetPersona = _impl.forgetPersona || falseRet;

// ── 维护用（清洗/权重/库文件路径）──────────────────────────────────────
// cleanMemText 两边都有实现；weightOf / dbFile 只有 sqlite 版才有意义。
export const cleanMemText = _impl.cleanMemText || ((t) => String(t ?? '').replace(/\s+/g, ' ').trim());
export const weightOf = _impl.weightOf || (() => 0);
export const dbFile = _impl.dbFile || (() => memoryFile('', loadConfig('')));

// ── 类海马体层对外接口（JSONL 后端给空实现，调用方不用判后端）────────────
const hippoNoop = {
  replay: () => ({ ok: false, reason: '类海马体层只在 sqlite 后端可用' }),
  beliefs: () => [],
  observeTrait: () => ({ ok: false, reason: '类海马体层只在 sqlite 后端可用' }),
  anchorBeliefs: () => ({ ok: false, reason: '类海马体层只在 sqlite 后端可用' }),
  driftReport: () => ({ rows: [], stability: 100, worst: null, alarm: 0 }),
  hippoStats: () => ({ ok: false }),
};
export const replay = (_hippo && _hippo.replay) || hippoNoop.replay;
export const beliefs = (_hippo && _hippo.beliefs) || hippoNoop.beliefs;
export const observeTrait = (_hippo && _hippo.observeTrait) || hippoNoop.observeTrait;
export const anchorBeliefs = (_hippo && _hippo.anchorBeliefs) || hippoNoop.anchorBeliefs;
export const driftReport = (_hippo && _hippo.driftReport) || hippoNoop.driftReport;
export const hippoStats = (_hippo && _hippo.hippoStats) || hippoNoop.hippoStats;

// ── 时序图谱 + 数据主权（JSONL 后端给空实现，调用方不用判后端）────────────
// 图谱只在 sqlite 后端有意义：JSONL 版没有 mem_edge 表。
const graphNoop = {
  addEdges: () => ({ ok: false, added: 0, superseded: 0, reason: '图谱只在 sqlite 后端可用' }),
  liveNeighbors: () => [],
  edgeHistory: () => [],
  personalizedPageRank: () => new Map(),
};
export const addEdges = _impl.addEdges || graphNoop.addEdges;
export const liveNeighbors = _impl.liveNeighbors || graphNoop.liveNeighbors;
export const edgeHistory = _impl.edgeHistory || graphNoop.edgeHistory;
export const personalizedPageRank = _impl.personalizedPageRank || graphNoop.personalizedPageRank;

// 导出/彻底删除/审计：两边都尽量实现（JSONL 版只有导出和删除文件）
export const exportScope = _impl.exportScope || ((dataRoot, scope) => ({
  scope: String(scope || ''), exportedAt: Date.now(),
  total: (loadMemories(dataRoot, scope, loadConfig(dataRoot)) || []).length,
  memories: loadMemories(dataRoot, scope, loadConfig(dataRoot)) || [], persona: [], edges: [],
}));
export const purgeScope = _impl.purgeScope || (() => ({ ok: false, reason: '彻底删除只在 sqlite 后端可用' }));
export const audit = _impl.audit || (() => false);
export const readAudit = _impl.readAudit || (() => []);
export const auditFile = _impl.auditFile || (() => '');

// 隐私：字段级加密（sqlite 后端真实现；JSONL 后端如实说"不适用"）
export const privacyState = _impl.privacyState || (() => ({ encryptAtRest: false, keyReady: false, cipher: 'none', backend: 'jsonl' }));
export const setEncryption = _impl.setEncryption || (() => ({ ok: false, reason: '字段级加密只在 sqlite 后端可用' }));
export const reencryptAll = _impl.reencryptAll || (() => ({ ok: false, reason: '只在 sqlite 后端可用' }));
export const memDecrypt = _impl.memDecrypt || ((dataRoot, s) => String(s ?? ''));

// 持久化运维：体检 / 维护 / schema 自述（JSONL 后端如实说"不适用"，不假装健康）
export const dbHealth = _impl.dbHealth || (() => ({ ok: false, healthy: false, verdict: 'JSONL 后端没有 SQLite 库' }));
export const maintainDb = _impl.maintainDb || (() => ({ ok: false, reason: 'JSONL 后端没有 SQLite 库' }));
export const schemaState = _impl.schemaState || (() => ({ version: 0, missing: [], error: 'JSONL 后端' }));
