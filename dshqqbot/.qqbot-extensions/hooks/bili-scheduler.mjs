/**
 * hooks/bili-scheduler.mjs — B 站定时任务
 *
 * 主人 2026-10-23 定：只在"我设定的时间"或"我 @ 它"时动 B 站。
 *  · 时间表在 {dataRoot}/bili-config.json → schedule.times（HH:MM，本地时区）；
 *  · 到点只做只读动作：看我的动态（可选把配图存进表情包），结果写进待汇报队列；
 *  · 每 6 小时检查一次登录；失效时写标记，下一次对话会主动汇报；
 *  · 不自动评论（评论只由 bili 工具在主人明确要求时执行）。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as B from '../lib/bili-api.mjs';

const DATA_ROOT_FALLBACK = 'F:/qqbot/dshqqbot';

function dataRootOf(cfg) {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  return (cfg && cfg.dataRoot) || DATA_ROOT_FALLBACK;
}

function metaDir(root) {
  const d = join(root, '.qqbot');
  try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}

function pushReport(root, kind, text) {
  try {
    appendFileSync(join(metaDir(root), 'bili-pending.jsonl'), JSON.stringify({ ts: Date.now(), kind, text: String(text || '').slice(0, 800) }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

function markLoginLost(root, why) {
  try {
    writeFileSync(join(metaDir(root), 'bili-login-lost.flag'), JSON.stringify({ ts: Date.now(), why: String(why || '') }), 'utf8');
  } catch { /* ignore */ }
}

function readState(root) {
  try { return JSON.parse(readFileSync(join(metaDir(root), 'bili-schedule-state.json'), 'utf8')); } catch { return {}; }
}

function saveState(root, st) {
  try { writeFileSync(join(metaDir(root), 'bili-schedule-state.json'), JSON.stringify(st), 'utf8'); } catch { /* ignore */ }
}

function hhmm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 本地日期（YYYY-MM-DD）。不能用 toISOString：那是 UTC，凌晨前后会串天。 */
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 记忆配置在 .qqbot-extensions 下（不是数据根），读不到就退回数据根那套默认值 */
function loadMemoryConfig() {
  const p = join(DATA_ROOT_FALLBACK, '.qqbot-extensions', 'memory-config.json');
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

export const name = 'bili-scheduler';

export async function run(env = {}) {
  const { logger } = env;
  const cfg = loadMemoryConfig();
  const root = dataRootOf(cfg);
  const bcfg = B.loadConfig(root);

  if (bcfg.enabled === false) {
    logger?.info?.('[bili-scheduler] bili-config.enabled=false，跳过');
    return { skipped: 'disabled' };
  }

  let stopped = false;
  let busy = false;

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const now = hhmm();
      const state = readState(root);
      const dayKey = localDay();
      const times = Array.isArray(bcfg.schedule?.times) ? bcfg.schedule.times : [];
      if (bcfg.schedule?.enabled && times.includes(now)) {
        const key = `${dayKey}@${now}`;
        if (!state[key]) {
          state[key] = Date.now();
          saveState(root, state);
          await runScheduled(logger, root, bcfg, now);
        }
      }

      // 每 6 小时检查一次登录状态
      const lastCheck = Number(state.loginCheckAt || 0);
      if (Date.now() - lastCheck > 6 * 3600_000) {
        state.loginCheckAt = Date.now();
        saveState(root, state);
        if (B.loadCookie(root)) {
          const me = await B.nav(root);
          if (!me.ok && me.needLogin) {
            markLoginLost(root, me.error);
            logger?.warn?.('[bili-scheduler] B 站登录已失效，已写汇报标记');
          }
        }
      }
    } catch (e) {
      logger?.warn?.(`[bili-scheduler] 定时任务出错: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  }

  async function runScheduled(logger2, root2, bcfg2, at) {
    const limit = Number(bcfg2.schedule?.limit) || 5;
    const r = await B.dynamics(root2, { limit });
    if (!r.ok) {
      if (r.needLogin) {
        markLoginLost(root2, r.error);
        pushReport(root2, 'login-lost', `B 站登录已失效：${r.error}。请主人重新扫码（action=login_start）。`);
      } else {
        pushReport(root2, 'error', `B 站定时读取失败：${r.error}`);
      }
      return;
    }
    const lines = r.items.map((it, i) => `${i + 1}. ${it.title || (it.text || '').slice(0, 30) || '(无正文)'}${it.bvid ? ` · ${it.bvid}` : ''}`);
    let extra = '';
    if (bcfg2.schedule?.collect && r.items.length) {
      const c = await import('../tools/bili.mjs');
      const urls = r.items.flatMap((x) => x.images).slice(0, 5);
      if (urls.length && c?.default?.run) {
        const cr = await c.default.run({ action: 'collect', urls, desc: 'B站动态配图', tags: ['B站'] }, { logger: logger2 });
        extra = cr.ok ? `\n顺手存了 ${String(cr.msg).match(/\d+/)?.[0] || ''} 张配图到表情包候选区。` : '';
      }
    }
    pushReport(root2, 'schedule', `【B站·${at} 定时浏览】最近 ${r.items.length} 条动态：\n${lines.join('\n')}${extra}`);
    logger2?.info?.(`[bili-scheduler] ${at} 定时浏览完成：${r.items.length} 条动态`);
  }

  await tick();
  const timer = setInterval(() => { tick().catch(() => {}); }, 30_000);
  try {
    if (typeof env.registerDispose === 'function') env.registerDispose(() => { stopped = true; clearInterval(timer); });
  } catch { /* ignore */ }
  return { started: true };
}

export default run;
