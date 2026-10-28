#!/usr/bin/env node
/**
 * past-profile-test.mjs — 「旧识」画像：导入的历史记录要真的被用上，而且不能串人
 *
 * 为什么单独测（两个都是真问题）：
 *   ① 死数据：qq-history-import 把画像写进 `person:qq:<号>`，运行时召回用的是
 *      `group:` / `c2c:` —— 两套 scope 本来就不通，画像写进去了也没人读，
 *      "得到对不同人的印象"等于没做。
 *   ② 隐私：一旦把画像读进 prompt，就必须保证「A 的旧识不会出现在 B 的上下文里」，
 *      而且普通群（水群）连"认识这个人"都不该展开。
 *
 * 跑法：node F:\qqbot\qqbot-mod\scripts\past-profile-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.tmpdir(), 'qqs-pastprofile-' + process.pid);
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;

let pass = 0;
let fail = 0;
const head = (s) => console.log('\n' + s);
const ok = (label, cond, extra) => {
  if (cond) { pass += 1; console.log('  ok   ' + label); }
  else { fail += 1; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
};
const info = (s) => console.log('       ' + s);

const M = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory.mjs');
const ext = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/aa-memory-recall.mjs');
const CLEAN = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/text-clean.mjs');

const IMPORT = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/qq-history-import.mjs');

// ── 准备：两个人各导入一段历史（走真实的导入逻辑，不手搓 scope）──────────
head('[准备] 导入两个人的历史记录');
const HISTORY_A = [
  '2026-09-01 22:14:03 爸爸(10001)',
  '今天又加班到十一点，引擎那边的着色器还没调通',
  '2026-09-02 23:40:11 爸爸(10001)',
  '我觉得这个 voxel 方案在移动端跑不动，得换个思路',
  '2026-09-03 20:05:44 爸爸(10001)',
  '你上次答应我的那个鲸鱼冷笑话什么时候讲',
].join('\n');
const HISTORY_B = [
  '2026-09-04 09:12:00 阿澈(20002)',
  '早上六点起来跑了十公里，配速四分半',
  '2026-09-05 07:30:22 阿澈(20002)',
  '周末去爬山吗，走野线',
].join('\n');

const cwd = process.cwd();
fs.mkdirSync(path.join(ROOT, 'in'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'in', 'a.txt'), HISTORY_A, 'utf8');
fs.writeFileSync(path.join(ROOT, 'in', 'b.txt'), HISTORY_B, 'utf8');

const ra = await IMPORT.importHistory({ file: path.join(ROOT, 'in', 'a.txt'), dataRoot: ROOT, minScore: 0 });
const rb = await IMPORT.importHistory({ file: path.join(ROOT, 'in', 'b.txt'), dataRoot: ROOT, minScore: 0 });
ok('A 的历史导入成功', ra.ok && ra.added > 0, JSON.stringify(ra).slice(0, 160));
ok('B 的历史导入成功', rb.ok && rb.added > 0, JSON.stringify(rb).slice(0, 160));

// ── ① 单人画像读得出来，且只读这一个 ──────────────────────────────────
head('[1] personProfile：只认明确的人物标识');
const pa = M.personProfile(ROOT, '10001');
ok('读到 A 的画像', pa.ok === true, JSON.stringify(pa));
ok('scope 落在 person:qq:10001', pa.scope === 'person:qq:10001', pa.scope);
ok('画像非空且有统计口径', pa.impression.length > 0 && /次|字|活跃|问/.test(pa.impression), pa.impression);
info('A 的画像：' + pa.impression);

const pb = M.personProfile(ROOT, '20002');
ok('读到 B 的画像', pb.ok === true);
ok('两个画像内容不同（没串）', pa.impression !== pb.impression);

const px = M.personProfile(ROOT, '99999');
ok('没导入过的人 → 空', px.ok === false && px.impression === '');
const pn = M.personProfile(ROOT, '爸爸');
ok('拿昵称去查 → 不认（防重名串号）', pn.ok === false);
const pe = M.personProfile(ROOT, '');
ok('空 id 不炸', pe.ok === false);

// ── ② 注入：只有"看得起"的场景才带 ────────────────────────────────────
const writeTier = (tier) => {
  fs.mkdirSync(path.join(ROOT, '.qqbot-extensions', 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.qqbot-extensions', 'data', 'group-tiers.json'),
    JSON.stringify({
      defaultTier: 'normal',
      priority: tier === 'priority' ? ['group:G1'] : [],
      normal: tier === 'normal' ? ['group:G1'] : [],
    }), 'utf8');
};

async function run(groupOpenid, senderId, senderName, text = '你还记得我之前在忙什么吗') {
  const log = [];
  const ctx = {
    text,
    message: { groupOpenid, senderId, senderName },
    platform: { mentioned: false },
    rewrite: (o) => log.push(o.text),
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  };
  let next = 0;
  await ext.onInbound(ctx, async () => { next += 1; });
  return { text: log.length ? log[log.length - 1] : '', next, rewrites: log.length };
}

head('[2] 特别关心群：该注入');
writeTier('priority');
const r1 = await run('G1', '10001', '爸爸');
ok('触发了 rewrite', r1.rewrites > 0);
ok('带 [旧识] 块', r1.text.includes('[旧识]'), r1.text.slice(-200));
// 画像是统计口径（次数/字数/活跃时段/语气），刻意不含原文 —— 跨群注入原话才是隐私事故
ok('旧识是 A 的统计（出现 3 次）', r1.text.includes('出现 3 次'), r1.text.slice(-200));
ok('不是 B 的统计（出现 2 次）', !r1.text.includes('出现 2 次'));
ok('带了活跃时段这类可用的认识', /常在 .*点/.test(r1.text));
ok('不带 A 的任何原话（引擎/voxel/着色器）', !/引擎|voxel|着色器/.test(r1.text), r1.text.slice(-200));
ok('next() 只走一次', r1.next === 1);

head('[3] 同一个群，换成 B：注入的是 B 的');
const r2 = await run('G1', '20002', '阿澈');
ok('带 [旧识] 块', r2.text.includes('[旧识]'));
ok('旧识是 B 的统计（出现 2 次）', r2.text.includes('出现 2 次'), r2.text.slice(-200));
ok('不是 A 的统计（出现 3 次）', !r2.text.includes('出现 3 次'));
ok('不带 B 的任何原话（配速/爬山）', !/配速|爬山|十公里/.test(r2.text));

head('[4] 普通群：一个字都不带');
writeTier('normal');
const r3 = await run('G1', '10001', '爸爸');
ok('没有 [旧识] 块', !r3.text.includes('[旧识]'), r3.text.slice(-160));
ok('也没有 A 的任何特征词', !/voxel|着色器/.test(r3.text));
head('[5] 私聊：和特别关心群同档，也带');
const r4 = await run('', '10001', '爸爸', '你还记得吗');
ok('私聊带 [旧识]', r4.text.includes('[旧识]'), r4.text.slice(-200));

head('[6] 配置开关能整体关掉');
fs.writeFileSync(path.join(ROOT, '.qqbot-extensions', 'memory-config.json'),
  JSON.stringify({ pastProfile: false, enabled: true }), 'utf8');
writeTier('priority');
const r5 = await run('G1', '10001', '爸爸');
ok('pastProfile=false → 不带旧识', !r5.text.includes('[旧识]'), r5.text.slice(-160));
fs.rmSync(path.join(ROOT, '.qqbot-extensions', 'memory-config.json'), { force: true });

// ── ③ 注入块不能被当成聊天内容再沉淀回去 ──────────────────────────────
head('[7] 注入块要能被剥掉（否则会自己吃自己）');
const dirty = '你还记得吗\n[记忆]1. 某条[/记忆]\n[印象]爸爸 · 熟悉[/印象]\n[旧识]出现 12 次，爱问技术问题[/旧识]';
const cleaned = CLEAN.cleanInjected(dirty);
ok('剥掉了 [旧识]', !cleaned.includes('[旧识]'), cleaned);
ok('剥掉了 [印象]/[记忆]', !cleaned.includes('[印象]') && !cleaned.includes('[记忆]'), cleaned);
ok('正文还在', cleaned.includes('你还记得吗'), cleaned);
ok('正文里没有旧识内容', !cleaned.includes('爱问技术问题'));

head('[8] JSONL 回退后端也不能炸');
ok('personProfile 在门面上始终可调用', typeof M.personProfile === 'function');

console.log('\n──────────────────────────────────────────');
console.log('PASS ' + pass + ' / FAIL ' + fail);
console.log('结论：' + (fail === 0 ? '画像桥接与隔离都成立' : '有问题，见上面 FAIL 行'));
// SQLite 连接还开着（WAL 会握着 memory.db），删不掉是正常的 —— 临时目录交给系统回收，
// 不要因为清理失败把测试结果盖掉。
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail === 0 ? 0 : 1;