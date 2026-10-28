/**
 * hooks/bili-ops-scheduler.mjs — B 站运营定时任务
 *
 * 到 bili-ops-config.json 的 schedule.times 时，AI 自己写脚本 + 渲染一条视频草稿，
 * 把结果写进 {dataRoot}/.qqbot/bili-pending.jsonl（下一条对话由 az-bili-note.mjs 提示）。
 *
 * 铁律：定时任务只产出草稿，**审核通过前绝不发布**。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Ops from '../lib/bili-ops.mjs';

function metaDir(dataRoot) {
  const d = join(String(dataRoot), '.qqbot');
  try {
    mkdirSync(d, { recursive: true });
  } catch {
    /* ignore */
  }
  return d;
}

function pushReport(dataRoot, kind, text) {
  try {
    appendFileSync(join(metaDir(dataRoot), 'bili-pending.jsonl'), JSON.stringify({ ts: Date.now(), kind, text: String(text || '').slice(0, 800) }) + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}

function readState(dataRoot) {
  try {
    return JSON.parse(readFileSync(Ops.paths(dataRoot).state, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(dataRoot, st) {
  try {
    mkdirSync(Ops.paths(dataRoot).root, { recursive: true });
    writeFileSync(Ops.paths(dataRoot).state, JSON.stringify(st), 'utf8');
  } catch {
    /* ignore */
  }
}

function hhmm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pickTopic(cfg, state, dataRoot) {
  const list = Array.isArray(cfg.schedule?.topics) ? cfg.schedule.topics.filter(Boolean) : [];
  if (list.length) {
    const cur = Number(state.topicCursor) || 0;
    return { topic: list[cur % list.length], patch: { topicCursor: cur + 1 } };
  }
  // 可选：外部选题文件（一行一个）
  try {
    const f = join(Ops.paths(dataRoot).root, 'topics.txt');
    if (existsSync(f)) {
      const lines = readFileSync(f, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length) {
        const cur = Number(state.fileTopicCursor) || 0;
        return { topic: lines[cur % lines.length], patch: { fileTopicCursor: cur + 1 } };
      }
    }
  } catch {
    /* ignore */
  }
  return { topic: '', patch: {} };
}

function dataRootOf(cfg) {
  const fromEnv = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (fromEnv) return fromEnv;
  return Ops.dataRootOf({});
}

export const name = 'bili-ops-scheduler';

export async function run(env = {}) {
  const logger = env.logger;
  const dataRoot = String(env?.caps?.dataRoot || dataRootOf());

  let cfg = Ops.loadOpsConfig(dataRoot);
  if (cfg.enabled === false) {
    logger?.info?.('[bili-ops-scheduler] bili-ops-config.enabled=false，跳过');
    return { skipped: 'disabled' };
  }

  let stopped = false;
  let busy = false;

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      cfg = Ops.loadOpsConfig(dataRoot);
      if (cfg.enabled === false || cfg.schedule?.enabled !== true) return;
      const now = hhmm();
      const times = Array.isArray(cfg.schedule.times) ? cfg.schedule.times : [];
      if (!times.includes(now)) return;

      const dayKey = localDay();
      const state = readState(dataRoot);
      const key = `${dayKey}@${now}`;
      if (state[key]) return;
      state[key] = Date.now();

      const picked = pickTopic(cfg, state, dataRoot);
      Object.assign(state, picked.patch || {});
      saveState(dataRoot, state);

      if (!picked.topic) {
        pushReport(dataRoot, 'bili-ops-error', '【B站运营】定时任务到了，但没有选题（schedule.topics 或 topics.txt 都是空的）。');
        return;
      }

      logger?.info?.(`[bili-ops-scheduler] ${now} 开始生成草稿：${picked.topic}`);
      const tool = await import('../tools/bili_ops.mjs');
      const r = await tool.default.run(
        { action: 'plan', topic: picked.topic },
        { logger, caps: { dataRoot }, internal: true }
      );

      if (!r.ok) {
        pushReport(dataRoot, 'bili-ops-error', `【B站运营】定时生成失败：${r.error}`);
        logger?.warn?.(`[bili-ops-scheduler] 生成失败：${r.error}`);
        return;
      }
      pushReport(
        dataRoot,
        'bili-ops-draft',
        `【B站运营·${now} 草稿待审】${r.title}（${r.durationSec}s / ${r.panels} 屏，文案 ${r.llm}）\n任务 ${r.jobId}\n回复「通过 ${r.jobId}」我就自动投稿。` +
          (r.warnings?.length ? `\n注意：${r.warnings.join('；')}` : '')
      );
      logger?.info?.(`[bili-ops-scheduler] 草稿已生成：${r.jobId}`);
    } catch (e) {
      logger?.warn?.(`[bili-ops-scheduler] 出错：${e?.message || String(e)}`);
    } finally {
      busy = false;
    }
  }

  await tick();
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, 60_000);
  try {
    if (typeof env.registerDispose === 'function') {
      env.registerDispose(() => {
        stopped = true;
        clearInterval(timer);
      });
    }
  } catch {
    /* ignore */
  }
  return { started: true };
}

export default run;
