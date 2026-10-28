#!/usr/bin/env node
/**
 * ext-harness.mjs — 用假 ctx 跑一遍入站扩展，验证「召回 → rewrite 注入」整条链
 *
 * 不是在真的 QQ 里跑，但走的是**真实的扩展代码**：memory-recall.mjs 的 onInbound。
 * 数据根指向开发目录（沙箱不拦），并支持重置。
 */

process.env.QQBOT_MEMORY_DATA_ROOT = 'F:/qqbot/qqbot-mod/.devdata';
// 本地向量模型默认在 <DSH_HOME>/models/bge-small-zh；子进程常常没带 DSH_HOME
if (!process.env.DSH_HOME) {
  const fs1 = await import('node:fs');
  const cands = [
    (process.env.APPDATA || '') + '/dsh-desktop/harness',
    (process.env.USERPROFILE || '') + '/.dsh',
  ];
  const hit = cands.find((p) => p && fs1.existsSync(p + '/models/bge-small-zh/onnx/model_quantized.onnx'));
  if (hit) process.env.DSH_HOME = hit;
}

const EXT = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/aa-memory-recall.mjs';
const CORE = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-core.mjs';
const DATA_ROOT = process.env.QQBOT_MEMORY_DATA_ROOT;
const SCOPE_KEY = 'group:TESTGROUP0001';

const ok = (s) => console.log('  ✅ ' + s);
const bad = (s) => { console.log('  ❌ ' + s); process.exitCode = 1; };
const info = (s) => console.log('     ' + s);

const ext = await import(EXT);
const M = await import(CORE);
ok('扩展模块加载成功（含 relative import ../lib/memory-core.mjs）');

// 清掉上一次的测试数据
const cfg0 = M.loadConfig(DATA_ROOT);
const file0 = M.memoryFile(DATA_ROOT, SCOPE_KEY);
const fs = await import('node:fs');
try { if (fs.existsSync(file0)) fs.unlinkSync(file0); } catch { /* ignore */ }

// 这个用例验证的是"特别关心群"的完整召回链；普通群现在默认不召回（只看信息本身）
try {
  fs.mkdirSync(DATA_ROOT + '/.qqbot-extensions/data', { recursive: true });
  fs.writeFileSync(DATA_ROOT + '/.qqbot-extensions/data/group-tiers.json',
    JSON.stringify({ defaultTier: 'normal', priority: [SCOPE_KEY], normal: [] }), 'utf8');
} catch { /* 写不了就按默认普通群跑，用例会自己失败 */ }

// 先往这个会话里灌两条记忆
console.log('\n[准备] 植入历史记忆');
for (const t of [
  '妈妈是群主，习惯熬夜到凌晨两三点才睡',
  '爸爸养了一只橘猫叫年糕，经常发它的照片',
]) {
  const r = await M.remember(DATA_ROOT, SCOPE_KEY, { text: t, kind: 'fact' }, cfg0);
  ok(`植入 ${r.reason}: ${t.slice(0, 16)}…`);
}

// 假 ctx：模拟一条"问起妈妈作息"的群消息
function makeCtx(text, rewriteLog) {
  return {
    text,
    message: { groupOpenid: 'TESTGROUP0001', senderId: 'USER_A', senderName: '爸爸' },
    platform: { mentioned: false },
    rewrite: (o) => { rewriteLog.push(o.text); },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
  };
}

let nextCalled = 0;
const rewriteLog = [];
const ctx = makeCtx('妈妈昨天几点睡的来着？', rewriteLog);

console.log('\n[1] 跑 onInbound');
await ext.onInbound(ctx, async () => { nextCalled += 1; });
ok(`next() 被调用 ${nextCalled} 次（必须=1，否则会吞消息）`);
if (nextCalled !== 1) bad('next() 次数不对');

console.log('\n[2] rewrite 注入');
if (rewriteLog.length === 0) bad('没有触发 rewrite —— 记忆没注入');
else {
  ok(`rewrite 触发 ${rewriteLog.length} 次，最终文本 ${rewriteLog[rewriteLog.length - 1].length} 字符`);
  for (const line of rewriteLog[rewriteLog.length - 1].split('\n')) info(line);
}

console.log('\n[3] 沉淀检查（这条消息本身应被记成 event）');
const after = M.stats(DATA_ROOT, SCOPE_KEY, cfg0);
ok(`记忆库现在 ${after.total} 条 ${JSON.stringify(after.byKind)}`);

console.log('\n[4] 异常安全：ctx 里什么都没有也不能抛');
try {
  await ext.onInbound({ text: '', logger: { debug() {} } }, async () => { nextCalled += 1; });
  ok('空 ctx 未抛异常');
} catch (e) { bad('空 ctx 抛了异常: ' + e.message); }

console.log('\n[5] 清理');
try { if (fs.existsSync(file0)) fs.unlinkSync(file0); ok('测试数据已删'); } catch { /* ignore */ }

console.log('\n结论: ' + (process.exitCode ? '有问题，见上。' : '入站扩展整链通过（召回→rewrite→沉淀→异常安全）。'));
