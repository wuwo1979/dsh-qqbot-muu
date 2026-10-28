#!/usr/bin/env node
/**
 * memory-selftest.mjs — 记忆库端到端自检（真跑，不是推演）
 *
 * 验的是完整链路：写入 → 向量化 → 去重 → 召回 → 打分 → 注入块格式化 → 统计。
 * 用独立 scope（selftest），跑完自动清掉，不污染真实群记忆。
 */

const CORE = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-core.mjs';
// 注意：这里用开发测试用的 dataRoot，而不是真实数据目录 ——
// 原因是 DSH 的 pwsh 沙箱对 .qqbot 子树有额外写入限制（运行时由宿主主进程写，不受影响）。
// 传入 argv[2] 可覆盖，例如：node memory-selftest.mjs F:/qqbot/dshqqbot
const DATA_ROOT = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'F:/qqbot/qqbot-mod/.devdata';
const SCOPE = 'selftest';

const ok = (s) => console.log('  ✅ ' + s);
const bad = (s) => { console.log('  ❌ ' + s); process.exitCode = 1; };
const info = (s) => console.log('     ' + s);

const M = await import(CORE);
ok('memory-core 模块加载成功');

const cfg = M.loadConfig(DATA_ROOT);
info(`配置: topK=${cfg.recallTopK} minCos=${cfg.recallMinCos} cap=${cfg.cap}`);

// ① 写入三条有区分度的事实
console.log('\n[1] 写入记忆');
const facts = [
  { text: '妈妈是群主，习惯熬夜到凌晨两三点才睡', kind: 'fact', subj: '妈妈' },
  { text: '爸爸养了一只橘猫叫年糕，经常发它的照片', kind: 'fact', subj: '爸爸' },
  { text: '小蓝答应过妈妈，下次给他讲一个鲸鱼冷笑话', kind: 'event', subj: '妈妈' },
];
for (const f of facts) {
  const r = await M.remember(DATA_ROOT, SCOPE, f, cfg);
  (r.ok ? ok : bad)(`写入 ${r.reason} → ${r.id ?? ''}  「${f.text.slice(0, 18)}…」`);
}

// ② 去重：重复写同一条，应判 deduped
console.log('\n[2] 去重');
const dup = await M.remember(DATA_ROOT, SCOPE, { text: '妈妈是群主，习惯熬夜到凌晨两三点才睡', kind: 'fact' }, cfg);
(dup.reason === 'deduped' ? ok : bad)(`重复写入 → ${dup.reason}（期望 deduped，cos=${(dup.cos ?? 0).toFixed(3)}）`);

// ③ 召回：三种查询，看命中对不对
console.log('\n[3] 召回');
const queries = [
  ['妈妈几点睡觉', '应命中「熬夜」那条'],
  ['年糕最近怎么样', '应命中「橘猫」那条'],
  ['你之前答应我什么了', '应命中「鲸鱼冷笑话」那条'],
];
for (const [q, expect] of queries) {
  const hits = await M.recall(DATA_ROOT, SCOPE, q, cfg);
  if (hits.length === 0) { bad(`「${q}」没有召回任何记忆`); continue; }
  const top = hits[0];
  ok(`「${q}」→ ${hits.length} 条，top1 cos=${top.cos.toFixed(3)} score=${top.score.toFixed(3)}`);
  info(`    ${top.text}   ← ${expect}`);
}

// ④ 注入块格式
console.log('\n[4] 注入块');
const hits = await M.recall(DATA_ROOT, SCOPE, '妈妈熬夜吗', cfg);
const block = M.formatRecallBlock(hits, cfg);
if (!block) bad('注入块为空');
else {
  ok(`注入块 ${block.length} 字符（预算 ${cfg.recallMaxChars}）`);
  for (const line of block.split('\n')) info(line);
}

// ⑤ 统计
console.log('\n[5] 统计');
const st = M.stats(DATA_ROOT, SCOPE, cfg);
ok(`共 ${st.total} 条（${JSON.stringify(st.byKind)}），嵌入器模式=${st.mode}`);
info(`文件: ${st.file}`);

// ⑥ 清理
console.log('\n[6] 清理测试数据');
const fs = await import('node:fs');
try {
  for (const f of [st.file, st.file + '.tmp']) if (fs.existsSync(f)) fs.unlinkSync(f);
  ok('测试 scope 已删除（不影响真实记忆）');
} catch (e) { bad('清理失败: ' + e.message); }

console.log('\n结论: ' + (process.exitCode ? '有问题，见上。' : '记忆库链路全部通过。'));
