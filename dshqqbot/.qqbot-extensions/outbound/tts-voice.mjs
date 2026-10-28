/**
 * tts-voice.mjs — 出站语音：把小蓝的某几句回复变成真·语音条
 *
 * 挂点：第六套扩展点 —— `{dataRoot}/.qqbot-extensions/outbound/*.mjs`
 *
 * 策略（可配 voice-config.json）：
 *   mode   off | sometimes | always      —— 完全不转 / 按概率 / 每条都转
 *   keepText true/false                  —— 文字照发+附一条语音 / 只发语音（文字被替掉）
 *
 * ★ 2026-10-23 第三次修（这条最关键）★
 *   出站链有一条 **3 秒硬超时**（`dist/transport/outbound-buffer.js:52 EXT_HOOK_TIMEOUT_MS`）：
 *   链一旦超时，宿主就"放弃改写/配图、按原文发出"，还会 error 一行
 *   「出站扩展链超时(3000ms)」。而 edge-tts 一次合成要 1~3 秒 —— 也就是说
 *   **只要在这一跳里同步合成，就必然踩超时**：语音发不出去、连 split-reply 的拆分也会被丢弃。
 *   所以 keepText 模式下改成 `ctx.background()`（宿主提供的"踢出主链"通道，见
 *   `dist/features/ext-outbound.js:228-250`）：正文立刻放行，合成+上传在后台跑。
 *
 * ★ force-voice 标记 ★
 *   `{dataRoot}/.qqbot/force-voice.json` 由入站代答（local-answer.mjs）在
 *   "她刚说了自己会说话/能发语音"时写一次；本扩展看到标记就把概率当 1 ——
 *   免得出现"嘴上说能发语音，结果一条都没发"的自相矛盾。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { synthesize } from '../lib/tts-core.mjs';

export const name = 'tts-voice';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  enabled: true,
  mode: 'sometimes',
  prob: 0.35,
  voice: 'zh-CN-XiaoyiNeural',
  provider: 'edge',
  endpoint: 'http://127.0.0.1:9880/v1/audio/speech',
  model: 'cosyvoice2',
  rate: '+8%',
  pitch: '+10Hz',
  rateJitter: 4,        // 每句语速 ±4%，去掉"每句同调"的合成感
  pitchJitter: 6,       // 每句音高 ±6Hz
  tailProb: 0.3,        // 句末偶尔加"嗯/啊/嘛"这类软语气词
  maxChars: 70,
  minChars: 2,
  cooldownMs: 45000,
  keepText: true,
  timeoutMs: 20000,
};

/** 数据根：优先环境变量，其次本文件所在扩展目录的上一级，最后默认路径 */
function dataRootOf(ctx) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  if (ctx && typeof ctx.dataRoot === 'string' && ctx.dataRoot) return ctx.dataRoot;
  // .../{dataRoot}/.qqbot-extensions/outbound/tts-voice.mjs
  return dirname(dirname(HERE));
}

function loadCfg(dataRoot) {
  const out = { ...DEFAULTS };
  try {
    const p = join(String(dataRoot || '.'), '.qqbot-extensions', 'voice-config.json');
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
          if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
        }
      }
    }
  } catch { /* 读不了就用默认 */ }
  return out;
}

/** 上次发语音的时间（按会话），进程内 */
const _lastAt = new Map();

/**
 * 取数字配置。
 * ★ 这里踩过坑：`Number(cfg.cooldownMs) || 45000` 在 cooldownMs=0 时会返回 **45000**
 *   （0 是 falsy），于是"关掉冷却"永远关不掉，也把测试卡在了冷却里。
 *   统一走 num()，0 就是 0。
 */
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// ── force-voice 标记 ────────────────────────────────────────────────────
export function forceFile(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot', 'force-voice.json');
}

/**
 * 读标记：{ scope, ts, ttlMs }
 * 只认 scope 相同（或 scope 为空=通配）且没过期的；过期文件顺手删掉。
 */
export function readForce(dataRoot, scopeKey, now = Date.now()) {
  try {
    const p = forceFile(dataRoot);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const ts = num(raw.ts, 0);
    const ttl = num(raw.ttlMs, 120000);
    if (!ts || now - ts > ttl) return null;
    // ★ 2026-10-23 修：入站那边记的是 `group:<peer>`，出站这边的 scopeKey 是 `group|<peer>`，
    //   原来用 `scopeKey.includes(sc)` 永远不相等 ⇒ 强制语音标记形同虚设。
    //   现在两边都归一化成"只比字母数字"，并退化到"比 peer id"。
    const sc = String(raw.scope || '');
    if (sc && scopeKey) {
      const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const a = normKey(sc);
      const b = normKey(scopeKey);
      const peer = (sc.match(/[A-Za-z0-9]{8,}/g) || []).pop() || '';
      const hit = (a && b.includes(a)) || (peer && b.includes(peer.toLowerCase()));
      if (!hit) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/** 这段文字该不该念 */
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/\[rf:[^\]]*\]/gi, '')
    .replace(/\[MEDIA:[^\]]*\]/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<@[^>]*>/g, '')
    .replace(/<qqbot-at-everyone\s*\/?>/gi, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldSpeak(ctx, text, cfg, scopeKey, forced) {
  if (cfg.enabled === false || cfg.mode === 'off') return { take: false, why: 'disabled' };
  // turnEnd 那一趟只负责收尾（发件箱补投在 outbox.mjs 里做）；
  // 这里再转一次就会和 phase='send' 那一趟重复发语音条。
  if (ctx.phase === 'turnEnd') return { take: false, why: 'turnEnd' };
  if (ctx.kind !== 'text') return { take: false, why: 'kind:' + String(ctx.kind) };
  if (ctx.isLastChunk === false) return { take: false, why: 'not-last-chunk' };
  const raw = String(ctx.text || '');
  // 带媒体/引用/代码的一律不转
  if (/\[MEDIA:/i.test(raw) || /!\[[^\]]*\]\(/.test(raw) || /\[rf:/i.test(raw)) return { take: false, why: 'has-media' };
  const t = cleanForSpeech(raw);
  if (!t) return { take: false, why: 'empty' };
  if (t.length < num(cfg.minChars, 2)) return { take: false, why: 'too-short' };
  if (t.length > num(cfg.maxChars, 70)) return { take: false, why: 'too-long' };
  if (!/[\u4e00-\u9fa5]/.test(t)) return { take: false, why: 'no-chinese' };

  const now = Date.now();
  const last = _lastAt.get(scopeKey) || 0;
  if (now - last < num(cfg.cooldownMs, 45000)) return { take: false, why: 'cooldown' };

  if (forced) return { take: true, why: 'force', text: t };
  if (cfg.mode === 'always') return { take: true, why: 'always', text: t };
  if (Math.random() > (typeof cfg.prob === 'number' ? cfg.prob : 0.35)) return { take: false, why: 'dice' };
  return { take: true, why: 'dice-hit', text: t };
}

/** 合成参数统一在一处拼，markSend 和 speakNow 共用 */
function ttsOpts(cfg, dataRoot) {
  return {
    dataRoot,
    voice: cfg.voice,
    provider: cfg.provider || 'edge',
    endpoint: cfg.endpoint || '',
    model: cfg.model || '',
    rate: cfg.rate,
    pitch: cfg.pitch,
    rateJitter: num(cfg.rateJitter, 4),
    pitchJitter: num(cfg.pitchJitter, 6),
    tailProb: num(cfg.tailProb, 0.3),
    timeoutMs: num(cfg.timeoutMs, 20000),
  };
}

export async function onOutbound(ctx, next) {
  let cfg;
  let dataRoot;
  try {
    dataRoot = dataRootOf(ctx);
    cfg = loadCfg(dataRoot);
  } catch {
    return next();
  }

  // 真机是 targetId（peerId 旧文档才有）；不认它的话每个群/私聊的键都会塌成 "group|"，冷却互相串
  const scopeKey = String(ctx?.target?.scope || '') + '|' + String(ctx?.target?.peerId || ctx?.target?.targetId || '');
  const forced = Boolean(readForce(dataRoot, scopeKey));
  const verdict = shouldSpeak(ctx, ctx?.text, cfg, scopeKey, forced);
  if (!verdict.take) return next();

  // 冷却先记：后台跑的时候也要防连发
  _lastAt.set(scopeKey, Date.now());
  const opts = ttsOpts(cfg, dataRoot);
  const sayText = verdict.text;

  const synthAndSend = async () => {
    let r;
    try {
      r = await synthesize(sayText, opts);
    } catch (e) {
      ctx?.logger?.warn?.(`[tts] 合成异常(已忽略): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    if (!r || !r.ok || !r.path) {
      ctx?.logger?.debug?.(`[tts] 合成失败(${r && r.error}) → 照常发文字`);
      return false;
    }
    try {
      await ctx.sendMedia({ path: r.path, kind: 'voice' });
      ctx?.logger?.info?.(`[tts] 语音 ${r.voice} ${r.rate}/${r.pitch} ${r.bytes}B ${r.ms}ms: ${r.said || sayText}`);
      return true;
    } catch (e) {
      ctx?.logger?.warn?.(`[tts] 语音发送失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  // ── keepText：正文照发，语音在后台补（绝不占出站链的 3 秒预算）──
  if (cfg.keepText !== false) {
    if (typeof ctx.background === 'function') {
      ctx.background(synthAndSend);
      return next();
    }
    // 老宿主没有 background：先让正文出去，再串行补语音
    await next();
    await synthAndSend();
    return;
  }

  // ── 只发语音：必须先合成成功才能摘文字（否则语音失败=消息全丢）──
  let r;
  try {
    r = await synthesize(sayText, opts);
  } catch (e) {
    ctx?.logger?.warn?.(`[tts] 合成异常(已忽略): ${e instanceof Error ? e.message : String(e)}`);
    return next();
  }
  if (!r || !r.ok || !r.path) {
    ctx?.logger?.debug?.(`[tts] 合成失败(${r && r.error}) → 照常发文字`);
    return next();
  }
  let killed = false;
  try {
    killed = ctx.annihilate?.('改发语音') !== false;
  } catch { killed = false; }
  if (!killed) return next();

  try {
    const sent = await ctx.sendMedia({ path: r.path, kind: 'voice' });
    ctx?.logger?.info?.(`[tts] 语音替文字 ${r.bytes}B ${r.ms}ms: ${r.said || sayText}${sent === false ? ' [发送失败]' : ''}`);
  } catch (e) {
    // 语音发不出去也不能让这条消息消失 → 把文字放回去
    ctx?.logger?.warn?.(`[tts] 语音发送失败，回退成文字: ${e instanceof Error ? e.message : String(e)}`);
    ctx.rewrite?.(ctx.text);
    await next();
  }
  return;
}

/** 工具/调试用：立刻念一句（不看出站链） */
export async function speakNow(text, opts = {}) {
  const dataRoot = opts.dataRoot || dataRootOf(null);
  const cfg = { ...loadCfg(dataRoot), ...(opts.cfg || {}) };
  return synthesize(String(text || ''), ttsOpts(cfg, dataRoot));
}
