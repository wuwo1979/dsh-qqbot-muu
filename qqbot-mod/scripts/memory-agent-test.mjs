#!/usr/bin/env node
/**
 * memory-agent-test.mjs — 「记忆分身」端到端自检（不调真模型，注入假 chat）
 *
 * 覆盖：JSON 解析容错 / 事实入库 / 印象卡写入与合并键 / 心情写入与过期 /
 *       新消息不足跳过 / 重复运行跳过 / 坏 JSON 不写库 / 幻觉人物卡片被丢弃 /
 *       [印象][状态] 注入块。
 */

const DATA_ROOT = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'F:/qqbot/qqbot-mod/.devdata-agent';
const fs = await import('node:fs');
const path = await import('node:path');
const url = await import('node:url');

const BASE = 'F:/qqbot/dshqqbot/.qqbot-extensions/lib/';
const AGENT_URL = url.pathToFileURL(BASE + 'memory-agent.mjs').href;
const FACADE_URL = url.pathToFileURL(BASE + 'memory.mjs').href;
const PROFILE_URL = url.pathToFileURL(BASE + 'profile-core.mjs').href;

let pass = 0, fail = 0;
const ok = (s) => { pass += 1; console.log('  PASS  ' + s); };
const bad = (s) => { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; };
const chk = (cond, s) => (cond ? ok(s) : bad(s));
const head = (s) => console.log('\n[' + s + ']');

fs.rmSync(DATA_ROOT, { recursive: true, force: true });
const now = Date.now();
// 这些测试群按「特别关心群」跑（普通群不写个人印象卡，2026-10-24 起）
fs.mkdirSync(path.join(DATA_ROOT, '.qqbot-extensions', 'data'), { recursive: true });
fs.writeFileSync(
  path.join(DATA_ROOT, '.qqbot-extensions', 'data', 'group-tiers.json'),
  JSON.stringify({ defaultTier: 'normal', priority: ['AGENT', 'AGENT2', 'AGENT3'], normal: [] }),
  'utf8',
);

function seed(scopeDir, scope, rows) {
  const dir = path.join(DATA_ROOT, '.qqbot', 'msg-history', scopeDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-10-23.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
}

const AGENT = 'group:AGENT';
seed('group_AGENT', AGENT, [
  { id: 'a1', s: 'U1', n: '爸爸', t: now - 60000, k: 'text', x: '我最近在做扩散模型实验，基本都熬到三点', me: false },
  { id: 'a2', s: 'self', n: '机器人', t: now - 55000, k: 'text', x: '啊这，别熬了', me: true },
  { id: 'a3', s: 'U1', n: '爸爸', t: now - 50000, k: 'text', x: '养了只猫叫年糕', me: false },
  { id: 'a4', s: 'U2', n: '妈妈', t: now - 40000, k: 'text', x: '明天一起打本吗', me: false },
  { id: 'a5', s: 'U1', n: '爸爸', t: now - 30000, k: 'text', x: '行，打完我去喂猫', me: false },
  { id: 'a6', s: 'self', n: '机器人', t: now - 20000, k: 'text', x: '好嘞', me: true },
]);

const M = await import(FACADE_URL);
const P = await import(PROFILE_URL);
const A = await import(AGENT_URL);

head('1 JSON 容错');
{
  const p1 = A.parseAgentJson('```json\n{"facts":[{"text":"甲喜欢猫","kind":"preference"}],"mood":"困"}\n```');
  chk(p1 && p1.facts.length === 1 && p1.mood === '困', '剥 ```json 围栏');
  const p2 = A.parseAgentJson('废话。{"facts":["乙在考研"]} 后面还有话');
  chk(p2 && p2.facts[0] === '乙在考研', '前后有废话也能抠出 JSON');
  const p3 = A.parseAgentJson('["丙搬走了"]');
  chk(p3 && p3.facts.length === 1 && p3.facts[0] === '丙搬走了', '裸数组当 facts');
  chk(A.parseAgentJson('完全不是 json') === null, '坏文本返回 null');
}

head('2 跑一轮');
const fakeText = JSON.stringify({
  facts: [
    { text: '爸爸在做扩散模型实验，常熬夜到三点', kind: 'preference', subj: '爸爸' },
    { text: '爸爸养了只猫叫年糕', kind: 'fact', subj: '爸爸' },
  ],
  cards: [{ name: '爸爸', card: '研究生，做扩散模型，常熬夜，养猫叫年糕' }],
  mood: '有点困但还想聊',
  relation: { name: '爸爸', delta: 2, note: '聊到猫和熬夜，愿意继续聊' },
  insights: [
    { text: '原来熬夜的人也需要有人提醒他早点休息，我以后多说几句', source: 'family' },
    { text: 'cat', source: 'nonsense-source' },
    { text: '太短', source: 'chat' },
  ],
});
let promptSeen = '';
const fakeChat = async ({ messages }) => {
  promptSeen = messages.map((m) => m.content).join('\n');
  return { ok: true, text: '```json\n' + fakeText + '\n```', ms: 12, model: 'fake' };
};

let r1;
{
  r1 = await A.runTurnAgent({
    dataRoot: DATA_ROOT,
    scope: AGENT,
    cfg: { enabled: true, memoryAgent: { enabled: true, minNewMessages: 2, minIntervalMs: 0, ingest: true, log: true, insights: true, selfReflect: false } },
    llmCfg: {},
    chatImpl: fakeChat,
    now: now,
  });
  chk(r1.ok === true, `run ok（${r1.reason || ''} ${r1.error || ''}）`);
  chk(promptSeen.includes('爸爸') && promptSeen.includes('年糕'), 'prompt 带上了最近对话');
  chk(r1.facts.length === 2 && r1.facts.every((f) => f.ok), '两条事实写入成功');
  chk(r1.cards.length === 1, '印象卡写入 1 条');
  chk(r1.mood === '有点困但还想聊', '心情写入成功');
  chk(promptSeen.includes('relation') && promptSeen.includes('delta'), 'prompt 要求输出关系变化');
  chk(r1.relation && r1.relation.name === '爸爸' && r1.relation.delta === 2, '关系温度写入 1 条（+2）');

  chk(r1.insights.length === 1, `学习心得只收 1 条（脏源/太短被滤，实际 ${r1.insights.length}）`);
  chk(r1.insights[0].source === 'family', '心得来源保留 family');
  const gmem = M.loadMemories(DATA_ROOT, P.GLOBAL_SCOPE) || [];
  const ins = gmem.find((m) => m.kind === 'insight' && String(m.text).includes('熬夜'));
  chk(!!ins, '心得已入库（GLOBAL_SCOPE kind=insight）');
  chk(String(ins.subj) === 'family', '心得来源存 subj');

  const mem = M.loadMemories(DATA_ROOT, AGENT) || [];
  const pref = mem.find((m) => m.kind === 'preference' && String(m.text).includes('扩散模型'));
  chk(!!pref, '偏好事实已在记忆库（kind=preference）');
  chk(mem.some((m) => String(m.text).includes('年糕')), '养猫事实已在记忆库');

  const card = M.getPersonaValue(DATA_ROOT, P.GLOBAL_SCOPE, 'card:U1');
  chk(!!card && String(card.value).startsWith('爸爸：'), `印象卡键是稳定 id（个人层，实际 ${card && card.value}）`);
  const mood = P.getMood(DATA_ROOT, AGENT, { ttlMs: 30 * 60 * 1000 });
  chk(!!mood && mood.text === '有点困但还想聊', '心情可读且未过期');
  chk(fs.existsSync(path.join(DATA_ROOT, '.qqbot', 'memory-agent-log.jsonl')), '写入整理日志');
}

head('3 注入块');
{
  const pb = P.profileBlockFor(DATA_ROOT, AGENT, { senderId: 'U1', senderName: '爸爸' }, {});
  chk(pb.startsWith('\n[印象]') && pb.includes('年糕') && pb.endsWith('[/印象]'), `印象块格式正确：${pb.slice(0, 50)}…`);
  const mb = P.moodBlockFor(DATA_ROOT, AGENT, { ttlMs: 30 * 60 * 1000 });
  chk(mb === '\n[状态]有点困但还想聊[/状态]', '状态块格式正确');
  const bb = P.bondBlockFor(DATA_ROOT, AGENT, { senderId: 'U1', senderName: '爸爸' }, {});
  chk(bb.startsWith('\n[关系]') && bb.includes('亲近') && bb.includes('信任') && bb.endsWith('[/关系]'), `关系块格式正确：${bb.slice(0, 70)}…`);
  const bond = P.getBond(DATA_ROOT, AGENT, { senderId: 'U1', senderName: '爸爸' }, {});
  chk(bond && bond.a === 14 && bond.t === 12 && bond.note.includes('猫'), `关系数值从起点 +2（实际 ${bond && bond.a}/${bond && bond.t}）`);
  // 把这条状态的时间改成 2 小时前，验证 TTL 过期（不能只把 ttl 设 1ms —— 有 60s 下限保护）
  try {
    const h = M.openDb(DATA_ROOT);
    h.db.prepare('UPDATE persona SET ts = ? WHERE scope = ? AND ckey = ?').run(now - 2 * 3600000, AGENT, '__mood');
  } catch { /* ignore */ }
  const stale = P.getMood(DATA_ROOT, AGENT, { ttlMs: 30 * 60 * 1000 });
  chk(stale === null, '过期心情不再返回');
  chk(P.moodBlockFor(DATA_ROOT, AGENT, { ttlMs: 30 * 60 * 1000 }) === '', '过期后状态块为空');
}

head('4 跳过');
{
  const r2 = await A.runTurnAgent({
    dataRoot: DATA_ROOT, scope: AGENT,
    cfg: { enabled: true, memoryAgent: { enabled: true, minNewMessages: 2, minIntervalMs: 0, ingest: true } },
    llmCfg: {}, chatImpl: fakeChat, now: now,
  });
  chk(r2.ok === false && r2.reason === 'few-new', `没有新消息就跳过（实际 ${r2.reason}）`);

  const r3 = await A.runTurnAgent({
    dataRoot: DATA_ROOT, scope: AGENT,
    cfg: { enabled: true, memoryAgent: { enabled: false } },
    llmCfg: {}, chatImpl: fakeChat, now: now,
  });
  chk(r3.reason === 'disabled', 'enabled=false 直接退出');
}

head('5 坏 JSON / 幻觉');
{
  const S2 = 'group:AGENT2';
  seed('group_AGENT2', S2, [
    { id: 'b1', s: 'U7', n: '阿七', t: now - 5000, k: 'text', x: '我今天搬去杭州了', me: false },
    { id: 'b2', s: 'self', n: '机器人', t: now - 4000, k: 'text', x: '啊，搬这么远', me: true },
    { id: 'b3', s: 'U7', n: '阿七', t: now - 3000, k: 'text', x: '嗯，以后不在这个群了', me: false },
  ]);
  const before = (M.loadMemories(DATA_ROOT, S2) || []).length;
  const rb = await A.runTurnAgent({
    dataRoot: DATA_ROOT, scope: S2,
    cfg: { enabled: true, memoryAgent: { enabled: true, minNewMessages: 2, minIntervalMs: 0, ingest: true } },
    llmCfg: {}, chatImpl: async () => ({ ok: true, text: '我拒绝输出 JSON' }), now: now,
  });
  chk(rb.ok === false && rb.reason === 'parse', `坏 JSON 不写库（${rb.reason}）`);
  chk((M.loadMemories(DATA_ROOT, S2) || []).length === before, '坏 JSON 没有新增记忆');

  const S3 = 'group:AGENT3';
  seed('group_AGENT3', S3, [
    { id: 'c1', s: 'U8', n: '小八', t: now - 5000, k: 'text', x: '我下周要去面试', me: false },
    { id: 'c2', s: 'self', n: '机器人', t: now - 4000, k: 'text', x: '加油啊', me: true },
    { id: 'c3', s: 'U8', n: '小八', t: now - 3000, k: 'text', x: '有点紧张', me: false },
  ]);
  const rc = await A.runTurnAgent({
    dataRoot: DATA_ROOT, scope: S3,
    cfg: { enabled: true, memoryAgent: { enabled: true, minNewMessages: 2, minIntervalMs: 0, ingest: true } },
    llmCfg: {},
    chatImpl: async () => ({
      ok: true,
      text: JSON.stringify({
        facts: [],
        cards: [{ name: '不存在的人', card: '这是个幻觉，不该写进库' }],
        mood: '',
      }),
    }),
    now: now,
  });
  chk(rc.ok === true && rc.cards.length === 0, '幻觉人物卡片被丢弃');
  chk(!M.getPersonaValue(DATA_ROOT, S3, 'card:不存在的人'), '库里没有幻觉卡片');

  // 普通群（未列入 priority）：不区分群成员，不写个人卡
  const S4 = 'group:AGENT_NORMAL';
  seed('group_AGENT_NORMAL', S4, [
    { id: 'd1', s: 'U9', n: '小九', t: now - 5000, k: 'text', x: '今天我们群好热闹', me: false },
    { id: 'd2', s: 'self', n: '机器人', t: now - 4000, k: 'text', x: '确实', me: true },
    { id: 'd3', s: 'U9', n: '小九', t: now - 3000, k: 'text', x: '晚上继续聊', me: false },
  ]);
  const rn = await A.runTurnAgent({
    dataRoot: DATA_ROOT, scope: S4,
    cfg: { enabled: true, memoryAgent: { enabled: true, minNewMessages: 2, minIntervalMs: 0, ingest: true } },
    llmCfg: {},
    chatImpl: async () => ({
      ok: true, text: JSON.stringify({ facts: [{ text: '小九今晚要通宵', kind: 'fact', subj: '小九' }], cards: [{ name: '小九', card: '爱吵架、脾气差' }], mood: '' }),
    }),
    now: now,
  });
  chk(rn.ok === true && rn.cards.length === 0, '普通群不写个人印象卡');
  chk(!M.getPersonaValue(DATA_ROOT, P.GLOBAL_SCOPE, 'card:U9'), '普通群里查不到个人卡（个人层也没有）');
  chk((M.loadMemories(DATA_ROOT, S4) || []).length === 0, '普通群不沉淀长期记忆（只看信息本身）');
}

head('6 出站挂点');
{
  const OB_URL = url.pathToFileURL('F:/qqbot/dshqqbot/.qqbot-extensions/outbound/memory-agent.mjs').href;
  const OB = await import(OB_URL);
  let nextCalled = false;
  await OB.onOutbound({
    phase: 'send', target: { peerId: 'AGENT', scope: 'group' }, text: '好嘞', dataRoot: DATA_ROOT,
  }, async () => { nextCalled = true; });
  chk(nextCalled === true, '非 turnEnd 直接放行');

  nextCalled = false;
  const t0 = Date.now();
  await OB.onOutbound({
    phase: 'turnEnd', target: { peerId: 'AGENT', scope: 'group' }, text: '好嘞', dataRoot: DATA_ROOT,
  }, async () => { nextCalled = true; });
  chk(nextCalled === true, 'turnEnd 先放行（整理不挡回复）');
  chk(Date.now() - t0 < 1000, `放行耗时 < 1s（实际 ${Date.now() - t0}ms）`);
}

head('7 自我反思（runSelfReflection）');
{
  const reflectChat = async () => ({
    ok: true,
    text: JSON.stringify({ growth: '今天学到边界的重要性，下次会更注意分寸，不再把热心当理所当然。' }),
  });
  const rr = await A.runSelfReflection({
    dataRoot: DATA_ROOT, cfg: { memoryAgent: { log: true } }, chatImpl: reflectChat,
  });
  chk(rr.ok === true, `反思跑通（${rr.reason || rr.error || ''}）`);
  chk(String(rr.text || '').includes('边界'), '心得文本正确');
  const g2 = (M.loadMemories(DATA_ROOT, P.GLOBAL_SCOPE) || []).filter((m) => m.kind === 'growth');
  chk(g2.length === 1, 'growth 心得入库 1 条');
  const card = M.getPersonaValue(DATA_ROOT, P.GLOBAL_SCOPE, 'growth:latest');
  chk(!!card && String(card.value).startsWith('最近的我：'), 'persona growth:latest 已写（[印象] 链路可带出）');
  const bad = await A.runSelfReflection({
    dataRoot: DATA_ROOT, cfg: {}, chatImpl: async () => ({ ok: true, text: '不是 json' }),
  });
  chk(bad.ok === false && bad.reason === 'parse', '非 JSON 输出安全失败');
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
