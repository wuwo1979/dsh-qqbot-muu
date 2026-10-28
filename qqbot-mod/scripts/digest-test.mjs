#!/usr/bin/env node
/**
 * digest-test.mjs — 验证「中层记忆」（抽取式摘要）
 *
 * 验的是：攒够 N 条 event → 触发一次摘要 → 生成 kind=summary 的可检索条目 →
 *        原记忆**一条都不删** → 第二次不再触发。
 */

process.env.QQBOT_MEMORY_DATA_ROOT = 'F:/qqbot/qqbot-mod/.devdata';
const DATA_ROOT = process.env.QQBOT_MEMORY_DATA_ROOT;
const SCOPE = 'group:DIGESTTEST';

const CORE = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-core.mjs';
const ok = (s) => console.log('  ✅ ' + s);
const bad = (s) => { console.log('  ❌ ' + s); process.exitCode = 1; };
const info = (s) => console.log('     ' + s);

const M = await import(CORE);
ok('memory-core 加载成功');

const fs = await import('node:fs');
const cfg0 = M.loadConfig(DATA_ROOT);
const cfg = { ...cfg0, digestEvery: 12 }; // 测试用更小的窗口

// 干净起点
for (const f of [M.memoryFile(DATA_ROOT, SCOPE), M.memoryFile(DATA_ROOT, SCOPE).replace(/\.jsonl$/, '')]) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
}

console.log('\n[1] 灌 13 条群聊，其中 3 条围绕同一件事');
const msgs = [
  '妈妈说他周末要去杭州出差三天',
  '爸爸问杭州那边下雨吗要不要带伞',
  '妈妈说查了天气预报周六有雨记得带伞',
  '哈哈哈哈这个表情好好笑',
  '今天午饭吃了螺蛳粉有点上头',
  '有人知道那个新出的显卡怎么样吗',
  '我昨天熬夜到三点看完了那部剧',
  '所以杭州到底冷不冷啊',
  '带件外套吧早晚温差大',
  '好想去海边玩啊啊啊',
  '这个月工资还没发',
  '谁有那张猫猫表情包再发一下',
  '妈妈说杭州回来给大家带特产',
];
for (const t of msgs) {
  const r = await M.remember(DATA_ROOT, SCOPE, { text: t, kind: 'event' }, cfg);
  if (!r.ok) bad(`写入失败: ${t} → ${r.reason}`);
}
const before = M.stats(DATA_ROOT, SCOPE, cfg);
ok(`已写入 ${before.total} 条（${JSON.stringify(before.byKind)}）`);

console.log('\n[2] shouldDigest 判据');
const should = M.shouldDigest(DATA_ROOT, SCOPE, cfg);
if (should) ok(`攒够 ${cfg.digestEvery} 条 → 该做摘要`);
else bad(`未触发（现有 event 数不足或时间戳问题）`);

console.log('\n[3] 执行摘要');
const d = M.digestScope(DATA_ROOT, SCOPE, cfg);
if (!d.ok) bad(`摘要失败: ${d.reason}`);
else {
  ok(`生成了 1 条 summary，覆盖 ${d.covered} 条`);
  info('摘要正文:');
  info(d.text);
}

console.log('\n[4] 原记忆必须一条都不能少');
const after = M.stats(DATA_ROOT, SCOPE, cfg);
if (after.total === before.total + 1) ok(`总数 ${before.total} → ${after.total}（+1 条摘要，原记忆未删）`);
else bad(`总数异常: ${before.total} → ${after.total}`);
if ((after.byKind.summary || 0) === 1) ok('byKind 里出现 1 条 summary');
else bad(`summary 条数异常: ${JSON.stringify(after.byKind)}`);

console.log('\n[5] 摘要能被召回（用杭州相关的话去问）');
const hits = await M.recall(DATA_ROOT, SCOPE, '他们周末要去哪来着', cfg);
if (hits.length === 0) bad('没召回任何东西');
else {
  ok(`召回 ${hits.length} 条：`);
  for (const h of hits) info(`cos=${h.cos.toFixed(3)}  [${h.kind}] ${h.text.slice(0, 60)}`);
  if (hits.some((h) => h.kind === 'summary')) ok('summary 出现在召回结果里');
  else info('（这一问没命中 summary，属正常——摘要只是多一条索引，不保证每次首选）');
}

console.log('\n[6] 幂等：再调一次不该重复摘要');
const d2 = M.digestScope(DATA_ROOT, SCOPE, cfg);
if (!d2.ok) ok(`第二次未触发（${d2.reason}）—— 游标已推进`);
else bad('第二次又生成了摘要，游标没推进');

console.log('\n[7] 清理');
try {
  if (fs.existsSync(M.memoryFile(DATA_ROOT, SCOPE))) fs.unlinkSync(M.memoryFile(DATA_ROOT, SCOPE));
  const dir = M.memoryFile(DATA_ROOT, SCOPE).replace(/[^\\/]+$/, '');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) if (f.startsWith('_digest_DIGESTTEST')) fs.unlinkSync(dir + f);
  }
  ok('测试数据已删');
} catch (e) { info('清理时忽略: ' + e.message); }

console.log('\n结论: ' + (process.exitCode ? '有问题，见上。' : '中层记忆链路通过。'));
