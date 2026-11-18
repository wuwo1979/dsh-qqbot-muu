/**
 * 积压消息补回（2026-11-13）
 *
 * 解决的问题：DSH 重启/掉线期间，QQ 里的消息没人回；重启后模型完全不知道发生过什么。
 * 做法：启动时扫 `memory.db` 的 chat 表，找出「最后一条入站 晚于 最后一条出站」的会话，
 * 把这段积压合成**一条**上下文注入该会话，让 agent 自己按人格回，而不是发死文案。
 *
 * 设计要点：
 *  - 只处理 QQ 的 `c2c:<openid>` / `group:<openid>`（微信 `wechat:<convId>`、小天才 `c2c:<腕表id>`
 *    由各自插件管，注册进 memory.db 的 scope 形状不同，先不碰，避免注入到错会话）。
 *  - 同一会话多条合并成一条；超过 maxAgeMs 的只保留最后一条，避免刷屏。
 *  - 用 `catchup.json` 记录 `lastRunAt` + 已补过的会话水位，重启不会重复补。
 *  - 全流程 try/catch，任何异常只记日志，绝不影响启动。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = 'catchup.json';

function readJson(file, dflt) {
  try {
    if (!existsSync(file)) return dflt;
    return JSON.parse(readFileSync(file, 'utf8')) ?? dflt;
  } catch {
    return dflt;
  }
}

function writeJson(file, obj) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 1), 'utf8');
  } catch {
    /* 写不进去就下次再补 */
  }
}

/** 一条入站消息在注入时最多占多少字 */
const PER_LINE_MAX = 120;

function clip(s, n = PER_LINE_MAX) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {{injectToPeer:Function}} opts.manager
 * @param {{info?:Function,warn?:Function,error?:Function}} [opts.logger]
 * @param {number} [opts.maxAgeMs] 只补这么久以内的消息（默认 6 小时）
 * @param {number} [opts.limit] 单次最多看多少条入站（默认 300）
 * @returns {Promise<{scopes:number,injected:number,skipped:number}>}
 */
export async function catchupUnrepliedMessages(opts) {
  const { dataRoot, manager } = opts || {};
  const logger = opts?.logger;
  const maxAgeMs = Number(opts?.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : 24 * 3600 * 1000;
  const limit = Number(opts?.limit) > 0 ? Number(opts.limit) : 300;
  const out = { scopes: 0, injected: 0, skipped: 0 };
  if (!dataRoot || !manager || typeof manager.injectToPeer !== 'function') return out;

  const dbFile = join(dataRoot, '.qqbot', 'memory.db');
  if (!existsSync(dbFile)) return out;

  const stateFile = join(dataRoot, '.qqbot', STATE_FILE);
  const state = readJson(stateFile, { version: 1, lastRunAt: 0, peers: {} });
  const now = Date.now();
  // 只看最近 maxAgeMs；去重靠 per-scope 水位(state.peers)，不靠全局 lastRunAt
  const since = now - maxAgeMs;

  let rows = [];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    rows = db.prepare(
      // 2026-11-14：不再整类排掉 msg-history —— 那是群里/私聊的台账镜像，
      // 掉线期间被记进台账却没回的消息也长这样，排掉就永远补不回来。
      // 只排 'import'（人工批量回填的旧账）；群聊另加「叫到小蓝才补」的闸门，见下面。
      // 倒序取最近 limit 条再翻转：台账镜像进来后 24h 内行数可能上千，
      // 正序 limit 会被清早的闲聊占满，真正的近期积压反而进不来。
      "select scope, sender_id, sender, text, ts, coalesce(src,'') src from chat where dir = 'in' and ts > ? " +
        "and coalesce(src, '') <> 'import' " +
        "and coalesce(src, '') not like 'wechat%' and coalesce(src, '') not like 'xtc%' " +
        "order by ts desc limit ?",
    ).all(since, limit);
    rows.reverse();
    db.close?.();
  } catch (e) {
    logger?.warn?.('积压补回：读记忆库失败 ' + String((e && e.message) || e));
    return out;
  }
  if (!rows.length) {
    writeJson(stateFile, { ...state, lastRunAt: now });
    return out;
  }

  // scope -> { kind, peerId, msgs: [] }
  const groups = new Map();
  // 小天才也用 c2c:<腕表id> 的 scope，但它归 xtc 插件自己补回，这里排掉，避免串台。
  const xtcPeers = (() => {
    try {
      const f = join(dataRoot, '.qqbot', 'xtc-peers.json');
      if (!existsSync(f)) return new Set();
      return new Set(Object.keys(JSON.parse(readFileSync(f, 'utf8')) || {}));
    } catch { return new Set(); }
  })();
  for (const r of rows) {
    const scope = String(r.scope || '');
    const m = /^(c2c|group):([A-Za-z0-9_\-]+)$/.exec(scope);
    if (!m) continue; // 微信/小天才等其它形状先不碰
    const [, kind, peerId] = m;
    if (!peerId) continue;
    if (kind === 'c2c' && xtcPeers.has(peerId)) continue;
    if (!groups.has(scope)) groups.set(scope, { kind, peerId, msgs: [] });
    groups.get(scope).msgs.push({ text: clip(r.text), ts: Number(r.ts) || 0, sender: String(r.sender || '') });
  }
  out.scopes = groups.size;

  // 找一个「最后出站」时间用的只读连接：已经被正常回过的会话不再重复补。
  let db2 = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db2 = new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    db2 = null;
  }
  const lastOutOf = (scope) => {
    try {
      return Number(db2.prepare("select max(ts) as t from chat where scope = ? and dir = 'out'").get(scope)?.t || 0);
    } catch {
      return 0;
    }
  };

  for (const [scope, g] of groups) {
    try {
      const lastIn = g.msgs[g.msgs.length - 1]?.ts || 0;
      const seen = Number(state.peers?.[scope] || 0);
      if (seen && lastIn <= seen) {
        out.skipped += 1;
        continue;
      }
      // 最后一条出站晚于最后一条入站 ⇒ 这段已经有人回了，不重复注入
      if (lastOutOf(scope) >= lastIn) {
        out.skipped += 1;
        state.peers = { ...(state.peers || {}), [scope]: lastIn };
        continue;
      }
      // 群聊：只有叫到小蓝（或 Whale 简称）才补；没叫到就整段跳过——
      // 台账镜像会包含群里所有闲聊，不设闸门会把整段群聊当积压回一遍。
      if (g.kind === 'group') {
        const hit = g.msgs.some((x) => /小蓝|鲸|MuU/i.test(String(x.text || '')))
        if (!hit) {
          out.skipped += 1;
          state.peers = { ...(state.peers || {}), [scope]: lastIn };
          continue;
        }
      }
      // 太久远的只留最后几条，避免一次性灌太多
      const msgs = g.msgs.length > 6 ? g.msgs.slice(-6) : g.msgs;
      const lines = msgs.map((x) => '- ' + (x.sender ? x.sender + '：' : '') + x.text).join('\n');
      const note = [
        '[补回] 你刚才不在的时候，这边收到这些消息（按时间顺序）：',
        lines,
        '',
        '接着这个话头回一句就好：别解释自己刚才在忙什么、别说“刚看到”，也别把上面这些复述一遍。',
      ].join('\n');
      // injectToPeer 只往「已经在内存里」的会话注入；重启后会话表是空的，直接调必然 false，
      // 积压就永远补不出去（2026-11-14 定位：补回一直静默空转）。先 getOrCreate 建会话再注入。
      let ok = await manager.injectToPeer(g.kind, g.peerId, note, 'catchup');
      if (!ok && typeof manager.getOrCreate === 'function') {
        try {
          const rec = await manager.getOrCreate(g.kind, g.peerId, 'catchup', { scope: g.kind, targetId: g.peerId });
          if (rec) ok = await manager.injectToPeer(g.kind, g.peerId, note, 'catchup');
        } catch (e) {
          logger?.warn?.(`积压补回：建会话 ${scope} 失败 ` + String((e && e.message) || e));
        }
      }
      if (!ok) logger?.warn?.(`积压补回：${scope} 注入未成功，下次巡检再试`);
      if (ok) {
        out.injected += 1;
        state.peers = { ...(state.peers || {}), [scope]: lastIn };
      }
    } catch (e) {
      logger?.warn?.(`积压补回：注入 ${scope} 失败 ` + String((e && e.message) || e));
    }
  }

  writeJson(stateFile, { version: state.version || 1, lastRunAt: now, peers: state.peers || {} });
  try { db2?.close?.() } catch { /* ignore */ }
  if (out.injected) logger?.info?.(`积压补回：已补 ${out.injected} 个会话（共扫到 ${rows.length} 条入站）`);
  return out;
}
