﻿/**
 * sticker-auto-test.mjs — 主动配表情包出站扩展（2026-10-24）
 *
 * 背景：`outbound/sticker-semantic.mjs` 从来没存在过，所以 sticker_auto 的开关
 * 一直是空的。本测试盯住新扩展的四条底线：
 *   · 总开关 / 隔离名单 / 限流（间隔、每小时上限、概率、最近去重）；
 *   · 检索必须过准入分，宁可不发也不乱配；
 *   · 只在出站文本里追加一张，不重复追加、不碰已有 MEDIA 的消息；
 *   · 每次决定都落日志，失败原因可回看。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadOptions, loadScope, targetAllowed, rateAllowed, choose, onOutbound, DEFAULTS,
} from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/outbound/ad-sticker-auto.mjs';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-stickerauto';
const GID = 'GROUP_OPENID_1234567890';
const A = 'c36d2851221a';
const B = '0077253deef5';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

function writeJson(rel, obj) {
  const p = join(ROOT, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function seed() {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  const lib = join(ROOT, '表情包', 'lib', 'library');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, A + '.jpg'), 'x');
  writeFileSync(join(lib, B + '.jpg'), 'x');
  writeJson('表情包/index.json', {
    version: 1,
    items: [
      { id: A, layer: 'library', ext: 'jpg', tags: ['无语'], desc: '一只无语的猫' },
      { id: B, layer: 'library', ext: 'jpg', tags: ['晚安'], desc: '钻被窝睡觉' },
    ],
  });
  // 本地 ONNX，超时压短，避免测试卡住
  writeJson('.qqbot-extensions/memory-config.json', {
    retrieval: { embeddingModel: 'local', stickerEmbeddingModel: 'local', timeoutMs: 3000 },
  });
}

function fakeCtx(text, target = { scope: 'group', targetId: GID }) {
  const ctx = {
    phase: 'send', kind: 'text', text, target, dataRoot: ROOT,
    rewritten: '', noted: '',
    rewrite(v) { ctx.rewritten = String(v); ctx.text = String(v); },
    note(v) { ctx.noted = String(v); },
  };
  return ctx;
}

async function call(ctx) {
  let n = 0;
  await onOutbound(ctx, async () => { n += 1; });
  return n;
}

async function main() {
  seed();

  // ── 开关 / 隔离 ──
  ok('没有开关文件默认开', loadOptions(ROOT).enabled === true);
  {
    const sc = loadScope(ROOT);
    ok('没有隔离文件 = whitelist 空名单', sc.mode === 'whitelist' && sc.targets.length === 0 && sc.exists === false, sc);
    ok('空名单谁都不配图', targetAllowed(sc, { scope: 'group', targetId: GID }) === false);
  }
  writeJson('.qqbot-extensions/data/sticker-semantic-scope.json', { mode: 'whitelist', targets: [{ key: 'group:' + GID }] });
  {
    const sc = loadScope(ROOT);
    ok('白名单命中群', targetAllowed(sc, { scope: 'group', targetId: GID }) === true);
    ok('白名单不命中别的群', targetAllowed(sc, { scope: 'group', targetId: 'OTHER' }) === false);
    ok('白名单不命中私聊', targetAllowed(sc, { scope: 'c2c', targetId: GID }) === false);
  }
  writeJson('.qqbot-extensions/data/sticker-semantic-scope.json', { mode: 'all', targets: [] });
  ok('all 模式放行所有目标', targetAllowed(loadScope(ROOT), { scope: 'c2c', targetId: 'X' }) === true);
  ok('缺 targetId 一律不放行', targetAllowed(loadScope(ROOT), { scope: 'group' }) === false);

  // ── 限流 ──
  {
    const now = 1_000_000_000_000;
    const rt = { lastAt: now - 1000, hourStart: now - 1000, hourCount: 0, recent: [] };
    ok('间隔不够就跳过', rateAllowed(rt, DEFAULTS, now).ok === false && rateAllowed(rt, DEFAULTS, now).why === 'gap');
    const rt2 = { lastAt: 0, hourStart: now - 1000, hourCount: 0, recent: [] };
    const r2 = rateAllowed(rt2, { ...DEFAULTS, minGapMs: 0 }, now);
    ok('间隔够了就放行并计数', r2.ok === true && r2.hourCount === 1, r2);
    const rt3 = { lastAt: 0, hourStart: now - 1000, hourCount: 99, recent: [] };
    ok('每小时上限拦住', rateAllowed(rt3, { ...DEFAULTS, minGapMs: 0, hourlyMax: 5 }, now).why === 'hourly');
  }

  // ── 检索准入 ──
  {
    const opt = { ...DEFAULTS, minScore: 2, lexicalMin: 0.1 };
    const p = await choose(ROOT, '今天真的无语了', { opt });
    ok('关键词命中并给出真实路径', p.ok && p.item.id === A && p.path.replace(/\\/g, '/').endsWith(A + '.jpg'), p);
  }
  {
    const opt = { ...DEFAULTS, minScore: 2, lexicalMin: 0.1 };
    const p = await choose(ROOT, '今天真的无语了', { opt, exclude: [A] });
    ok('最近用过的去重', p.ok === false && p.reason === 'recent', p);
  }
  {
    const p = await choose(ROOT, '啊', { opt: DEFAULTS });
    ok('太短的正文不配图', p.ok === false && p.reason === 'query-too-short', p);
  }

  // ── 端到端：追加一张、落状态、落日志 ──
  writeJson('.qqbot-extensions/data/auto-sticker.json', {
    enabled: true, minGapMs: 0, hourlyMax: 99, probability: 1, minScore: 2, lexicalMin: 0.1,
  });
  {
    const ctx = fakeCtx('今天真的无语了，服了');
    const n = await call(ctx);
    ok('出站被放行一次', n === 1);
    ok('正文末尾追加 MEDIA 图片标记', /\[MEDIA:image\|[^\]]+c36d2851221a\.jpg\]/.test(ctx.text), ctx.text);
    ok('追加写在原文之后', ctx.text.indexOf('服了') < ctx.text.indexOf('[MEDIA:image|'), ctx.text);
    ok('写了 note 便于排查', ctx.noted.includes('sticker-auto'));
    const st = JSON.parse(readFileSync(join(ROOT, '.qqbot-extensions', 'data', 'auto-sticker-state.json'), 'utf8'));
    ok('最近使用已落盘', st.recent.includes(A), st);
    const log = readFileSync(join(ROOT, '.qqbot', 'auto-sticker-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok('日志记了 sent 与分数', log.some((x) => x.result === 'sent' && x.id === A && typeof x.score === 'number'), log);
  }
  {
    // 同一张刚用过：不重复发
    const ctx = fakeCtx('今天真的无语了，服了');
    await call(ctx);
    ok('最近用过的不会立刻重复', !ctx.text.includes('[MEDIA:'), ctx.text);
  }
  {
    // 已有图的消息不追加
    const ctx = fakeCtx('今天真的无语了\n[MEDIA:image|F:/x.jpg]');
    await call(ctx);
    ok('已有 MEDIA 不重复追加', (ctx.text.match(/\[MEDIA:/g) || []).length === 1, ctx.text);
  }
  {
    // 关掉总开关
    writeJson('.qqbot-extensions/data/auto-sticker.json', { enabled: false, probability: 1 });
    const ctx = fakeCtx('今天真的无语了，服了');
    await call(ctx);
    ok('总开关关掉就不配图', !ctx.text.includes('[MEDIA:'), ctx.text);
    writeJson('.qqbot-extensions/data/auto-sticker.json', {
      enabled: true, minGapMs: 0, hourlyMax: 99, probability: 1, minScore: 2, lexicalMin: 0.1,
    });
  }
  {
    // 空名单不放行
    writeJson('.qqbot-extensions/data/sticker-semantic-scope.json', { mode: 'whitelist', targets: [] });
    const ctx = fakeCtx('今天真的无语了，服了');
    await call(ctx);
    ok('隔离名单为空时不配图', !ctx.text.includes('[MEDIA:'), ctx.text);
    writeJson('.qqbot-extensions/data/sticker-semantic-scope.json', { mode: 'all', targets: [] });
  }
  {
    // 每小时额度用完
    writeJson('.qqbot-extensions/data/auto-sticker-state.json', {
      lastAt: 0, hourStart: Date.now(), hourCount: 99, recent: [],
    });
    const ctx = fakeCtx('今天真的无语了，服了');
    await call(ctx);
    ok('每小时上限生效', !ctx.text.includes('[MEDIA:'), ctx.text);
    const log = readFileSync(join(ROOT, '.qqbot', 'auto-sticker-log.jsonl'), 'utf8');
    ok('跳过原因写进日志', log.includes('"why":"hourly"'), log.slice(-300));
  }

  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n主动表情包 PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}

try { await main(); } catch (e) {
  if (e && typeof e === 'object' && '__verifyExit' in e) throw e;
  console.error(e);
  process.exit(1);
}

