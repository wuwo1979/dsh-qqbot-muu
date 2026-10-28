/**
 * _local-harness.mjs — 本地代答的测试夹具（给 local-persona-eval 等脚本用）
 *
 * 造一个假的入站 ctx（只带 local-answer 真正用到的字段），
 * 调一次 onInbound，把"接没接管 / 说了什么 / 花了多久"记下来。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as brain from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/brain-lock.mjs';

const DATA_ROOT = 'F:\\qqbot\\qqbot-mod\\.devdata';
process.env.QQBOT_MEMORY_DATA_ROOT = DATA_ROOT;

const EXT_DIR = join(DATA_ROOT, '.qqbot-extensions');
const CFG_PATH = join(EXT_DIR, 'local-llm-config.json');

const BASE = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:11434',
  // 2026-10-23：0.5b 已从本机 ollama 删除（现在跑 qwen2.5:7b），
  // 测试夹具跟着线上配置走，否则健康检查永远「未就绪」而静默 SKIP。
  model: 'qwen2.5:7b',
  timeoutMs: 8000,
  maxTokens: 48,
  maxInputChars: 24,
  maxReplyChars: 40,
  shortChatChars: 8,
  minIntervalMs: 0,
  maxPerWindow: 999,
  windowMs: 60000,
  allowUnmentioned: false,
  ownerToo: false,
  healthTtlMs: 0,
  systemPrompt: '',
  // 2026-10-23 新增的两条"单脑铁律"在夹具里放开 —— 否则被 @ 的夹具消息会全部让给云端，
  // 各套件测的（记忆注入、仲裁窗口、语音触发）就永远跑不到。铁律本身由 local-answer-test 的 [5] 验。
  onlyUnmentioned: false,
  c2cLocal: true,
};

/** 写测试用配置（每次以 BASE 为基准，只让 patch 覆盖；避免上一次跑的残留把 model 带偏） */
export function setCfg(patch = {}) {
  mkdirSync(EXT_DIR, { recursive: true });
  const cur = existsSync(CFG_PATH) ? JSON.parse(readFileSync(CFG_PATH, 'utf8')) : {};
  // ⚠️ 顺序很重要：cur 在前、BASE 在后 —— 否则历史残留里的 model:qwen2.5:0.5b
  //   会盖掉 BASE，健康检查永远「未就绪」，测试静默 SKIP（2026-10-23 踩到）。
  writeFileSync(CFG_PATH, JSON.stringify({ ...cur, ...BASE, ...patch }, null, 2), 'utf8');
}

export function makeCtx(text, opts = {}) {
  const state = { nextCalls: 0, sent: [], annihilated: false };
  const ctx = {
    text,
    message: { groupOpenid: opts.groupOpenid === null ? undefined : 'G1', senderId: 'U1', senderName: '测试' },
    platform: { mentioned: opts.mentioned !== false },
    isOwner: opts.isOwner === true,
    // 引用的原文（测「引用子会话转发」这类分支时传 opts.quote）
    state: opts.quote ? { quote: { text: String(opts.quote) } } : undefined,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    rewrite() { return true; },
    // 与真实插件同签名：ctx.annihilate(opts)，opts = { reason, ownerAck }。
    // 主人消息必须 ownerAck=true 才能摘（否则插件会 refused-owner 返回 false）。
    annihilate(o) {
      if (opts.annihilateFails) return false;
      if (opts.isOwner === true && !(o && o.ownerAck === true)) return false;
      state.annihilated = true;
      state.killOpts = o;
      return true;
    },
    caps: { async text(s) { state.sent.push(s); return true; }, async media() { return true; } },
  };
  const next = async () => { state.nextCalls += 1; };
  return { ctx, state, next };
}

let _mod = null;
async function loadMod() {
  if (!_mod) _mod = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/local-answer.mjs');
  return _mod;
}

/** 跑一条消息，返回 { took, sent, nextCalls, ms } */
export async function runLocal(text, opts = {}) {
  const mod = await loadMod();
  mod.resetRate?.();
  setCfg(opts.cfg || {});
  // 单脑仲裁：每条测试消息都从"会话安静"出发（否则上一条的 cloud 记账会把下一条挡住）
  resetLock();
  if (opts.lock) setLock(opts.lock);
  const { ctx, state, next } = makeCtx(text, opts);
  const t0 = Date.now();
  await mod.onInbound(ctx, next);
  return { took: state.annihilated, sent: state.sent, nextCalls: state.nextCalls, ms: state.sent.length ? Date.now() - t0 : 0 };
}

/** 清空 brain-lock（测试隔离） */
export function resetLock() {
  try { brain.reset(DATA_ROOT); } catch { /* ignore */ }
}

/** 预置一条锁（测"云端刚说过话，本地该不该插嘴"） */
export function setLock({ who = 'cloud', ageMs = 0, scope = 'group:G1' } = {}) {
  try { brain.mark(DATA_ROOT, scope, who, { why: 'test', now: Date.now() - Number(ageMs || 0) }); } catch { /* ignore */ }
}

export { DATA_ROOT, CFG_PATH, brain };
