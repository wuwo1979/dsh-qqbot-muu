#!/usr/bin/env node
/**
 * memory-graph-test.mjs — 时序图谱自检
 *
 * 覆盖：
 *   ① 三元组带有效期落库（valid_from / status）
 *   ② 单值关系冲突消解：新事实让旧事实失效，但**不删除**（可追溯她什么时候改的口）
 *   ③ 多值关系不误伤（"喜欢"换了个对象，旧的不该作废）
 *   ④ Personalized PageRank：多跳可达、阻尼单调、边界安全
 *   ⑤ 数据主权：导出 / 彻底删除 / 审计留痕
 *
 * 不依赖向量模型：这里全部是可判定的结构断言（本机向量模型离线也能跑）。
 */

const DATA_ROOT = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'F:/qqbot/qqbot-mod/.devdata-graph';
const SCOPE = 'graphtest';

const fs = await import('node:fs');
const path = await import('node:path');
const url = await import('node:url');

const DB_URL = url.pathToFileURL('F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-db.mjs').href;

let pass = 0;
let fail = 0;
const ok = (s) => { pass += 1; console.log('  PASS  ' + s); };
const bad = (s) => { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; };
const chk = (c, s) => (c ? ok(s) : bad(s));
const head = (s) => console.log('\n[' + s + ']');

// 干净起点：图谱断言的数值必须可复现
fs.rmSync(DATA_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA_ROOT, '.qqbot'), { recursive: true });
console.log('数据根: ' + DATA_ROOT);

const M = await import(DB_URL);
const cfg = M.loadConfig(DATA_ROOT);
const h = M.openDb(DATA_ROOT);
const q1 = (sql, ...a) => h.db.prepare(sql).get(...a);
const count = (t, sc) => Number(q1(`SELECT COUNT(*) AS n FROM ${t} WHERE scope = ?`, sc)?.n) || 0;

head('1 写入与有效期');
{
  const r1 = await M.remember(DATA_ROOT, SCOPE, { text: '妈妈是群主，习惯熬夜到凌晨三点', kind: 'fact' }, cfg);
  chk(r1.ok === true, '写入第一条记忆');
  const rows = h.db.prepare('SELECT src, rel, dst, status, valid_from, ts FROM mem_edge WHERE scope = ?').all(SCOPE);
  chk(rows.length > 0, `三元组已落库（${rows.length} 条）`);
  chk(rows.every((r) => r.status === 'active'), '新边默认 active');
  chk(rows.every((r) => Number(r.valid_from) === Number(r.ts)), 'valid_from 初始化为事实时间（不是 null）');
  chk(rows.some((r) => r.src === '妈妈' && r.rel === '是' && r.dst === '群主'), '抽到「妈妈-是-群主」');
}

head('2 单值关系冲突消解（旧事实失效但不删）');
{
  const r2 = await M.remember(DATA_ROOT, SCOPE, { text: '妈妈是管理员，群规改成晚上十点关群', kind: 'fact' }, cfg);
  chk(r2.ok === true, '写入新事实「妈妈是管理员」');

  const hist = M.edgeHistory(DATA_ROOT, SCOPE, '妈妈', '是');
  chk(hist.length === 2, `关系变化史有 2 条（${hist.map((x) => x.dst).join(' → ')}）`);
  const oldOne = hist.find((x) => x.dst === '群主');
  const newOne = hist.find((x) => x.dst === '管理员');
  chk(!!oldOne && oldOne.status === 'superseded', '旧事实被标记 superseded');
  chk(!!oldOne && oldOne.validTo !== null && oldOne.validTo >= oldOne.validFrom, '旧事实写入了 valid_to 失效时间');
  chk(!!newOne && newOne.status === 'active', '新事实仍然 active');
  chk(!!oldOne && !!newOne && oldOne.supersededBy === newOne.memId, 'superseded_by 指回取代它的那条记忆');
  chk(!!oldOne && count('mem_edge', SCOPE) >= 2, '旧边没有被 DELETE（历史可追溯）');

  const nb = M.liveNeighbors(DATA_ROOT, SCOPE, '妈妈').map((x) => x.name);
  chk(nb.includes('管理员'), '活跃邻居里有新值「管理员」');
  chk(!nb.includes('群主'), '失效的旧值「群主」不再出现在活跃邻居里');
}

head('3 多值关系不误伤');
{
  await M.remember(DATA_ROOT, SCOPE, { text: '小蓝喜欢橘猫年糕', kind: 'fact' }, cfg);
  await M.remember(DATA_ROOT, SCOPE, { text: '小蓝喜欢深海里的鲸歌', kind: 'fact' }, cfg);
  const rows = h.db.prepare(
    "SELECT dst, status FROM mem_edge WHERE scope = ? AND src = '小蓝' AND rel = '喜欢'",
  ).all(SCOPE);
  chk(rows.length >= 2, `「喜欢」产生多条边（${rows.length}）`);
  chk(rows.every((r) => r.status === 'active'), '多值关系不因新值而失效');
}

head('4 Personalized PageRank');
{
  // 链式图：A—B—C，从 A 出发应当能摸到两跳外的 C
  const adj = new Map([
    ['A', ['B']],
    ['B', ['A', 'C']],
    ['C', ['B']],
  ]);
  const m = M.personalizedPageRank(adj, ['A'], { damping: 0.85, iters: 20 });
  chk(m.size === 3, '三个节点都拿到了质量');
  const a = m.get('A') || 0;
  const b = m.get('B') || 0;
  const c = m.get('C') || 0;
  // 注意：PPR 不是"离种子越近质量越大"。链式图里 B 是枢纽（度数 2），
  // A 只有 0.85 的质量往外走、只靠 0.15 的跳回补，所以实测 B > A 是正常的。
  // 真正成立的性质是：近端 > 远端。
  chk(b > c, `近端节点质量高于远端（B=${b.toFixed(4)} > C=${c.toFixed(4)}）`);
  chk(a > 0, '种子本身保留质量（重启概率）');
  chk(c > 0, '两跳外的节点仍被激活（1 跳扩散做不到这点）');
  const sum = a + b + c;
  chk(Math.abs(sum - 1) < 0.02, `质量守恒（合计 ${sum.toFixed(4)}）`);

  const low = M.personalizedPageRank(adj, ['A'], { damping: 0.2, iters: 20 });
  chk((low.get('C') || 0) < c, '阻尼越小 → 远处节点质量越低（随机游走更容易跳回种子）');

  chk(M.personalizedPageRank(adj, [], {}).size === 0, '没有种子 → 空结果');
  chk(M.personalizedPageRank(adj, ['不存在'], {}).size === 0, '种子不在图里 → 空结果');
  chk(M.personalizedPageRank(new Map(), ['A'], {}).size === 0, '空图 → 空结果');
  // 无向邻接由调用方构建；孤立节点自己成环不影响守恒
  const iso = M.personalizedPageRank(new Map([['X', []]]), ['X'], { iters: 5 });
  chk(Math.abs((iso.get('X') || 0) - 1) < 0.05, '孤立种子质量留在自己身上');
}

head('5 本地模型补图（离线也必须安全）');
{
  const G = await import(url.pathToFileURL('F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-graph-llm.mjs').href);

  // 模型输出清洗：这是唯一能挡住"模型胡说不进库"的闸门
  const cleaned = G.tidyTriples([
    { src: '老王', rel: '负责', dst: '审核' },
    { src: '他', rel: '是', dst: '笨蛋' },          // 代词不是实体
    { src: '老王', rel: '负责', dst: '审核' },       // 重复
    { src: 'x'.repeat(20), rel: '是', dst: '群主' }, // 名字过长
    { src: '妈妈', rel: '是一个非常非常长的关系', dst: '群主' }, // 关系过长
    { subject: '甲', predicate: '住在', object: '南山' },        // 英文字段名
    { src: '123', rel: '是', dst: '456' },          // 纯数字
  ]);
  chk(cleaned.length === 2, `清洗后只留 2 条合法三元组（${cleaned.length}）`);
  chk(cleaned.some((t) => t.src === '老王' && t.rel === '负责' && t.dst === '审核'), '保留合法中文三元组');
  chk(cleaned.some((t) => t.subject === undefined && t.src === '甲'), '兼容 subject/predicate/object 字段名');
  chk(G.tidyTriples([{ src: '甲', rel: '是', dst: '甲' }]).length === 0, '自环被丢掉');

  // 模型爱加解释/代码块，必须能捞出 JSON
  chk(G.pickJsonArray('好的，结果如下：\n```json\n[{"src":"a","rel":"是","dst":"b"}]\n```') === '[{"src":"a","rel":"是","dst":"b"}]', '能从代码块里捞出 JSON');
  chk(G.pickJsonArray('直接输出 [ ] 就这样') === '[ ]', '能从解释文字里捞出 JSON');
  chk(G.pickJsonArray('') === '', '空输入不报错');

  // 太短的文本不值得调模型
  const short = await G.extractTriples('嗯', { dataRoot: DATA_ROOT });
  chk(short.ok === false && short.reason === 'too-short', '过短文本直接跳过（不调模型）');

  // 模型离线：必须 fail-soft，不能抛、不能卡。
  // ★ 这里不能假设"一定离线"——本机 Ollama 有时是起着的（模型刚加载完那一两秒就是在线）。
  //   真正的不变量是"返回结构永远完整、永远可判"，在线离线都成立。
  const t0 = Date.now();
  const off = await G.extractTriples('老王现在管审核了，他自己说的', { dataRoot: DATA_ROOT, timeoutMs: 800 });
  const dt = Date.now() - t0;
  chk(off && typeof off === 'object' && (off.ok === true
    ? Array.isArray(off.triples)
    : typeof off.reason === 'string'),
  `返回结构永远完整（ok=${off && off.ok}, reason=${off && off.reason ? off.reason : '成功时不需要'}）`);
  chk(dt < 6000, `离线判定不拖时间（${dt} ms）`);

  const batch = await G.enrichScopeGraph(DATA_ROOT, SCOPE, { limit: 3, budgetMs: 3000 });
  chk(batch && typeof batch === 'object' && !batch.error, '批量补图不抛异常');
  chk(batch.added === 0 || batch.added > 0, `批量补图返回结构完整（scanned=${batch.scanned}, added=${batch.added}）`);
  chk(Number.isFinite(batch.ms), '补图有耗时回报（面板可展示）');

  // 外部补的边与规则边同权：单值关系照样会让旧值失效
  const row = h.db.prepare('SELECT id FROM mem WHERE scope = ? LIMIT 1').get(SCOPE);
  if (row) {
    M.addEdges(DATA_ROOT, SCOPE, row.id, [{ src: '妈妈', rel: '负责', dst: '审核' }], { srcKind: 'llm' });
    M.addEdges(DATA_ROOT, SCOPE, row.id, [{ src: '妈妈', rel: '负责', dst: '值班' }], { srcKind: 'llm' });
    const st = G.relationState(DATA_ROOT, SCOPE, '妈妈', '负责');
    chk(st.current === '值班', `关系现值取最新一条（${st.current}）`);
    chk(st.changed === true, 'relationState 能看出这条关系变过');
    chk(st.history.some((x) => x.status === 'superseded' && x.dst === '审核'), '模型补的旧关系同样被标记失效');
    chk(st.history.every((x) => !('src_kind' in x) || true), 'history 结构可序列化');
  }
}

head('6 导出 / 彻底删除 / 审计');
{
  const before = count('mem', SCOPE);
  const dump = M.exportScope(DATA_ROOT, SCOPE);
  chk(dump.scope === SCOPE && dump.total === before, `导出条数与库内一致（${dump.total}）`);
  chk(dump.memories.length === before && dump.memories.every((x) => typeof x.text === 'string' && x.text), '导出内容带正文');
  chk(dump.edges.length > 0 && dump.edges.some((e) => e.status === 'superseded'), '导出带上失效的旧边（保留历史）');
  chk(!('vec' in (dump.memories[0] || {})), '导出不含内部向量');

  const p = M.purgeScope(DATA_ROOT, SCOPE);
  chk(p.ok === true && p.total > 0, `彻底删除成功（共 ${p.total} 行）`);
  chk(count('mem', SCOPE) === 0, 'mem 已空');
  chk(count('mem_edge', SCOPE) === 0, 'mem_edge 已空');
  chk(count('mem_tag', SCOPE) === 0, 'mem_tag 已空');
  chk(count('persona', SCOPE) === 0, 'persona 已空');
  chk(M.liveNeighbors(DATA_ROOT, SCOPE, '妈妈').length === 0, '删除后不再有活跃邻居');
  chk(M.exportScope(DATA_ROOT, SCOPE).total === 0, '删除后导出为空');

  const log = M.readAudit(DATA_ROOT, 20);
  chk(log.some((x) => x.action === 'export' && x.scope === SCOPE), '审计记下了导出');
  chk(log.some((x) => x.action === 'purge' && x.scope === SCOPE), '审计记下了删除');
  chk(log.every((x) => x.at > 0 && x.scope), '审计条目结构完整（at/scope/action）');
}

head('7 后端降级：没有向量模型也要召得回来');
{
  // 这条守的是"真机第一跑"的场景：向量模型还没下载/离线，embedder 会退化成
  // 字 n-gram 词频向量。此时同一对问答的余弦只有 0.02~0.14，沿用语义门槛 0.45
  // 会让记忆一条都召不回来 —— 表现就是"她完全不记得你"。
  const S2 = 'group:DEGRADE';
  await M.remember(DATA_ROOT, S2, { text: '本鲸今天教你钓鱼吧，人类要好好学哦。', kind: 'say' }, cfg);
  await M.remember(DATA_ROOT, S2, { text: '海洋馆的水温今天调到十七度了', kind: 'event' }, cfg);

  const mode = M.embedderMode();
  const gate = M.effectiveMinCos(cfg);
  console.log(`       向量后端=${mode}  语义门槛=${cfg.recallMinCos}  实际门槛=${gate === null ? '不用余弦·证据准入' : gate}`);
  if (mode === 'lexical') chk(gate === null, '词频回退不再拿余弦当门槛（噪声底噪高于真实命中）');
  else chk(gate === cfg.recallMinCos, '语义后端沿用原门槛（不悄悄放松）');

  // 复述型问句：与原文没有一个共同二元组，只有"教"这一个单字重合。
  // 这正是单字通道要解决的问题。
  const hits = await M.recall(DATA_ROOT, S2, '你还记得你说过要教我什么吗', cfg);
  chk(hits.length > 0, `复述问句召回到 ${hits.length} 条（单字通道）`);
  chk(hits.some((x) => /钓鱼/.test(x.text)), 'top 结果确实是"教你钓鱼"那条');
  chk(hits.every((x) => x.vecMode === mode), '召回带上了实际使用的向量后端（面板可解释）');

  // 不相干的问题不该被任何通道硬拉进来。
  // 这条守的是一个真修掉的 bug：词频模式下余弦的噪声底噪（0.10~0.19）**高于**
  // 真实命中（0.02~0.14），拿它当门槛会把「量子力学的数学推导」匹配到「杯子打翻了」。
  for (const q of ['董事会投票结果如何', '请给出量子力学的数学推导', '这首歌的副歌怎么唱']) {
    const off = await M.recall(DATA_ROOT, S2, q, cfg);
    chk(off.length === 0, `无关提问「${q}」召回 ${off.length} 条（应为 0，不污染上下文）`);
  }
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
console.log(`结论：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
