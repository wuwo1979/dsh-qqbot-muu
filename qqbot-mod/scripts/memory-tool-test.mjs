#!/usr/bin/env node
/**
 * memory-tool-test.mjs — 验证"她自己记 → 收件箱 → 入站归位 → 下一句能召回"整条闭环
 *
 * 这是 P4 的第二半：episode（自动沉淀原话）之外，她能主动记**事实**。
 */

process.env.QQBOT_MEMORY_DATA_ROOT = 'F:/qqbot/qqbot-mod/.devdata';
// 本地向量模型默认在 <DSH_HOME>/models/bge-small-zh；子进程常常没带 DSH_HOME
if (!process.env.DSH_HOME) {
  const fs0 = await import('node:fs');
  const cands = [
    (process.env.APPDATA || '') + '/dsh-desktop/harness',
    (process.env.USERPROFILE || '') + '/.dsh',
  ];
  const hit = cands.find((p) => p && fs0.existsSync(p + '/models/bge-small-zh/onnx/model_quantized.onnx'));
  if (hit) process.env.DSH_HOME = hit;
}
const DATA_ROOT = process.env.QQBOT_MEMORY_DATA_ROOT;

const TOOL = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/memory.mjs';
const CORE = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-core.mjs';
const EXT = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/aa-memory-recall.mjs';

const ok = (s) => console.log('  ✅ ' + s);
const bad = (s) => { console.log('  ❌ ' + s); process.exitCode = 1; };
const info = (s) => console.log('     ' + s);

const tool = (await import(TOOL)).default;
const M = await import(CORE);
const ext = await import(EXT);
ok('memory 工具 + 核心 + 入站扩展 均加载成功');

const cfg = M.loadConfig(DATA_ROOT);
const fs = await import('node:fs');
const SCOPE = 'group:TOOLTEST';

// 这个用例验证特别关心群的"记 → 归位 → 召回"闭环；普通群现在默认不召回/不沉淀
try {
  fs.mkdirSync(DATA_ROOT + '/.qqbot-extensions/data', { recursive: true });
  fs.writeFileSync(DATA_ROOT + '/.qqbot-extensions/data/group-tiers.json',
    JSON.stringify({ defaultTier: 'normal', priority: [SCOPE], normal: [] }), 'utf8');
} catch { /* 写不了就按默认普通群跑 */ }

// 干净起点
for (const f of [M.memoryFile(DATA_ROOT, SCOPE), M.inboxFile(DATA_ROOT)]) {
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
}

const env = { logger: { debug() {}, info() {}, warn() {} } };

// ① 工具：add
console.log('\n[1] 工具 add（她主动记一条事实）');
const r1 = await tool.run({ action: 'add', text: '妈妈不吃香菜，点外卖要备注', kind: 'preference', subj: '妈妈' }, env);
r1.ok ? ok(r1.msg) : bad(r1.msg);
info(`收件箱: ${M.inboxFile(DATA_ROOT)} 存在=${fs.existsSync(M.inboxFile(DATA_ROOT))}`);

// ② 入站：收件箱应被并入当前群
console.log('\n[2] 下一条消息进来 → 收件箱归位到当前群');
const before = M.stats(DATA_ROOT, SCOPE, cfg).total;
let nextCalled = 0;
const rewritten = [];
const ctx = {
  text: '帮我点个麻辣烫',
  message: { groupOpenid: 'TOOLTEST', senderId: 'U1', senderName: '妈妈' },
  platform: { mentioned: true },
  rewrite: (o) => rewritten.push(o.text),
  logger: env.logger,
};
await ext.onInbound(ctx, async () => { nextCalled += 1; });
const after = M.stats(DATA_ROOT, SCOPE, cfg);
ok(`next()=${nextCalled}；记忆条数 ${before} → ${after.total}`);
if (!fs.existsSync(M.inboxFile(DATA_ROOT))) ok('收件箱已清空');
else bad('收件箱没被清空');

// ③ 下一句应该能召回刚记的那条
console.log('\n[3] 再问一句 → 应召回"不吃香菜"');
const rewritten2 = [];
const ctx2 = {
  text: '今天点外卖吃啥好',
  message: { groupOpenid: 'TOOLTEST', senderId: 'U1', senderName: '妈妈' },
  platform: { mentioned: true },
  rewrite: (o) => rewritten2.push(o.text),
  logger: env.logger,
};
await ext.onInbound(ctx2, async () => {});
const finalText = rewritten2[rewritten2.length - 1] || '';
if (finalText.includes('香菜')) {
  ok('召回到了她之前记的那条');
  for (const l of finalText.split('\n')) info(l);
} else {
  bad('没召回「不吃香菜」那条');
  for (const l of finalText.split('\n')) info(l);
}

// ④ list / forget
console.log('\n[4] 工具 list / forget');
const rList = await tool.run({ action: 'list', limit: 5 }, env);
rList.ok ? ok('list 可用') : bad(rList.msg);
for (const l of String(rList.msg).split('\n').slice(0, 4)) info(l);
const idMatch = String(rList.msg).match(/\[(m_[a-z0-9]+)\][^\n]*香菜/);
if (idMatch) {
  const rDel = await tool.run({ action: 'forget', id: idMatch[1] }, env);
  rDel.ok ? ok(`forget 生效: ${idMatch[1]}`) : bad(rDel.msg);
} else info('（没在 list 里找到那条，跳过 forget）');

// ⑤ 安全：坏参数不抛
console.log('\n[5] 异常安全');
for (const badArgs of [{ action: 'add' }, { action: 'nope' }, {}, { action: 'forget' }]) {
  try { const r = await tool.run(badArgs, env); ok(`args=${JSON.stringify(badArgs)} → ok=${r.ok}（未抛）`); }
  catch (e) { bad(`args=${JSON.stringify(badArgs)} 抛了: ${e.message}`); }
}

console.log('\n结论: ' + (process.exitCode ? '有问题，见上。' : '记忆写入闭环通过。'));
