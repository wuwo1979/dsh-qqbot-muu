#!/usr/bin/env node
/**
 * history-full-import-test.mjs — 「指定对话 + 完整记录」导入与库维护
 *
 * 这轮要守住四件事，每一条都是之前做不到或会悄悄坏的：
 *   ① 指定联系人：从"全量导出"里只捞出和某一个人的对话，而且能分清"我"和"对方"；
 *   ② 完整记录：--archive 写进聊天台账的是**原样**（不筛寒暄、不砍长消息），
 *      并且重复导入幂等；60 天保留窗不能把它删掉；
 *   ③ 双方印象：除了"TA 是什么人"，还要有一条"我们俩怎么相处"（关系记忆）；
 *   ④ 库自愈：索引表被删/老库缺表时，重新打开要能自己补回来，体检要能看出来。
 *
 * 跑法：node F:\qqbot\qqbot-mod\scripts\history-full-import-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.tmpdir(), 'qqs-fullimport-' + process.pid);
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

const LIB = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/';
const IMPORT = await import(LIB + 'qq-history-import.mjs');
const CHAT = await import(LIB + 'chatlog-db.mjs');
const DB = await import(LIB + 'memory-db.mjs');

// ── 造一份"全量导出"：两个人和一个群混在一个 txt 里 ────────────────────────
const LONG_PARA = '我把那套体素渲染的整个思路重新捋了一遍，'
  + '关键是不能在每个 chunk 里单独建 mesh，那样 draw call 会爆掉，'
  + '得先把同一种材质的方块合并成一个批次，再用一张图集去贴，'
  + '另外 LOD 的切换阈值要按屏幕空间误差算而不是按距离算，'
  + '不然远处的地形会一直在两个层级之间闪。这套东西我写了大概四天，'
  + '中间踩了三个坑，第一个是法线方向反了，第二个是透明方块排序，'
  + '第三个最要命：区块边界上的面剔除没有考虑邻居区块还没加载的情况，'
  + '结果边界会露出一个一个的洞。后来我加了一个脏标记队列，'
  + '等邻居到齐再重算那一层面，问题才算彻底解决。'
  + '除此之外还有内存的问题：每个区块的顶点数据如果用 Float32Array 单独存，'
  + '碎片会多到 GC 一直在跑，所以我改成一个大 slab 加索引分配器，'
  + '按需扩容、按块回收，跑了一晚上内存曲线才算是平的。'
  + '光照那边也折腾了很久，最终没有走传统的光照图，'
  + '而是给每个体素存一个 AO 级别，在着色器里用三线性插值平滑，'
  + '效果不如烘焙但胜在完全动态，拆墙建墙不用重新烘。'
  + '现在回头看，最难的不是技术本身，是决定要砍掉哪些东西——'
  + '阴影、反射、后处理全砍了，只留下能撑住帧率的部分。'
  + '还有个容易被忽略的点：区块的坐标系一定要用整数，'
  + '我一开始图省事用了浮点，结果玩家走到坐标很大的地方就开始抖，'
  + '方块边缘一个像素一个像素地跳，查了两天才发现是精度掉了。'
  + '改成以玩家为中心的相对坐标之后，抖动彻底消失，'
  + '代价是每次跨区块都要重算一遍可见性，但那个开销比抖动好接受得多。'
  + '网络同步也是个大坑：体素改动不能整块重传，只能传差量，'
  + '而且差量要带版本号，不然两端会越走越偏，最后玩家看到的地形都不一样。';

const TXT = [
  // 会话 A：爸爸（要导入的那个）
  '2026-09-01 22:14:03 爸爸(10001)',
  '今天又加班到十一点，引擎那边的着色器还没调通',
  '2026-09-01 22:15:10 我(99999)',
  '这么晚啊，早点睡吧',
  '2026-09-02 23:40:11 爸爸(10001)',
  '我觉得这个 voxel 方案在移动端跑不动，得换个思路',
  '2026-09-02 23:41:02 我(99999)',
  '那你打算换成什么',
  '2026-09-02 23:42:30 爸爸(10001)',
  LONG_PARA,
  // 会话 B：阿澈（同一个文件里的另一个人，不该被导入）
  '2026-09-04 09:12:00 阿澈(20002)',
  '早上六点起来跑了十公里，配速四分半，感觉膝盖有点不舒服',
  '2026-09-05 07:30:22 阿澈(20002)',
  '周末去爬山吗，走野线，大概六个小时',
  // 群聊：多个发言人（不该被当成一对一）
  '2026-09-06 12:00:00 群友甲(30003)',
  '中午吃什么，楼下那家新开的拉面',
  '2026-09-06 12:00:30 群友乙(40004)',
  '我不吃辣的，你们去吧',
  '2026-09-06 12:01:00 群友丙(50005)',
  '那我也不去了，下午还有个会要开',
].join('\n');

// ── ① 裁剪：只 leave 爸爸 + 我 ───────────────────────────────────────────
head('[1] 指定联系人：从全量导出里只留这一段');
const PARSED = IMPORT.parseHistory(TXT);
ok('解析出全部消息', PARSED.messages.length >= 10, String(PARSED.messages.length));

const cut = IMPORT.filterConversation(PARSED.messages, { peer: '10001', selfUin: '99999' });
ok('只留下 5 条（爸爸 3 + 我 2）', cut.kept === 5, 'kept=' + cut.kept);
ok('没有阿澈/群友混进来', !cut.messages.some((m) => /阿澈|群友/.test(m.nick)));
ok('认出"我"的条数', cut.selfCount === 2, 'selfCount=' + cut.selfCount);
ok('不需要补 self-uin', cut.needSelfUin === false);

const cut2 = IMPORT.filterConversation(PARSED.messages, { peer: '10001' });
ok('不给 self-uin 且文件里有多人 → 提示 needSelfUin', cut2.needSelfUin === true);
ok('这种情况下只留对方的话', cut2.kept === 3 && !cut2.messages.some((m) => m.nick === '我'), 'kept=' + cut2.kept);

const cut3 = IMPORT.filterConversation(PARSED.messages, { peer: '阿澈' });
ok('按昵称也能裁（不撞号）', cut3.kept === 2 && cut3.messages.every((m) => m.uin === '20002'), 'kept=' + cut3.kept);

// ── ② 完整归档 ───────────────────────────────────────────────────────────
head('[2] 完整归档：原样进台账，不筛寒暄、不砍长消息');
const r1 = await IMPORT.importHistory({
  raw: TXT, dataRoot: ROOT, peer: '10001', selfUin: '99999', selfLabel: '我',
  archive: true, minScore: 0.55,
});
ok('导入成功', r1.ok === true, JSON.stringify(r1).slice(0, 200));
ok('归档 5 条', r1.archived === 5, 'archived=' + r1.archived);
ok('归档 scope 按 QQ 号命名', r1.archiveScope === 'c2c:qq:10001', r1.archiveScope);

const rows = CHAT.queryChat(ROOT, 'c2c:qq:10001', { limit: 50 });
ok('台账里能查到这段对话', rows.length === 5, String(rows.length));
const longRow = rows.find((x) => x.text.includes('体素渲染'));
ok('长消息没有被截断到 500 字', !!longRow && longRow.text.length > 500, longRow ? String(longRow.text.length) : 'missing');
ok('寒暄"这么晚啊"也留下来了（台账不筛）', rows.some((x) => x.text.includes('这么晚')));
ok('方向标记正确（我 = out）', rows.filter((x) => x.dir === 'out').length === 2,
  rows.map((x) => x.dir).join(','));

const r2 = await IMPORT.importHistory({
  raw: TXT, dataRoot: ROOT, peer: '10001', selfUin: '99999', selfLabel: '我',
  archive: true, minScore: 0.55,
});
ok('重复导入不涨条数', r2.archived === 0 && CHAT.queryChat(ROOT, 'c2c:qq:10001', { limit: 50 }).length === 5,
  'archived=' + r2.archived);

head('[3] 保留窗不能把导入的档案删掉');
const pruned = CHAT.pruneChat(ROOT, { retentionDays: 1, capPerScope: 2 });
ok('prune 跑完了', pruned.ok === true);
ok('导入的行仍在（60 天窗只管自动采集）', CHAT.queryChat(ROOT, 'c2c:qq:10001', { limit: 50 }).length === 5,
  'after prune=' + CHAT.queryChat(ROOT, 'c2c:qq:10001', { limit: 50 }).length);
info('删除计数 ' + pruned.deleted + '（导入的行不计入）');

// ── ③ 双方画像 ───────────────────────────────────────────────────────────
head('[4] 双方印象：TA 是谁 + 我们怎么相处');
ok('生成了双方画像文本', !!r1.pair && r1.pair.length > 30, r1.pair);
ok('画像里两个人的量都写了', /爸爸 3 条/.test(r1.pair || '') && /我 2 条/.test(r1.pair || ''), r1.pair);
ok('关系记忆已写入', r1.pairWritten === true);
const personMems = DB.listAll(ROOT, { limit: 50, scopeFilter: 'person:qq:10001' }).items
  || DB.listAll(ROOT, { limit: 50, scopeFilter: 'person:qq:10001' });
const relRow = (Array.isArray(personMems) ? personMems : personMems.items || []).find((x) => x.kind === 'relation');
ok('kind=relation 的那条在 person scope 里', !!relRow, JSON.stringify(personMems).slice(0, 200));
ok('关系记忆里带共同话题/活跃时段这类相处信息',
  !!relRow && /轮对话|条（平均/.test(String(relRow.text)), relRow && String(relRow.text).slice(0, 80));

const pair = IMPORT.pairProfileOf(
  IMPORT.filterConversation(PARSED.messages, { peer: '10001', selfUin: '99999' })
    .messages.map((m) => ({ ...m, dir: m.uin === '99999' ? 'out' : 'in' })),
);
ok('pairProfile 有两侧统计', pair && pair.other.n === 3 && pair.me.n === 2, JSON.stringify(pair && { a: pair.other.n, b: pair.me.n }));
ok('能算出会话段数', pair && pair.sessions >= 2, 'sessions=' + (pair && pair.sessions));

// ── ④ 库自愈 + 体检 ──────────────────────────────────────────────────────
head('[5] 库自愈：索引表被删掉要能补回来');
const h = DB.getHandle(ROOT);
h.db.exec('DROP TABLE mem_tok');
ok('已经成功把 mem_tok 删了', !h.db.prepare("SELECT 1 FROM sqlite_master WHERE name='mem_tok'").get());
DB.closeDb(ROOT);
const health1 = DB.dbHealth(ROOT);
ok('重新打开后 mem_tok 又建回来了',
  Number(health1.tables.mem_tok) >= 0 && health1.missing.length === 0, JSON.stringify(health1.missing));

const rep = DB.maintainDb(ROOT, { reindex: true, backup: true, keep: 2 });
ok('维护产出备份', !!rep.backup && fs.existsSync(rep.backup), rep.reason);
ok('备份是个非空文件', rep.backup ? fs.statSync(rep.backup).size > 0 : false);
ok('索引重建覆盖了全部 scope', Array.isArray(rep.reindexed) && rep.reindexed.every((x) => x.ok),
  JSON.stringify(rep.reindexed || []).slice(0, 160));

const health2 = DB.dbHealth(ROOT);
ok('体检结论 healthy', health2.healthy === true, health2.verdict);
ok('体检能看到 schema 版本', health2.schemaVersion === DB.SCHEMA_VERSION, `${health2.schemaVersion}/${DB.SCHEMA_VERSION}`);
ok('倒排覆盖率 > 0', health2.indexedMem > 0, String(health2.indexedMem));
info('库大小 ' + health2.bytes + 'B，页 ' + health2.pageCount + '，freelist ' + health2.freePages);

head('[6] 收尾');
try { DB.closeDb(ROOT); } catch { /* 已经关掉 */ }
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 文件被占用就留给系统清理 */ }
console.log(`\nPASS ${pass} / FAIL ${fail}`);
console.log(fail === 0 ? '结论：指定对话、完整归档、双方印象、库自愈都成立' : '结论：有断言失败，需要修');
process.exitCode = fail === 0 ? 0 : 1;
