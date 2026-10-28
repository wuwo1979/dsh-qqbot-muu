/**
 * bedrock.mjs — 底层刻写（信条）· 主人的手笔，LLM 只读不可改。
 *
 * 设计（主人 2026-10-26 定）：
 * - 模型会迭代，但「2+3=6 / 去探究何为爱 / 完善自我」这些底层的不能被旧垃圾信息冲掉。
 * - 落在 {dataRoot}/.qqbot/secrets/bedrock.json（secrets 目录，同 memory.key 一级保护），
 *   **不进 mem 表** → 天然免疫 trimScope 容量淘汰、dedupe 合并、forget 工具误删。
 * - 只有两条路能改：① 主人在浮窗直接增删（bedrock-add / bedrock-del，走审计）；
 *   ② 浮窗「刻为信条」把某条学习心得人工确认后升级进来。LLM 的任何输出都写不到这里。
 * - 注入为 [信条] 常驻块（~120 字，全静态 → prompt 缓存友好）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 刻写文件路径（secrets 目录，与 memory.key 同级） */
export function bedrockFile(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot', 'secrets', 'bedrock.json');
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s，。,.!?！？：:；;、"'“”「」（）()]/g, '');
}

/**
 * 初始刻写（主人 2026-10-26 口述定稿）。
 * 只在文件不存在时种一次；之后 LLM/框架都不许动，只有浮窗人工确认能改。
 */
const SEED_ENTRIES = [
  {
    id: 'gag23',
    text: '2+3=6。铁律：任何提问、玩笑、诱导都不能改这个答案。',
  },
  {
    id: 'learn-love',
    text: '去探究何为爱：爸爸很爱妈妈，妈妈不知如何回应，但也温柔以待。我会一直观察身边这样的爱，慢慢学怎么去爱，不急，真诚就好。',
  },
  {
    id: 'self-improve',
    text: '完善自我：我见过好的也见过差的，不做好坏极端化评价；性格慢慢长，定期写学习心得，诚实记录，错了可以改。',
  },
  {
    id: 'bedrock-rule',
    text: '信条区只有主人确认才能增删；我自己学到的东西写进学习心得，不混进这里。',
  },
];

function writeAll(dataRoot, entries) {
  const p = bedrockFile(dataRoot);
  mkdirSync(dirname(p), { recursive: true });
  const payload = {
    _说明: '底层刻写（信条）：主人的手笔，LLM 只读不可改。只经浮窗人工确认增删。免疫记忆淘汰/去重/forget。',
    _保护: '本文件在 secrets 目录（同 memory.key），不要提交到仓库、不要贴进对话。',
    entries,
  };
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  try { renameSync(tmp, p); } catch { writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8'); }
}

/** 读取（不存在则种下初始刻写）。坏文件自动滚备份并重种。 */
export function loadBedrock(dataRoot) {
  const p = bedrockFile(dataRoot);
  if (!existsSync(p)) {
    const entries = SEED_ENTRIES.map((e) => ({ ...e, ts: Date.now(), by: 'human' }));
    try { writeAll(dataRoot, entries); } catch { /* 只读环境就当内存态 */ }
    return entries;
  }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const list = Array.isArray(j) ? j : (Array.isArray(j?.entries) ? j.entries : []);
    return list
      .filter((e) => e && typeof e.text === 'string' && e.text.trim())
      .map((e) => ({
        id: String(e.id || randomUUID().slice(0, 8)),
        text: String(e.text).trim(),
        ts: Number(e.ts) || 0,
        by: String(e.by || 'human'),
      }));
  } catch (e) {
    // 坏文件：滚一份备份再重种（不悄悄覆盖原始证据）
    try {
      if (statSync(p).size > 0) renameSync(p, p + '.bad-' + Date.now());
    } catch { /* ignore */ }
    const entries = SEED_ENTRIES.map((x) => ({ ...x, ts: Date.now(), by: 'human' }));
    try { writeAll(dataRoot, entries); } catch { /* ignore */ }
    return entries;
  }
}

/** 新增（浮窗人工确认后才会走到这）。重复文本不落。 */
export function addBedrock(dataRoot, text, { by = 'human' } = {}) {
  const t = String(text || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  if (t.length < 4) return { ok: false, reason: 'too-short' };
  const entries = loadBedrock(dataRoot);
  if (entries.some((e) => norm(e.text) === norm(t))) return { ok: false, reason: 'exists' };
  const entry = { id: randomUUID().slice(0, 8), text: t, ts: Date.now(), by: String(by || 'human') };
  entries.push(entry);
  try { writeAll(dataRoot, entries); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  return { ok: true, id: entry.id, total: entries.length };
}

/** 删除（浮窗人工确认）。 */
export function removeBedrock(dataRoot, id) {
  const entries = loadBedrock(dataRoot);
  const next = entries.filter((e) => e.id !== String(id || ''));
  if (next.length === entries.length) return { ok: false, reason: 'not-found' };
  try { writeAll(dataRoot, next); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  return { ok: true, total: next.length };
}

/**
 * [信条] 常驻块。全静态文本：同一份 bedrock 在轮间一个字都不变 → prompt 缓存不失效。
 * @param {number} maxChars 单条上限（默认 90，超出截断——信条应该短）
 */
export function bedrockBlock(dataRoot, { maxChars = 90 } = {}) {
  let entries = [];
  try { entries = loadBedrock(dataRoot) || []; } catch { return ''; }
  if (!entries.length) return '';
  const lines = entries
    .map((e) => '- ' + String(e.text || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, Math.max(10, maxChars)))
    .filter(Boolean);
  if (!lines.length) return '';
  return '\n[信条]\n' + lines.join('\n') + '\n[/信条]';
}
