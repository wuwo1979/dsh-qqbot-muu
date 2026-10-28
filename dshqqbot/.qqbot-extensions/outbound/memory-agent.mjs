/**
 * outbound/memory-agent.mjs — 回合收尾时唤一次「记忆分身」
 *
 * 为什么放在 outbound/turnEnd：
 *   · 此时她刚说完，最近对话最完整（含她自己的回复）；
 *   · 正文块已经发完，不会挡用户看到回复；
 *   · 和 turn-memory 一样只在 turnEnd 触发，天然一回合一次。
 *
 * 行为：
 *   1) 同步补一次聊天台账（新增行才写，成本 ≈ 读几个 KB）；
 *   2) 把「整理这段对话」丢给 lib/memory-agent.mjs，**不 await**；
 *   3) 同一 scope 正在整理时直接跳过，避免堆积并发小模型请求。
 *
 * 关闭方式：memory-config.json → "memoryAgent": { "enabled": false }
 * 或整个记忆关掉（"enabled": false）。任何异常都静默降级。
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'memory-agent';

const HERE = dirname(fileURLToPath(import.meta.url));
const _running = new Set();

/**
 * 历史印象（高维卡）的自动更新。
 *
 * 之前这套只有面板里手动点才会跑，配置里 `digest.perDayMs`（"每天最多重建一次"）
 * 等于一句空话——导入再多历史，那张"这个人是谁"的卡也不会自己长出来。
 *
 * 三处限流，任何一处不满足就不跑：
 *   · 只做 c2c：群里的卡要按发言人做，出站钩子拿不到稳定的发言人 id；
 *   · 进程内 12h/人：模型离线反复失败时不至于每回合撞一次 60s 超时；
 *   · digestPerson 内部的 perDayMs：跨进程重启也不会重复重建。
 */
const DIGEST_EVERY_MS = 12 * 3600 * 1000;
const _lastDigest = new Map();

async function maybeDigest(root, scope, cfg, ok) {
  if (!ok) return null;
  if (cfg?.digest?.auto === false) return null;
  if (!scope.startsWith('c2c:')) return null;
  const sid = scope.slice(4);
  if (!sid) return null;
  const k = root + '|' + sid;
  if (Date.now() - (Number(_lastDigest.get(k)) || 0) < DIGEST_EVERY_MS) return null;
  _lastDigest.set(k, Date.now());
  const { digestPerson } = await import('../lib/profile-digest.mjs');
  return digestPerson({ dataRoot: root, senderId: sid, scope: '', cfg });
}

/**
 * 印象「保鲜」（主人 2026-10-27）：
 *   · 卡片长期不更新，面板上的印象就会和目标偏移；
 *   · 自我卡（"我自己是谁"）以前是每次面板临时合成的，库里那张停在 10-26，从不变。
 * 所以每 N 小时做一次轻量保养：
 *   1) 重写自我卡（纯读 character.json + growth，不花 token）；
 *   2) 挑最多 1 个"有新切片没消化 / 太旧"的人重建卡（digestPerson 自带 22h 节流）。
 * 进程内 6h 一次；异常静默。
 */
const FRESH_EVERY_MS = 6 * 3600 * 1000;
const _lastFresh = new Map();

async function maybeFresh(root, cfg) {
  if (cfg?.personaFresh?.enabled === false) return null;
  const k = root;
  if (Date.now() - (Number(_lastFresh.get(k)) || 0) < FRESH_EVERY_MS) return null;
  _lastFresh.set(k, Date.now());
  const { refresh } = await import('../lib/persona-fresh.mjs');
  return refresh(root, { mode: 'stale', budget: 1, force: false, cfg });
}

function dataRootOf(ctx) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  if (ctx && typeof ctx.dataRoot === 'string' && ctx.dataRoot) return ctx.dataRoot;
  return dirname(dirname(HERE)); // .../{dataRoot}/.qqbot-extensions/outbound/
}

function scopeOfTarget(target) {
  if (!target) return '';
  // 真机 ctx.target = { scope, targetId }（不是 peerId）；两个都认，否则永远拿不到会话
  const peer = String(target.peerId || target.targetId || '');
  if (!peer) return '';
  const kind = String(target.scope || '');
  if (kind === 'c2c' || kind === 'user' || kind === 'private') return 'c2c:' + peer;
  return 'group:' + peer;
}

export async function onOutbound(ctx, next) {
  if (ctx?.phase !== 'turnEnd') return next();

  try {
    const root = dataRootOf(ctx);
    const scope = scopeOfTarget(ctx?.target);
    if (!scope || _running.has(scope)) return next();

    const mem = await import('../lib/memory.mjs');
    const cfg = mem.loadConfig(root);
    if (cfg.enabled === false) return next();

    const { runTurnAgent, loadAgentCfg } = await import('../lib/memory-agent.mjs');
    const acfg = loadAgentCfg(cfg);
    if (acfg.enabled === false) return next();

    _running.add(scope);
    // 故意不 await：整理要调本地模型（几百 ms ~ 几秒），不能拖慢收尾
    Promise.resolve()
      .then(async () => {
        let llmCfg = null;
        try {
          const llm = await import('../lib/local-llm.mjs');
          llmCfg = llm.loadConfig(root);
        } catch { /* 没有本地模型就交给 runTurnAgent 自己判 */ }
        const r = await runTurnAgent({ dataRoot: root, scope, cfg, llmCfg, reply: String(ctx?.text || '') });
        // 回合整理成功 = 这段对话真的在推进，顺手看一眼"这个人的历史印象"要不要重建。
        // 慢（本地模型几十秒），所以继续往后扔，不阻塞收尾。
        maybeDigest(root, scope, cfg, !!(r && r.ok)).catch(() => { /* 卡片没更新不影响聊天 */ });
        maybeFresh(root, cfg).catch(() => { /* 保鲜失败不影响聊天 */ });
        return r;
      })
      .catch(() => { /* 整理失败不影响任何链路 */ })
      .finally(() => { _running.delete(scope); });
  } catch { /* ignore */ }

  return next();
}

export default onOutbound;
