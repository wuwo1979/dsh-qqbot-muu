/**
 * live/store.mjs — 状态、事件日志、回复草稿的落盘（全部脱敏）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function defaultState() {
  return {
    version: 1,
    day: '',
    sentAt: [],
    llmAt: [],
    perUser: {},
    recentKeys: {},
    recentTexts: [],
    counters: { replies: 0, drafts: 0, skipped: 0, errors: 0, llmCalls: 0, tokens: 0 },
    totals: { replies: 0, drafts: 0, skipped: 0, errors: 0, llmCalls: 0, tokens: 0 },
    lastSentAt: 0,
    lastEnterFlushAt: 0,
    lastWelcomeAt: 0,
    updatedAt: 0,
  };
}

function ensureDir(file) {
  try { mkdirSync(dirname(file), { recursive: true }); } catch { /* ignore */ }
}

export function loadState(file) {
  ensureDir(file);
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return defaultState();
    return { ...defaultState(), ...j, counters: { ...defaultState().counters, ...(j.counters || {}) }, totals: { ...defaultState().totals, ...(j.totals || {}) } };
  } catch { return defaultState(); }
}

export function saveState(file, state) {
  ensureDir(file);
  try {
    state.updatedAt = Date.now();
    writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch { /* 落盘失败不影响回复 */ }
}

function rotateIfNeeded(file, maxBytes, keepLines) {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size <= maxBytes) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    writeFileSync(file, lines.slice(-keepLines).join('\n') + '\n', 'utf8');
  } catch { /* ignore */ }
}

export function appendJsonl(file, obj, { maxBytes = 1048576, keepLines = 2000 } = {}) {
  ensureDir(file);
  rotateIfNeeded(file, maxBytes, keepLines);
  try { appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8'); } catch { /* ignore */ }
}

export function readTailJsonl(file, n = 20) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, n)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
