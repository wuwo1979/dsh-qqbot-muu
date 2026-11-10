/**
 * live/redact.mjs — 日志与面板统一脱敏
 *
 * 硬规则：房间号、UID、open_id、token、Cookie、auth_body 不进明文日志。
 * 所有模块内部日志都走这里，不允许直接 console.log 原始对象。
 */
const NUM_ID_KEYS = /^(room_?id|uid|mid|open_?id|union_id|anchor_?uid|reply_open_id|message_id|msg_id|gift_?id|app_?id|access_?key_?id)$/i;
const SECRET_KEYS = /^(token|key|auth_body|csrf|bili_jct|sessdata|buvid3?|dedeuserid|ac_time_value|refresh_token|access_?key_?secret|secret|authorization|cookie)$/i;

export function maskId(value, keep = 2) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (s.length <= keep * 2) return '***';
  return s.slice(0, keep) + '*'.repeat(Math.max(2, Math.min(6, s.length - keep * 2))) + s.slice(-keep);
}

export function maskSecret(value) {
  const s = String(value ?? '');
  return s ? `***(${s.length})` : '';
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {{roomId?:string|number, uid?:string|number, tokens?:string[], cookies?:object}} opts
 */
export function createRedactor(opts = {}) {
  const exact = [];
  const add = (v) => {
    const s = String(v ?? '').trim();
    if (s.length >= 4) exact.push(s);
  };
  add(opts.roomId);
  add(opts.uid);
  for (const t of opts.tokens || []) add(t);
  for (const v of Object.values(opts.cookies || {})) add(v);

  const exactRe = exact.length
    ? new RegExp(`\\b(?:${exact.map(escapeRe).join('|')})\\b`, 'g')
    : null;

  function scrubText(input) {
    let out = String(input ?? '');
    if (exactRe) out = out.replace(exactRe, (m) => (m.length > 24 ? maskSecret(m) : maskId(m)));
    out = out.replace(
      /\b(SESSDATA|bili_jct|buvid3|buvid4|DedeUserID|DedeUserID__ckMd5|sid|access_key(?:_id|_secret)?|refresh_token|csrf|token|auth_body|open_id|union_id|room_?id|roomid|uid|mid|app_id)\s*[=:]\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^;,\s}]+)/gi,
      (m, k) => `${k}=***`,
    );
    out = out.replace(
      /("(?:room_?id|uid|mid|open_?id|union_id|msg_id|message_id|app_?id|access_?key_?id)"\s*:\s*)("(?:[^"\\]|\\.)*"|\d+)/gi,
      (m, k, v) => `${k}${v.startsWith('"') ? '"***"' : '***'}`,
    );
    out = out.replace(/wss?:\/\/[^\s"']+/gi, (m) => m.replace(/([?&][^=&]+=)[^&]+/g, '$1***'));
    out = out.replace(/\b1[3-9]\d{9}\b/g, (m) => `${m.slice(0, 3)}****${m.slice(7)}`);
    return out;
  }

  function scrub(value, depth = 0) {
    if (depth > 5) return '[deep]';
    if (value == null) return value;
    if (typeof value === 'string') return scrubText(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (SECRET_KEYS.test(k)) out[k] = maskSecret(v);
        else if (NUM_ID_KEYS.test(k)) out[k] = maskId(v);
        else out[k] = scrub(v, depth + 1);
      }
      return out;
    }
    return String(value);
  }

  return { scrub, scrubText, maskId, maskSecret };
}

const LEVELS = ['debug', 'info', 'warn', 'error'];

export function makeLogger(baseLogger, redactor, tag = 'live') {
  const r = redactor || createRedactor();
  const emit = (level, args) => {
    const msg = args
      .map((a) => (typeof a === 'string' ? r.scrubText(a) : r.scrub(a)))
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    const fn = baseLogger?.[level] || baseLogger?.info || console[level] || console.log;
    try { fn.call(baseLogger || console, `[${tag}] ${msg}`); } catch { /* 日志失败不影响主流程 */ }
  };
  const logger = {};
  for (const level of LEVELS) logger[level] = (...args) => emit(level, args);
  logger.scrub = r.scrub;
  logger.scrubText = r.scrubText;
  return logger;
}
