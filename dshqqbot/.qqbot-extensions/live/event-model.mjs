/**
 * live/event-model.mjs — 跨平台统一直播事件模型
 *
 * 任何平台（B 站社区长连 / 官方开放平台 / 将来的抖音）解析后都产出同一结构，
 * 回复策略与面板只依赖这个结构，不依赖平台原始 JSON。
 *
 * 注意：事件里只保留脱敏后的用户标识，原始 uid/open_id/msg 原始包不进事件对象。
 */
import { createHash } from 'node:crypto';
import { maskId } from './redact.mjs';

export const EVENT_TYPES = {
  DANMAKU: 'danmaku',
  GIFT: 'gift',
  ENTER: 'enter',
  FOLLOW: 'follow',
  SHARE: 'share',
  LIKE: 'like',
  GUARD: 'guard',
  SUPERCHAT: 'superchat',
  LIVE_START: 'live_start',
  LIVE_END: 'live_end',
  WATCH: 'watch',
  UNKNOWN: 'unknown',
};

export function hashKey(input) {
  return createHash('sha1').update(String(input)).digest('hex').slice(0, 16);
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function tsMs(v) {
  const n = num(v, 0);
  if (!n) return Date.now();
  return n > 1e12 ? n : n * 1000;
}

function baseEvent({ platform = 'bilibili', channel = 'web', cmd, type, at, user, text = '', gift = null, amount = null, extra = null, msgId = '' }) {
  const idPart = msgId || hashKey(`${type}|${user?.id || ''}|${text}|${Math.floor(at / 5000)}`);
  return {
    key: `${platform}:${channel}:${type}:${idPart}`,
    platform,
    channel,
    cmd,
    type,
    at,
    user: {
      id: user?.id ? maskId(user.id) : '',
      name: String(user?.name || '').slice(0, 40),
      guardLevel: num(user?.guardLevel, 0),
      medalLevel: num(user?.medalLevel, 0),
      medalName: String(user?.medalName || '').slice(0, 20),
      admin: Boolean(user?.admin),
      self: Boolean(user?.self),
    },
    text: String(text || '').slice(0, 200),
    gift,
    amount,
    extra,
  };
}

/**
 * B 站社区长连（web）事件。packet 是解码后的整条 JSON（含 cmd / data / info）。
 */
export function normalizeBiliWeb(packet, ctx = {}) {
  if (!packet || typeof packet !== 'object') return null;
  const cmdRaw = String(packet.cmd || '');
  const cmd = cmdRaw.split(':')[0];
  const d = packet.data || {};
  const selfName = String(ctx.selfName || '');
  const selfUid = ctx.selfUid ? String(ctx.selfUid) : '';
  const isSelf = (uid, uname) =>
    (selfUid && String(uid) === selfUid) || (selfName && String(uname || '') === selfName);

  if (cmd === 'DANMU_MSG') {
    const info = Array.isArray(packet.info) ? packet.info : [];
    const text = info[1] || '';
    const u = info[2] || [];
    const medal = info[3] || [];
    const uid = u[0];
    const uname = u[1];
    return baseEvent({
      channel: 'web',
      cmd,
      type: EVENT_TYPES.DANMAKU,
      at: tsMs(info[0]?.[4] || info[9]?.ts),
      msgId: info[0]?.[7] || info[9]?.ct,
      text,
      user: {
        id: uid,
        name: uname,
        guardLevel: info[7] || 0,
        medalLevel: medal[0] || 0,
        medalName: medal[1] || '',
        admin: false,
        self: isSelf(uid, uname),
      },
      extra: { dmType: info[0]?.[12] || 0 },
    });
  }

  if (cmd === 'SEND_GIFT' || cmd === 'COMBO_SEND') {
    const price = num(d.price, 0);
    const n = num(d.num || d.gift_num || d.combo_num, 1);
    const total = price * n;
    return baseEvent({
      channel: 'web',
      cmd,
      type: EVENT_TYPES.GIFT,
      at: tsMs(d.timestamp),
      msgId: d.tid || d.msg_id || '',
      user: {
        id: d.uid || '',
        name: d.uname,
        guardLevel: d.guard_level || 0,
        medalLevel: d.medal_info?.medal_level || 0,
        medalName: d.medal_info?.medal_name || '',
        self: isSelf(d.uid, d.uname),
      },
      gift: {
        name: String(d.giftName || d.gift_name || '').slice(0, 30),
        num: n,
        price,
        paid: d.coin_type === 'gold' || Boolean(d.paid) || price > 0,
        total,
        combo: Boolean(d.combo_send || d.batch_combo_send || d.combo_gift),
      },
      amount: { coins: total, rmb: Math.round(total / 100) / 10 },
      extra: { blind: Boolean(d.blind_gift?.status) },
    });
  }

  if (cmd === 'INTERACT_WORD' || cmd === 'INTERACT_WORD_V2') {
    const mt = num(d.msg_type, 1);
    const type = mt === 1 ? EVENT_TYPES.ENTER : mt === 2 ? EVENT_TYPES.FOLLOW : mt === 3 ? EVENT_TYPES.SHARE : EVENT_TYPES.UNKNOWN;
    // V2 包把用户信息放在 uinfo 里（d.uid/uname 为空），不取会导致整批进场事件被当成同一条去重
    const ui = d.uinfo || {};
    const uid = d.uid || ui.uid || d.ident_info?.uid;
    const uname = d.uname || ui.uname;
    const medal = d.fans_medal || ui.fans_medal || {};
    return baseEvent({
      channel: 'web',
      cmd,
      type,
      at: tsMs(d.timestamp),
      msgId: d.ident_info?.msg_id || d.msg_id || (d.pb ? 'pb:' + hashKey(d.pb).slice(0, 12) : ''),
      user: {
        id: uid,
        name: uname,
        guardLevel: d.guard_level || ui.guard_level || 0,
        medalLevel: medal.medal_level || 0,
        medalName: medal.medal_name || '',
        self: isSelf(uid, uname),
      },
      extra: { msgType: mt },
    });
  }

  if (cmd === 'GUARD_BUY') {
    const price = num(d.price, 0);
    const n = num(d.num, 1);
    return baseEvent({
      channel: 'web',
      cmd,
      type: EVENT_TYPES.GUARD,
      at: tsMs(d.timestamp),
      msgId: d.msg_id || '',
      user: { id: d.uid, name: d.uname, guardLevel: d.guard_level || 0, self: isSelf(d.uid, d.uname) },
      gift: { name: d.gift_name || '', num: n, price, paid: true, total: price * n, combo: false },
      amount: { coins: price * n, rmb: Math.round((price * n) / 100) / 10 },
      extra: { guardLevel: d.guard_level || 0 },
    });
  }

  if (cmd === 'SUPER_CHAT_MESSAGE') {
    const rmb = num(d.price, 0);
    return baseEvent({
      channel: 'web',
      cmd,
      type: EVENT_TYPES.SUPERCHAT,
      at: tsMs(d.start_time || d.time),
      msgId: d.id || '',
      text: d.message || '',
      user: { id: d.uid, name: d.user_info?.uname, guardLevel: d.guard_level || 0, medalLevel: d.medal_info?.medal_level || 0, medalName: d.medal_info?.medal_name || '', self: isSelf(d.uid, d.user_info?.uname) },
      amount: { coins: rmb * 1000, rmb },
      extra: { messageId: d.id || '' },
    });
  }

  if (cmd === 'LIKE_INFO_V3_CLICK' || cmd === 'LIKE_INFO_V3_UPDATE') {
    return baseEvent({
      channel: 'web',
      cmd,
      type: EVENT_TYPES.LIKE,
      at: Date.now(),
      msgId: '',
      text: d.like_text || d.text || '',
      user: { id: d.uid, name: d.uname, medalLevel: d.ident_info?.medal_level || 0, self: isSelf(d.uid, d.uname) },
      extra: { count: num(d.ident_info?.click_num || d.total, 0) },
    });
  }

  if (cmd === 'WATCHED_CHANGE') {
    return baseEvent({
      channel: 'web',
      cmd,
      type: EVENT_TYPES.WATCH,
      at: Date.now(),
      user: {},
      extra: { num: num(d.num, 0), text: String(d.text_small || '').slice(0, 40) },
    });
  }

  if (cmd === 'LIVE') {
    return baseEvent({ channel: 'web', cmd, type: EVENT_TYPES.LIVE_START, at: Date.now(), user: {}, extra: { title: String(d.title || '').slice(0, 60) } });
  }
  if (cmd === 'PREPARING') {
    return baseEvent({ channel: 'web', cmd, type: EVENT_TYPES.LIVE_END, at: Date.now(), user: {} });
  }

  return baseEvent({ channel: 'web', cmd, type: EVENT_TYPES.UNKNOWN, at: Date.now(), user: {}, extra: { cmd } });
}

/**
 * B 站官方直播开放平台（open）事件。
 */
export function normalizeOpen(packet, ctx = {}) {
  if (!packet || typeof packet !== 'object') return null;
  const cmd = String(packet.cmd || '');
  const d = packet.data || {};
  const commonUser = {
    id: d.open_id || '',
    name: d.uname || '',
    guardLevel: d.guard_level || 0,
    medalLevel: d.fans_medal_level || 0,
    medalName: d.fans_medal_name || '',
  };

  if (cmd === 'OPEN_LIVEROOM_DM' || cmd === 'OPEN_LIVEROOM_DM_MIRROR') {
    return baseEvent({
      channel: 'open',
      cmd,
      type: EVENT_TYPES.DANMAKU,
      at: tsMs(d.timestamp),
      msgId: d.msg_id || '',
      text: d.msg || '',
      user: cmd.endsWith('MIRROR') ? {} : commonUser,
      extra: { mirror: cmd.endsWith('MIRROR'), dmType: d.dm_type || 0 },
    });
  }
  if (cmd === 'OPEN_LIVEROOM_SEND_GIFT') {
    const price = num(d.r_price || d.price, 0);
    const n = num(d.gift_num, 1);
    return baseEvent({
      channel: 'open',
      cmd,
      type: EVENT_TYPES.GIFT,
      at: tsMs(d.timestamp),
      msgId: d.msg_id || '',
      user: commonUser,
      gift: { name: d.gift_name || '', num: n, price, paid: Boolean(d.paid), total: price * n, combo: Boolean(d.combo_gift) },
      amount: { coins: price * n, rmb: Math.round((price * n) / 100) / 10 },
    });
  }
  if (cmd === 'OPEN_LIVEROOM_GUARD') {
    const price = num(d.price, 0);
    const n = num(d.num, 1);
    return baseEvent({
      channel: 'open',
      cmd,
      type: EVENT_TYPES.GUARD,
      at: tsMs(d.timestamp),
      msgId: d.msg_id || '',
      user: { ...commonUser, guardLevel: d.guard_level || 0 },
      gift: { name: d.gift_name || '', num: n, price, paid: true, total: price * n, combo: false },
      amount: { coins: price * n, rmb: Math.round((price * n) / 100) / 10 },
      extra: { guardLevel: d.guard_level || 0 },
    });
  }
  if (cmd === 'OPEN_LIVEROOM_SUPER_CHAT') {
    const rmb = num(d.rmb, 0);
    return baseEvent({
      channel: 'open',
      cmd,
      type: EVENT_TYPES.SUPERCHAT,
      at: tsMs(d.timestamp),
      msgId: d.msg_id || String(d.message_id || ''),
      text: d.message || '',
      user: commonUser,
      amount: { coins: rmb * 1000, rmb },
      extra: { messageId: d.message_id || '' },
    });
  }
  if (cmd === 'OPEN_LIVEROOM_LIKE') {
    return baseEvent({ channel: 'open', cmd, type: EVENT_TYPES.LIKE, at: Date.now(), user: commonUser, extra: { count: num(d.like_num, 0) } });
  }
  if (cmd === 'OPEN_LIVEROOM_LIVE_ROOM_ENTER') {
    return baseEvent({ channel: 'open', cmd, type: EVENT_TYPES.ENTER, at: Date.now(), user: commonUser });
  }
  if (cmd === 'OPEN_LIVEROOM_LIVE_START') {
    return baseEvent({ channel: 'open', cmd, type: EVENT_TYPES.LIVE_START, at: Date.now(), user: {} });
  }
  if (cmd === 'OPEN_LIVEROOM_LIVE_END' || cmd === 'OPEN_LIVEROOM_INTERACTION_END') {
    return baseEvent({ channel: 'open', cmd, type: EVENT_TYPES.LIVE_END, at: Date.now(), user: {} });
  }
  return baseEvent({ channel: 'open', cmd: cmd || 'unknown', type: EVENT_TYPES.UNKNOWN, at: Date.now(), user: {} });
}

export function summarizeEvent(e) {
  if (!e) return null;
  return {
    at: e.at,
    type: e.type,
    name: e.user?.name || '',
    uid: e.user?.id || '',
    text: e.text || '',
    gift: e.gift ? { name: e.gift.name, num: e.gift.num, rmb: e.amount?.rmb ?? 0 } : null,
    rmb: e.amount?.rmb ?? 0,
    cmd: e.cmd,
  };
}
