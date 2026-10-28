/**
 * memory-dedupe-test.mjs — 记忆去重 + 自匹配（走真实入站扩展，用独立临时库）
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as M from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'qqmem-'));
mkdirSync(ROOT, { recursive: true });
process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;

const { onInbound } = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/aa-memory-recall.mjs');

const SCOPE = 'group:TESTDEDUPE';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

const cfg = M.loadConfig(ROOT);

/** 造一个最小 ctx，跑一轮入站，返回最终文本 */
async function runOne(text) {
  let out = text;
  const ctx = {
    text,
    message: { groupOpenid: 'TESTDEDUPE', senderId: 'u1', senderName: '测试员' },
    platform: { mentioned: false },
    rewrite(o) { if (o && typeof o.text === 'string') out = o.text; },
    logger: { debug() {}, info() {}, warn() {} },
  };
  let nexted = 0;
  await onInbound(ctx, () => { nexted++; });
  return { out, nexted };
}

console.log('[1] 同一句话记 3 次只留 1 条');
const TXT = '妈妈是群主，习惯熬夜到凌晨两三点才睡';
for (let i = 0; i < 3; i++) await M.remember(ROOT, SCOPE, { text: TXT, kind: 'fact' }, cfg);
const st = M.stats(ROOT, SCOPE, cfg);
ok('去重后只剩 1 条', st.total === 1 || st.fact === 1, JSON.stringify(st));

console.log('[2] 自匹配：说过的话不该被当成"回忆"再注回来');
const a = await runOne(TXT);           // 第一次：库里已有同文，召回必须把它滤掉
ok('next() 只调 1 次', a.nexted === 1, 'n=' + a.nexted);
const memBlockOf = (s) => (String(s).match(/\[记忆\]([\s\S]*?)\[\/记忆\]/) || [, ''])[1];
ok('注入块里没有这句原文', !memBlockOf(a.out).includes(TXT), memBlockOf(a.out) ? memBlockOf(a.out).replace(/\n/g, ' ⏎ ') : '(没有记忆块，正确)');

const b = await runOne('爸爸养了一只橘猫叫年糕');   // 第二次：无关新句，应召回历史
ok('第二次仍只 next 1 次', b.nexted === 1);
ok('无关新句不注入它自己', !b.out.split('\n').slice(1).join('\n').includes('爸爸养了一只橘猫叫年糕'), b.out.replace(/\n/g, ' ⏎ ').slice(0, 220));

console.log('[3] 召回结果不重复');
const hits = await M.recall(ROOT, SCOPE, '妈妈几点睡', cfg);
const seen = new Set(); let dup = false;
for (const h of hits) { const k = String(h.text).trim(); if (seen.has(k)) dup = true; seen.add(k); }
ok('没有重复条目', !dup, hits.map((h) => String(h.text).slice(0, 10)).join(' | '));
ok('召回条数 ≤ topK', hits.length <= (cfg.recallTopK || 4), 'n=' + hits.length);

console.log('[4] 存储后端');
ok('用的是 SQLite', M.backendName === 'sqlite', 'backend=' + M.backendName + ' note=' + (M.backendNote || ''));

try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* WAL 锁着就算了 */ }
console.log('');
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `失败 ${fail} / 通过 ${pass}`);
process.exit(fail === 0 ? 0 : 1);
