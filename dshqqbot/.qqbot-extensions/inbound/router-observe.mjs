/**
 * router-observe.mjs — 分流决策的**观察期**钩子（不改变任何行为）
 *
 * 目的：先跑够样本，看复杂度分档在真实群里分得准不准，再决定要不要拿它去拦云端。
 * 现在它只做一件事：每条入站算一个分，追加一行到 `{dataRoot}/.qqbot/router-log.jsonl`。
 *
 * 为什么只观察不生效：
 *   入站扩展只有 annihilate（会**真的吞掉**消息、不进历史）和 forceWake（跳过门控）两种手段，
 *   都不是"这条不值得唤醒 AI 但消息仍要进记忆"的正确语义。
 *   那个语义在插件里叫 valueGate='block'，属于 dist 侧，改它风险高于收益。
 *   ⇒ 观察够了再决定：要么把阈值喂给 valueGate，要么做一次受控的 dist patch。
 *
 * 停用：删掉本文件，或把 memory-config.json 的 router.enabled 设为 false。
 */

import { loadConfig } from '../lib/memory-core.mjs';
import { classify } from '../lib/router-core.mjs';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'router-observe';

const MAX_BYTES = 2 * 1024 * 1024; // 超 2MB 自动轮转一份

function dataRootOf(cfg) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  return (cfg && cfg.dataRoot) || 'F:/qqbot/dshqqbot';
}

function logPath(root) {
  return join(root, '.qqbot', 'router-log.jsonl');
}

function appendCapped(file, line) {
  try {
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      try { renameSync(file, file + '.1'); } catch { /* 轮转失败就算了 */ }
    }
    appendFileSync(file, line + '\n', 'utf8');
  } catch { /* 记日志失败绝不影响聊天 */ }
}

/** 去掉别的扩展注入的块（[记忆] / [设定]），否则分流判定看的是被污染后的长文本 */
function stripInjected(text) {
  return String(text || '')
    .replace(/\n?\[记忆\][\s\S]*?\[\/记忆\]\n?/g, '\n')
    .replace(/\n?\[设定\][\s\S]*?\[\/设定\]\n?/g, '\n')
    .replace(/\n?\[学\][\s\S]*?\[\/学\]\n?/g, '\n')
    .replace(/\n?\[别重复\][^\n]*/g, '\n')
    .trim();
}

export async function onInbound(ctx, next) {
  try {
    const cfg = loadConfig(dataRootOf({}));
    const root = dataRootOf(cfg);
    if (cfg.router && cfg.router.enabled === false) return next();

    const text = stripInjected(ctx?.text);
    if (text.length === 0) return next();

    const r = classify(text);
    const scope = ctx?.message?.groupOpenid ? 'group:' + ctx.message.groupOpenid
      : (ctx?.message?.senderId ? 'c2c:' + ctx.message.senderId : 'unknown');
    appendCapped(logPath(root), JSON.stringify({
      ts: Date.now(),
      scope,
      mentioned: ctx?.platform?.mentioned === true,
      tier: r.tier,
      score: r.score,
      s: r.signals,
      text: text.slice(0, 60),
    }));
  } catch { /* ignore */ }
  return next();
}
