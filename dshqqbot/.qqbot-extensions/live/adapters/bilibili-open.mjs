/**
 * live/adapters/bilibili-open.mjs — B 站官方直播开放平台（open 协议）
 *
 * 鉴权：HMAC-SHA256 请求头签名 + 主播身份码 code。
 * 限制：需要开放平台入驻、创建项目并审核；未上架应用只能连开发者自己的直播间。
 * 因此该通道在个人场景下通常不可用，代码先按官方文档实现，缺凭据时给出明确错误。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { normalizeOpen } from '../event-model.mjs';
import { encodePacket, decodePackets } from './bilibili-web.mjs';

const HOST = 'https://live-open.biliapi.com';
const OP = { HEARTBEAT: 2, SEND_SMS_REPLY: 5, AUTH: 7, AUTH_REPLY: 8 };

const ERR = {
  4001: '应用无效（检查 access_key_id）',
  4002: '签名异常',
  4003: '请求过期（本机时间不准？）',
  4004: '重复请求',
  4005: '签名算法异常',
  4007: 'IP 白名单限制（需要把本机出口 IP 报备到开放平台）',
  4008: '接口权限异常',
  4009: '接口访问限制（频率或权限不足）',
  5004: '房间白名单限制：未上架应用只能连开发者自己的直播间',
  5011: '应用权限限制',
  7007: '主播身份码错误或过期',
  7010: '同一应用单直播间连接数超过上限（最多 5 个）',
};

export class BiliOpenAdapter {
  constructor({ dataRoot, cfg, secrets, logger, redactor, onEvent, onStatus }) {
    this.dataRoot = dataRoot;
    this.cfg = cfg;
    this.secrets = secrets?.bilibili || {};
    this.logger = logger;
    this.redactor = redactor;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.ws = null;
    this.stopped = true;
    this.connecting = false;
    this.gameId = '';
    this.wsInfo = null;
    this.anchor = null;
    this.hostIndex = 0;
    this.backoffMs = 3000;
    this.reconnects = 0;
    this.lastError = '';
    this.state = 'idle';
    this.hbTimer = null;
    this.wsHbTimer = null;
  }

  snapshot() {
    return {
      state: this.state,
      room: this.anchor ? { id: this.redactor.maskId(this.anchor.room_id), uid: this.redactor.maskId(this.anchor.uid), name: String(this.anchor.uname || '').slice(0, 20), liveStatus: 1 } : null,
      reconnects: this.reconnects,
      lastError: this.redactor.scrubText(this.lastError),
      channel: 'open',
    };
  }

  setState(state) { this.state = state; this.onStatus?.(this.snapshot()); }

  signedHeaders(bodyText) {
    const s = this.secrets;
    if (!s.accessKeyId || !s.accessKeySecret) throw new Error('缺少官方开放平台 access_key_id / access_key_secret');
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const md5 = createHash('md5').update(bodyText).digest('hex');
    const headerStr = [
      `x-bili-accesskeyid:${s.accessKeyId}`,
      `x-bili-content-md5:${md5}`,
      'x-bili-signature-method:HMAC-SHA256',
      `x-bili-signature-nonce:${nonce}`,
      'x-bili-signature-version:1.0',
      `x-bili-timestamp:${ts}`,
    ].join('\n');
    const sign = createHmac('sha256', s.accessKeySecret).update(headerStr).digest('hex');
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-bili-accesskeyid': s.accessKeyId,
      'x-bili-content-md5': md5,
      'x-bili-signature-method': 'HMAC-SHA256',
      'x-bili-signature-nonce': nonce,
      'x-bili-signature-version': '1.0',
      'x-bili-timestamp': ts,
      authorization: sign,
    };
  }

  async call(path, body, timeoutMs = 15000) {
    const text = JSON.stringify(body || {});
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(HOST + path, { method: 'POST', headers: this.signedHeaders(text), body: text, signal: ctl.signal });
      const j = await res.json().catch(() => null);
      const code = Number(j?.code ?? -1);
      if (code !== 0) return { ok: false, code, error: ERR[code] || String(j?.message || 'open-api-error').slice(0, 80) };
      return { ok: true, data: j?.data || {} };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 80) };
    } finally {
      clearTimeout(timer);
    }
  }

  async start() {
    this.stopped = false;
    if (this.connecting || this.ws) return { ok: true, msg: '已在运行' };
    if (!this.secrets.appId || !this.secrets.identityCode || !this.secrets.accessKeyId) {
      this.lastError = '未配置官方开放平台凭据（appId / accessKeyId / accessKeySecret / identityCode）';
      this.setState('not-configured');
      return { ok: false, error: this.lastError, configured: false };
    }
    const r = await this.call('/v2/app/start', { code: this.secrets.identityCode, app_id: Number(this.secrets.appId) });
    if (!r.ok) {
      this.lastError = r.error || 'start-failed';
      this.setState('error');
      this.scheduleReconnect();
      return r;
    }
    this.gameId = String(r.data?.game_info?.game_id || '');
    this.wsInfo = r.data?.websocket_info || null;
    this.anchor = r.data?.anchor_info || null;
    if (!this.gameId || !this.wsInfo?.wss_link?.length) {
      this.lastError = '开放平台返回缺少长连信息';
      this.setState('error');
      return { ok: false, error: this.lastError };
    }
    return this.connect();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.setState('reconnecting');
    const wait = Math.min(30000, this.backoffMs) + Math.floor(Math.random() * 2000);
    this.backoffMs = Math.min(30000, this.backoffMs * 1.8);
    setTimeout(() => { if (!this.stopped) this.connect(); }, wait).unref?.();
  }

  async connect() {
    if (this.stopped || this.connecting) return { ok: false, error: 'busy' };
    this.connecting = true;
    this.setState('connecting');
    const links = this.wsInfo?.wss_link || [];
    if (!links.length) { this.connecting = false; return { ok: false, error: 'no-wss-link' }; }
    const url = links[this.hostIndex % links.length];
    this.hostIndex += 1;
    try {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.addEventListener('open', () => {
        try { ws.send(encodePacket(OP.AUTH, this.wsInfo?.auth_body || '{}', 1, 1)); } catch (e) { this.lastError = String((e && e.message) || e); }
      });
      ws.addEventListener('message', (ev) => { try { this.handleMessage(ev.data, ws); } catch (e) { this.lastError = String((e && e.message) || e); } });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.connecting = false;
        this.clearTimers();
        if (!this.stopped) { this.reconnects += 1; this.scheduleReconnect(); }
      });
      ws.addEventListener('error', () => { this.lastError = 'websocket-error'; });
      return { ok: true };
    } catch (e) {
      this.connecting = false;
      this.ws = null;
      this.lastError = String((e && e.message) || e).slice(0, 80);
      this.scheduleReconnect();
      return { ok: false, error: this.lastError };
    }
  }

  handleMessage(data, ws) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (const p of decodePackets(buf)) {
      if (p.op === OP.AUTH_REPLY) {
        this.connecting = false;
        this.backoffMs = 3000;
        this.lastError = '';
        this.setState('live');
        this.startTimers(ws);
        continue;
      }
      if (p.op !== OP.SEND_SMS_REPLY) continue;
      let j = null;
      try { j = JSON.parse(p.body.toString('utf8')); } catch { continue; }
      const ev = normalizeOpen(j, {});
      if (ev) this.onEvent?.(ev);
    }
  }

  startTimers(ws) {
    this.clearTimers();
    const wsBeat = () => { if (this.ws === ws && ws.readyState === 1) { try { ws.send(encodePacket(OP.HEARTBEAT, '', 1, 1)); } catch { /* ignore */ } } };
    wsBeat();
    this.wsHbTimer = setInterval(wsBeat, 20000);
    this.wsHbTimer.unref?.();
    const apiBeat = async () => {
      if (!this.gameId) return;
      const r = await this.call('/v2/app/heartbeat', { game_id: this.gameId });
      if (!r.ok) {
        this.lastError = r.error || 'heartbeat-failed';
        this.bothWarn('项目心跳失败：' + this.lastError);
        try { ws.close(); } catch { /* ignore */ }
      }
    };
    this.hbTimer = setInterval(apiBeat, 20000);
    this.hbTimer.unref?.();
  }

  bothWarn(msg) { try { this.logger?.warn?.(msg); } catch { /* ignore */ } }

  clearTimers() {
    if (this.wsHbTimer) clearInterval(this.wsHbTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.wsHbTimer = null;
    this.hbTimer = null;
  }

  async send() {
    return { ok: false, error: '官方通道暂未接入消息发送（需要额外权限与报备）' };
  }

  async stop() {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.connecting = false;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    if (this.gameId) {
      // 必须调用 end，否则影响后续场次与礼物投放
      await this.call('/v2/app/end', { app_id: Number(this.secrets.appId), game_id: this.gameId }).catch(() => null);
      this.gameId = '';
    }
    this.setState('stopped');
  }
}
