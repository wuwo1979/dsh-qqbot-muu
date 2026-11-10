/**
 * live/adapters/bilibili-web.mjs — B 站社区长连（web 协议）
 *
 * 能力：读取弹幕 / 礼物 / 进场 / 关注 / 上舰 / SC / 点赞 / 人气 / 开播下播，
 * 用登录 Cookie 发送弹幕（受平台限流与账号等级约束）。
 *
 * 说明：这是社区协议，不是官方开放平台。平台改版可能失效；官方接入见 bilibili-open.mjs。
 */
import { inflateSync, brotliDecompressSync } from 'node:zlib';
import { UA, cookieHeader } from '../../lib/bili-api.mjs';
import { normalizeBiliWeb, EVENT_TYPES } from '../event-model.mjs';
import { sendBiliDanmaku } from '../sender.mjs';

const OP = { HEARTBEAT: 2, HEARTBEAT_REPLY: 3, SEND_SMS_REPLY: 5, AUTH: 7, AUTH_REPLY: 8 };
const API = 'https://api.live.bilibili.com';

export function encodePacket(op, body = '', version = 1, seq = 1) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const buf = Buffer.alloc(16 + payload.length);
  buf.writeUInt32BE(buf.length, 0);
  buf.writeUInt16BE(16, 4);
  buf.writeUInt16BE(version, 6);
  buf.writeUInt32BE(op, 8);
  buf.writeUInt32BE(seq, 12);
  payload.copy(buf, 16);
  return buf;
}

function decodeRaw(buf) {
  const out = [];
  let offset = 0;
  while (offset + 16 <= buf.length) {
    const total = buf.readUInt32BE(offset);
    if (!total || total < 16 || offset + total > buf.length) break;
    const headerLen = buf.readUInt16BE(offset + 4);
    const ver = buf.readUInt16BE(offset + 6);
    const op = buf.readUInt32BE(offset + 8);
    const seq = buf.readUInt32BE(offset + 12);
    const body = buf.subarray(offset + headerLen, offset + total);
    out.push({ ver, op, seq, body });
    offset += total;
  }
  return out;
}

export function decodePackets(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const packets = [];
  for (const p of decodeRaw(buf)) {
    if (p.ver === 2) {
      try { packets.push(...decodePackets(inflateSync(p.body))); } catch { /* 坏包跳过 */ }
    } else if (p.ver === 3) {
      try { packets.push(...decodePackets(brotliDecompressSync(p.body))); } catch {
        try { packets.push(...decodePackets(inflateSync(p.body))); } catch { /* 坏包跳过 */ }
      }
    } else {
      packets.push(p);
    }
  }
  return packets;
}

async function httpJson(url, { cookie = null, timeoutMs = 12000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { 'user-agent': UA, accept: 'application/json', referer: 'https://live.bilibili.com/' };
    if (cookie && Object.keys(cookie).length) headers.cookie = cookieHeader(cookie);
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, error: 'bad-json' };
    if (Number(j.code ?? 0) !== 0) return { ok: false, code: Number(j.code), error: String(j.message || j.msg || 'api-error').slice(0, 80) };
    return { ok: true, data: j.data || {} };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

export class BiliWebAdapter {
  constructor({ dataRoot, cfg, cookies = {}, logger, redactor, onEvent, onStatus }) {
    this.dataRoot = dataRoot;
    this.cfg = cfg;
    this.cookies = cookies || {};
    this.logger = logger;
    this.redactor = redactor;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.ws = null;
    this.stopped = true;
    this.connecting = false;
    this.room = null;
    this.hosts = [];
    this.hostIndex = 0;
    this.token = '';
    this.heartbeatTimer = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.backoffMs = 3000;
    this.lastHttpAt = 0;
    this.lastPacketAt = 0;
    this.reconnects = 0;
    this.lastError = '';
    this.state = 'idle';
    this.selfName = String(cfg?.personaName || '小蓝');
  }

  snapshot() {
    return {
      state: this.state,
      room: this.room ? { id: this.redactor.maskId(this.room.realRoomId), title: String(this.room.title || '').slice(0, 40), liveStatus: this.room.liveStatus, uid: this.redactor.maskId(this.room.uid) } : null,
      hosts: this.hosts.length,
      host: this.hosts[this.hostIndex] ? this.redactor.scrubText(this.hosts[this.hostIndex].host) : '',
      reconnects: this.reconnects,
      lastPacketAt: this.lastPacketAt,
      lastError: this.redactor.scrubText(this.lastError),
    };
  }

  setState(state, extra = {}) {
    this.state = state;
    this.onStatus?.(this.snapshot(), extra);
  }

  waitHttpGap(ms = 1200) {
    const wait = Math.max(0, this.lastHttpAt + ms - Date.now());
    return wait ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
  }

  async resolveRoom() {
    await this.waitHttpGap();
    this.lastHttpAt = Date.now();
    let id = String(this.cfg?.bilibili?.roomId || '').trim();
    if (!id) {
      const mid = String(this.cookies.DedeUserID || '').trim();
      if (!mid) return { ok: false, error: '未配置房间号，且登录态里没有 DedeUserID' };
      const r = await httpJson(`${API}/room/v1/Room/getRoomInfoOld?mid=${encodeURIComponent(mid)}`, { cookie: this.cookies });
      if (!r.ok) return { ok: false, error: r.error };
      id = String(r.data?.roomid || '');
      if (!id) return { ok: false, error: '无法从账号 UID 反查直播间' };
    }
    const r = await httpJson(`${API}/room/v1/Room/get_info?room_id=${encodeURIComponent(id)}`, { cookie: this.cookies });
    if (!r.ok) return { ok: false, error: r.error };
    const d = r.data || {};
    const real = Number(d.room_id || id);
    this.room = {
      realRoomId: real,
      shortRoomId: Number(d.short_id || 0),
      uid: Number(d.uid || 0),
      title: String(d.title || ''),
      liveStatus: Number(d.live_status || 0),
    };
    this.logger?.info?.('房间已解析：' + this.redactor.maskId(real) + ' · 状态=' + this.room.liveStatus);
    return { ok: true, room: this.room };
  }

  async fetchDanmuInfo() {
    if (!this.room) return { ok: false, error: 'room-not-resolved' };
    await this.waitHttpGap();
    this.lastHttpAt = Date.now();
    const r = await httpJson(`${API}/xlive/web-room/v1/index/getDanmuInfo?id=${this.room.realRoomId}&type=0`, { cookie: this.cookies });
    if (r.ok) {
      const hosts = Array.isArray(r.data?.host_list) ? r.data.host_list : [];
      if (!hosts.length) return { ok: false, error: '平台没有返回长连节点' };
      this.hosts = hosts;
      this.token = String(r.data.token || '');
      return { ok: true, hosts };
    }
    // 新版接口在风控下会返回 -352，回退到旧版 getConf（字段名不同，需归一化）
    await this.waitHttpGap();
    this.lastHttpAt = Date.now();
    const old = await httpJson(`${API}/room/v1/Danmu/getConf?room_id=${this.room.realRoomId}&platform=pc&player=web`, { cookie: this.cookies });
    if (!old.ok) return { ok: false, error: old.error || r.error };
    const hosts = Array.isArray(old.data?.host_server_list) ? old.data.host_server_list : [];
    if (!hosts.length) return { ok: false, error: '平台没有返回长连节点' };
    this.hosts = hosts;
    this.token = String(old.data.token || '');
    return { ok: true, hosts, fallback: 'getConf' };
  }

  async ensureBuvid() {
    if (this.cookies?.buvid3) return;
    const r = await httpJson('https://api.bilibili.com/x/frontend/finger/spi', { timeoutMs: 8000 });
    const b = r.data || {};
    if (r.ok && b.b_3) this.cookies = { ...this.cookies, buvid3: String(b.b_3), buvid4: String(b.b_4 || b.b_3) };
  }

  async start() {
    this.stopped = false;
    if (this.connecting || this.ws) return { ok: true, msg: '已在运行' };
    await this.ensureBuvid();
    const rr = await this.resolveRoom();
    if (!rr.ok) {
      this.lastError = rr.error;
      this.setState('error');
      this.scheduleReconnect();
      return rr;
    }
    const always = Boolean(this.cfg?.bilibili?.alwaysConnect);
    if (!this.room.liveStatus && !always) {
      this.setState('waiting-live');
      this.schedulePoll();
      return { ok: true, msg: '未开播，等待开播' };
    }
    return this.connect();
  }

  schedulePoll() {
    if (this.stopped || this.pollTimer) return;
    const gap = Math.max(20000, Number(this.cfg?.bilibili?.pollLiveMs || 60000));
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (this.stopped) return;
      const r = await this.resolveRoom();
      if (r.ok && this.room?.liveStatus) {
        this.setState('connecting');
        this.connect();
      } else {
        this.setState(r.ok ? 'waiting-live' : 'error');
        this.schedulePoll();
      }
    }, gap);
    this.pollTimer.unref?.();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const wait = Math.min(30000, Math.max(5000, this.backoffMs)) + Math.floor(Math.random() * 2000);
    this.backoffMs = Math.min(30000, this.backoffMs * 1.8);
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      const r = await this.resolveRoom();
      if (!r.ok) { this.lastError = r.error; this.scheduleReconnect(); return; }
      if (!this.room.liveStatus && !this.cfg?.bilibili?.alwaysConnect) {
        this.setState('waiting-live');
        this.schedulePoll();
        return;
      }
      this.connect();
    }, wait);
    this.reconnectTimer.unref?.();
  }

  async connect() {
    if (this.stopped || this.connecting) return { ok: false, error: 'busy' };
    this.connecting = true;
    this.setState('connecting');
    try {
      const di = await this.fetchDanmuInfo();
      if (!di.ok) {
        this.lastError = di.error;
        this.connecting = false;
        this.scheduleReconnect();
        return { ok: false, error: di.error };
      }
      const host = this.hosts[this.hostIndex % this.hosts.length];
      this.hostIndex += 1;
      const url = `wss://${host.host}:${host.wss_port || 443}/sub`;
      this.logger?.info?.('连接长连节点：' + this.redactor.scrubText(host.host));
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timeout = setTimeout(() => { if (this.ws === ws && !this.authed) { try { ws.close(); } catch {} } }, 12000);
      timeout.unref?.();

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        const auth = {
          uid: Number(this.cookies.DedeUserID || 0),
          roomid: this.room.realRoomId,
          protover: 3,
          platform: 'web',
          type: 2,
          key: this.token,
          buvid: String(this.cookies.buvid3 || ''),
        };
        try { ws.send(encodePacket(OP.AUTH, JSON.stringify(auth), 1, 1)); } catch (e) { this.lastError = String((e && e.message) || e); }
      });

      ws.addEventListener('message', (ev) => {
        try { this.handleMessage(ev.data, ws); } catch (e) {
          this.lastError = String((e && e.message) || e);
          this.logger?.warn?.('解析长连消息失败：' + this.lastError);
        }
      });

      ws.addEventListener('error', () => {
        this.lastError = 'websocket-error';
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (this.ws !== ws) return;
        this.ws = null;
        this.authed = false;
        this.clearHeartbeat();
        this.connecting = false;
        if (!this.stopped) {
          this.reconnects += 1;
          this.scheduleReconnect();
        }
      });
      return { ok: true };
    } catch (e) {
      this.connecting = false;
      this.ws = null;
      this.lastError = String((e && e.message) || e).slice(0, 80);
      this.getLoggerWarn('建立长连失败：' + this.lastError);
      this.scheduleReconnect();
      return { ok: false, error: this.lastError };
    }
  }

  getLoggerWarn(msg) {
    try { this.logger?.warn?.(msg); } catch { /* ignore */ }
  }

  handleMessage(data, ws) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const packets = decodePackets(buf);
    for (const p of packets) {
      this.lastPacketAt = Date.now();
      if (p.op === OP.AUTH_REPLY) {
        let j = null;
        try { j = JSON.parse(p.body.toString('utf8')); } catch { j = null; }
        if (Number(j?.code) === 0) {
          this.authed = true;
          this.connecting = false;
          this.backoffMs = 3000;
          this.lastError = '';
          this.setState('live');
          this.startHeartbeat(ws);
        } else {
          this.authed = false;
          this.lastError = 'auth-code-' + String(j?.code ?? '');
          this.getLoggerWarn('鉴权失败：' + this.lastError);
          try { ws.close(); } catch { /* ignore */ }
        }
        continue;
      }
      if (p.op === OP.HEARTBEAT_REPLY) {
        continue;
      }
      if (p.op !== OP.SEND_SMS_REPLY) continue;
      let j = null;
      try { j = JSON.parse(p.body.toString('utf8')); } catch { continue; }
      if (!j || !j.cmd) continue;
      const ev = normalizeBiliWeb(j, { selfUid: this.cookies.DedeUserID, selfName: this.selfName });
      if (!ev || ev.type === EVENT_TYPES.UNKNOWN) continue;   // 在线榜/房间更新等无关 CMD 直接丢弃
      if (ev.type === 'live_end') {
        this.onEvent?.(ev);
        this.setState('waiting-live');
        try { ws.close(); } catch { /* ignore */ }
        this.schedulePoll();
        continue;
      }
      this.onEvent?.(ev);
    }
  }

  startHeartbeat(ws) {
    this.clearHeartbeat();
    const send = () => {
      if (this.ws !== ws || ws.readyState !== 1) return;
      try { ws.send(encodePacket(OP.HEARTBEAT, '', 1, 1)); } catch { /* ignore */ }
      if (this.lastPacketAt && Date.now() - this.lastPacketAt > 90000) {
        this.getLoggerWarn('长连 90 秒无数据，主动重连');
        try { ws.close(); } catch { /* ignore */ }
      }
    };
    send();
    this.heartbeatTimer = setInterval(send, 30000);
    this.heartbeatTimer.unref?.();
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async send(text) {
    if (!this.room) return { ok: false, error: 'room-not-resolved' };
    return sendBiliDanmaku({ cookies: this.cookies, roomId: this.room.realRoomId, text });
  }

  async stop() {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    this.connecting = false;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    this.setState('stopped');
  }
}
