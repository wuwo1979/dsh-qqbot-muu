/**
 * chatlog-db.mjs — QQ 聊天记录 → SQLite 持久化（原始台账层）
 *
 * 为什么要有这一层：
 *   mem 表存的是"提炼后的记忆"（一句一条、带向量、会被去重/淘汰）；
 *   它不是原始聊天记录，删了就真没了。而"像人一样记得上下文"还需要一份**原始台账**：
 *     · 给本地记忆分身（lib/memory-agent.mjs）当输入，提炼事实/关系/心情；
 *     · 给面板/运维查"那晚到底聊了什么"；
 *     · 将来换 embedding 模型时可以从台账重建记忆，不用重灌聊天。
 *
 * 数据源头（插件自己已经落盘的那份，不额外抓包）：
 *   {dataRoot}/.qqbot/msg-history/<group_xxx|c2c_xxx>/YYYY-MM-DD.jsonl
 *   每行：{ id, s, n, t, k, x, me }
 *         id=平台消息号  s=发送者id  n=昵称  t=时间戳ms  k=类型  x=正文  me=是否机器人自己
 *
 * 设计约束：
 *   · 和 mem 共用一个 memory.db（不新建库文件，备份/迁移只面对一份）；
 *   · 幂等：按平台消息号去重，重复 ingest 不会涨条数；
 *   · 增量：每个文件记住已读到的字节偏移（chat_meta），只读新增部分；
 *   · 永不抛：任何异常都降级成 { ok:false, reason }，聊天照常。
 *
 * 表：
 *   chat(fp PK, scope, ts, dir, sender_id, sender, kind, text, media, msg_id, src)
 *   chat_meta(k PK, v)   —— 增量游标 + 记忆分身状态
 */

import {
  existsSync, readdirSync, openSync, closeSync, readSync, fstatSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getHandle, dbFile, maintainDb } from './memory-db.mjs';

export const DEFAULTS = {
  enabled: true,
  retentionDays: 60,      // 超过这么久的历史会被 prune 掉（0 = 不按时间删）；导入的档案不受影响
  capPerScope: 8000,      // 每个 scope 最多保留多少条（0 = 不按条数删）；同样只数自动采集的行
  maxChars: 500,          // 单条正文入库上限（实时采集；导入的档案单独放宽）
  ingestThrottleMs: 15000,
  maxFilesPerRun: 8,      // 一次最多补几个文件（首轮会分几次追平）
  maxBytesPerRun: 4 * 1024 * 1024,
  dailyBackup: true,      // 每天顺带做一次库备份（和 prune 同一个节流窗口，不额外加频）
  backupKeep: 5,          // 备份保留份数
};

const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat (
  fp        TEXT PRIMARY KEY,
  scope     TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  dir       TEXT,
  sender_id TEXT,
  sender    TEXT,
  kind      TEXT,
  text      TEXT,
  media     TEXT,
  msg_id    TEXT,
  src       TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_scope_ts ON chat(scope, ts);
CREATE INDEX IF NOT EXISTS idx_chat_ts       ON chat(ts);

CREATE TABLE IF NOT EXISTS chat_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

function ensureChat(h) {
  try {
    // 每次都探一下表在不在：库文件可能被运维删掉重建，缓存"已建过"会踩空
    const ok = h.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat'").get();
    if (!ok) h.db.exec(CHAT_SCHEMA);
    backfillCleanText(h);
    // v1：早期把 c2c 的 sender_id 当昵称存了，清成可读称呼（只跑一次）
    const done = h.db.prepare("SELECT 1 FROM chat_meta WHERE k='mig:sender_name_v1'").get();
    if (!done) {
      h.db.exec("UPDATE chat SET sender = CASE WHEN scope LIKE 'c2c:%' THEN '对方' ELSE '群友' END WHERE sender = sender_id");
      h.db.prepare("INSERT OR IGNORE INTO chat_meta(k, v) VALUES ('mig:sender_name_v1', '1')").run();
    }
    backfillSenderNames(h);
  } catch { /* 建表失败后面 query 自己会返回空 */ }
  return h;
}

/** 一次性的历史清洗：把早期没剥干净的注入块（尤其是被截断、没有闭合标签的）重新洗一遍 */
function backfillCleanText(h) {
  const done = h.db.prepare("SELECT 1 FROM chat_meta WHERE k='mig:clean_v2'").get();
  if (done) return;
  try {
    const rows = h.db
      .prepare(
        "SELECT fp, text FROM chat WHERE text LIKE '%[记忆]%' OR text LIKE '%[设定]%' OR text LIKE '%[印象]%' OR text LIKE '%[状态]%' OR text LIKE '%[别重复]%'",
      )
      .all();
    if (rows.length) {
      const upd = h.db.prepare('UPDATE chat SET text=? WHERE fp=?');
      h.db.exec('BEGIN');
      try {
        for (const r of rows) upd.run(cleanChatText(r.text), r.fp);
        h.db.exec('COMMIT');
      } catch {
        h.db.exec('ROLLBACK');
      }
    }
    h.db.prepare("INSERT OR IGNORE INTO chat_meta(k, v) VALUES ('mig:clean_v2', '1')").run();
  } catch { /* 清洗失败不影响主流程 */ }
}

/** 用群聊里同一 openid 的昵称，回填私聊/缺名的 sender（只跑一次） */
function backfillSenderNames(h) {
  const done = h.db.prepare("SELECT 1 FROM chat_meta WHERE k='mig:sender_name_v2'").get();
  if (done) return;
  try {
    const pairs = h.db
      .prepare("SELECT sender_id, sender FROM chat WHERE sender_id <> '' AND sender <> '' AND sender <> sender_id")
      .all();
    const generic = new Set(['对方', '群友', '小蓝']);
    const map = new Map();
    for (const p of pairs) {
      const id = String(p.sender_id || '').trim();
      const name = String(p.sender || '').trim();
      if (!id || !name || generic.has(name) || name.length > 24 || looksLikeOpenid(name)) continue;
      if (!map.has(id)) map.set(id, name);
    }
    if (map.size) {
      const upd = h.db.prepare(
        "UPDATE chat SET sender=? WHERE sender_id=? AND (sender=? OR sender='' OR sender='对方' OR sender='群友')",
      );
      h.db.exec('BEGIN');
      try {
        for (const [id, name] of map) upd.run(name, id, id);
        h.db.exec('COMMIT');
      } catch {
        h.db.exec('ROLLBACK');
      }
    }
    h.db.prepare("INSERT OR IGNORE INTO chat_meta(k, v) VALUES ('mig:sender_name_v2', '1')").run();
  } catch { /* 回填失败不影响主流程 */ }
}

/** 平台昵称缺失时，别把 32 位 openid 当人名用 */
function looksLikeOpenid(s) {
  const t = String(s || '').trim();
  return t.length >= 16 && !/[\u4e00-\u9fa5]/.test(t) && /^[A-Za-z0-9_-]+$/.test(t);
}

function senderNameOf(o, dir, scope) {
  if (dir === 'out') return '小蓝';
  const id = String(o?.s || '').trim();
  const raw = String(o?.n || '').trim();
  // 「机器人」是宿主给 bot 自己消息填的昵称，绝不能当对方人名
  if (!raw || raw === id || raw === '机器人' || looksLikeOpenid(raw)) return scope.startsWith('c2c:') ? '对方' : '群友';
  return raw;
}

function handleOf(dataRoot) {
  return ensureChat(getHandle(dataRoot));
}

// ── 文本清洗 ────────────────────────────────────────────────────────────
const SPACE_CHARS = ' \t\r\n' + String.fromCharCode(0x3000);
function isSpaceChar(c) {
  return SPACE_CHARS.indexOf(c) >= 0;
}

/** 找 `[/标签]` 的结束位置（兼容 `[/ 记忆]`、`[/\n记忆]` 这类畸形写法） */
function findCloseTag(t, from, tag) {
  const marker = '[/';
  let i = t.indexOf(marker, from);
  while (i >= 0) {
    let j = i + marker.length;
    while (j < t.length && isSpaceChar(t[j])) j += 1;
    if (t.startsWith(tag, j)) {
      j += tag.length;
      while (j < t.length && isSpaceChar(t[j])) j += 1;
      if (t[j] === ']') return j + 1;
    }
    i = t.indexOf(marker, i + 1);
  }
  return -1;
}

/** 没有闭合标签时，判断后面这段像不像注入的内容（编号清单开头的就是） */
function looksLikeInjectedTail(rest) {
  let k = 0;
  while (k < rest.length && isSpaceChar(rest[k])) k += 1;
  let d = k;
  while (d < rest.length && rest[d] >= '0' && rest[d] <= '9') d += 1;
  if (d > k && (rest[d] === '.' || rest[d] === '、')) return true;
  if (rest.startsWith('刚说过')) return true;
  return false;
}

/**
 * 剥掉一个注入块。
 * cutUnclosed=true 用于"整块都在句尾、且一定是系统加的"标签（印象/状态/别重复）；
 * 记忆/设定 则只在后面确实像编号清单时才砍，避免误伤用户自己打的 `[记忆]`。
 */
function stripTagBlock(t, tag, cutUnclosed) {
  const open = '[' + tag + ']';
  let guard = 0;
  while (guard < 8) {
    const a = t.indexOf(open);
    if (a < 0) break;
    const restStart = a + open.length;
    const closeEnd = findCloseTag(t, restStart, tag);
    if (closeEnd > 0) {
      t = t.slice(0, a) + ' ' + t.slice(closeEnd);
    } else {
      const rest = t.slice(restStart);
      if (cutUnclosed || looksLikeInjectedTail(rest)) t = t.slice(0, a);
      break;
    }
    guard += 1;
  }
  return t;
}

/**
 * 台账里常混进"进上下文那版"文本（带 [记忆]/[设定]/[印象]/[状态]/[别重复] 块）
 * 和平台标记 `<@OPENID>`。入库前统一洗掉，否则记忆分身会把注入块当聊天内容再记一遍。
 * 注意：插件落盘时正文会被截到 500 字，闭合标签可能已经被截掉——
 * 所以这里必须能处理"只有开头、没有结尾"的块。
 */
export function cleanChatText(text) {
  let t = String(text == null ? '' : text)
    .replace(/<@[^>]*>/g, '')
    .replace(/<qqbot-at-everyone\s*\/?>/gi, '@全体成员');
  t = stripTagBlock(t, '记忆', false);
  t = stripTagBlock(t, '设定', false);
  t = stripTagBlock(t, '印象', true);
  t = stripTagBlock(t, '状态', true);
  t = stripTagBlock(t, 'B站', true);
  t = stripTagBlock(t, '别重复', true);
  return t
    .replace(/\[MEDIA:[^\]]*\]/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[ \u3000]{2,}/g, ' ')
    .trim();
}

/** 只有占位符的正文 → 空；用于"纯图片/表情"这类消息 */
function textOfLine(o) {
  const kind = String(o?.k || 'text');
  const raw = String(o?.x || '');
  const t = cleanChatText(raw);
  if (kind === 'text' || kind === '') return t;
  // 非文本消息：把有效的 caption 留下来，纯占位符（[image]）丢掉
  if (t && !/^\[[^\]]+\]$/.test(t) && !/^\[image\]$/i.test(t)) return t;
  return '';
}

function scopeFromDirName(name) {
  const b = String(name || '');
  if (b.startsWith('group_')) return 'group:' + b.slice(6);
  if (b.startsWith('c2c_')) return 'c2c:' + b.slice(4);
  return b;
}

function fingerprint(scope, dir, senderId, ts, text, msgId) {
  if (msgId) return 'id:' + String(scope) + ':' + String(msgId).slice(0, 120);
  const h = createHash('sha1')
    .update(`${scope}|${dir}|${senderId}|${ts}|${text}`)
    .digest('hex')
    .slice(0, 20);
  return 'h:' + h;
}

// ── chat_meta 游标 ──────────────────────────────────────────────────────
function metaGet(h, k) {
  try {
    const row = h.db.prepare('SELECT v FROM chat_meta WHERE k = ?').get(String(k));
    return row ? row.v : null;
  } catch { return null; }
}

function metaSet(h, k, v) {
  try {
    h.db.prepare('INSERT INTO chat_meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(String(k), String(v));
  } catch { /* 游标写失败只是下次多读一段，不影响主流程 */ }
}

/** 记忆分身/维护脚本的会话状态（JSON） */
export function getChatState(dataRoot, key) {
  try {
    const raw = metaGet(handleOf(dataRoot), 'state:' + String(key || ''));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function setChatState(dataRoot, key, obj) {
  try {
    metaSet(handleOf(dataRoot), 'state:' + String(key || ''), JSON.stringify(obj || {}));
    return true;
  } catch { return false; }
}

// ── 写入 ────────────────────────────────────────────────────────────────
/**
 * 写入一条聊天记录（幂等）。用于"插件历史文件还没落盘时"的实时补记。
 * @returns {boolean} true = 新插入；false = 重复或参数无效
 */
export function appendChat(dataRoot, {
  scope, ts = Date.now(), dir = 'in', senderId = '', sender = '', kind = 'text', text = '', media = '', msgId = '', src = 'live',
} = {}) {
  const s = String(scope || '').trim();
  if (!s) return false;
  const t = cleanChatText(text).slice(0, DEFAULTS.maxChars);
  if (!t && !media) return false;
  try {
    const h = handleOf(dataRoot);
    const fp = fingerprint(s, dir, senderId, Number(ts) || Date.now(), t, msgId);
    const r = h.db.prepare(
      `INSERT OR IGNORE INTO chat(fp, scope, ts, dir, sender_id, sender, kind, text, media, msg_id, src)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(fp, s, Number(ts) || Date.now(), String(dir), String(senderId || ''), String(sender || ''),
      String(kind || 'text'), t, String(media || ''), String(msgId || ''), String(src || ''));
    return (r.changes || 0) > 0;
  } catch { return false; }
}

/**
 * 归档一段**完整**对话（历史导入用）。
 *
 * 和 appendChat / ingestChatHistory 的区别，是这一层存在的理由：
 *   · 不做信息量筛选 —— 台账要的是原样。筛哪句值得记是 mem 层的事，
 *     台账要是也被筛过，就没法"事后重放"，换模型也重建不了记忆；
 *   · 正文截断放到 archiveMaxChars（默认 2000）。线上实时台账截 500 是怕脏数据撑库，
 *     但历史导入里 500 字以上的长消息恰恰是最有信息量的；
 *   · 一律标 src='import'，和自动采集的行区分开 —— 保留窗不管导入的行（见 pruneChat）。
 *
 * 幂等：同一个文件重复导入不会涨条数（无平台消息号时按内容指纹哈希）。
 * @returns {{ok:boolean, added:number, skipped:number, scope:string}}
 */
export function archiveMessages(dataRoot, opts = {}) {
  const scope = String(opts.scope || '').trim();
  const list = Array.isArray(opts.messages) ? opts.messages : [];
  const src = String(opts.src || 'import');
  const maxChars = Math.max(50, Math.min(20000, Number(opts.maxChars) || 2000));
  const out = { ok: false, added: 0, skipped: 0, scope };
  if (!scope) return { ...out, reason: 'no-scope' };
  if (!list.length) return { ...out, ok: true, reason: 'empty' };
  try {
    const h = handleOf(dataRoot);
    const stmt = h.db.prepare(
      `INSERT OR IGNORE INTO chat(fp, scope, ts, dir, sender_id, sender, kind, text, media, msg_id, src)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 一批一个事务：几千条逐条提交在 WAL 下会非常慢
    h.db.exec('BEGIN');
    try {
      for (const m of list) {
        const ts = Number(m.ts) || 0;
        const text = cleanChatText(m.text).slice(0, maxChars);
        if (!ts || (!text && !m.media)) { out.skipped += 1; continue; }
        const dir = m.dir === 'out' ? 'out' : 'in';
        const senderId = String(m.senderId || '');
        const fp = fingerprint(scope, dir, senderId, ts, text, String(m.msgId || ''));
        const r = stmt.run(
          fp, scope, ts, dir, senderId, String(m.sender || ''), String(m.kind || 'text'),
          text, String(m.media || ''), String(m.msgId || ''), src,
        );
        if ((r.changes || 0) > 0) out.added += 1; else out.skipped += 1;
      }
      h.db.exec('COMMIT');
    } catch (e) {
      try { h.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    out.ok = true;
    return out;
  } catch (e) {
    return { ...out, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── 从插件台账增量导入 ─────────────────────────────────────────────────
function readRange(fd, start, end) {
  const len = Math.max(0, end - start);
  if (!len) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, start + off);
    if (!n) break;
    off += n;
  }
  return off === len ? buf : buf.subarray(0, off);
}

function parseLine(line, scope) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const ts = Number(o.t) || 0;
  if (!ts) return null;
  // 宿主给 bot 自己的消息填昵称「机器人」；有的行 me 会缺，按昵称兜底判自我
  const dir = (o.me === true || String(o.n || '').trim() === '机器人') ? 'out' : 'in';
  const senderId = String(o.s || '');
  const sender = senderNameOf(o, dir, scope);
  const kind = String(o.k || 'text');
  const text = textOfLine(o).slice(0, DEFAULTS.maxChars);
  if (!text) {
    if (kind === 'text') return null; // 空文本没有归档价值
  }
  const media = kind === 'text' ? '' : JSON.stringify([kind]);
  return {
    scope, ts, dir, senderId, sender, kind, text, media,
    msgId: String(o.id || ''), src: 'msg-history',
  };
}

/**
 * 把 msg-history 里新增的行补进 chat 表。
 * @param {object} opts { maxFilesPerRun, maxBytesPerRun }
 * @returns {{ok:boolean, imported:number, scanned:number, files:number, reason?:string}}
 */
export function ingestChatHistory(dataRoot, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  if (cfg.enabled === false) return { ok: true, imported: 0, scanned: 0, files: 0, reason: 'disabled' };
  try {
    const root = String(dataRoot || '').trim();
    if (!root) return { ok: false, imported: 0, reason: 'no-root' };
    const base = join(root, '.qqbot', 'msg-history');
    if (!existsSync(base)) return { ok: true, imported: 0, scanned: 0, files: 0, reason: 'no-history' };

    const h = handleOf(root);
    let dirs = [];
    try {
      dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { return { ok: false, imported: 0, reason: 'readdir' }; }

    let imported = 0, scanned = 0, files = 0, bytes = 0;
    for (const dn of dirs.sort()) {
      const scope = scopeFromDirName(dn);
      const dirPath = join(base, dn);
      let names = [];
      try { names = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')).sort(); } catch { continue; }

      const stateKey = 'ingest:' + dn;
      let state = {};
      try { state = JSON.parse(metaGet(h, stateKey) || '{}') || {}; } catch { state = {}; }
      if (!state.files || typeof state.files !== 'object') state.files = {};

      for (const name of names) {
        if (files >= Math.max(1, Number(cfg.maxFilesPerRun) || 8) && bytes >= cfg.maxBytesPerRun) break;
        const p = join(dirPath, name);
        let st = null;
        try { st = statSync(p); } catch { continue; }
        const size = Number(st.size) || 0;
        let off = Number(state.files[name]?.off) || 0;
        if (off > size) off = 0;              // 文件被截断/替换
        if (off === size) continue;
        if (bytes >= cfg.maxBytesPerRun) break;

        let fd = null;
        try {
          fd = openSync(p, 'r');
          let realSize = size;
          try { realSize = Number(fstatSync(fd).size) || size; } catch { /* ignore */ }
          // 只吃"完整行"：最后一行可能正在被插件写
          const buf = readRange(fd, off, realSize);
          const str = buf.toString('utf8');
          const lastNl = str.lastIndexOf('\n');
          if (lastNl < 0) continue;
          const complete = str.slice(0, lastNl + 1);
          const consumed = Buffer.byteLength(complete, 'utf8');

          for (const line of complete.split('\n')) {
            scanned += 1;
            const rec = parseLine(line, scope);
            if (!rec) continue;
            const fp = fingerprint(rec.scope, rec.dir, rec.senderId, rec.ts, rec.text, rec.msgId);
            try {
              const r = h.db.prepare(
                `INSERT OR IGNORE INTO chat(fp, scope, ts, dir, sender_id, sender, kind, text, media, msg_id, src)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ).run(fp, rec.scope, rec.ts, rec.dir, rec.senderId, rec.sender, rec.kind, rec.text, rec.media, rec.msgId, rec.src);
              if ((r.changes || 0) > 0) imported += 1;
            } catch { /* 单条坏行跳过 */ }
          }
          state.files[name] = { off: off + consumed, mtime: Number(st.mtimeMs) || 0 };
          bytes += consumed;
          files += 1;
        } catch { /* 单文件失败继续下一个 */ }
        finally { if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } } }
      }

      // 清掉已经不存在的文件游标，免得 chat_meta 越滚越大
      const alive = new Set(names);
      for (const k of Object.keys(state.files)) if (!alive.has(k)) delete state.files[k];
      metaSet(h, stateKey, JSON.stringify(state));
    }

    // 保留窗 + 备份每天自动跑一次（默认 60 天 / 每 scope 8000 条），避免库无限长
    let pruned = 0;
    let backup = '';
    try {
      const last = Number(metaGet(h, 'last_prune') || 0);
      if (Date.now() - last > 86400000 && ((Number(cfg.retentionDays) > 0) || (Number(cfg.capPerScope) > 0))) {
        metaSet(h, 'last_prune', Date.now());
        pruned = Number(pruneChat(root, cfg).deleted) || 0;
      }
      // 备份和清理放同一个每日窗口：记忆库是长期资产，没有备份的清理等于没有清理
      if (cfg.dailyBackup !== false) {
        const lastBk = Number(metaGet(h, 'last_backup') || 0);
        if (Date.now() - lastBk > 86400000) {
          metaSet(h, 'last_backup', Date.now());
          backup = maintainDb(root, { backup: true, keep: Number(cfg.backupKeep) || 5, vacuum: false }).backup || '';
        }
      }
    } catch { /* 清理/备份失败不影响导入 */ }

    return { ok: true, imported, scanned, files, pruned, backup };
  } catch (e) {
    return { ok: false, imported: 0, scanned: 0, files: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── 查询 ────────────────────────────────────────────────────────────────
function rowToChat(r) {
  return {
    fp: r.fp, scope: r.scope, ts: Number(r.ts) || 0, dir: r.dir || 'in',
    senderId: r.sender_id || '', sender: r.sender || '',
    kind: r.kind || 'text', text: r.text || '', media: r.media || '',
    msgId: r.msg_id || '', src: r.src || '',
  };
}

/**
 * 取某个 scope 的聊天记录（按时间正序返回，方便直接喂给模型）。
 * @param {object} opts { limit=20, beforeTs=0, afterTs=0, dir='' }
 */
export function queryChat(dataRoot, scope, { limit = 20, beforeTs = 0, afterTs = 0, dir = '' } = {}) {
  try {
    const h = handleOf(dataRoot);
    const lim = Math.max(1, Math.min(500, Number(limit) || 20));
    const where = ['scope = ?'];
    const args = [String(scope || '')];
    if (Number(beforeTs) > 0) { where.push('ts < ?'); args.push(Number(beforeTs)); }
    if (Number(afterTs) > 0) { where.push('ts > ?'); args.push(Number(afterTs)); }
    if (dir) { where.push('dir = ?'); args.push(String(dir)); }
    // 先取最近 limit 条（DESC），再反转成正序
    const rows = h.db.prepare(
      `SELECT * FROM chat WHERE ${where.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`,
    ).all(...args, lim);
    return rows.map(rowToChat).reverse();
  } catch { return []; }
}

/** 关键词检索（中文没分词，只做 LIKE；给面板/运维用） */
export function searchChat(dataRoot, scope, query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const h = handleOf(dataRoot);
    const lim = Math.max(1, Math.min(200, Number(limit) || 20));
    return h.db.prepare(
      'SELECT * FROM chat WHERE scope = ? AND text LIKE ? ORDER BY ts DESC LIMIT ?',
    ).all(String(scope || ''), '%' + q.replace(/[%_]/g, ' ') + '%', lim).map(rowToChat).reverse();
  } catch { return []; }
}

/** 统计：总量、各 scope、时间跨度 */
export function chatStats(dataRoot, scope = '') {
  try {
    const h = handleOf(dataRoot);
    const f = String(scope || '');
    const total = f
      ? Number(h.db.prepare('SELECT COUNT(*) AS n FROM chat WHERE scope = ?').get(f)?.n) || 0
      : Number(h.db.prepare('SELECT COUNT(*) AS n FROM chat').get()?.n) || 0;
    const scopes = h.db.prepare(
      `SELECT scope, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last
       FROM chat ${f ? 'WHERE scope = ?' : ''} GROUP BY scope ORDER BY n DESC`,
    ).all(...(f ? [f] : [])).map((r) => ({
      scope: r.scope, total: Number(r.n) || 0, first: Number(r.first) || 0, last: Number(r.last) || 0,
    }));
    return { backend: 'sqlite', file: dbFile(dataRoot), total, scopes };
  } catch (e) {
    return { backend: 'sqlite', file: '', total: 0, scopes: [], reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 删除：按时间保留窗 + 每 scope 条数上限。返回删除条数。 */
export function pruneChat(dataRoot, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  try {
    const h = handleOf(dataRoot);
    let deleted = 0;
    // 保留窗只管"自动采集"的行。src='import' 是用户主动导入的档案，
    // 按 60 天把它删掉等于"导进来就没了"——那是数据丢失，不是清理。
    const keepImported = cfg.pruneImported !== true;
    const guard = keepImported ? " AND src <> 'import'" : '';
    const days = Number(cfg.retentionDays) || 0;
    if (days > 0) {
      const cutoff = Date.now() - days * 86400000;
      deleted += Number(h.db.prepare(`DELETE FROM chat WHERE ts < ?${guard}`).run(cutoff).changes) || 0;
    }
    const cap = Number(cfg.capPerScope) || 0;
    if (cap > 0) {
      // 条数上限同样只数自动采集的行：导入的长档案不该把实时台账挤掉，也不该被它挤掉
      const scopes = h.db.prepare(
        `SELECT scope, COUNT(*) AS n FROM chat WHERE 1=1${guard} GROUP BY scope HAVING n > ?`,
      ).all(cap);
      for (const s of scopes) {
        const over = Number(s.n) - cap;
        if (over <= 0) continue;
        deleted += Number(h.db.prepare(
          `DELETE FROM chat WHERE fp IN (SELECT fp FROM chat WHERE scope = ?${guard} ORDER BY ts ASC LIMIT ?)`,
        ).run(s.scope, over).changes) || 0;
      }
    }
    return { ok: true, deleted };
  } catch (e) {
    return { ok: false, deleted: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 清空某个 scope（测试/运维用） */
export function dropChatScope(dataRoot, scope) {
  try {
    const h = handleOf(dataRoot);
    return Number(h.db.prepare('DELETE FROM chat WHERE scope = ?').run(String(scope || '')).changes) || 0;
  } catch { return 0; }
}

export default {
  ingestChatHistory, appendChat, archiveMessages, queryChat, searchChat, chatStats, pruneChat,
  dropChatScope, cleanChatText, getChatState, setChatState, DEFAULTS,
};
