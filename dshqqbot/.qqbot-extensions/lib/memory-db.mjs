/**
 * memory-db.mjs — 小蓝的长期记忆库（SQLite 版）
 *
 * 和 memory-core.mjs（JSONL 版）**同名同签名**，可以直接平替；算法逐行对齐，
 * 只把存储层从「一行一条 appendFile」换成「node:sqlite 的 DatabaseSync」。
 *
 * 为什么换：JSONL 每次召回都要全文件 parse、每次写入都要整文件 rewrite，
 * 记忆上万条后是 O(n) 的读写放大；SQLite 有索引、有事务、WAL 并发读，
 * 还能顺手把「角色设定/世界书」和「记忆」放进同一个库统一备份。
 *
 * 落在 {dataRoot}/.qqbot/memory.db（WAL 模式）。
 * 表：
 *   mem(id, scope, kind, subj, text, vec BLOB, ts, hits, last_hit, src)  每行一条记忆
 *   persona(id, scope, ckey, cvalue, weight, ts)                        角色设定 / 世界书条目
 *   meta(k, v)                                                          游标：迁移标记、摘要时间戳
 *   mem_fts(...)                                                        FTS5 关键词索引（建不出来就跳过）
 *
 * 算法（与 memory-core 完全一致，勿随意改）：
 *   · 召回打分 = cos * (0.5 + 0.5*recency) * (1 + 0.1*min(hits,5))
 *   · 召回门槛 recallMinCos；与查询几乎逐字相同（cos > 0.98）的条目跳过
 *   · 写入去重：cos >= dedupeCos 视为同一条，只累加 hits
 *   · 容量：每 scope 上限 cap 条，超出按 hits*recency 最低淘汰
 *   · 中层记忆：抽取式摘要（向量质心最近的 1~2 条原句），零 token，不删原记忆
 *
 * 向量存 BLOB：Float32Array → Buffer；读回 Float32Array → 普通 Array（cos 只吃 Array）。
 *
 * 为什么用 node:sqlite：宿主是 Electron 自带的 node 24，内置 DatabaseSync，零依赖；
 * better-sqlite3 没装，也别装。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, appendFileSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { embedTexts } from './embedder.mjs';

// ── 参数（可被 memory-config.json 覆盖）────────────────────────────────
const DEFAULTS = {
  cap: 1500,              // 每 scope 最大记忆条数
  recallTopK: 4,          // 每次召回几条
  // 召回门槛：bge-small-zh 对"改述型问句"余弦只有 ~0.50，0.55 会漏召回；0.45 是实测档位。
  recallMinCos: 0.45,
  recallCandidates: 24,   // 倒排/实体候选少于此数就退回全表向量扫描（保证语义召回不丢）
  recallMaxChars: 300,    // 注入块的字数上限
  dedupeCos: 0.92,        // 高于这个视为重复
  halfLifeDays: 30,       // 时间衰减半衰期
  minTextLen: 6,          // 短于此的消息不进记忆
  digestEvery: 40,        // 每攒够多少条 event 做一次中层摘要（零 token，不删原记忆）
  pluginDir: '',          // 空 = 运行时自动找（见 lib/plugin-dir.mjs，兼容 .generations/live）
  // 隐私：字段级加密（opt-in，默认关）。开着时 mem.text 落盘为 AES-256-GCM 密文，
  // 读侧透明解密；倒排/实体索引只存分词不存原文，FTS 全文索引会停用（否则等于明文落盘）。
  privacy: { encryptAtRest: false },
};

let CONFIG = { ...DEFAULTS };

/** 读一次配置（扩展目录下 memory-config.json，可选）——与 core 同路径同语义 */
export function loadConfig(dataRoot) {
  try {
    const p = join(dataRoot, '.qqbot-extensions', 'memory-config.json');
    if (existsSync(p)) CONFIG = { ...DEFAULTS, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch { /* 配置坏了就用默认，绝不因此中断 */ }
  return CONFIG;
}

// ── 路径 ────────────────────────────────────────────────────────────────
const FALLBACK_ROOT = 'F:/qqbot/dshqqbot';

function rootOf(dataRoot) {
  const v = String(dataRoot || '').trim();
  return v || String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim() || FALLBACK_ROOT;
}

export function memoryDir(dataRoot) {
  return join(rootOf(dataRoot), '.qqbot', 'memory');
}

/** 库文件（JSONL 版这里是分 scope 的 .jsonl；SQLite 版全 scope 共用一个文件） */
export function memoryFile(dataRoot, scope) {
  return dbFile(dataRoot);
}

export function dbFile(dataRoot) {
  return join(rootOf(dataRoot), '.qqbot', 'memory.db');
}

// ── 嵌入器：统一走 lib/embedder.mjs（本地 ONNX / Ollama 可切换）──────────
let _embedderMode = 'pending';
let _embedderWarnedModel = '';

export function embedderMode() { return _embedderMode; }

/**
 * 当前向量后端下的**实际**余弦门槛。
 *
 * · 语义后端：就是 cfg.recallMinCos。
 * · 词频回退（没装模型/离线）：返回 **null**，表示"不拿余弦当准入门槛"。
 *
 * 为什么词频模式必须关掉余弦门槛（实测数据）：
 *   同一对真实问答在词频向量下只有 0.018~0.137，而**毫不相干**的句子之间
 *   随便就有 0.10~0.19 —— 噪声底噪高于真实命中，说明这个量纲本身没有判别力。
 *   早先降到 0.08 的写法等于给噪声开门（「量子力学的数学推导」能召回「杯子打翻了」）。
 *   正确做法：词频模式下准入只看证据通道（词面/实体/图谱/回溯意图）。
 */
export function effectiveMinCos(cfg = CONFIG) {
  return _embedderMode === 'lexical' ? null : Number(cfg.recallMinCos);
}

async function embedMany(dataRoot, texts, cfg, asQuery = false) {
  const r = await embedTexts(dataRoot, texts, {
    role: 'memory',
    kind: asQuery ? 'query' : 'passage',
  });
  _embedderMode = r.mode;
  if (r.mode === 'lexical' && r.model !== _embedderWarnedModel) {
    _embedderWarnedModel = r.model;
    try { console.warn('[memory-db] 向量模型不可用，已退化为词频：' + (r.error || 'unknown')); } catch { /* ignore */ }
  }
  return r.vecs;
}

// ── 向量 / BLOB 互转 ────────────────────────────────────────────────────
/** 向量 → BLOB（Float32 定长，省空间） */
export function vecToBlob(vec) {
  if (!vec || vec.length === 0) return null;
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** BLOB → 普通 Array（cos() 用 Array.isArray 判断，所以必须吐 Array 而不是 Float32Array） */
export function blobToVec(blob) {
  if (!blob || blob.byteLength === 0) return [];
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // Float32Array 要求 byteOffset 4 字节对齐；不对齐就先复制一份
  const f32 = (u8.byteOffset % 4 === 0)
    ? new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4))
    : new Float32Array(u8.slice().buffer, 0, Math.floor(u8.byteLength / 4));
  return Array.from(f32);
}

export function cos(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return d / Math.sqrt(na * nb);
}

/** 时间衰减：越久越淡，半衰期 halfLifeDays */
function recency(ts, halfLifeDays) {
  const ageDays = (Date.now() - Number(ts || 0)) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// ── 建库 / 打开 ─────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS mem (
  id       TEXT PRIMARY KEY,
  scope    TEXT,
  kind     TEXT,
  subj     TEXT,
  text     TEXT,
  vec      BLOB,
  ts       INTEGER,
  hits     INTEGER DEFAULT 0,
  last_hit INTEGER,
  src      TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_scope    ON mem(scope);
CREATE INDEX IF NOT EXISTS idx_mem_scope_ts ON mem(scope, ts);

CREATE TABLE IF NOT EXISTS persona (
  id     TEXT PRIMARY KEY,
  scope  TEXT,
  ckey   TEXT,
  cvalue TEXT,
  weight REAL DEFAULT 1,
  ts     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_persona_scope ON persona(scope);
CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_scope_ckey ON persona(scope, ckey);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- ── 类海马体索引（2026-10-24）──────────────────────────────────────────
-- 为什么加：主表只有「向量 + 全表扫描」，查询必须先把整个 scope 的 1500 条向量
-- 全部算一遍余弦，既慢又只能靠语义相似度排序（名字/专名类查询经常被摘要挤掉）。
-- 这里补三层索引，让召回像海马体一样「先锚定，再扩散」：
--   mem_tok  倒排（中文二元组 + 拉丁词）→ 关键词候选，纯 SQL，不算向量
--   mem_entity / mem_tag  实体词典与实体↔记忆标签 → 名字类查询直接锚定
--   mem_edge 三元组（甲公司关系：妈妈-是-群主）→ 1 跳关系扩散
CREATE TABLE IF NOT EXISTS mem_tok (
  scope  TEXT,
  tok    TEXT,
  mem_id TEXT,
  tf     INTEGER DEFAULT 1,
  PRIMARY KEY(scope, tok, mem_id)
);
CREATE INDEX IF NOT EXISTS idx_mem_tok_lookup ON mem_tok(scope, tok);

CREATE TABLE IF NOT EXISTS mem_entity (
  scope TEXT,
  name  TEXT,
  kind  TEXT,
  ts    INTEGER,
  hits  INTEGER DEFAULT 0,
  PRIMARY KEY(scope, name)
);

CREATE TABLE IF NOT EXISTS mem_tag (
  scope  TEXT,
  name   TEXT,
  mem_id TEXT,
  PRIMARY KEY(scope, name, mem_id)
);
CREATE INDEX IF NOT EXISTS idx_mem_tag_name ON mem_tag(scope, name);
CREATE INDEX IF NOT EXISTS idx_mem_tag_mem  ON mem_tag(scope, mem_id);

-- 三元组（甲-是-群主）→ 关系扩散；带**有效期**，
-- 新事实让旧事实失效而不是删掉（Graphiti/Zep 那套 bi-temporal 思路的精简版）：
--   valid_from / valid_to 是"这件事在现实里成立的时间段"
--   status = 'active' | 'superseded'
--   superseded_by 指向取代它的记忆 id，方便追溯"她为什么改口"
CREATE TABLE IF NOT EXISTS mem_edge (
  scope    TEXT,
  src      TEXT,
  rel      TEXT,
  dst      TEXT,
  mem_id   TEXT,
  ts       INTEGER,
  valid_from INTEGER,
  valid_to   INTEGER,
  status   TEXT DEFAULT 'active',
  superseded_by TEXT,
  src_kind TEXT DEFAULT 'rule',
  PRIMARY KEY(scope, src, rel, dst, mem_id)
);
CREATE INDEX IF NOT EXISTS idx_mem_edge_src ON mem_edge(scope, src);
CREATE INDEX IF NOT EXISTS idx_mem_edge_dst ON mem_edge(scope, dst);
`;

/**
 * schema 版本。加表/加列就 +1。
 * 为什么要有这个数：宿主是长跑进程，句柄一缓存，后面新增的建表语句就再也等不到执行。
 * 线上实测出现过 mem_tok / mem_entity / mem_tag / mem_edge **整组缺失**——
 * 关键词、实体、图谱三路召回全哑，只剩向量一路；而 insertItem 把建表异常吞了，
 * 面板上看起来一切正常。所以必须有一个可读的版本号 + 缺表清单暴露出去。
 */
export const SCHEMA_VERSION = 3;

const REQUIRED_TABLES = ['mem', 'persona', 'meta', 'mem_tok', 'mem_entity', 'mem_tag', 'mem_edge'];

const _schema = { version: 0, missing: [], error: '', checkedAt: 0 };

/**
 * 建表 + 补列 + 校验，幂等且便宜（无表时才会真建）。
 * 返回缺失表清单，供 handle()/面板判断是否降级。
 */
function ensureSchema(h) {
  let error = '';
  try {
    h.db.exec(SCHEMA);
    migrateGraphColumns(h.db);
    h.fts = tryCreateFts(h.db);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const missing = [];
  for (const t of REQUIRED_TABLES) {
    try {
      if (!h.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) missing.push(t);
    } catch { missing.push(t); }
  }
  h.schemaVersion = SCHEMA_VERSION;
  h.schemaMissing = missing;
  h.schemaCheckedAt = Date.now();
  _schema.version = SCHEMA_VERSION;
  _schema.missing = missing;
  _schema.error = error;
  _schema.checkedAt = h.schemaCheckedAt;
  try {
    setMeta(h, 'schema_version', String(SCHEMA_VERSION));
    if (missing.length) setMeta(h, 'schema_missing', missing.join(','));
  } catch { /* meta 写不进去不影响主流程 */ }
  return missing;
}

/** 当前进程的 schema 自述（给面板/健康检查用，不需要 dataRoot） */
export function schemaState() {
  return { ..._schema, expected: SCHEMA_VERSION };
}

/** 索引写入失败计数：静默降级是上一版最大的坑，至少要能看见 */
let _indexErrors = 0;
let _lastIndexError = '';
function noteIndexError(e) {
  _indexErrors += 1;
  _lastIndexError = e instanceof Error ? e.message : String(e);
}

/**
 * 老库补列：mem_edge 早期只有 (scope,src,rel,dst,mem_id,ts)，没有有效期字段。
 * SQLite 的 ALTER TABLE ADD COLUMN 不能带非常量默认值，加不上就跳过（列缺失时查询会兜底）。
 */
function migrateGraphColumns(db) {
  const want = [
    ['valid_from', 'INTEGER'],
    ['valid_to', 'INTEGER'],
    ['status', "TEXT DEFAULT 'active'"],
    ['superseded_by', 'TEXT'],
    ['src_kind', "TEXT DEFAULT 'rule'"],
  ];
  let have = new Set();
  try {
    have = new Set(db.prepare('PRAGMA table_info(mem_edge)').all().map((r) => r.name));
  } catch {
    return;
  }
  for (const [name, type] of want) {
    if (have.has(name)) continue;
    try { db.exec(`ALTER TABLE mem_edge ADD COLUMN ${name} ${type}`); } catch { /* 加不上就算了 */ }
  }
  // 老行没有有效期：把 ts 当作"从这时起成立"，status 补成 active
  try { db.exec("UPDATE mem_edge SET status = 'active' WHERE status IS NULL"); } catch { /* ignore */ }
  try { db.exec('UPDATE mem_edge SET valid_from = ts WHERE valid_from IS NULL'); } catch { /* ignore */ }
  // 索引必须在补列之后再建：老库在这一步之前还没有 status 列
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_mem_edge_live ON mem_edge(scope, status)"); } catch { /* ignore */ }
}

/** FTS5 虚拟表：中文在 unicode61 下不分词，命中率有限，所以只是补充手段；建不出来就静默跳过。 */
function tryCreateFts(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(id UNINDEXED, scope UNINDEXED, text)");
    return true;
  } catch {
    return false; // 宿主没编 FTS5 / 建表失败 —— 主召回走向量，不受影响
  }
}

const _handles = new Map(); // dataRoot(小写绝对路径) → handle

function keyOf(root) {
  try { return resolve(root).toLowerCase(); } catch { return String(root).toLowerCase(); }
}

function newId() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── 字段级加密（AES-256-GCM，opt-in）────────────────────────────────────
// 密钥落在 {root}/.qqbot/secrets/memory.key（32 字节 hex）。丢了密钥 = 记忆读不回来，
// 所以解密失败时返回空串而不是密文，宁可失忆也不能把乱码当记忆注入人格。
const ENC_PREFIX = 'enc1:';
const ENC_IV_LEN = 12;
const ENC_TAG_LEN = 16;

function keyFilePath(root) {
  return join(root, '.qqbot', 'secrets', 'memory.key');
}

function loadEncKey(root, create) {
  try {
    const f = keyFilePath(root);
    if (existsSync(f)) {
      const hex = readFileSync(f, 'utf8').trim();
      return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
    }
    if (!create) return null;
    const dir = dirname(f);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const k = randomBytes(32);
    writeFileSync(f, k.toString('hex') + '\n', 'utf8');
    return k;
  } catch { return null; }
}

function encText(h, plain) {
  const s = String(plain || '');
  if (!h || !h.encOn || !h.encKey || !s || s.startsWith(ENC_PREFIX)) return s;
  try {
    const iv = randomBytes(ENC_IV_LEN);
    const c = createCipheriv('aes-256-gcm', h.encKey, iv);
    const body = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  } catch { return s; } // 加密失败退回明文：宁明文不丢记忆
}

function decText(h, stored) {
  const s = String(stored || '');
  if (!s.startsWith(ENC_PREFIX)) return s; // 明文直通（未加密/老库）
  if (!h || !h.encKey) return '';          // 密钥不在 = 读不回
  try {
    const buf = Buffer.from(s.slice(ENC_PREFIX.length), 'base64');
    const d = createDecipheriv('aes-256-gcm', h.encKey, buf.subarray(0, ENC_IV_LEN));
    d.setAuthTag(buf.subarray(ENC_IV_LEN, ENC_IV_LEN + ENC_TAG_LEN));
    return Buffer.concat([d.update(buf.subarray(ENC_IV_LEN + ENC_TAG_LEN)), d.final()]).toString('utf8');
  } catch { return ''; }
}

/** 跨文件解密口：panel-core / graph-llm / hippo 直读 SQL 时用它（密文就解，明文原样） */
export function memDecrypt(dataRoot, stored) {
  try { return decText(handle(dataRoot), stored); } catch { return ''; }
}

function encConfigOf(cfg) {
  const p = cfg && cfg.privacy;
  return !!(p && typeof p === 'object' && p.encryptAtRest);
}

/** 隐私状态（给浮窗） */
export function privacyState(dataRoot) {
  const root = rootOf(dataRoot);
  const h = handle(dataRoot);
  return {
    encryptAtRest: !!h.encOn,
    keyReady: !!h.encKey,
    keyFile: keyFilePath(root),
    cipher: 'aes-256-gcm',
  };
}

/** 全库重加密（切开关时用）：on=true 明文→密文，on=false 密文→明文 */
export function reencryptAll(dataRoot, on) {
  const h = handle(dataRoot);
  const want = !!on;
  if (want && !h.encKey) return { ok: false, reason: 'no-key' };
  if (!want) {
    // 关加密必须有钥匙在手，否则密文行会变空串——先探一下
    const probe = h.db.prepare("SELECT COUNT(*) AS n FROM mem WHERE substr(text, 1, 5) = 'enc1:'").get();
    if ((Number(probe?.n) || 0) > 0 && !h.encKey) return { ok: false, reason: 'key-missing' };
  }
  const rows = h.db.prepare('SELECT id, text FROM mem').all();
  let changed = 0;
  h.db.exec('BEGIN');
  try {
    const upd = h.db.prepare('UPDATE mem SET text = ? WHERE id = ?');
    for (const r of rows) {
      const plain = decText(h, r.text);
      const next = want ? encText({ encOn: true, encKey: h.encKey }, plain) : plain;
      if (next !== String(r.text || '')) { upd.run(next, String(r.id)); changed++; }
    }
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  // FTS 里若有过往明文必须清掉（加密态不再写 FTS）
  try { h.db.exec('DELETE FROM mem_fts'); } catch { /* 没建 FTS 就算了 */ }
  return { ok: true, rows: rows.length, changed };
}

/** 开/关字段级加密（写配置 + 全库转换 + 记审计）。行数在万级也是毫秒-秒级。 */
export function setEncryption(dataRoot, on) {
  const root = rootOf(dataRoot);
  const h = handle(dataRoot);
  const want = !!on;
  if (want && !h.encKey) h.encKey = loadEncKey(root, true);
  if (want && !h.encKey) return { ok: false, reason: '密钥文件创建失败' };
  const r = reencryptAll(dataRoot, want);
  if (!r.ok) return r;
  h.encOn = want;
  // 持久化到 memory-config.json（下次进程起来还是这个状态）
  const p = join(root, '.qqbot-extensions', 'memory-config.json');
  try { const pd = dirname(p); if (!existsSync(pd)) mkdirSync(pd, { recursive: true }); } catch { /* ignore */ }
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(p, 'utf8')) || {}; } catch { cfg = {}; }
  cfg.privacy = { ...(cfg.privacy || {}), encryptAtRest: want };
  try { if (existsSync(p)) copyFileSync(p, p + '.bak'); } catch { /* ignore */ }
  try { writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  CONFIG = { ...CONFIG, privacy: { ...(CONFIG.privacy || {}), encryptAtRest: want } };
  audit(dataRoot, { action: want ? 'encrypt-on' : 'encrypt-off', count: r.changed, note: 'setEncryption' });
  return { ok: true, encryptAtRest: want, rows: r.rows, changed: r.changed };
}

/**
 * 打开（或复用）某个数据根的库。
 * 不传 dataRoot = 只探测 node:sqlite 是否可用（内存库，不碰磁盘、无副作用）。
 */
export function openDb(dataRoot) {
  if (!dataRoot) {
    const probe = new DatabaseSync(':memory:');
    try {
      probe.exec(SCHEMA);
      return { ok: true, probe: true, file: ':memory:', fts: tryCreateFts(probe) };
    } finally {
      try { probe.close(); } catch { /* 关不掉也无所谓 */ }
    }
  }
  return handle(dataRoot);
}

function handle(dataRoot) {
  const root = rootOf(dataRoot);
  const key = keyOf(root);
  const hit = _handles.get(key);
  if (hit) {
    // 句柄还在 = 进程没重启 = 新增的建表语句之前没跑过。
    // 这里做一次廉价自愈：版本落后或缺表就补建（幂等），失败的话 5 分钟内不再重试，
    // 免得只读盘/权限问题把每次访问都拖成一次建表尝试。
    if (hit.schemaVersion !== SCHEMA_VERSION || (hit.schemaMissing && hit.schemaMissing.length)) {
      if (hit.schemaVersion !== SCHEMA_VERSION || Date.now() - (Number(hit.schemaCheckedAt) || 0) > 5 * 60000) {
        ensureSchema(hit);
      }
    }
    return hit;
  }

  const file = dbFile(root);
  const dir = join(root, '.qqbot');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');

  // 加密状态：配置要 + 密钥就绪才真开；配置没要但密钥文件在，也把钥匙加载好
  //（这样「开关漂移」时老密文照样读得回来，只是新写入不再加密）。
  loadConfig(root);
  const wantEnc = encConfigOf(CONFIG);
  const h = { ok: true, db, fts: false, root, file, encKey: null, encOn: false };
  if (wantEnc) {
    h.encKey = loadEncKey(root, true);
    h.encOn = !!h.encKey;
  } else {
    h.encKey = loadEncKey(root, false);
  }
  _handles.set(key, h);
  // 先登记句柄再建表：建表过程中若触发 migrateJsonlHandle 之类的重入，能拿到同一个 h
  ensureSchema(h);
  // 首次打开（或 JSONL 变新了）→ 把老的 .jsonl 记忆并进来。失败绝不外抛。
  migrateJsonlHandle(h);
  return h;
}

/**
 * 把内部句柄暴露给同目录的 chatlog-db.mjs（它和 mem 共用一个 SQLite 文件）。
 * 不是给业务代码用的：业务代码一律走 memory.mjs 门面。
 */
export function getHandle(dataRoot) {
  return handle(dataRoot);
}

/** 关掉某个数据根的连接（测试/退出用；生产环境进程退出自然关） */
export function closeDb(dataRoot) {
  const root = rootOf(dataRoot);
  const key = keyOf(root);
  const h = _handles.get(key);
  if (!h) return false;
  try { h.db.close(); } catch { /* ignore */ }
  _handles.delete(key);
  return true;
}

// ── meta 游标 ───────────────────────────────────────────────────────────
function getMeta(h, k) {
  try {
    const row = h.db.prepare('SELECT v FROM meta WHERE k = ?').get(String(k));
    return row ? row.v : null;
  } catch { return null; }
}

function setMeta(h, k, v) {
  h.db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(String(k), String(v));
}

// ── 行 ↔ 记忆对象 ───────────────────────────────────────────────────────
function rowToItem(r, h = null) {
  return {
    id: r.id,
    ts: Number(r.ts) || 0,
    kind: r.kind || 'fact',
    // 读的时候也洗一遍：老库里存着带 `<@OPENID>` 的正文（cleanMemText 上线前写进去的），
    // 洗在读取侧 = 立刻见效，不用等迁移。加密开启时先解密再洗。
    text: cleanMemText(decText(h, r.text)),
    subj: r.subj || '',
    vec: blobToVec(r.vec),
    hits: Number(r.hits) || 0,
    lastHit: Number(r.last_hit) || 0,
    src: r.src || '',
  };
}

// ── 类海马体索引：分词 / 实体 / 三元组（零依赖、纯本地）─────────────────
/**
 * 中文没有空格，FTS5 的 unicode61 又不切词，所以这里自己做最轻的一层：
 *   · 拉丁词/数字整词
 *   · 中文连续串切二元组（"妈妈熬夜" → 妈妈/星熬/熬夜），去停用二元组
 * 。二元组不是"理解"，但作为**候选筛选**的倒排键足够：它只负责把 1500 条缩到
 * 几十条，真正的排序仍由向量 + RRF 完成，所以召回不会因此变差。
 */
const STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '什么', '怎么', '就是', '不是', '可以',
  '一个', '没有', '还是', '因为', '所以', '但是', '如果', '已经', '现在', '然后', '之后',
  '这样', '那样', '时候', '东西', '自己', '别人', '大家', '一下', '一点', '一些', '觉得',
  '知道', '应该', '真的', '有点', '其实', '好像', '的话', '的是', '了的', '了吗', '呢的',
  // 回溯型问句里的"元词"：它们描述的是"我要找记忆"这个动作本身，不是话题内容。
  // 不剔掉的话，「你还记得…」会和「明天记得带伞」靠「记得」强绑定，把噪声顶到第一位。
  '记得', '说过', '讲过', '提过', '聊过', '上次', '下次', '之前', '以前', '那次',
  '我的', '你的', '他的', '她的', '这次', '需要', '可能', '一直', '哪些',
]);

/**
 * 单字通道的前缀。放在 `\u0001` 上是为了与真实文本不可能碰撞：
 * 二元组一定是汉字/字母，永远不会以这个控制字符开头。
 */
const UNI = '\u0001';

/**
 * 单字停用表：虚词/语气词。只当单字索引用，不影响二元组。
 * 这些字几乎出现在每句话里，拿来当召回依据只会把整库都拉进来。
 */
const STOP_CHARS = new Set(Array.from('的了着过吗呢啊吧呀哦嘛是在有我你他她它们这那和与就都也还很太更最不没要会能可被把给对从到向往说个一二三四五六七八九十么什怎哪谁何时地得'));

/**
 * 提取倒排键：ASCII 词 + 中文二元组（+ 可选的中文单字）。
 *
 * 为什么需要单字（默认开启）：
 *   只有二元组时，措辞一变就整串落空——"你说过要教我什么" 与
 *   "本鲸今天教你钓鱼吧" 没有一个共同二元组（只有"教"这一个单字）。
 *   这就是"复述型问句召不回来"的根因。单字是噪声更大的信号，所以
 *   单独打标（UNI 前缀）并在算分时给低权重，只用来补召回、不参与主排序。
 */
export function tokensOf(text, opts = {}) {
  const s = String(text || '');
  const uni = opts.unigrams !== false;
  const out = [];
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) out.push(m[0].toLowerCase());
  for (const run of (s.match(/[\u4e00-\u9fa5]+/g) || [])) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg)) out.push(bg);
    }
    if (uni) {
      for (const ch of run) if (!STOP_CHARS.has(ch)) out.push(UNI + ch);
    }
  }
  return Array.from(new Set(out)).slice(0, uni ? 96 : 60);
}

/** 主语里常带的"我记得/他说"之类前缀，抽三元组前先削掉，否则实体会变成整句 */
const SUBJ_NOISE = /^(?:我|你|他|她|它|咱们|我们|你们|他们|好像|其实|记得|听说|据说|之前|刚才|昨天|今天|早上|晚上|然后|而且|但是|所以)+/;

function trimName(s) {
  const t = String(s || '').replace(SUBJ_NOISE, '').replace(/[的了着过吗呢啊吧呀哦嘛]+$/, '').trim();
  return t.length >= 2 && t.length <= 14 && !STOP_BIGRAMS.has(t) ? t : '';
}

/**
 * 关系抽取（启发式，不求全）：只抓「A 是/在/喜欢/养了/叫 B」这五类最常见的主谓宾。
 * 抓错也不致命 —— 边只用来做 1 跳扩散加分，最终排序还是向量 + 关键词。
 */
const REL_PATTERNS = [
  { rel: '是', re: /([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:就是|其实是|是)([\u4e00-\u9fa5A-Za-z0-9]{2,14})/g },
  { rel: '在', re: /([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:住在|在)([\u4e00-\u9fa5A-Za-z0-9]{2,14})/g },
  { rel: '喜欢', re: /([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:喜欢|爱吃|爱看|讨厌)([\u4e00-\u9fa5A-Za-z0-9]{2,14})/g },
  { rel: '养', re: /([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:养了|有一条|有一只)([\u4e00-\u9fa5A-Za-z0-9]{2,14})/g },
  { rel: '叫', re: /([\u4e00-\u9fa5A-Za-z0-9]{2,10})(?:叫做|叫)([\u4e00-\u9fa5A-Za-z0-9]{2,14})/g },
];

/** 一条记忆 → { toks: Map(tok→tf), entities: string[], edges: [{src,rel,dst}] } */
export function extractIndex(text) {
  const s = String(text || '');
  const toks = new Map();
  for (const t of tokensOf(s)) toks.set(t, 1);
  // 二元组按出现次数补 tf（同一句里反复提到，说明是重点）
  for (const run of (s.match(/[\u4e00-\u9fa5]+/g) || [])) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (STOP_BIGRAMS.has(bg)) continue;
      toks.set(bg, (toks.get(bg) || 1) + 1);
    }
  }

  const entities = new Set();
  // 引号/书名号里的东西几乎一定是专名
  for (const re of [/「([^」]{1,12})」/g, /“([^”]{1,12})”/g, /《([^》]{1,12})》/g]) {
    for (const m of s.matchAll(re)) { const n = trimName(m[1]); if (n) entities.add(n); }
  }
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) {
    if (m[0].length >= 2) entities.add(m[0]);
  }

  const edges = [];
  for (const { rel, re } of REL_PATTERNS) {
    for (const m of s.matchAll(re)) {
      const src = trimName(m[1]);
      const dst = trimName(m[2]);
      if (!src || !dst || src === dst) continue;
      entities.add(src);
      entities.add(dst);
      edges.push({ src, rel, dst });
    }
  }

  return { toks: Array.from(toks.entries()), entities: Array.from(entities), edges };
}

function clearIndexRows(h, scope, id) {
  try {
    h.db.prepare('DELETE FROM mem_tok  WHERE scope = ? AND mem_id = ?').run(scope, id);
    h.db.prepare('DELETE FROM mem_tag  WHERE scope = ? AND mem_id = ?').run(scope, id);
    h.db.prepare('DELETE FROM mem_edge WHERE scope = ? AND mem_id = ?').run(scope, id);
  } catch { /* 索引坏不影响主表 */ }
}

function indexMemory(h, scope, it) {
  const { toks, entities, edges } = extractIndex(it.text);
  const insTok = h.db.prepare('INSERT OR REPLACE INTO mem_tok(scope, tok, mem_id, tf) VALUES (?, ?, ?, ?)');
  for (const [tok, tf] of toks) insTok.run(scope, tok, it.id, tf);
  const insEnt = h.db.prepare(
    `INSERT INTO mem_entity(scope, name, kind, ts, hits) VALUES (?, ?, 'entity', ?, 1)
     ON CONFLICT(scope, name) DO UPDATE SET hits = COALESCE(mem_entity.hits, 0) + 1, ts = excluded.ts`,
  );
  const insTag = h.db.prepare('INSERT OR IGNORE INTO mem_tag(scope, name, mem_id) VALUES (?, ?, ?)');
  const ts = Number(it.ts) || Date.now();
  for (const name of entities) {
    insEnt.run(scope, name, ts);
    insTag.run(scope, name, it.id);
  }
  const insEdge = h.db.prepare(
    `INSERT OR IGNORE INTO mem_edge(scope, src, rel, dst, mem_id, ts, valid_from, status, src_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  );
  for (const e of edges) {
    insEdge.run(scope, e.src, e.rel, e.dst, it.id, ts, ts, String(it.src || 'rule'));
    // 冲突消解：单值关系（是/住在/叫…）出现新值时，旧值标记失效而不是删掉
    invalidateEdgeConflicts(h, scope, e, it.id, ts);
  }
}

/**
 * 外部补边（本地模型抽出来的三元组走这里）。
 * 与入库时同一套冲突消解，保证"模型抽的关系"和"规则抽的关系"地位一致。
 */
export function addEdges(dataRoot, scope, memId, edgeList, opt = {}) {
  const h = handle(dataRoot);
  const sc = String(scope || '');
  const ts = Number(opt.ts) || Date.now();
  const kind = String(opt.srcKind || 'llm');
  const list = Array.isArray(edgeList) ? edgeList : [];
  const insEdge = h.db.prepare(
    `INSERT OR IGNORE INTO mem_edge(scope, src, rel, dst, mem_id, ts, valid_from, status, src_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  );
  let added = 0;
  let superseded = 0;
  for (const e of list) {
    const src = trimName(e?.src);
    const dst = trimName(e?.dst);
    const rel = trimName(e?.rel);
    if (!src || !dst || !rel || src === dst) continue;
    try {
      const r = insEdge.run(sc, src, rel, dst, String(memId), ts, ts, kind);
      if (Number(r.changes) > 0) added += 1;
      superseded += invalidateEdgeConflicts(h, sc, { src, rel, dst }, String(memId), ts);
    } catch { /* 单条失败不影响其它 */ }
  }
  return { ok: true, added, superseded };
}

/**
 * 单值关系（一个人只有一个"现任群主"、一个"真名"、一个"住处"…）。
 * 只有这类关系才做失效；"喜欢"这种多值关系不能因为说了新对象就把旧的作废。
 */
const FUNCTIONAL_REL_RE = /^(是|叫|名|名字|真名|住在?|在|位于|属于|负责|管理|当|担任|群主|管理员|家长|年龄|生日|工作|职业|学校|公司|手机|电话|qq|微信号?)$/i;

/**
 * 新事实让旧事实失效：
 *   同一 scope 下 src+rel 相同、dst 不同、仍在有效期内的边 → valid_to = 新事实时间、
 *   status = 'superseded'、superseded_by = 新记忆 id。
 * 这样"她改了群规/换了工作"这类变化能被检索层感知，同时又保留了历史（可追溯她为什么改口）。
 */
function invalidateEdgeConflicts(h, scope, edge, memId, ts) {
  const rel = String(edge.rel || '');
  if (!FUNCTIONAL_REL_RE.test(rel)) return 0;
  try {
    const r = h.db.prepare(
      `UPDATE mem_edge
          SET status = 'superseded', valid_to = ?, superseded_by = ?
        WHERE scope = ? AND src = ? AND rel = ? AND dst <> ?
          AND COALESCE(status, 'active') = 'active'
          AND COALESCE(valid_from, ts) <= ?`,
    ).run(Number(ts) || Date.now(), String(memId), scope, String(edge.src), rel, String(edge.dst), Number(ts) || Date.now());
    return Number(r?.changes) || 0;
  } catch {
    return 0;
  }
}

function insertItem(h, scope, it, ignoreExisting = false) {
  const verb = ignoreExisting ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
  const r = h.db.prepare(
    `${verb} INTO mem(id, scope, kind, subj, text, vec, ts, hits, last_hit, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    String(it.id), String(scope), String(it.kind || 'fact'), String(it.subj || ''), encText(h, it.text),
    vecToBlob(it.vec), Number(it.ts) || Date.now(), Number(it.hits) || 0, Number(it.lastHit) || 0, String(it.src || ''),
  );
  if (r.changes > 0) {
    clearIndexRows(h, scope, String(it.id));
    try { indexMemory(h, scope, it); } catch (e) { noteIndexError(e); }
  }
  // 加密态不写 FTS：FTS5 会把原文明文落盘，等于白加密
  if (r.changes > 0 && h.fts && !h.encOn) {
    try {
      h.db.prepare('DELETE FROM mem_fts WHERE id = ?').run(String(it.id));
      h.db.prepare('INSERT INTO mem_fts(id, scope, text) VALUES (?, ?, ?)')
        .run(String(it.id), String(scope), String(it.text || ''));
    } catch { /* 索引失败不影响主表 */ }
  }
  return r.changes > 0;
}

function deleteIds(h, ids, scope = '') {
  if (!ids || ids.length === 0) return 0;
  const del = h.db.prepare('DELETE FROM mem WHERE id = ?');
  const delFts = h.fts ? h.db.prepare('DELETE FROM mem_fts WHERE id = ?') : null;
  // 跨 scope 删除（forgetAnywhere）拿不到 scope，就按 id 现查一次
  const getScope = h.db.prepare('SELECT scope FROM mem WHERE id = ?');
  let n = 0;
  h.db.exec('BEGIN');
  try {
    for (const id of ids) {
      const sc = String(scope || '') || String(getScope.get(String(id))?.scope || '');
      n += del.run(String(id)).changes || 0;
      if (sc) clearIndexRows(h, sc, String(id));
      if (delFts) { try { delFts.run(String(id)); } catch { /* ignore */ } }
    }
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return n;
}

// ── 索引补建 / 巩固 ─────────────────────────────────────────────────────
// v2：倒排表新增中文单字键（补复述型问句的召回）。版本号一变，
// 老库会在下次召回时整体重建索引——不这么做，旧库只有二元组，单字通道永远空。
const indexFlag = (scope) => 'index_v2:' + String(scope || 'unknown');

/** 老库（索引表上线前写入的记忆）首次检索前补一遍倒排/实体索引。每个 scope 只做一次。 */
function ensureIndexed(h, scope, cfg = CONFIG) {
  try {
    if (getMeta(h, indexFlag(scope))) return;
    const rows = h.db.prepare('SELECT * FROM mem WHERE scope = ?').all(String(scope || 'unknown'));
    h.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const it = rowToItem(r, h);
        clearIndexRows(h, String(scope), String(it.id));
        indexMemory(h, String(scope), it);
      }
      h.db.exec('COMMIT');
    } catch (e) {
      try { h.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    setMeta(h, indexFlag(scope), String(Date.now()));
  } catch { /* 补建失败不致命：召回会退回全表向量扫描 */ }
}

/**
 * 巩固（运维/面板/测试用）：重建某个 scope 的全部索引，并返回实体/关系规模。
 * 在线路径不需要手动调用 —— 新记忆写入时就已增量索引，这是给老库和排障留的入口。
 */
export function consolidate(dataRoot, scope) {
  try {
    const h = handle(dataRoot);
    const sc = String(scope || 'unknown');
    const rows = h.db.prepare('SELECT * FROM mem WHERE scope = ?').all(sc);
    h.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const it = rowToItem(r, h);
        clearIndexRows(h, sc, String(it.id));
        indexMemory(h, sc, it);
      }
      h.db.exec('COMMIT');
    } catch (e) {
      try { h.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    setMeta(h, indexFlag(sc), String(Date.now()));
    const ent = Number(h.db.prepare('SELECT COUNT(*) AS n FROM mem_entity WHERE scope = ?').get(sc)?.n) || 0;
    const edge = Number(h.db.prepare('SELECT COUNT(*) AS n FROM mem_edge WHERE scope = ?').get(sc)?.n) || 0;
    const tok = Number(h.db.prepare('SELECT COUNT(*) AS n FROM mem_tok WHERE scope = ?').get(sc)?.n) || 0;
    return { ok: true, scope: sc, memories: rows.length, entities: ent, edges: edge, tokens: tok };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 实体/关系图（面板/调试）：返回实体与三元组，按热度截断。 */
export function entityGraph(dataRoot, scope, { limit = 50 } = {}) {
  try {
    const h = handle(dataRoot);
    const sc = String(scope || 'unknown');
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const entities = h.db.prepare(
      'SELECT name, COALESCE(hits, 0) AS hits, ts FROM mem_entity WHERE scope = ? ORDER BY COALESCE(hits, 0) DESC, ts DESC LIMIT ?',
    ).all(sc, lim).map((r) => ({ name: r.name, hits: Number(r.hits) || 0, ts: Number(r.ts) || 0 }));
    const edges = h.db.prepare(
      'SELECT src, rel, dst, mem_id, ts FROM mem_edge WHERE scope = ? ORDER BY ts DESC LIMIT ?',
    ).all(sc, lim).map((r) => ({
      src: r.src, rel: r.rel, dst: r.dst, memId: r.mem_id, ts: Number(r.ts) || 0,
    }));
    return { ok: true, scope: sc, entities, edges };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), entities: [], edges: [] };
  }
}

// ── 读写（与 core 同名同签名）────────────────────────────────────────────
export function loadMemories(dataRoot, scope, cfg = CONFIG) {
  try {
    const h = handle(dataRoot);
    const rows = h.db.prepare('SELECT * FROM mem WHERE scope = ? ORDER BY ts ASC, rowid ASC').all(String(scope || 'unknown'));
    return rows.map((r) => rowToItem(r, h));
  } catch { return []; /* 读不了就当空，绝不打断聊天 */ }
}

/**
 * 记一条。返回 { ok, reason, id }。
 * kind: fact（事实）/ event（事件）/ preference（偏好）/ relation（关系）
 *
 * ★ 2026-10-23 修两处真问题（用户反馈"长期记忆数据库估计有问题"，实测坐实）：
 *   ① 存进去的正文带着 `<@OPENID>` 这类平台标记 —— 既污染 embedding（召回变差），
 *      注入上下文时又白占长度。所以入库前统一洗掉。
 *   ② 同一条消息被存了两次（1792715992151 / 1792715992158 这种同秒重复）：
 *      remember 里"先向量去重、再插入"之间隔着 await，两个并发调用会互相看不见。
 *      所以插入前再加一道**同步的原文等值检查**（check 与 insert 之间没有 await，
 *      在 Node 单线程里不可能交错），把并发重复堵死。
 */
export function cleanMemText(text) {
  return String(text || '')
    .replace(/<@[^>]*>/g, '')                       // @某人 的平台标记
    .replace(/<qqbot-at-everyone\s*\/?>/gi, '@全体成员')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[ \u3000]{2,}/g, ' ')
    .trim();
}

export async function remember(dataRoot, scope, { text, kind = 'fact', subj = '' } = {}, cfg = CONFIG) {
  const t = cleanMemText(text).slice(0, 300);
  if (t.length < 2) return { ok: false, reason: 'too-short' };

  const h = handle(dataRoot);
  const items = loadMemories(dataRoot, scope, cfg);
  const [vec] = await embedMany(dataRoot, [t], cfg, false);

  // 去重：与已有记忆比相似度
  for (const it of items) {
    const c = cos(vec, it.vec);
    if (c >= cfg.dedupeCos) {
      h.db.prepare('UPDATE mem SET hits = COALESCE(hits, 0) + 1, last_hit = ? WHERE id = ?').run(Date.now(), it.id);
      return { ok: true, reason: 'deduped', id: it.id, cos: c };
    }
  }

  // 并发兜底：原文完全相同就算重复（同步段，无 await 穿插）。
  // 加密态下每条密文 IV 不同，等值比对永远不中——跳过它，向量去重仍在。
  if (!h.encOn) try {
    const dup = h.db.prepare('SELECT id FROM mem WHERE scope = ? AND text = ? LIMIT 1').get(String(scope || 'unknown'), t);
    if (dup && dup.id) {
      h.db.prepare('UPDATE mem SET hits = COALESCE(hits, 0) + 1, last_hit = ? WHERE id = ?').run(Date.now(), dup.id);
      return { ok: true, reason: 'deduped-text', id: dup.id };
    }
  } catch { /* 老库没有该列组合也不影响插入 */ }

  const entry = {
    id: newId(), ts: Date.now(), kind, text: t, subj: String(subj || ''),
    vec, hits: 0, lastHit: 0, src: '',
  };
  insertItem(h, scope, entry);
  trimScope(h, scope, cfg);
  return { ok: true, reason: 'added', id: entry.id };
}

/** 超容量：按 hits*新鲜度 从低到高淘汰（等价于 core 的 sort+truncate） */
function trimScope(h, scope, cfg) {
  const cap = Math.max(1, Number(cfg.cap) || DEFAULTS.cap);
  // 学习心得/成长心得不参与容量淘汰（主人 2026-10-26）：这是她自己长出来的东西，
  // 被静默删掉等于否定自我学习。超 cap 时优先淘汰别的 kind（信条另有文件，不在这）。
  const rows = h.db.prepare(
    "SELECT id, hits, ts FROM mem WHERE scope = ? AND kind NOT IN ('insight','growth')",
  ).all(String(scope || 'unknown'));
  if (rows.length <= cap) return 0;
  const hl = Number(cfg.halfLifeDays) || DEFAULTS.halfLifeDays;
  const scored = rows.map((r) => ({ id: r.id, s: (Number(r.hits) || 0) * recency(Number(r.ts), hl) }));
  scored.sort((a, b) => b.s - a.s);
  return deleteIds(h, scored.slice(cap).map((x) => x.id), String(scope || 'unknown'));
}

/** 删一条 */
export function forget(dataRoot, scope, id, cfg = CONFIG) {
  try {
    const h = handle(dataRoot);
    const n = deleteIds(h, [id], String(scope || ''));
    if (n > 0) audit(dataRoot, { action: 'forget', scope: String(scope || ''), count: 1, note: String(id).slice(0, 60) });
    return n > 0;
  } catch { return false; }
}

// ── 召回 ────────────────────────────────────────────────────────────────
/**
 * 给当前消息召回 topK 条记忆。返回 [{ id, text, kind, ts, cos, score }]。
 *
 * ★ 2026-10-23 修召回质量（真机实测：每句查询的 4 个名额全被同 3 条中层摘要占满，
 *   175 条真实事件一次都没被想起）★
 *   原因：中层摘要是"整段历史向量的质心"，它对**任何**查询的余弦都在 0.5 左右，
 *   天生比真实事件（相关时 0.45~0.65，不相关 <0.3）更"稳定地高"。
 *   所以给 kind 加权重：summary 扣分、她自己的话/事件/承诺加分；
 *   并且**最多只留 1 条摘要**，把名额让给真实记忆。weightOf() 导出让测试可断言。
 */
const KIND_WEIGHT = {
  summary: -0.12,
  digest: -0.12,
  event: 0.03,
  say: 0.05,
  promise: 0.06,
  fact: 0.04,
  preference: 0.04,
  relation: 0.04,
};

export function weightOf(kind) {
  const k = String(kind || '');
  return Object.prototype.hasOwnProperty.call(KIND_WEIGHT, k) ? KIND_WEIGHT[k] : 0;
}

export async function recall(dataRoot, scope, queryText, cfg = CONFIG) {
  const q = String(queryText || '').trim();
  if (q.length < 2) return [];
  const h = handle(dataRoot);
  const sc = String(scope || 'unknown');
  const total = Number(h.db.prepare('SELECT COUNT(*) AS n FROM mem WHERE scope = ?').get(sc)?.n) || 0;
  if (total === 0) return [];

  const [qvec] = await embedMany(dataRoot, [q], cfg, true);

  // ── ① 关键词候选：倒排表 mem_tok（纯 SQL，不算向量）──
  //   二元组是主证据（权重 1.0），单字只用来"补召回"（权重 0.3）：
  //   单字同现太常见，给满权重会把不相干的条目顶上来；但完全没有它，
  //   复述型问句（"你说过要教我什么"）会一条都挂不上。
  ensureIndexed(h, sc, cfg);
  const qToks = tokensOf(q).slice(0, 96);
  const kwScore = new Map();
  // 强词面证据（二元组 / ASCII 词）另记一份：只有它能当"免检凭证"。
  // 单字太廉价——「子」「学」这种字能把一半的库拉进来，所以它只参与排序，不负责开门。
  const kwStrong = new Map();
  if (qToks.length) {
    try {
      const ph = qToks.map(() => '?').join(',');
      const rows = h.db.prepare(`SELECT mem_id, tok, tf FROM mem_tok WHERE scope = ? AND tok IN (${ph})`).all(sc, ...qToks);
      for (const r of rows) {
        const isUni = String(r.tok).startsWith(UNI);
        // 单字权重低：它是"补召回"的，不该把不相干条目顶到前面，但必须能挂上
        const hit = 1 + Math.log1p(Number(r.tf) || 1);
        kwScore.set(r.mem_id, (kwScore.get(r.mem_id) || 0) + (isUni ? 0.3 : 1) * hit);
        if (!isUni) kwStrong.set(r.mem_id, (kwStrong.get(r.mem_id) || 0) + hit);
      }
    } catch { /* 没有倒排表就退化成全表扫描 */ }
  }

  // ── ② 实体锚定 + 1 跳关系扩散（海马体那一层的"先锚定、再扩散"）──
  const entScore = anchorCandidates(h, sc, q);

  // ── ②b 图谱随机游走（PPR）：顺着"甲→乙→丙"找到字面没命中、但确实沾边的记忆 ──
  //  只在前两路太弱时才跑，正常对话不多花这一趟（沿边扩散比纯 SQL 贵得多）。
  let pprScore = new Map();
  // 环境变量关掉图谱通道（排查"某条召回是不是被图拉进来的"用；也方便对照实验）
  const pprSwitch = String(process.env.QQBOT_MEM_PPR || '').trim();
  if (pprSwitch !== '0' && Number(cfg.graphPpr ?? 1) !== 0) {
    const weak = kwScore.size + entScore.size < Math.max(3, cfg.recallTopK || 4);
    if (weak || cfg.graphPpr === 'always') {
      try { pprScore = pprCandidates(h, sc, q, { ...(cfg.graphPprOpt || {}) }); } catch { pprScore = new Map(); }
    }
  }

  // ── ②c 回溯型问句：「你还记得你说过要教我什么」「你答应过我什么」──
  //   这类问题的目标不是"话题"，而是**她自己说过的话**（自述/承诺）。
  //   按话题匹配只会撞上「明天记得带伞」这种字面噪声，于是单独开一路：
  //   命中句式就把最近的 say / promise 提上来，谁新谁靠前。
  const intentScore = recallIntentOf(q) ? recentByKind(h, sc, ['say', 'promise'], 8) : new Map();

  // ── ③ 候选集合：够多就只算这些的向量；太少就退回全表（保证语义召回不丢）──
  //  注意：是否"够多"只看关键词/实体两路（与加 PPR 之前完全同口径），
  //  否则候选池会被图谱通道撑大，反而把整表扫描的分支切掉、丢掉本该召回的记忆。
  const core = new Set([...kwScore.keys(), ...entScore.keys(), ...intentScore.keys()]);
  const cand = new Set([...core, ...pprScore.keys()]);
  const minCand = Math.max(8, Math.min(64, Number(cfg.recallCandidates) || 24));
  let rows = [];
  if (core.size >= Math.min(minCand, total)) {
    const ids = Array.from(cand).slice(0, 300);
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      rows.push(...h.db.prepare(
        `SELECT * FROM mem WHERE scope = ? AND id IN (${chunk.map(() => '?').join(',')})`,
      ).all(sc, ...chunk));
    }
  } else {
    rows = h.db.prepare('SELECT * FROM mem WHERE scope = ?').all(sc);
  }

  // ── ④ 只有候选才做余弦（这是"低耗"的关键：全表向量扫描换成几十条）──
  const entries = [];
  const lexicalMode = _embedderMode === 'lexical';
  // lexical 模式下 effectiveMinCos 返回 null：不看余弦，只看证据
  const minCos = effectiveMinCos(cfg);
  for (const r of rows) {
    const it = rowToItem(r, h);
    const c = cos(qvec, it.vec);
    // 自匹配护栏：与查询几乎逐字相同的条目不算"历史记忆"（那是刚刚这句话自己）。
    if (c > 0.98) continue;
    const ppr = pprScore.get(it.id) || 0;
    const kw = kwScore.get(it.id) || 0;
    const ent = entScore.get(it.id) || 0;
    const intent = intentScore.get(it.id) || 0;
    // 证据通道：强词面（二元组 / ASCII 词）、实体锚定、图谱游走、回溯意图。
    // 单字同现不算证据——「子」「学」这种字连「量子力学」都能和「杯子」凑上。
    const proof = (kwStrong.get(it.id) || 0) > 0 || ent > 0 || ppr >= 0.2 || intent > 0;
    if (lexicalMode) {
      // 词频模式：余弦没有判别力（见 effectiveMinCos 的注释），无证据直接丢
      if (!proof) continue;
    } else if (c < minCos && intent <= 0) {
      // 语义模式：余弦门槛挡噪声；但回溯意图通道（"你还记得你说过…"）捞上来的
      // 最近自述/承诺不能被门槛滤掉——这类问句与原话的余弦天然只有 0.1~0.4。
      continue;
    }
    entries.push({
      it, cos: c,
      // 语义模式：余弦当底座；词频模式：底座由证据强度决定，否则噪声的 0.15 会压过真命中的 0.05
      base: lexicalMode
        ? Math.max(0, Math.min(1.2, kw * 0.22) + (ent > 0 ? 0.3 : 0) + ppr * 0.3
          + (intent > 0 ? 0.5 : 0) + weightOf(it.kind))
        : Math.max(0, c + weightOf(it.kind)),
      kw, ent, ppr, intent,
    });
  }

  // ── ⑤ 多路 RRF 融合：语义 / 关键词 / 实体 / 图谱游走 / 回溯意图，
  //      各排一次名，按倒数排名相加 ──
  const ranksOf = (key) => {
    const s = entries.filter((x) => x[key] > 0).sort((a, b) => b[key] - a[key]);
    const m = new Map();
    s.forEach((x, i) => m.set(x.it.id, i + 1));
    return m;
  };
  const rVec = ranksOf('base');
  const rKw = ranksOf('kw');
  const rEnt = ranksOf('ent');
  const rPpr = ranksOf('ppr');
  const rInt = ranksOf('intent');
  const RRF_K = 60;
  for (const x of entries) {
    let fused = 0;
    for (const m of [rVec, rKw, rEnt, rPpr, rInt]) {
      const r = m.get(x.it.id);
      if (r) fused += 1 / (RRF_K + r);
    }
    // 乘回时间衰减 / 命中热度，×100 只是让数值好读。
    // 命中热度改成**次线性封顶**（最高 1.3×）：早先是 (1 + 0.1*min(hits,5))，满额 1.5×，
    // 而 RRF 里"排名差一位"只差约 1.6% —— 结果热门旧记忆会长期压住新鲜的字面精确命中。
    x.score = fused * 100
      * (0.5 + 0.5 * recency(x.it.ts, cfg.halfLifeDays))
      * (1 + 0.3 * (1 - 1 / (1 + Math.log1p(x.it.hits || 0))));
  }
  entries.sort((a, b) => b.score - a.score);

  // 名额分配：摘要最多 1 条（它只是"前情提要"，不该挤掉真实记忆）
  const top = [];
  let summaries = 0;
  const maxSummary = 1;
  for (const x of entries) {
    if (top.length >= cfg.recallTopK) break;
    const isSummary = /^(summary|digest)$/.test(String(x.it.kind || ''));
    if (isSummary) {
      if (summaries >= maxSummary) continue;
      summaries += 1;
    }
    top.push(x);
  }

  // 命中计数（不改 ts，只提升 hits —— 常被想起的更容易再被想起）
  if (top.length) {
    try {
      h.db.exec('BEGIN');
      try {
        const up = h.db.prepare('UPDATE mem SET hits = COALESCE(hits, 0) + 1, last_hit = ? WHERE id = ?');
        for (const x of top) up.run(Date.now(), x.it.id);
        h.db.exec('COMMIT');
      } catch (e) {
        try { h.db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
    } catch { /* 计量失败不影响召回 */ }
  }

  return top.map((x) => ({
    id: x.it.id, text: x.it.text, kind: x.it.kind, ts: x.it.ts,
    cos: x.cos, score: x.score, kw: x.kw, ent: x.ent, ppr: x.ppr || 0, intent: x.intent || 0,
    // 面板/排查用：这条召回是在哪套向量后端下算的。
    // lexical 表示向量模型不可用、走了词频回退——此时的 cos 不能当作语义相似度来解释。
    vecMode: lexicalMode ? 'lexical' : _embedderMode,
  }));
}

/**
 * 实体锚定：查「查询里出现的实体」→ 直接挂到记忆；再沿三元组走 1 跳拿邻居实体。
 * 返回 Map(mem_id → 分数)。纯 SQL，失败就返回空（退回纯向量召回）。
 */
function anchorCandidates(h, scope, q) {
  const out = new Map();
  let anchors = [];
  try {
    anchors = h.db.prepare(
      'SELECT name FROM mem_entity WHERE scope = ? AND instr(?, name) > 0 ORDER BY COALESCE(hits, 0) DESC LIMIT 6',
    ).all(scope, q);
  } catch { return out; }
  if (anchors.length === 0) return out;

  const tagIds = h.db.prepare('SELECT mem_id FROM mem_tag WHERE scope = ? AND name = ?');
  const neighbors = new Set();
  for (const a of anchors) {
    for (const r of tagIds.all(scope, a.name)) out.set(r.mem_id, (out.get(r.mem_id) || 0) + 1);
    try {
      // 只走还在有效期内的边：被取代的旧关系不该再把记忆拉进来
      const nb = h.db.prepare(
        `SELECT dst AS n FROM mem_edge WHERE scope = ? AND src = ? AND COALESCE(status, 'active') = 'active'
         UNION SELECT src AS n FROM mem_edge WHERE scope = ? AND dst = ? AND COALESCE(status, 'active') = 'active'`,
      ).all(scope, a.name, scope, a.name);
      for (const r of nb) if (r.n && r.n !== a.name) neighbors.add(r.n);
    } catch { /* ignore */ }
  }
  for (const n of neighbors) {
    for (const r of tagIds.all(scope, n)) out.set(r.mem_id, (out.get(r.mem_id) || 0) + 0.5);
  }
  return out;
}

// ── 图谱检索：Personalized PageRank（HippoRAG 那一层）───────────────────
/** 载入 scope 内的活跃边，构建无向邻接表（关系扩散两个方向都算） */
function loadActiveGraph(h, scope, limit = 8000) {
  const adj = new Map();
  let rows = [];
  try {
    rows = h.db.prepare(
      `SELECT src, rel, dst FROM mem_edge
        WHERE scope = ? AND COALESCE(status, 'active') = 'active'
        ORDER BY ts DESC LIMIT ?`,
    ).all(scope, limit);
  } catch {
    return adj;
  }
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const r of rows) {
    add(r.src, r.dst);
    add(r.dst, r.src);
  }
  return adj;
}

/**
 * 带重启的随机游走（PPR）：从查询命中的实体出发，按边等权扩散，
 * 每次以 (1-阻尼) 概率跳回种子。收敛后的节点质量 ≈ "跟这个问题有多近"。
 * 相比 1 跳扩散，能顺着 A→B→C 找到"没被字面命中、但语义上沾边"的记忆。
 */
export function personalizedPageRank(adj, seeds, opt = {}) {
  const damping = Math.max(0.1, Math.min(0.95, Number(opt.damping) || 0.85));
  const iters = Math.max(1, Math.min(40, Number(opt.iters) || 12));
  const nodes = Array.from(adj.keys());
  if (!nodes.length) return new Map();
  const alive = new Set(nodes);
  const seedList = Array.from(new Set(seeds)).filter((s) => alive.has(s));
  if (!seedList.length) return new Map();

  const per = 1 / seedList.length;
  const personal = new Map(seedList.map((s) => [s, per]));
  let x = new Map(nodes.map((n) => [n, personal.get(n) || 0]));
  for (let k = 0; k < iters; k += 1) {
    const nx = new Map(nodes.map((n) => [n, (1 - damping) * (personal.get(n) || 0)]));
    let dangling = 0;
    for (const n of nodes) {
      const v = x.get(n) || 0;
      if (v <= 1e-12) continue;
      const nb = adj.get(n) || [];
      if (!nb.length) { dangling += v; continue; }
      const share = (damping * v) / nb.length;
      for (const m of nb) nx.set(m, (nx.get(m) || 0) + share);
    }
    // 悬挂节点的质量按个性化向量补回去，否则整体质量会一点点漏光
    if (dangling > 0) {
      for (const s of seedList) nx.set(s, (nx.get(s) || 0) + damping * dangling * per);
    }
    x = nx;
  }
  return x;
}

/**
 * PPR 检索通道：种子 = 查询里出现的实体；把收敛质量摊到各实体挂着的记忆上。
 * 返回 Map(mem_id → 0..1)。任何异常都返回空（退回原有三路）。
 */
/**
 * 回溯型问句：用户要的是"她自己说过/答应过什么"，不是某个话题。
 *
 * 这些句式的共同点是——里面的实词（记得/说过/上次）指向的是"检索动作"，
 * 而不是内容。按普通话题匹配，它们反而会精确命中无关里的同形词
 * （「你还记得…」↔「明天记得带伞」）。所以识别出来走单独一路。
 */
const RECALL_INTENT = /(?:你还?记得|你还?记不记得|你说过|你讲过|你提过|你答应|答应过我|你上次|上次(?:说|讲|提)|之前(?:说|讲|提)|我们聊过|跟你说过|你承诺)/;

function recallIntentOf(q) {
  return RECALL_INTENT.test(String(q || ''));
}

/**
 * 取某几类记忆里最近的 N 条（回溯通道用）。
 * 权重按新到旧线性递减：回溯问句问的是"最近说过什么"，越新越该排前面。
 */
function recentByKind(h, scope, kinds, limit = 8) {
  const out = new Map();
  const list = Array.isArray(kinds) ? kinds.filter(Boolean) : [];
  if (!list.length) return out;
  try {
    const ph = list.map(() => '?').join(',');
    const rows = h.db.prepare(
      `SELECT id FROM mem WHERE scope = ? AND kind IN (${ph}) ORDER BY ts DESC LIMIT ?`,
    ).all(String(scope), ...list, Math.max(1, Math.min(30, limit)));
    rows.forEach((r, i) => out.set(r.id, 1 - i / (rows.length + 1)));
  } catch { /* 查询失败就当没有这一路 */ }
  return out;
}

function pprCandidates(h, scope, q, opt = {}) {
  const out = new Map();
  let seeds = [];
  try {
    seeds = h.db.prepare(
      'SELECT name FROM mem_entity WHERE scope = ? AND instr(?, name) > 0 ORDER BY COALESCE(hits, 0) DESC LIMIT 6',
    ).all(scope, q).map((r) => r.name);
  } catch {
    return out;
  }
  if (!seeds.length) return out;

  const adj = loadActiveGraph(h, scope, Math.max(100, Math.min(20000, Number(opt.maxEdges) || 8000)));
  if (!adj.size) return out;
  const mass = personalizedPageRank(adj, seeds, opt);
  if (!mass.size) return out;

  let max = 0;
  for (const v of mass.values()) if (v > max) max = v;
  if (max <= 0) return out;

  const floor = Number(opt.pprFloor) || 0.02;
  const names = [];
  for (const [name, v] of mass) if (v / max >= floor) names.push(name);
  if (!names.length) return out;
  names.sort((a, b) => (mass.get(b) || 0) - (mass.get(a) || 0));
  const picked = names.slice(0, 120);

  for (let i = 0; i < picked.length; i += 80) {
    const chunk = picked.slice(i, i + 80);
    try {
      const rows = h.db.prepare(
        `SELECT name, mem_id FROM mem_tag WHERE scope = ? AND name IN (${chunk.map(() => '?').join(',')})`,
      ).all(scope, ...chunk);
      for (const r of rows) {
        const w = (mass.get(r.name) || 0) / max;
        if (w >= floor) out.set(r.mem_id, Math.max(out.get(r.mem_id) || 0, w));
      }
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * 某个人的画像（来自历史聊天记录导入）。
 *
 * 为什么单独一个出口：
 *   导入的历史记录按 `person:qq:<号>` 分 scope 落库，运行时召回用的是
 *   `group:<id>` / `c2c:<id>` —— 两者本来就不通，所以导入出来的"印象"如果不
 *   单独取，就永远是死数据。这个函数只读**这一个**人的 scope，不做跨人聚合，
 *   天然满足"A 的画像不会出现在 B 的上下文里"。
 *
 * @param {string} dataRoot
 * @param {string} senderId 运行时的人物标识（QQ 号 / openid）
 * @returns {{ok:boolean, scope:string, impression:string, say:number, first:number, last:number}}
 */
export function personProfile(dataRoot, senderId) {
  const empty = { ok: false, scope: '', impression: '', say: 0, first: 0, last: 0 };
  const raw = String(senderId || '').trim();
  if (!raw) return empty;
  // 只认两种明确形态：直接给 QQ 号，或已经带上 person: 前缀的完整 scope。
  // 不做"模糊匹配昵称"——昵称重名会把两个人的历史串到一起。
  const scope = raw.startsWith('person:') ? raw : `person:qq:${raw}`;
  let h;
  try { h = handle(dataRoot); } catch { return empty; }
  try {
    const row = h.db.prepare(
      'SELECT text, ts FROM mem WHERE scope = ? AND kind = ? ORDER BY ts DESC LIMIT 1',
    ).get(scope, 'impression');
    if (!row || !row.text) return empty;
    const agg = h.db.prepare(
      'SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM mem WHERE scope = ?',
    ).get(scope) || {};
    return {
      ok: true,
      scope,
      impression: cleanMemText(decText(h, row.text)),
      say: Number(agg.n) || 0,
      first: Number(agg.first) || 0,
      last: Number(agg.last) || 0,
    };
  } catch {
    return empty;
  }
}

/** 把召回结果拼成注入块（≤ recallMaxChars 字）——与 core 逐字一致 */
export function formatRecallBlock(hits, cfg = CONFIG) {
  if (!hits || hits.length === 0) return '';
  const lines = [];
  let used = 0;
  for (const h of hits) {
    const line = `${lines.length + 1}. ${h.text}`;
    if (used + line.length > cfg.recallMaxChars) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '';
  return `\n[记忆]\n${lines.join('\n')}\n[/记忆]`;
}

// ── 时序图谱：可追溯的"她什么时候改的口" ────────────────────────────────
/** 当前仍然成立的邻居（只走 active 边）——面板/调试用，也可断言"失效后不再扩散" */
export function liveNeighbors(dataRoot, scope, name) {
  const h = handle(dataRoot);
  try {
    return h.db.prepare(
      `SELECT dst AS name, rel, ts FROM mem_edge
        WHERE scope = ? AND src = ? AND COALESCE(status, 'active') = 'active'
        UNION
       SELECT src AS name, rel, ts FROM mem_edge
        WHERE scope = ? AND dst = ? AND COALESCE(status, 'active') = 'active'
        ORDER BY ts ASC`,
    ).all(String(scope), String(name), String(scope), String(name))
      .map((r) => ({ name: r.name, rel: r.rel, ts: Number(r.ts) || 0 }));
  } catch {
    return [];
  }
}

/**
 * 某条关系的变化史：谁在什么时候取代了谁。
 * 这是"冲突消解"能解释的前提——她改口以后还能说清"以前是群主，现在是管理员"。
 */
export function edgeHistory(dataRoot, scope, src, rel) {
  const h = handle(dataRoot);
  try {
    return h.db.prepare(
      `SELECT src, rel, dst, mem_id, ts, valid_from, valid_to, status, superseded_by
         FROM mem_edge WHERE scope = ? AND src = ? AND rel = ?
        ORDER BY COALESCE(valid_from, ts) ASC`,
    ).all(String(scope), String(src), String(rel))
      .map((r) => ({
        src: r.src, rel: r.rel, dst: r.dst, memId: r.mem_id, ts: Number(r.ts) || 0,
        validFrom: Number(r.valid_from || r.ts) || 0,
        validTo: r.valid_to === null || r.valid_to === undefined ? null : Number(r.valid_to),
        status: r.status || 'active',
        supersededBy: r.superseded_by || '',
      }));
  } catch {
    return [];
  }
}

// ── 数据主权：导出 / 彻底删除 / 审计 ────────────────────────────────────
/** 审计日志：谁在什么时候动了哪个 scope 的什么（只追加，永不回改） */
export function auditFile(dataRoot) {
  return join(rootOf(dataRoot), '.qqbot', 'memory', '_audit.jsonl');
}

export function audit(dataRoot, entry = {}) {
  try {
    const file = auditFile(dataRoot);
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify({
      at: Date.now(),
      action: String(entry.action || ''),
      scope: String(entry.scope || ''),
      actor: String(entry.actor || 'local'),
      count: Number(entry.count) || 0,
      note: String(entry.note || '').slice(0, 200),
    }) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 读审计日志（最近 n 条） */
export function readAudit(dataRoot, limit = 50) {
  try {
    const lines = readFileSync(auditFile(dataRoot), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, limit)).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 导出某个 scope 的全量记忆（给用户"带走自己的数据"）。
 * 不含向量（那是内部索引，且体积大）；给出纯文本 + 元信息。
 */
export function exportScope(dataRoot, scope) {
  const sc = String(scope || '');
  const h = handle(dataRoot);
  const memories = [];
  try {
    for (const r of h.db.prepare(
      'SELECT id, kind, subj, text, ts, hits, last_hit, src FROM mem WHERE scope = ? ORDER BY ts ASC',
    ).all(sc)) {
      memories.push({
        id: r.id, kind: r.kind, subj: r.subj, text: cleanMemText(decText(h, r.text)),
        ts: Number(r.ts) || 0, hits: Number(r.hits) || 0, src: r.src || '',
      });
    }
  } catch { /* ignore */ }
  const persona = [];
  try { persona.push(...getPersona(dataRoot, sc)); } catch { /* ignore */ }
  const edges = [];
  try {
    edges.push(...h.db.prepare(
      `SELECT src, rel, dst, ts, status, valid_from, valid_to FROM mem_edge WHERE scope = ? ORDER BY ts ASC`,
    ).all(sc).map((r) => ({
      src: r.src, rel: r.rel, dst: r.dst, ts: Number(r.ts) || 0,
      status: r.status || 'active',
      validFrom: Number(r.valid_from || r.ts) || 0,
      validTo: r.valid_to === null || r.valid_to === undefined ? null : Number(r.valid_to),
    })));
  } catch { /* ignore */ }
  const out = { scope: sc, exportedAt: Date.now(), total: memories.length, memories, persona, edges };
  audit(dataRoot, { action: 'export', scope: sc, count: memories.length });
  return out;
}

/**
 * 彻底删除某个 scope 的一切（含索引、画像、图谱）。
 * 与 forget 的区别：forget 是"忘掉某一条"，purge 是"这个人/这个群的东西全删掉"。
 * 用于"我不想让你再记得这个群"这类要求——必须真删，不能只隐藏。
 */
export function purgeScope(dataRoot, scope) {
  const sc = String(scope || '');
  const h = handle(dataRoot);
  const counts = {};
  const tables = [
    ['mem', 'scope'],
    ['persona', 'scope'],
    ['mem_tok', 'scope'],
    ['mem_tag', 'scope'],
    ['mem_edge', 'scope'],
    ['mem_entity', 'scope'],
    ['mem_gist', 'scope'],
    ['mem_link', 'scope'],
  ];
  for (const [t, col] of tables) {
    try {
      const n = Number(h.db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(sc).changes) || 0;
      counts[t] = n;
    } catch {
      counts[t] = 0;
    }
  }
  try {
    const ids = h.db.prepare('SELECT id FROM mem WHERE scope = ?').all(sc);
    for (const r of ids) { try { h.db.prepare('DELETE FROM mem_fts WHERE id = ?').run(r.id); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  // jsonl 老文件也一并清掉（否则重新迁移会把删掉的记忆又搬回来）
  try {
    const jf = join(memoryDir(dataRoot), sc.replace(/[^A-Za-z0-9_.-]/g, '_') + '.jsonl');
    if (existsSync(jf)) rmSync(jf, { force: true });
  } catch { /* ignore */ }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  audit(dataRoot, { action: 'purge', scope: sc, count: total });
  return { ok: true, scope: sc, deleted: counts, total };
}

/** 统计（给面板/调试用） */
export function stats(dataRoot, scope, cfg = CONFIG) {
  const items = loadMemories(dataRoot, scope, cfg);
  const byKind = {};
  for (const it of items) byKind[it.kind || '?'] = (byKind[it.kind || '?'] || 0) + 1;
  let persona = 0;
  try { persona = getPersona(dataRoot, scope).length; } catch { persona = 0; }
  let schema = null;
  try {
    const h = handle(dataRoot);
    schema = {
      version: h.schemaVersion || 0,
      expected: SCHEMA_VERSION,
      missing: h.schemaMissing || [],
      indexErrors: _indexErrors,
      lastIndexError: _lastIndexError,
    };
  } catch { /* 拿不到句柄就不报 schema */ }
  return {
    scope,
    total: items.length,
    byKind,
    persona,
    mode: _embedderMode,
    backend: 'sqlite',
    file: memoryFile(dataRoot, scope),
    schema,
  };
}

// ── 持久化：健康检查与维护 ──────────────────────────────────────────────
/**
 * 库健康快照。回答三个运维问题：
 *   1) 索引是不是真的建好了（缺表 / 倒排覆盖率不够都算不健康）；
 *   2) 文件是不是虚胖（freelist 占比高 = 该 VACUUM 了）；
 *   3) 完整性有没有问题。
 * 全部只读，不会改库，可以随时调。
 */
export function dbHealth(dataRoot) {
  const h = handle(dataRoot);
  const out = {
    ok: true, file: h.file,
    schemaVersion: h.schemaVersion || 0, expectedSchema: SCHEMA_VERSION,
    missing: h.schemaMissing || [], indexErrors: _indexErrors, lastIndexError: _lastIndexError,
    bytes: 0, pageCount: 0, freePages: 0, pageSize: 0, freeRatio: 0,
    journal: '', integrity: '', tables: {}, indexedMem: -1, scopes: [],
  };
  try { out.bytes = Number(statSync(h.file).size) || 0; } catch { /* 文件可能刚被移走 */ }
  const one = (sql) => { try { return h.db.prepare(sql).get() || null; } catch { return null; } };
  out.pageCount = Number(one('PRAGMA page_count')?.page_count) || 0;
  out.freePages = Number(one('PRAGMA freelist_count')?.freelist_count) || 0;
  out.pageSize = Number(one('PRAGMA page_size')?.page_size) || 0;
  out.journal = String(one('PRAGMA journal_mode')?.journal_mode || '');
  out.freeRatio = out.pageCount ? Math.round((out.freePages / out.pageCount) * 1000) / 1000 : 0;
  try { out.integrity = String(one('PRAGMA quick_check')?.quick_check || ''); } catch { out.integrity = 'error'; }
  const cnt = (t) => { try { return Number(h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n) || 0; } catch { return -1; }; };
  out.tables = {
    mem: cnt('mem'), chat: cnt('chat'), persona: cnt('persona'),
    mem_tok: cnt('mem_tok'), mem_entity: cnt('mem_entity'), mem_tag: cnt('mem_tag'), mem_edge: cnt('mem_edge'),
  };
  // 倒排覆盖率：有多少条 mem 在 mem_tok 里挂上了键。远小于 mem 行数 = 索引没建全。
  try { out.indexedMem = Number(h.db.prepare('SELECT COUNT(DISTINCT mem_id) AS n FROM mem_tok').get()?.n) || 0; } catch { out.indexedMem = -1; }
  try {
    out.scopes = h.db.prepare('SELECT scope, COUNT(*) AS n FROM mem GROUP BY scope ORDER BY n DESC LIMIT 20')
      .all().map((r) => ({ scope: String(r.scope || ''), n: Number(r.n) || 0 }));
  } catch { out.scopes = []; }
  // 一句话结论，省得每次都要人来解读
  const problems = [];
  if (out.missing.length) problems.push('缺表:' + out.missing.join('/'));
  if (out.integrity && out.integrity !== 'ok') problems.push('完整性:' + out.integrity);
  if (out.indexedMem === 0 && out.tables.mem > 0) problems.push('倒排未建（召回退化为全表扫描）');
  else if (out.indexedMem > 0 && out.tables.mem > 0 && out.indexedMem < out.tables.mem * 0.9) {
    problems.push(`倒排覆盖不全 ${out.indexedMem}/${out.tables.mem}`);
  }
  if (out.indexErrors) problems.push(`索引写失败 ${out.indexErrors} 次`);
  if (out.freeRatio > 0.25) problems.push('碎片率 ' + Math.round(out.freeRatio * 100) + '%（可 VACUUM）');
  out.verdict = problems.length ? problems.join('；') : 'healthy';
  out.healthy = problems.length === 0;
  return out;
}

/**
 * 定期维护。三件事，按代价从小到大：
 *   1) WAL 检查点：WAL 不 checkpoint 会一直长，备份时容易漏；
 *   2) VACUUM：prune 删掉的行只进 freelist，文件不会自己变小（只在碎片率高时才做）；
 *   3) 备份：VACUUM INTO 出一份一致的快照，只留最近 keep 份。
 * 记忆库是长期资产——一份能回滚的备份比任何清理都重要。
 */
export function maintainDb(dataRoot, opts = {}) {
  const root = rootOf(dataRoot);
  const h = handle(dataRoot);
  const rep = { ok: true, checkpoint: null, vacuum: false, reclaimed: 0, backup: '', kept: 0, reason: '' };
  try {
    const mode = String(h.db.prepare('PRAGMA journal_mode').get()?.journal_mode || '');
    if (mode === 'wal' && opts.checkpoint !== false) {
      rep.checkpoint = h.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || null;
    }
  } catch { /* 检查点失败不影响后续 */ }

  const health = opts.vacuum === 'auto' ? dbHealth(dataRoot) : null;
  const wantVacuum = opts.vacuum === true || (opts.vacuum === 'auto' && health && health.freeRatio > 0.25);
  if (wantVacuum) {
    try {
      const before = Number(statSync(h.file).size) || 0;
      h.db.exec('VACUUM');
      rep.vacuum = true;
      rep.reclaimed = Math.max(0, before - (Number(statSync(h.file).size) || 0));
    } catch (e) {
      rep.vacuum = false;
      rep.reason = 'vacuum-failed: ' + (e instanceof Error ? e.message : String(e));
    }
  }

  if (opts.backup !== false) {
    try {
      const dir = join(root, '.qqbot', 'backups');
      mkdirSync(dir, { recursive: true });
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const out = join(dir, `memory-${stamp}.db`);
      // VACUUM INTO 在 WAL 下也能拿到一致快照，比直接 cp 安全（cp 可能拿到撕裂的页）
      h.db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
      rep.backup = out;
      const keep = Math.max(1, Number(opts.keep) || 5);
      let files = [];
      try {
        files = readdirSync(dir).filter((f) => /^memory-\d{8}-\d{6}\.db$/.test(f)).sort();
      } catch { files = []; }
      while (files.length > keep) {
        const drop = files.shift();
        try { rmSync(join(dir, drop), { force: true }); } catch { /* 删不掉就留着 */ }
      }
      rep.kept = files.length;
    } catch (e) {
      rep.ok = false;
      rep.reason = (rep.reason ? rep.reason + '；' : '') + 'backup-failed: ' + (e instanceof Error ? e.message : String(e));
    }
  }

  // 索引自愈：缺表（老库/长跑进程）或倒排覆盖率不足时，把每个 scope 的索引重建一遍。
  // 这是"索引静默失效"的兜底——它坏了不会报错，只会让召回悄悄变差。
  if (opts.reindex) {
    try {
      const scopes = h.db.prepare('SELECT DISTINCT scope FROM mem').all().map((r) => String(r.scope || ''));
      rep.reindexed = [];
      for (const sc of scopes) {
        const r = consolidate(dataRoot, sc);
        rep.reindexed.push({ scope: sc, ok: !!r.ok, memories: r.memories || 0, tokens: r.tokens || 0, edges: r.edges || 0 });
      }
    } catch (e) {
      rep.reason = (rep.reason ? rep.reason + '；' : '') + 'reindex-failed: ' + (e instanceof Error ? e.message : String(e));
    }
  }
  return rep;
}

// ── 收件箱：解耦"工具不知道当前是哪个群"的问题 ──────────────────────────
/**
 * 工具（tool 扩展）拿不到"当前会话作用域"，所以只往**公共收件箱**写一行，
 * 入站扩展在下一条消息到来时并进**当前群**，然后清空。
 * 收件箱是"队列"不是"记忆"，所以仍然用 jsonl（写一次读一次删掉，简单可靠）。
 */
export function inboxFile(dataRoot) {
  return join(rootOf(dataRoot), '.qqbot', 'memory', '_inbox.jsonl');
}

export function pushInbox(dataRoot, { text, kind = 'fact', subj = ' ' } = {}) {
  const t = String(text || '').trim();
  if (t.length < 2) return { ok: false, reason: 'too-short' };
  const file = inboxFile(dataRoot);
  try {
    const dir = memoryDir(dataRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: Date.now(), kind, subj: String(subj || '').trim(), text: t }) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 把收件箱并入某个 scope，然后清空。返回并入条数。绝不抛。 */
export async function drainInbox(dataRoot, scope, cfg = CONFIG) {
  const file = inboxFile(dataRoot);
  if (!existsSync(file)) return 0;
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return 0;
  }
  if (lines.length === 0) return 0;
  let n = 0;
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!o?.text) continue;
      const r = await remember(dataRoot, scope, { text: o.text, kind: o.kind || 'fact', subj: o.subj }, cfg);
      if (r.ok) n += 1;
    } catch { /* 单行坏了继续 */ }
  }
  try { rmSync(file, { force: true }); } catch { /* 清不掉就下次再清（会去重） */ }
  return n;
}

/** 跨 scope 列出记忆（工具的 list 用） */
export function listAll(dataRoot, { limit = 30, scopeFilter = '' } = {}) {
  try {
    const h = handle(dataRoot);
    const lim = Math.max(1, Math.min(5000, Number(limit) || 30));
    const f = String(scopeFilter || '');
    const rows = f
      ? h.db.prepare('SELECT scope, id, kind, subj, text, ts, hits FROM mem WHERE instr(scope, ?) > 0 ORDER BY ts DESC LIMIT ?').all(f, lim)
      : h.db.prepare('SELECT scope, id, kind, subj, text, ts, hits FROM mem ORDER BY ts DESC LIMIT ?').all(lim);
    return rows.map((r) => ({
      scope: r.scope, id: r.id, kind: r.kind, subj: r.subj || '', text: cleanMemText(decText(h, r.text)), ts: Number(r.ts) || 0, hits: Number(r.hits) || 0,
    }));
  } catch { return []; }
}

/** 跨 scope 按 id 删除（工具的 forget 用） */
export function forgetAnywhere(dataRoot, id, cfg = CONFIG) {
  try {
    const h = handle(dataRoot);
    return deleteIds(h, [id]) > 0;
  } catch { return false; }
}

// ── 关键词检索（FTS5 优先，退化 LIKE）────────────────────────────────────
/**
 * 注意：unicode61 分词器不切中文，FTS 对中文短语命中率有限，所以主召回始终走
 * 向量近邻（recall）；这里是给调试/面板/将来的混合检索留的补充接口。
 */
export function searchText(dataRoot, scope, query, limit = 10) {
  const q = String(query || '').trim();
  if (!q) return [];
  const h = handle(dataRoot);
  const lim = Math.max(1, Math.min(200, Number(limit) || 10));
  // 加密态：FTS/LIKE 对密文无效，退化成解密后子串扫描（只用于面板/调试，量级可接受）
  if (h.encOn) {
    const rows = h.db.prepare('SELECT * FROM mem WHERE scope = ? ORDER BY ts DESC').all(String(scope || 'unknown'));
    const ql = q.toLowerCase();
    return rows
      .map((r) => rowToItem(r, h))
      .filter((it) => String(it.text || '').toLowerCase().includes(ql))
      .slice(0, lim);
  }
  if (h.fts) {
    try {
      const rows = h.db.prepare(
        'SELECT m.* FROM mem_fts f JOIN mem m ON m.id = f.id WHERE m.scope = ? AND mem_fts MATCH ? ORDER BY m.ts DESC LIMIT ?',
      ).all(String(scope || 'unknown'), '"' + q.replace(/"/g, '""') + '"', lim);
      if (rows.length) return rows.map((r) => rowToItem(r, h));
    } catch { /* FTS 查询语法不认就退化 */ }
  }
  const rows = h.db.prepare('SELECT * FROM mem WHERE scope = ? AND text LIKE ? ORDER BY ts DESC LIMIT ?')
    .all(String(scope || 'unknown'), '%' + q.replace(/[%_]/g, ' ') + '%', lim);
  return rows.map((r) => rowToItem(r, h));
}

// ── persona：角色设定 / 世界书 ──────────────────────────────────────────
/** 写一条设定（同 scope 同 ckey 覆盖）。key 如 'identity' / 'speech' / 'world:年糕'。 */
export function setPersona(dataRoot, scope, { ckey, cvalue, weight = 1, id } = {}) {
  const k = String(ckey || '').trim();
  if (!k) return { ok: false, reason: 'ckey 不能为空' };
  try {
    const h = handle(dataRoot);
    const pid = String(id || ('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)));
    h.db.prepare(
      `INSERT INTO persona(id, scope, ckey, cvalue, weight, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, ckey) DO UPDATE SET cvalue = excluded.cvalue, weight = excluded.weight, ts = excluded.ts`,
    ).run(pid, String(scope || 'global'), k, String(cvalue ?? ''), Number(weight) || 1, Date.now());
    return { ok: true, id: pid, ckey: k };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 读某个 scope 的全部设定（按 weight 降序、同权重按新旧） */
export function getPersona(dataRoot, scope, { limit = 200 } = {}) {
  try {
    const h = handle(dataRoot);
    const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
    const rows = h.db.prepare(
      'SELECT id, scope, ckey, cvalue, weight, ts FROM persona WHERE scope = ? ORDER BY weight DESC, ts ASC LIMIT ?',
    ).all(String(scope || 'global'), lim);
    return rows.map((r) => ({
      id: r.id, scope: r.scope, ckey: r.ckey, cvalue: r.cvalue, weight: Number(r.weight) || 1, ts: Number(r.ts) || 0,
    }));
  } catch { return []; }
}

/** 取单条设定（没有就 null）。ts/ckey 一起返回，给「心情」这类有保鲜期的条目判断新旧。 */
export function getPersonaValue(dataRoot, scope, ckey) {
  try {
    const h = handle(dataRoot);
    const row = h.db.prepare('SELECT id, ckey, scope, cvalue, ts FROM persona WHERE scope = ? AND ckey = ?')
      .get(String(scope || 'global'), String(ckey));
    return row
      ? { id: row.id, value: row.cvalue, ckey: row.ckey, scope: row.scope, ts: Number(row.ts) || 0 }
      : null;
  } catch { return null; }
}

/** 跨 scope 列设定 */
export function listPersona(dataRoot, { limit = 50, scopeFilter = '' } = {}) {
  try {
    const h = handle(dataRoot);
    const lim = Math.max(1, Math.min(2000, Number(limit) || 50));
    const f = String(scopeFilter || '');
    const rows = f
      ? h.db.prepare('SELECT * FROM persona WHERE instr(scope, ?) > 0 ORDER BY ts DESC LIMIT ?').all(f, lim)
      : h.db.prepare('SELECT * FROM persona ORDER BY ts DESC LIMIT ?').all(lim);
    return rows.map((r) => ({
      id: r.id, scope: r.scope, ckey: r.ckey, cvalue: r.cvalue, weight: Number(r.weight) || 1, ts: Number(r.ts) || 0,
    }));
  } catch { return []; }
}

/** 删一条设定 */
export function forgetPersona(dataRoot, id) {
  try {
    const h = handle(dataRoot);
    return h.db.prepare('DELETE FROM persona WHERE id = ?').run(String(id)).changes > 0;
  } catch { return false; }
}

// ── 从老的 JSONL 迁移 ───────────────────────────────────────────────────
const MIGRATE_FLAG = 'migrated_jsonl';

function jsonlFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('_'));
  } catch { return []; }
}

/**
 * 文件名 → scope。core 的 memoryFile() 会把 scope 里的非法字符换成 '_'
 * （`group:1234` → `group_1234.jsonl`），真正的 scope 只有两种形状：
 * 群聊 `group:<openid>` / 私聊 `c2c:<openid>`（见 inbound/memory-recall.mjs 的 scopeOf），
 * openid 是纯字母数字，所以这两种前缀可以无损还原。其余 scope（测试用的 selftest 等）
 * 本来就是合法文件名字符，原样即可。
 */
function scopeFromJsonlName(name) {
  const base = name.replace(/\.jsonl$/, '');
  if (base.startsWith('group_')) return 'group:' + base.slice(6);
  if (base.startsWith('c2c_')) return 'c2c:' + base.slice(4);
  return base;
}

/** core 的 scope → 文件名安全形式（与 core 的 memoryFile 完全同规则） */
function safeScopeName(scope) {
  return String(scope || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function maxMtime(dir, files) {
  let m = 0;
  for (const f of files) {
    try { m = Math.max(m, statSync(join(dir, f)).mtimeMs); } catch { /* ignore */ }
  }
  return m;
}

/**
 * 把 {dataRoot}/.qqbot/memory/*.jsonl 全部并进来（按 id 去重，INSERT OR IGNORE）。
 * 触发条件：meta.migrated_jsonl 没设过（首次），或 jsonl 的 mtime 比上次迁移更新
 * （兼容老测试脚本先灌 jsonl 再让扩展读的用法；平时 jsonl 不再写，所以只会迁一次）。
 * 任何失败都只返回 {ok:false}，绝不抛给调用方。
 */
function migrateJsonlHandle(h) {
  try {
    const dir = memoryDir(h.root);
    if (!existsSync(dir)) { setMeta(h, MIGRATE_FLAG, String(Date.now())); return { ok: true, imported: 0, reason: 'no-jsonl-dir' }; }

    const files = jsonlFiles(dir);
    if (files.length === 0) {
      if (!getMeta(h, MIGRATE_FLAG)) setMeta(h, MIGRATE_FLAG, String(Date.now()));
      return { ok: true, imported: 0, reason: 'no-jsonl' };
    }
    const latest = maxMtime(dir, files);
    const flag = Number(getMeta(h, MIGRATE_FLAG) || 0);
    if (flag > 0 && latest <= flag) return { ok: true, imported: 0, reason: 'up-to-date' };

    let imported = 0, scanned = 0;
    for (const f of files) {
      const scope = scopeFromJsonlName(f);
      let lines = [];
      try { lines = readFileSync(join(dir, f), 'utf8').split('\n'); } catch { continue; }
      for (const line of lines) {
        const t = String(line || '').trim();
        if (!t) continue;
        let o;
        try { o = JSON.parse(t); } catch { continue; }
        if (!o || typeof o !== 'object' || !o.text) continue;
        scanned += 1;
        try {
          const okIns = insertItem(h, scope, {
            id: String(o.id || newId()),
            ts: Number(o.ts) || Date.now(),
            kind: o.kind || 'fact',
            subj: String(o.subj || ''),
            text: String(o.text),
            vec: Array.isArray(o.vec) ? o.vec : null,
            hits: Number(o.hits) || 0,
            lastHit: Number(o.lastHit) || 0,
            src: 'migrate:jsonl',
          }, true);
          if (okIns) imported += 1;
        } catch { /* 单条坏行跳过 */ }
      }
      // 顺带把"上次摘要到哪儿了"接过来，避免迁完又从头摘要一遍
      try {
        const stFile = join(dir, `_digest_${safeScopeName(scope)}.json`);
        if (existsSync(stFile)) {
          const st = JSON.parse(readFileSync(stFile, 'utf8'));
          if (Number(st?.lastDigestTs) > 0 && !getMeta(h, digestKey(scope))) {
            setMeta(h, digestKey(scope), JSON.stringify({ lastDigestTs: Number(st.lastDigestTs), lastRun: Number(st.lastRun) || 0 }));
          }
        }
      } catch { /* 摘要游标迁不过来就算了，最多多做一次摘要 */ }
    }
    setMeta(h, MIGRATE_FLAG, String(Date.now()));
    return { ok: true, imported, scanned, files: files.length };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 手动触发一次迁移（测试/运维用）。返回 { ok, imported, ... }，绝不抛。 */
export function migrateJsonl(dataRoot) {
  try {
    return migrateJsonlHandle(handle(dataRoot));
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── 中层记忆：抽取式摘要（零 token，不删原记忆）──────────────────────────
/** 向量质心 */
function centroid(vecs) {
  const n = vecs.length;
  const dim = vecs[0].length;
  const c = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) c[i] += v[i];
  for (let i = 0; i < dim; i++) c[i] /= n;
  return c;
}

const digestKey = (scope) => 'digest:' + String(scope || 'unknown');

function readDigestState(h, scope) {
  try {
    const raw = getMeta(h, digestKey(scope));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeDigestState(h, scope, st) {
  try { setMeta(h, digestKey(scope), JSON.stringify(st)); } catch { /* ignore */ }
}

/**
 * 给某个 scope 做一次中层摘要。返回 { ok, added, covered } 或 { ok:false, reason }。
 * 触发条件：距上次摘要累积的 event 条数 >= cfg.digestEvery（默认 40）。
 */
export function digestScope(dataRoot, scope, cfg = CONFIG) {
  const every = Math.max(10, Number(cfg.digestEvery) || 40);
  try {
    const h = handle(dataRoot);
    const items = loadMemories(dataRoot, scope, cfg);
    const st = readDigestState(h, scope);
    const since = Number(st.lastDigestTs) || 0;

    const fresh = items
      .filter((it) => it.kind === 'event' && Number(it.ts) > since && Array.isArray(it.vec) && it.vec.length > 0)
      .sort((a, b) => a.ts - b.ts);
    if (fresh.length < every) return { ok: false, reason: `不足 ${every} 条（现有 ${fresh.length}）` };

    const batch = fresh.slice(0, every);
    const c = centroid(batch.map((x) => x.vec));
    // 离质心最近的两条（且彼此不重复）
    const ranked = batch
      .map((it) => ({ it, c: cos(c, it.vec) }))
      .sort((a, b) => b.c - a.c);
    const picked = [];
    for (const r of ranked) {
      if (picked.some((p) => cos(p.vec, r.it.vec) > 0.9)) continue;
      picked.push(r.it);
      if (picked.length >= 2) break;
    }
    if (picked.length === 0) return { ok: false, reason: '挑不出代表句' };

    const from = new Date(batch[0].ts).toISOString().slice(5, 16).replace('T', ' ');
    const to = new Date(batch[batch.length - 1].ts).toISOString().slice(5, 16).replace('T', ' ');
    const text = `（${from}~${to} 群里的 ${batch.length} 条消息，主要围绕）` + picked.map((p) => cleanMemText(p.text)).join('；');

    // 直接写一条 summary（不走去重：摘要本来就该独立存在）
    const entry = {
      id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      ts: Date.now(), kind: 'summary', text: text.slice(0, 260), subj: '',
      vec: c, hits: 0, lastHit: 0, src: 'digest',
    };
    insertItem(h, scope, entry);
    trimScope(h, scope, cfg);
    writeDigestState(h, scope, { lastDigestTs: batch[batch.length - 1].ts, lastRun: Date.now() });
    return { ok: true, added: 1, covered: batch.length, text: entry.text };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 把"该不该做摘要"的判断做成廉价守卫（避免每条消息都扫全库） */
export function shouldDigest(dataRoot, scope, cfg = CONFIG) {
  try {
    const every = Math.max(10, Number(cfg.digestEvery) || 40);
    const h = handle(dataRoot);
    const st = readDigestState(h, scope);
    const since = Number(st.lastDigestTs) || 0;
    const row = h.db.prepare("SELECT COUNT(*) AS n FROM mem WHERE scope = ? AND kind = 'event' AND ts > ?")
      .get(String(scope || 'unknown'), since);
    return (Number(row?.n) || 0) >= every;
  } catch { return false; }
}

// ── 向量模型切换 / 全量重嵌 ────────────────────────────────────────────
const EMBED_META_KEY = 'embedding_model';

/** 当前库里向量是用哪个模型算的（给浮窗显示、判断是否需要重建） */
export function embeddingModelInfo(dataRoot) {
  try {
    const h = handle(dataRoot);
    const raw = getMeta(h, EMBED_META_KEY);
    if (!raw) return { model: '', mode: '', rows: 0, ts: 0 };
    const o = JSON.parse(raw);
    return { model: String(o.model || ''), mode: String(o.mode || ''), rows: Number(o.rows) || 0, ts: Number(o.ts) || 0 };
  } catch { return { model: '', mode: '', rows: 0, ts: 0 }; }
}

/** 当前配置实际能用的模型（只探一条，不重嵌） */
export async function currentEmbedderInfo(dataRoot) {
  try {
    const r = await embedTexts(dataRoot, ['探测'], { role: 'memory', kind: 'query' });
    return { model: r.model, mode: r.mode, dim: (r.vecs[0] || []).length, error: r.error || '' };
  } catch (e) {
    return { model: '', mode: 'error', dim: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 换模型后的全量重嵌。分批跑，任何一批失败只记失败数，不中断。
 * @param {object} o
 * @param {number} [o.batch]
 * @param {(p:{done:number,total:number,model:string,mode:string})=>void} [o.onProgress]
 */
export async function rebuildEmbeddings(dataRoot, { batch = 16, onProgress = null } = {}) {
  const b = Math.max(1, Math.min(64, Number(batch) || 16));
  try {
    const h = handle(dataRoot);
    const rows = h.db.prepare('SELECT id, text FROM mem ORDER BY rowid ASC').all();
    const total = rows.length;
    let done = 0;
    let failed = 0;
    let model = '';
    let mode = '';
    const upd = h.db.prepare('UPDATE mem SET vec = ? WHERE id = ?');
    for (let i = 0; i < total; i += b) {
      const chunk = rows.slice(i, i + b);
      // eslint-disable-next-line no-await-in-loop
      const r = await embedTexts(dataRoot, chunk.map((x) => decText(h, x.text)), { role: 'memory', kind: 'passage' });
      model = r.model;
      mode = r.mode;
      chunk.forEach((row, k) => {
        const blob = vecToBlob(r.vecs[k]);
        if (!blob) { failed += 1; return; }
        try { upd.run(blob, row.id); } catch { failed += 1; }
      });
      done += chunk.length;
      try { onProgress && onProgress({ done, total, model, mode }); } catch { /* ignore */ }
    }
    setMeta(h, EMBED_META_KEY, JSON.stringify({ model, mode, rows: done - failed, ts: Date.now() }));
    return { ok: true, total, updated: done - failed, failed, model, mode };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 写入时记一笔「用的是哪个模型」（首次写入/重嵌后保持一致） */
export function markEmbeddingModel(dataRoot, model, mode) {
  try {
    const h = handle(dataRoot);
    const cur = embeddingModelInfo(dataRoot);
    if (cur.model === model) return { ok: true, unchanged: true };
    setMeta(h, EMBED_META_KEY, JSON.stringify({ model, mode, rows: cur.rows, ts: Date.now() }));
    return { ok: true };
  } catch { return { ok: false }; }
}
