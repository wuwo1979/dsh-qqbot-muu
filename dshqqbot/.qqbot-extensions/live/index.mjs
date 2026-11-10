/**
 * live/index.mjs — 直播模块控制器
 *
 * 职责：装载配置、创建平台 adapter、收事件 → 回复策略 → 生成短句 → 发弹幕/出草稿，
 * 并给浮窗与工具提供统一状态。
 *
 * 边界：本模块独立目录；不修改 scripts/ 运维脚本与表情包目录。
 */
import { loadConfig, loadSecrets, loadBiliCookies, pathsOf, saveConfig } from './config.mjs';
import { createRedactor, makeLogger } from './redact.mjs';
import { BiliWebAdapter } from './adapters/bilibili-web.mjs';
import { BiliOpenAdapter } from './adapters/bilibili-open.mjs';
import { DouyinAdapter } from './adapters/douyin.mjs';
import { loadState, saveState, appendJsonl, readTailJsonl } from './store.mjs';
import { decide, rollDay, prune, pickTemplate, sanitizeReply } from './reply-policy.mjs';
import { generateReply } from './persona.mjs';
import { EVENT_TYPES } from './event-model.mjs';

const DAY = 24 * 3600_000;
const SLOT = Symbol.for('qqbot.live.controller');

import { withRetry } from '../lib/retry.mjs';

function safeText(s, max = 60) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 纯文本降级：去掉颜文字方括号段、非 BMP emoji 与零宽字符，压缩空白（P2-3） */
function plainize(text) {
  return String(text || '')
    .replace(/\[[^\]]{0,16}\]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class LiveController {
  constructor(dataRoot, env = {}) {
    this.dataRoot = String(dataRoot || '');
    this.env = env;
    this.cfg = loadConfig(this.dataRoot);
    this.paths = pathsOf(this.dataRoot);
    this.state = loadState(this.paths.stateFile);
    // P2-3：队列溢出丢弃计数（旧 state 文件没有这个键，lazy 补）
    this.state.drop = this.state.drop || { overflow: 0, lastAt: 0 };
    this.dropWarnAt = 0;
    this.secrets = loadSecrets(this.dataRoot);
    this.cookies = loadBiliCookies(this.dataRoot);
    this.redactor = createRedactor({
      roomId: this.cfg?.bilibili?.roomId,
      uid: this.cookies?.DedeUserID,
      tokens: [this.cfg?.bilibili?.roomId, this.cookies?.DedeUserID],
      cookies: this.cookies,
    });
    this.logger = makeLogger(env.logger, this.redactor, 'live');
    this.adapter = null;
    this.running = false;
    this.busy = false;
    this.chain = Promise.resolve();
    this.chainPending = 0;
    this.ring = [];
    this.enterBuf = [];
    this.draftAt = [];
    this.seen = new Map();
    this.saveTimer = null;
    this.enterTimer = null;
    this.lastManualAt = 0;
    this.lastStatus = null;
    this.platform = 'bilibili';
  }

  // ---------- 生命周期 ----------

  async start() {
    if (this.running) return { ok: true, msg: '已在运行', status: this.status() };
    this.reload();
    this.running = true;
    this.platform = String(this.cfg.platform || 'bilibili');
    this.startLoopTimers();
    if (this.cfg.enabled === false) {
      this.logger.info('直播模块配置为关闭（live-config.json enabled=false）');
      return { ok: true, msg: '模块已关闭，仅加载未连接', status: this.status() };
    }
    this.adapter = this.createAdapter();
    if (!this.adapter) return { ok: false, error: '不支持的平台：' + this.platform, status: this.status() };
    this.logger.info('启动直播适配器：' + this.platform + '/' + (this.cfg?.bilibili?.channel || ''));
    const r = await this.adapter.start();
    return { ...(r || { ok: true }), status: this.status() };
  }

  createAdapter() {
    if (this.platform === 'douyin') {
      return new DouyinAdapter({ cfg: this.cfg, logger: this.logger, redactor: this.redactor, onEvent: (e) => this.enqueue(e), onStatus: (s) => { this.lastStatus = s; } });
    }
    if (this.cfg?.bilibili?.channel === 'open') {
      return new BiliOpenAdapter({
        dataRoot: this.dataRoot,
        cfg: this.cfg,
        secrets: this.secrets,
        logger: this.logger,
        redactor: this.redactor,
        onEvent: (e) => this.enqueue(e),
        onStatus: (s) => { this.lastStatus = s; },
      });
    }
    return new BiliWebAdapter({
      dataRoot: this.dataRoot,
      cfg: this.cfg,
      cookies: this.cookies,
      logger: this.logger,
      redactor: this.redactor,
      onEvent: (e) => this.enqueue(e),
      onStatus: (s) => { this.lastStatus = s; },
    });
  }

  reload() {
    this.cfg = loadConfig(this.dataRoot);
    this.paths = pathsOf(this.dataRoot);
    this.secrets = loadSecrets(this.dataRoot);
    this.cookies = loadBiliCookies(this.dataRoot);
    this.redactor = createRedactor({
      roomId: this.cfg?.bilibili?.roomId,
      uid: this.cookies?.DedeUserID,
      tokens: [this.cfg?.bilibili?.roomId, this.cookies?.DedeUserID],
      cookies: this.cookies,
    });
  }

  async stop() {
    this.running = false;
    if (this.adapter) await this.adapter.stop().catch(() => null);
    this.adapter = null;
    this.stopLoopTimers();
    this.saveStateNow();
    this.logger.info('直播模块已停止');
    return { ok: true, msg: '已停止' };
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  startLoopTimers() {
    this.stopLoopTimers();
    this.saveTimer = setInterval(() => this.saveStateNow(), 30000);
    this.saveTimer.unref?.();
    this.enterTimer = setInterval(() => this.flushEnter(), 30000);
    this.enterTimer.unref?.();
  }

  stopLoopTimers() {
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.enterTimer) clearInterval(this.enterTimer);
    this.saveTimer = null;
    this.enterTimer = null;
  }

  saveStateNow() {
    try { saveState(this.paths.stateFile, this.state); } catch { /* ignore */ }
  }

  // ---------- 事件处理 ----------

  enqueue(event) {
    if (!event || !this.running) return;
    this.chainPending += 1;
    if (this.chainPending > 80 && event.type !== EVENT_TYPES.SUPERCHAT && event.type !== EVENT_TYPES.GUARD) {
      this.chainPending -= 1;
      // P2-3：高峰期不再静默丢弃 —— 计数进 status.drop（浮窗可见），告警按 60s 节流
      const now = Date.now();
      this.state.drop.overflow += 1;
      this.state.drop.lastAt = now;
      this.state.counters.droppedOverflow = (this.state.counters.droppedOverflow || 0) + 1;
      if (now - this.dropWarnAt >= 60_000) {
        this.dropWarnAt = now;
        this.logger.warn('直播事件队列溢出，累计丢弃 ' + this.state.drop.overflow + ' 条');
      }
      return;
    }
    this.chain = this.chain
      .then(() => this.processEvent(event))
      .catch((e) => this.logger.warn('事件处理异常：' + String((e && e.message) || e)))
      .finally(() => { this.chainPending = Math.max(0, this.chainPending - 1); });
  }

  rememberEvent(summary) {
    this.ring.push(summary);
    if (this.ring.length > 40) this.ring.shift();
    this.writeEventLog(summary);
  }

  writeEventLog(summary) {
    if (this.cfg.log?.persistEvents === false) return;
    appendJsonl(this.paths.eventsFile, this.redactor.scrub(summary), {
      maxBytes: Number(this.cfg.log?.maxBytes || 1048576),
      keepLines: Number(this.cfg.log?.keepLines || 2000),
    });
  }

  async processEvent(event) {
    const now = Date.now();
    rollDay(this.state, now);
    prune(this.state, now);

    // 内存去重：平台重复推送 / 连击包重复
    if (this.seen.has(event.key)) {
      this.noteSkip(event, 'duplicate-memory', now);
      return;
    }
    this.seen.set(event.key, now);
    for (const [k, at] of this.seen) if (now - at > 300000) this.seen.delete(k);

    if (event.type === EVENT_TYPES.LIVE_START) {
      this.logger.info('检测到开播');
      this.lastStatus = { state: 'live', room: this.lastStatus?.room || null };
      return;
    }
    if (event.type === EVENT_TYPES.LIVE_END) {
      this.logger.info('检测到下播');
      this.lastStatus = { state: 'waiting-live', room: this.lastStatus?.room || null };
      return;
    }

    if (event.type === EVENT_TYPES.ENTER) {
      this.enterBuf.push(now);
      if (this.enterBuf.length > 200) this.enterBuf.shift();
      if (this.cfg.reply?.replyToEnter !== true) {
        this.noteSkip(event, 'enter-aggregate', now, { silentLog: true });
        return;
      }
    }

    const decision = decide(event, this.cfg.reply || {}, this.state, { now });
    if (!decision.reply) {
      this.noteSkip(event, decision.reason, now, { silentLog: decision.reason === 'low-interest' });
      return;
    }
    await this.deliver(event, decision, now);
  }

  noteSkip(event, reason, now, { silentLog = false } = {}) {
    this.state.counters.skipped = (this.state.counters.skipped || 0) + 1;
    this.state.totals.skipped = (this.state.totals.skipped || 0) + 1;
    const summary = { at: now, type: event.type, name: event.user?.name || '', uid: event.user?.id || '', text: safeText(event.text, 40), rmb: event.amount?.rmb ?? 0, cmd: event.cmd, action: 'skip', reason };
    this.rememberEvent(summary);
    if (!silentLog) this.logger.debug('跳过：' + event.type + ' · ' + reason);
  }

  /** P2-3：发送带 1 次重试；两次都失败则降级纯文本再试；仍失败才交给调用方记 error */
  async sendWithRetry(text, { retries = 1, gapMs = 300 } = {}) {
    if (!this.adapter) return { ok: false, error: '未连接' };
    const attempt = async (t) => {
      const r = await this.adapter.send(t);
      if (!r?.ok) {
        const e = new Error(String(r?.error || 'send-failed'));
        e.result = r;
        throw e;
      }
      return r;
    };
    let r;
    if (process.env.QQBOT_RETRY_ENGINE === 'legacy') {
      r = await this.adapter.send(text);
      for (let i = 0; !r?.ok && i < retries; i++) {
        await new Promise((res) => setTimeout(res, gapMs * (i + 1)));
        r = await this.adapter.send(text);
      }
    } else {
      try { return await withRetry(() => attempt(text), { retries, gapMs, factor: 1 }); }
      catch (e) { r = e.result || { ok: false, error: String(e.message || e) }; }
    }
    if (!r?.ok) {
      const plain = plainize(text);
      if (plain && plain !== text) {
        try { return await attempt(plain); }
        catch (e) { return e.result || { ok: false, error: String(e.message || e) }; }
      }
    }
    return r || { ok: false, error: 'send-failed' };
  }

  async deliver(event, decision, now) {
    if (this.busy) {
      this.noteSkip(event, 'busy', now);
      return;
    }
    this.busy = true;
    try {
      let text = '';
      let source = 'template';
      let tokens = 0;
      if (decision.useLLM) {
        const g = await generateReply(this.dataRoot, event, this.cfg.reply || {}, { state: this.state });
        text = g.text;
        source = g.source;
        tokens = g.tokens || 0;
        if (source === 'llm') {
          this.state.llmAt.push(now);
          this.state.counters.llmCalls = (this.state.counters.llmCalls || 0) + 1;
          this.state.counters.tokens = (this.state.counters.tokens || 0) + tokens;
          this.state.totals.llmCalls = (this.state.totals.llmCalls || 0) + 1;
          this.state.totals.tokens = (this.state.totals.tokens || 0) + tokens;
        }
      }
      if (!text) {
        text = pickTemplate(event, this.cfg.reply || {}, this.state);
        source = 'template';
      }
      text = sanitizeReply(text, Number(this.cfg.reply?.maxChars || 26));
      if (!text) {
        this.noteSkip(event, 'empty-reply', now);
        return;
      }

      if (this.cfg.reply?.dryRun !== false) {
        if (!this.draftAllowed(now)) {
          this.noteSkip(event, 'draft-rate', now);
          return;
        }
        this.draftAt.push(now);
        this.state.counters.drafts = (this.state.counters.drafts || 0) + 1;
        this.state.totals.drafts = (this.state.totals.drafts || 0) + 1;
        appendJsonl(this.paths.draftsFile, this.redactor.scrub({ at: now, type: event.type, name: event.user?.name || '', uid: event.user?.id || '', text: safeText(event.text, 40), reply: text, source }), {
          maxBytes: Number(this.cfg.log?.maxBytes || 1048576),
          keepLines: Number(this.cfg.log?.keepLines || 2000),
        });
        this.rememberEvent({ at: now, type: event.type, name: event.user?.name || '', uid: event.user?.id || '', text: safeText(event.text, 40), rmb: event.amount?.rmb ?? 0, cmd: event.cmd, action: 'draft', reply: text, source });
        this.logger.info('草稿：' + text);
        return;
      }

      const sent = await this.sendWithRetry(text);
      if (!sent?.ok) {
        this.state.counters.errors = (this.state.counters.errors || 0) + 1;
        this.state.totals.errors = (this.state.totals.errors || 0) + 1;
        this.logger.warn('发送失败：' + String(sent?.error || 'unknown'));
        this.rememberEvent({ at: now, type: event.type, name: event.user?.name || '', uid: event.user?.id || '', text: safeText(event.text, 40), rmb: event.amount?.rmb ?? 0, cmd: event.cmd, action: 'error', reason: safeText(sent?.error, 60), reply: text });
        return;
      }
      this.markReply(event, text, now);
      this.rememberEvent({ at: now, type: event.type, name: event.user?.name || '', uid: event.user?.id || '', text: safeText(event.text, 40), rmb: event.amount?.rmb ?? 0, cmd: event.cmd, action: 'sent', reply: text, source });
      this.logger.info('已回复：' + text);
    } finally {
      this.busy = false;
    }
  }

  draftAllowed(now) {
    const maxPerMinute = Number(this.cfg.reply?.maxPerMinute || 4);
    const gap = Number(this.cfg.reply?.minGapMs || 8000);
    const last = this.draftAt[this.draftAt.length - 1] || 0;
    if (last && now - last < gap) return false;
    this.draftAt = this.draftAt.filter((t) => now - t < 60_000);
    return this.draftAt.length < maxPerMinute;
  }

  markReply(event, text, now) {
    this.state.sentAt.push(now);
    this.state.lastSentAt = now;
    this.state.counters.replies = (this.state.counters.replies || 0) + 1;
    this.state.totals.replies = (this.state.totals.replies || 0) + 1;
    this.state.recentKeys[event.key] = now;
    this.state.recentTexts = this.state.recentTexts || [];
    this.state.recentTexts.push({ at: now, text });
    this.state.recentTexts = this.state.recentTexts.slice(-20);
    const uid = event.user?.id;
    if (uid) {
      const rec = this.state.perUser[uid] || { lastAt: 0, sentAt: [] };
      rec.lastAt = now;
      rec.sentAt = rec.sentAt || [];
      rec.sentAt.push(now);
      this.state.perUser[uid] = rec;
    }
    if (event.type === EVENT_TYPES.FOLLOW) this.state.lastWelcomeAt = now;
    this.saveStateNow();
  }

  flushEnter() {
    if (!this.running) return;
    const agg = this.cfg.reply?.enterAggregate || {};
    if (agg.enabled === false || this.cfg.reply?.replyToEnter === true) { this.enterBuf = []; return; }
    const now = Date.now();
    const windowMs = Number(agg.windowMs || 60000);
    this.enterBuf = this.enterBuf.filter((t) => now - t <= windowMs);
    if (this.enterBuf.length < Number(agg.minCount || 5)) return;
    if (now - (this.state.lastEnterFlushAt || 0) < windowMs) return;
    const prev = this.state.lastSentAt || 0;
    if (now - prev < Number(this.cfg.reply?.minGapMs || 8000)) return;
    const text = pickTemplate({ type: EVENT_TYPES.ENTER, user: {} }, this.cfg.reply || {}, this.state);
    this.state.lastEnterFlushAt = now;
    this.enterBuf = [];
    if (this.cfg.reply?.dryRun !== false) {
      appendJsonl(this.paths.draftsFile, this.redactor.scrub({ at: now, type: 'enter-aggregate', reply: text, source: 'template' }), {
        maxBytes: Number(this.cfg.log?.maxBytes || 1048576),
        keepLines: Number(this.cfg.log?.keepLines || 2000),
      });
      this.state.counters.drafts = (this.state.counters.drafts || 0) + 1;
      this.rememberEvent({ at: now, type: 'enter-aggregate', action: 'draft', reply: text, source: 'template' });
      return;
    }
    this.sendWithRetry(text).then((r) => {
      if (r?.ok) {
        this.markReply({ type: EVENT_TYPES.ENTER, user: {} , key: 'enter:' + now }, text, now);
        this.rememberEvent({ at: now, type: 'enter-aggregate', action: 'sent', reply: text, source: 'template' });
      } else {
        this.logger.warn('进场聚合发送失败：' + String(r?.error || 'unknown'));
      }
    }).catch(() => null);
  }

  // ---------- 状态 ----------

  status() {
    const now = Date.now();
    const sent = (this.state.sentAt || []).filter((t) => now - t < DAY);
    const llm = (this.state.llmAt || []).filter((t) => now - t < DAY);
    const adapter = this.adapter?.snapshot?.() || this.lastStatus || { state: this.running ? 'idle' : 'stopped' };
    const reply = this.cfg.reply || {};
    return {
      ok: true,
      running: this.running,
      platform: this.platform,
      channel: this.platform === 'bilibili' ? String(this.cfg?.bilibili?.channel || 'web') : 'douyin',
      dryRun: reply.dryRun !== false,
      room: adapter.room || null,
      connection: adapter,
      counters: { ...this.state.counters },
      drop: { overflow: Number(this.state.drop?.overflow || 0), lastAt: Number(this.state.drop?.lastAt || 0) },
      budgets: {
        sentLastMinute: sent.filter((t) => now - t < 60_000).length,
        maxPerMinute: Number(reply.maxPerMinute || 4),
        sentLastHour: sent.filter((t) => now - t < 3600_000).length,
        maxPerHour: Number(reply.maxPerHour || 30),
        llmLastHour: llm.filter((t) => now - t < 3600_000).length,
        maxLlmPerHour: Number(reply.llm?.maxCallsPerHour || 10),
        tokensToday: Number(this.state.counters.tokens || 0),
        maxTokensPerDay: Number(reply.llm?.maxTokensPerDay || 0),
      },
      replyConfig: {
        enabled: reply.enabled !== false,
        dryRun: reply.dryRun !== false,
        mentionNames: reply.mentionNames || [],
        keywords: reply.keywords || [],
        chatSampleRate: reply.chatSampleRate,
        quietHours: reply.quietHours || [],
        alwaysConnect: Boolean(this.cfg?.bilibili?.alwaysConnect),
      },
      secrets: { configured: Boolean(this.secrets?.configured), files: Number(this.secrets?.files || 0) },
      recent: this.ring.slice(-20),
      lastError: adapter.lastError || '',
    };
  }

  recent(limit = 20) {
    const n = Math.max(1, Math.min(40, Number(limit) || 20));
    const tail = readTailJsonl(this.paths.eventsFile, n);
    return tail.length ? tail : this.ring.slice(-n);
  }

  reloadFromConfig() {
    this.reload();
    if (this.adapter) {
      this.adapter.cfg = this.cfg;
      this.adapter.cookies = this.cookies;
      this.adapter.selfName = String(this.cfg?.reply?.personaName || '小蓝');
    }
  }

  async manualSay(text) {
    const clean = sanitizeReply(String(text || ''), 30);
    if (!clean) return { ok: false, error: '内容为空或全是链接' };
    const now = Date.now();
    if (now - this.lastManualAt < 8000) return { ok: false, error: '手动发送间隔至少 8 秒' };
    if (!this.adapter) return { ok: false, error: '连接未启动' };
    const r = await this.adapter.send(clean);
    if (r?.ok) {
      this.lastManualAt = now;
      this.state.sentAt.push(now);
      this.state.counters.replies = (this.state.counters.replies || 0) + 1;
      this.rememberEvent({ at: now, type: 'manual', action: 'sent', reply: clean, source: 'manual' });
    }
    return r;
  }
}

// ---------- 单例 ----------

export function getController(dataRoot, env = {}) {
  const key = String(dataRoot || '') || 'default';
  if (!globalThis[SLOT]) globalThis[SLOT] = new Map();
  const map = globalThis[SLOT];
  if (!map.has(key)) map.set(key, new LiveController(dataRoot, env));
  const c = map.get(key);
  if (env && env.logger) c.logger = makeLogger(env.logger, c.redactor, 'live');
  return c;
}

export async function startLive(dataRoot, env = {}) {
  return getController(dataRoot, env).start();
}

export async function stopLive(dataRoot, env = {}) {
  return getController(dataRoot, env).stop();
}

export function liveStatus(dataRoot, env = {}) {
  return getController(dataRoot, env).status();
}

export function isOwner(env = {}, cfg = {}) {
  if (env.internal === true) return true;
  if (env.user && typeof env.user.isOwner === 'boolean') return env.user.isOwner;
  const actor = String(env.actorOpenid || env.senderId || env.userId || '').trim();
  if (!actor) return false;
  const owners = [...(Array.isArray(env.owners) ? env.owners : []), ...(Array.isArray(cfg.ownerOpenids) ? cfg.ownerOpenids : [])]
    .map((x) => String(x || '').trim()).filter(Boolean);
  return owners.includes(actor);
}

export async function panel(dataRoot, body = {}, env = {}) {
  const c = getController(dataRoot, env);
  const action = String(body.action || 'status');
  try {
    if (action === 'status') return c.status();
    if (action === 'recent') return { ok: true, events: c.recent(body.limit) };
    if (action === 'start') return c.start();
    if (action === 'stop') return c.stop();
    if (action === 'restart') return c.restart();
    if (action === 'start-reply') {
      saveConfig(dataRoot, { reply: { enabled: true } });
      c.reloadFromConfig();
      return { ok: true, msg: '回复已开启', status: c.status() };
    }
    if (action === 'stop-reply') {
      saveConfig(dataRoot, { reply: { enabled: false } });
      c.reloadFromConfig();
      return { ok: true, msg: '回复已关闭', status: c.status() };
    }
    if (action === 'set-room') {
      const roomId = String(body.roomId || '').replace(/[^\d]/g, '').slice(0, 20);
      if (!roomId) return { ok: false, error: '房间号只能是数字' };
      saveConfig(dataRoot, { bilibili: { roomId } });
      await c.restart();
      return { ok: true, msg: '房间已保存，正在重连', status: c.status() };
    }
    if (action === 'set-reply') {
      const patch = { reply: {} };
      if (typeof body.dryRun === 'boolean') patch.reply.dryRun = body.dryRun;
      if (typeof body.enabled === 'boolean') patch.reply.enabled = body.enabled;
      if (typeof body.alwaysConnect === 'boolean') patch.bilibili = { alwaysConnect: body.alwaysConnect };
      if (body.keywords !== undefined) patch.reply.keywords = Array.isArray(body.keywords) ? body.keywords.slice(0, 30).map(String) : [];
      if (body.mentionNames !== undefined) patch.reply.mentionNames = Array.isArray(body.mentionNames) ? body.mentionNames.slice(0, 10).map(String) : [];
      if (body.chatSampleRate !== undefined) patch.reply.chatSampleRate = Math.max(0, Math.min(1, Number(body.chatSampleRate) || 0));
      saveConfig(dataRoot, patch);
      c.reloadFromConfig();
      if (typeof body.alwaysConnect === 'boolean' && body.alwaysConnect) await c.restart();
      return { ok: true, msg: '已保存', status: c.status() };
    }
    if (action === 'say') {
      const r = await c.manualSay(String(body.text || ''));
      return { ...r, status: c.status() };
    }
    if (action === 'douyin') {
      return { ok: true, placeholder: true, note: '抖音直播仅保留 adapter 与事件映射，不实现具体逻辑。', status: c.status() };
    }
    if (action === 'config') {
      return {
        ok: true,
        cfg: {
          platform: c.cfg.platform,
          bilibili: { channel: c.cfg?.bilibili?.channel, roomIdMasked: c.redactor.maskId(c.cfg?.bilibili?.roomId), alwaysConnect: c.cfg?.bilibili?.alwaysConnect },
          reply: c.cfg.reply,
          storage: c.paths.storage,
        },
      };
    }
    return { ok: false, error: '未知 action：' + action, status: c.status() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120), status: c.status() };
  }
}
