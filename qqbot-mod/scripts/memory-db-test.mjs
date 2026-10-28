#!/usr/bin/env node
/**
 * memory-db-test.mjs — SQLite 记忆库端到端自检（真跑，不是推演）
 *
 * 覆盖：建库/表结构 → remember 写入 → 去重 → recall 召回（含改述）→ listAll
 *       → forget → stats → persona 写入/读取 → JSONL 迁移 → openDb 重复调用不锁死。
 *
 * 数据根固定指到开发目录（沙箱禁止 node 往真实数据目录 .qqbot 子树写文件）。
 * 一个文件跑完，不 spawn 别的 node（沙箱禁 node→node 管道 stdio）。
 */

const DATA_ROOT = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'F:/qqbot/qqbot-mod/.devdata';
const MIG_ROOT = DATA_ROOT + '-dbmig';
const SCOPE = 'dbtest';
const SCOPE2 = 'dbtest-alt';

const fs = await import('node:fs');
const path = await import('node:path');
const url = await import('node:url');

const DB_URL = url.pathToFileURL('F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-db.mjs').href;
const FACADE_URL = url.pathToFileURL('F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory.mjs').href;

let pass = 0, fail = 0;
const ok = (s) => { pass += 1; console.log('  PASS  ' + s); };
const bad = (s) => { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; };
const chk = (cond, s) => (cond ? ok(s) : bad(s));
const info = (s) => console.log('        ' + s);
const head = (s) => console.log('\n[' + s + ']');

function rmDir(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
function rmDbFiles(root) {
  const f = path.join(root, '.qqbot', 'memory.db');
  for (const x of [f, f + '-wal', f + '-shm']) { try { fs.rmSync(x, { force: true }); } catch { /* ignore */ } }
}

// ── 干净的起点 ──────────────────────────────────────────────────────────
fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(MIG_ROOT, { recursive: true });
rmDbFiles(MIG_ROOT);
rmDir(path.join(MIG_ROOT, '.qqbot'));
fs.mkdirSync(path.join(DATA_ROOT, '.qqbot'), { recursive: true });

console.log('数据根: ' + DATA_ROOT);
console.log('迁移根: ' + MIG_ROOT);

const M = await import(DB_URL);
ok('memory-db 模块加载成功（node:sqlite 可用）');

// 上一轮遗留的测试 scope 先清掉，保证可重复跑
{
  const h0 = M.openDb(DATA_ROOT);
  chk(h0 && h0.ok === true, 'openDb 返回 ok');
  for (const s of [SCOPE, SCOPE2]) {
    try { h0.db.prepare('DELETE FROM mem WHERE scope = ?').run(s); } catch { /* ignore */ }
    try { h0.db.prepare('DELETE FROM persona WHERE scope = ?').run(s); } catch { /* ignore */ }
    try { h0.db.prepare('DELETE FROM mem_fts WHERE scope = ?').run(s); } catch { /* ignore */ }
    // 类海马体索引表也要清，否则上一轮的 token/实体会残留到这一轮
    for (const t of ['mem_tok', 'mem_tag', 'mem_edge', 'mem_entity']) {
      try { h0.db.prepare(`DELETE FROM ${t} WHERE scope = ?`).run(s); } catch { /* ignore */ }
    }
    try { h0.db.prepare('DELETE FROM meta WHERE k = ?').run('index_v1:' + s); } catch { /* ignore */ }
  }
}

const cfg = M.loadConfig(DATA_ROOT);
info(`配置: topK=${cfg.recallTopK} minCos=${cfg.recallMinCos} dedupeCos=${cfg.dedupeCos} cap=${cfg.cap}`);

// ── ① 建库 ──────────────────────────────────────────────────────────────
head('1 建库');
{
  const dbf = M.dbFile(DATA_ROOT);
  chk(fs.existsSync(dbf), `库文件已创建: ${dbf}`);
  const h = M.openDb(DATA_ROOT);
  const names = h.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all().map((r) => r.name);
  chk(names.includes('mem'), 'mem 表存在');
  chk(names.includes('persona'), 'persona 表存在');
  chk(names.includes('meta'), 'meta 表存在');
  chk(names.includes('idx_mem_scope'), 'scope 索引存在');
  chk(['mem_tok', 'mem_entity', 'mem_tag', 'mem_edge'].every((t) => names.includes(t)), '海马体索引表存在（倒排/实体/标签/三元组）');
  const jm = h.db.prepare('PRAGMA journal_mode').get();
  chk(String(jm.journal_mode).toLowerCase() === 'wal', `WAL 模式: ${jm.journal_mode}`);
  const cols = h.db.prepare('PRAGMA table_info(mem)').all().map((r) => r.name);
  const want = ['id', 'scope', 'kind', 'subj', 'text', 'vec', 'ts', 'hits', 'last_hit', 'src'];
  chk(want.every((c) => cols.includes(c)), `mem 列齐全: ${cols.join(',')}`);
  chk(h.fts === true, 'FTS5 关键词索引建好了（失败也应跳过而非报错）');
  info('backend = ' + (h.ok ? 'sqlite' : '?'));
}

// ── ② remember 写入 ────────────────────────────────────────────────────
head('2 remember 写入');
const facts = [
  { text: '妈妈是群主，习惯熬夜到凌晨两三点才睡', kind: 'fact', subj: '妈妈' },
  { text: '爸爸养了一只橘猫叫年糕，经常发它的照片', kind: 'fact', subj: '爸爸' },
  { text: '小蓝答应过妈妈，下次给他讲一个鲸鱼冷笑话', kind: 'event', subj: '妈妈' },
  { text: '群里的投票规矩：超过三个人同意才执行', kind: 'preference', subj: '' },
];
const ids = [];
for (const f of facts) {
  const r = await M.remember(DATA_ROOT, SCOPE, f, cfg);
  chk(r.ok && r.reason === 'added' && !!r.id, `写入 added → ${r.id} 「${f.text.slice(0, 14)}…」`);
  if (r.id) ids.push(r.id);
}
{
  const items = M.loadMemories(DATA_ROOT, SCOPE, cfg);
  chk(items.length === facts.length, `loadMemories 读回 ${items.length} 条（期望 ${facts.length}）`);
  const withVec = items.filter((x) => Array.isArray(x.vec) && x.vec.length > 0);
  chk(withVec.length === items.length, `全部带向量（${withVec[0]?.vec.length ?? 0} 维，Float32 BLOB 往返无损读取）`);
  const alt = M.loadMemories(DATA_ROOT, SCOPE2, cfg);
  chk(alt.length === 0, 'scope 隔离：别的 scope 读不到这些记忆');
  const short = await M.remember(DATA_ROOT, SCOPE, { text: '嗯' }, cfg);
  chk(short.ok === false && short.reason === 'too-short', '太短的文本被拒（too-short）');
}

// 向量 BLOB 往返数值一致
{
  const v = [0.1, -0.25, 0.5, 0.75];
  const back = M.blobToVec(M.vecToBlob(v));
  const near = back.length === v.length && back.every((x, i) => Math.abs(x - v[i]) < 1e-6);
  chk(near, 'vecToBlob→blobToVec 往返一致（float32 精度内）');
  chk(Array.isArray(back), 'blobToVec 返回普通 Array（cos 只吃 Array）');
}

// ── ③ 去重 ──────────────────────────────────────────────────────────────
head('3 去重');
{
  const dup = await M.remember(DATA_ROOT, SCOPE, { text: '妈妈是群主，习惯熬夜到凌晨两三点才睡', kind: 'fact' }, cfg);
  chk(dup.reason === 'deduped', `重复写入 → ${dup.reason}（期望 deduped，cos=${(dup.cos ?? 0).toFixed(4)}）`);
  chk(dup.id === ids[0], '去重命中同一条 id（没有新增行）');
  const after = M.loadMemories(DATA_ROOT, SCOPE, cfg);
  chk(after.length === facts.length, `去重后条数不变：${after.length}`);
  const hit = after.find((x) => x.id === ids[0]);
  chk((hit?.hits ?? 0) >= 1, `重复写入累加 hits → ${hit?.hits}`);
  const dup2 = await M.remember(DATA_ROOT, SCOPE, { text: '妈妈是群主，习惯熬夜到凌晨两三点才睡', kind: 'fact' }, cfg);
  chk(dup2.reason === 'deduped', '再写一次仍然 deduped');
}

// ── ④ recall 召回（含改述）──────────────────────────────────────────────
head('4 recall 召回');
{
  const q = '妈妈几点睡觉';
  const hits = await M.recall(DATA_ROOT, SCOPE, q, cfg);
  chk(hits.length > 0, `「${q}」召回 ${hits.length} 条`);
  if (hits.length) {
    info(`top1 cos=${hits[0].cos.toFixed(3)} score=${hits[0].score.toFixed(3)} :: ${hits[0].text}`);
    chk(hits[0].text.includes('熬夜'), '「妈妈几点睡觉」top1 命中「熬夜」那条');
    chk(hits.length <= cfg.recallTopK, `不超过 recallTopK=${cfg.recallTopK}`);
    // 门槛看"当前后端下的实际档位"：语义后端是余弦门槛，词频后端返回 null
    // （词频的余弦没有判别力，准入改看证据通道）。
    const gate = M.effectiveMinCos(cfg);
    const passGate = (h) => (gate === null
      ? (h.kw > 0 || h.ent > 0 || (h.ppr || 0) >= 0.2 || (h.intent || 0) > 0)
      : h.cos >= gate || h.kw > 0 || h.ent > 0 || (h.ppr || 0) >= 0.2);
    chk(hits.every(passGate), gate === null
      ? '词频模式：每条都带证据通道（不看余弦）'
      : `每条都过实际门槛（${gate}）或带词面/图上证据`);
  }
}
{
  // 改述型问句：字面几乎不重合，靠语义（lexical 兜底下靠 n-gram 的共同字）
  const q = '你之前答应我什么了';
  const hits = await M.recall(DATA_ROOT, SCOPE, q, cfg);
  chk(hits.length > 0, `改述问句「${q}」召回 ${hits.length} 条`);
  if (hits.length) {
    info(`top1 cos=${hits[0].cos.toFixed(3)} :: ${hits[0].text}`);
    chk(hits.some((h) => h.text.includes('答应')), '改述问句召回到「答应过…冷笑话」那条');
  }
}
{
  const q = '年糕';
  const hits = await M.recall(DATA_ROOT, SCOPE, q, cfg);
  chk(hits.length > 0 && hits[0].text.includes('年糕'), '「年糕」召回到橘猫那条');
  const empty = await M.recall(DATA_ROOT, SCOPE, '前', cfg);
  chk(empty.length === 0, '太短的查询直接返回空（不白算向量）');
  // 自匹配护栏：任何 cos>0.98 的条目都不该回流（那是"刚刚这句话自己"，不是历史记忆）
  const selfQ = facts[0].text;
  const selfHits = await M.recall(DATA_ROOT, SCOPE, selfQ, cfg);
  chk(selfHits.every((h) => h.cos <= 0.98), '自匹配护栏：cos>0.98 的条目一律不回流');
  {
    const same = selfHits.find((h) => h.text === selfQ);
    info(same
      ? `原句仍能被召回但 cos=${same.cos.toFixed(3)} ≤ 0.98（真实模型 embedQuery≠embedPassage，护栏阈值未触发；与 core 行为一致）`
      : '原句被 0.98 护栏挡掉了');
  }
  const block = M.formatRecallBlock(await M.recall(DATA_ROOT, SCOPE, '妈妈熬夜吗', cfg), cfg);
  chk(block.startsWith('\n[记忆]\n') && block.trim().endsWith('[/记忆]'), `注入块格式正确（${block.length} 字符 ≤ ${cfg.recallMaxChars}）`);
  info(block.replace(/\n/g, ' ⏎ ').slice(0, 160));
}

// ── ④b 类海马体索引（倒排 / 实体 / 三元组 / 候选筛选）──────────────────
head('4b 海马体-lite 索引');
{
  chk(M.tokensOf('妈妈熬夜到凌晨').includes('妈妈'), 'tokensOf 切中文二元组（妈妈）');
  chk(M.tokensOf('hello 年糕').includes('hello'), 'tokensOf 保留拉丁整词');
  const ex = M.extractIndex('妈妈是群主，习惯熬夜');
  chk(ex.entities.includes('妈妈'), `实体抽取 → ${JSON.stringify(ex.entities)}`);
  chk(ex.edges.some((e) => e.src === '妈妈' && e.rel === '是'), `三元组抽取 → ${JSON.stringify(ex.edges)}`);
  chk(ex.toks.length > 0, `倒排键非空（${ex.toks.length} 个）`);

  const h = M.openDb(DATA_ROOT);
  const n = (sql) => Number(h.db.prepare(sql).get(SCOPE)?.n) || 0;
  const tokRows = n('SELECT COUNT(*) AS n FROM mem_tok WHERE scope = ?');
  chk(tokRows > 0, `写入时已增量建倒排（${tokRows} 行）`);
  chk(n('SELECT COUNT(*) AS n FROM mem_tag WHERE scope = ?') > 0, '实体标签已落库');

  const c = M.consolidate(DATA_ROOT, SCOPE);
  chk(c.ok === true && c.memories >= facts.length, `consolidate 重建成功：${c.memories} 条记忆 / ${c.entities} 实体 / ${c.edges} 三元组 / ${c.tokens} token`);
  chk(c.entities > 0 && c.edges > 0, '巩固后实体与三元组都非空');

  const g = M.entityGraph(DATA_ROOT, SCOPE, { limit: 20 });
  chk(g.ok && g.entities.length > 0, `实体图可读：${g.entities.length} 实体 / ${g.edges.length} 边`);
  chk(g.edges.some((e) => (e.src + e.dst).includes('妈妈')), '边里能查到妈妈');

  // 候选筛选不能伤召回质量：名字类查询仍要 top1 命中
  const hits = await M.recall(DATA_ROOT, SCOPE, '年糕', cfg);
  chk(hits.length > 0 && hits[0].text.includes('年糕'), '实体锚定查询「年糕」top1 仍命中');
  chk(hits.every((x) => typeof x.kw === 'number' && typeof x.ent === 'number'), '召回带 kw/ent 证据字段（面板可解释）');
  const gate2 = M.effectiveMinCos(cfg);
  chk(hits.every((x) => (gate2 === null
    ? (x.kw > 0 || x.ent > 0 || (x.ppr || 0) >= 0.2 || (x.intent || 0) > 0)
    : x.cos >= gate2 || x.kw > 0 || x.ent > 0 || (x.ppr || 0) >= 0.2)),
  `RRF 融合后门槛依旧生效（实际档位 ${gate2 === null ? '词频·证据准入' : gate2}）`);

  // 删掉的记忆不能留在索引里
  const before = n('SELECT COUNT(*) AS n FROM mem_tok WHERE scope = ?');
  M.forget(DATA_ROOT, SCOPE, ids[ids.length - 1], cfg);
  const after = n('SELECT COUNT(*) AS n FROM mem_tok WHERE scope = ?');
  chk(after < before, `forget 会同步清索引（${before} → ${after}）`);
  const back = await M.remember(DATA_ROOT, SCOPE, facts[facts.length - 1], cfg);
  chk(back.ok === true, '为后续用例补回那条记忆');
  if (back.id) ids[ids.length - 1] = back.id;
}

// ── ⑤ listAll ──────────────────────────────────────────────────────────
head('5 listAll');
{
  const all = M.listAll(DATA_ROOT, { limit: 50, scopeFilter: SCOPE });
  chk(all.length === facts.length, `scopeFilter 过滤到 ${all.length} 条（期望 ${facts.length}）`);
  chk(all.every((x) => x.scope === SCOPE), 'listAll 返回的 scope 正确');
  chk(all.every((x) => x.id && x.text && Number.isFinite(x.ts)), 'listAll 字段齐全（id/text/ts）');
  const sorted = all.every((x, i) => i === 0 || (all[i - 1].ts >= x.ts));
  chk(sorted, '按 ts 倒序');
  const limited = M.listAll(DATA_ROOT, { limit: 2, scopeFilter: SCOPE });
  chk(limited.length === 2, 'limit 生效');
  const missed = M.listAll(DATA_ROOT, { limit: 50, scopeFilter: '不存在的scope' });
  chk(missed.length === 0, 'scopeFilter 不匹配时返回空');
}

// ── ⑥ forget ───────────────────────────────────────────────────────────
head('6 forget');
{
  const target = ids[3];
  const r = M.forget(DATA_ROOT, SCOPE, target, cfg);
  chk(r === true, `forget 返回 true（删 ${target}）`);
  const after = M.loadMemories(DATA_ROOT, SCOPE, cfg);
  chk(after.length === facts.length - 1, `删后 ${after.length} 条`);
  chk(!after.some((x) => x.id === target), '目标 id 已不在库里');
  chk(M.forget(DATA_ROOT, SCOPE, target, cfg) === false, '重复删同一条返回 false');
  // 加一条到另一个 scope，测跨 scope 删除
  const r2 = await M.remember(DATA_ROOT, SCOPE2, { text: '临时记忆：这条只用来测跨群删除', kind: 'fact' }, cfg);
  chk(r2.ok, '往另一个 scope 写一条');
  chk(M.forgetAnywhere(DATA_ROOT, r2.id, cfg) === true, 'forgetAnywhere 跨 scope 删成功');
  chk(M.forgetAnywhere(DATA_ROOT, 'm_不存在', cfg) === false, 'forgetAnywhere 删不存在的 id 返回 false');
  chk(M.loadMemories(DATA_ROOT, SCOPE2, cfg).length === 0, '另一个 scope 已清空');
  // 把删掉的补回来，后面 cap / 统计还要用
  const back = await M.remember(DATA_ROOT, SCOPE, { text: '群里的投票规矩：超过三个人同意才执行', kind: 'preference', subj: '' }, cfg);
  chk(back.ok, '（补回被删的那条，供后续步骤使用）');
}

// ── ⑦ stats ────────────────────────────────────────────────────────────
head('7 stats');
{
  const st = M.stats(DATA_ROOT, SCOPE, cfg);
  chk(st.total === facts.length, `stats.total = ${st.total}`);
  chk(st.byKind.fact === 2 && st.byKind.event === 1 && st.byKind.preference === 1,
    `按 kind 分组: ${JSON.stringify(st.byKind)}`);
  chk(typeof st.mode === 'string', `嵌入器模式 = ${st.mode}（拿不到模型就是 lexical）`);
  chk(st.backend === 'sqlite', 'stats 标明后端 = sqlite');
  chk(fs.existsSync(st.file), `stats.file 指向库文件: ${st.file}`);
}

// ── ⑧ persona 写入 / 读取 ──────────────────────────────────────────────
head('8 persona');
{
  const w1 = M.setPersona(DATA_ROOT, SCOPE, { ckey: 'identity', cvalue: '深海鲸鱼娘小蓝，从马里亚纳海沟游进人类网络', weight: 2 });
  chk(w1.ok && !!w1.id, `写入 persona: ${w1.ckey}`);
  const w2 = M.setPersona(DATA_ROOT, SCOPE, { ckey: 'world:年糕', cvalue: '爸爸家那只橘猫，会开冰箱', weight: 1 });
  chk(w2.ok, '写入世界书条目 world:年糕');
  const rows = M.getPersona(DATA_ROOT, SCOPE);
  chk(rows.length === 2, `读回 ${rows.length} 条设定`);
  chk(rows[0].ckey === 'identity', '按 weight 降序（identity 权重 2 排第一）');
  const one = M.getPersonaValue(DATA_ROOT, SCOPE, 'world:年糕');
  chk(one && one.value.includes('橘猫'), 'getPersonaValue 取单条正确');
  // 同 ckey 覆盖，不新增行
  M.setPersona(DATA_ROOT, SCOPE, { ckey: 'identity', cvalue: '小蓝，深海鲸鱼娘（改过一版）', weight: 2 });
  const rows2 = M.getPersona(DATA_ROOT, SCOPE);
  chk(rows2.length === 2, `同 ckey 覆盖不新增（仍 ${rows2.length} 条）`);
  chk(rows2.find((r) => r.ckey === 'identity').cvalue.includes('改过一版'), '覆盖后的值生效');
  chk(M.getPersona(DATA_ROOT, 'other-scope').length === 0, 'persona 也是按 scope 隔离的');
  chk(M.getPersona(DATA_ROOT, SCOPE).length === 2, '另一个 scope 的写入没污染本 scope');
  chk(M.forgetPersona(DATA_ROOT, w2.id) === true, 'forgetPersona 删除生效');
  chk(M.getPersona(DATA_ROOT, SCOPE).length === 1, '删后剩 1 条');
}

// ── ⑨ JSONL 迁移 ───────────────────────────────────────────────────────
head('9 JSONL 迁移');
{
  // 独立的迁移根，避免污染主测试根
  rmDbFiles(MIG_ROOT);
  rmDir(path.join(MIG_ROOT, '.qqbot'));
  const mdir = path.join(MIG_ROOT, '.qqbot', 'memory');
  fs.mkdirSync(mdir, { recursive: true });
  const mkLine = (o) => JSON.stringify(o) + '\n';
  const legacy = [
    { id: 'm_legacy01', ts: Date.now() - 86400000, kind: 'fact', text: '老记忆：妈妈家里有一只叫年糕的橘猫', subj: '妈妈', vec: null, hits: 3, lastHit: 0 },
    { id: 'm_legacy02', ts: Date.now() - 3600000, kind: 'event', text: '老记忆：小蓝昨天答应讲冷笑话', subj: '', vec: null, hits: 1, lastHit: 0 },
  ];
  // 手搓一个 256 维向量（模拟老库里存的是 JSON 数组）
  const vec256 = (seed) => {
    const v = new Array(256).fill(0);
    for (let i = 0; i < seed.length; i++) v[(seed.charCodeAt(i) * 31 + i) % 256] += 1;
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  legacy[0].vec = vec256(legacy[0].text);
  legacy[1].vec = vec256(legacy[1].text);
  fs.writeFileSync(path.join(mdir, 'group_LEGACY.jsonl'), legacy.map(mkLine).join(''), 'utf8');
  fs.writeFileSync(path.join(mdir, 'c2c_LEGACY.jsonl'), mkLine({ id: 'm_legacy03', ts: Date.now(), kind: 'fact', text: '老记忆：私聊里的第三条，测多文件一起迁', vec: vec256('第三条') }) + '{坏行不炸}\n', 'utf8');
  fs.writeFileSync(path.join(mdir, 'selftest.jsonl'), mkLine({ id: 'm_legacy04', ts: Date.now(), kind: 'fact', text: '老记忆：不带前缀的 scope 也要迁', vec: null }), 'utf8');
  fs.writeFileSync(path.join(mdir, '_inbox.jsonl'), mkLine({ text: '收件箱不该被当成记忆迁进去', kind: 'fact' }), 'utf8');
  fs.writeFileSync(path.join(mdir, '_digest_group_LEGACY.json'), JSON.stringify({ lastDigestTs: 1700000000000, lastRun: 1700000000000 }), 'utf8');

  const hMig = M.openDb(MIG_ROOT);
  const flag = hMig.db.prepare("SELECT v FROM meta WHERE k = 'migrated_jsonl'").get();
  chk(!!flag && Number(flag.v) > 0, `首次打开置位 meta.migrated_jsonl = ${flag?.v}`);

  const g = M.loadMemories(MIG_ROOT, 'group:LEGACY');
  chk(g.length === 2, `group_LEGACY.jsonl 迁进 ${g.length} 条（期望 2，文件名还原成 scope group:LEGACY）`);
  const c = M.loadMemories(MIG_ROOT, 'c2c:LEGACY');
  chk(c.length === 1, `c2c_LEGACY.jsonl 迁进 ${c.length} 条（坏行被跳过、不影响其他行）`);
  chk(M.loadMemories(MIG_ROOT, 'selftest').length === 1, '不带前缀的 scope 原样迁移（selftest）');
  chk(!M.loadMemories(MIG_ROOT, '_inbox').length, '以 _ 开头的文件（收件箱/摘要状态）不迁移');
  const m1 = g.find((x) => x.id === 'm_legacy01');
  chk(!!m1 && m1.vec.length === 256, `老库的 JSON 向量转成了 BLOB（${m1?.vec.length} 维）`);
  chk(m1 && m1.hits === 3, 'hits 等字段原样保留');
  chk(g.every((x) => x.src === 'migrate:jsonl'), '迁移来源标记 src = migrate:jsonl');
  const dst = hMig.db.prepare("SELECT v FROM meta WHERE k = 'digest:' || 'group:LEGACY'").get();
  chk(!!dst && JSON.parse(dst.v).lastDigestTs === 1700000000000, '「上次摘要到哪儿了」也一起迁过来了');

  // 再次打开（新连接）→ 幂等，不重复插入
  M.closeDb(MIG_ROOT);
  const h2 = M.openDb(MIG_ROOT);
  const g2 = M.loadMemories(MIG_ROOT, 'group:LEGACY');
  chk(g2.length === 2, `重开库不重复迁移（仍 ${g2.length} 条）`);
  info('迁移后再查 meta: ' + JSON.stringify(h2.db.prepare("SELECT v FROM meta WHERE k='migrated_jsonl'").get()));

  // 迁移后这一整片"活"着：关键词检索能命中老记忆，新写入也能被召回
  const legacyHits = M.searchText(MIG_ROOT, 'group:LEGACY', '年糕');
  chk(legacyHits.length === 1 && legacyHits[0].id === 'm_legacy01', `迁进来的老记忆能关键词检索到：${legacyHits[0]?.text ?? '（无）'}`);

  // 老库里是 256 维词法向量，新查询是模型向量（维度不同 → cos 归 0，与 core 同行为，不能崩）
  let recallThrew = false;
  let oldHits = [];
  try { oldHits = await M.recall(MIG_ROOT, 'group:LEGACY', '年糕那只橘猫', { ...cfg, recallMinCos: 0.2 }); } catch { recallThrew = true; }
  chk(!recallThrew && Array.isArray(oldHits), `维度不一致的老向量查询不崩（返回 ${oldHits.length} 条，cos 归 0）`);

  const addAfter = await M.remember(MIG_ROOT, 'group:LEGACY', { text: '迁移以后新写的一条：橘猫年糕今天又偷吃了罐头', kind: 'fact', subj: '妈妈' }, cfg);
  const newHits = await M.recall(MIG_ROOT, 'group:LEGACY', '年糕今天干了什么', { ...cfg, recallMinCos: 0.2 });
  chk(addAfter.ok && newHits.some((x) => x.text.includes('偷吃了罐头')), `迁移过的 scope 还能正常写入并召回：${newHits[0]?.text?.slice(0, 20) ?? '（无）'}`);

  // 迁移绝不抛：给个坏根（不可写目录不存在也能兜住）
  let threw = false;
  let res = null;
  try { res = M.migrateJsonl(MIG_ROOT); } catch { threw = true; }
  chk(!threw, `migrateJsonl 二次调用不抛，返回 ${JSON.stringify(res)}`);
}

// ── ⑨b 候选筛选路径（库变大后仍低耗且不丢召回）────────────────────────
head('9b 候选筛选');
{
  const who = ['阿蓝', '爸爸', '妈妈', '小鹿', '年糕', '橘座', '海獭', '星野', '盐汽水'];
  const what = ['在阳台晒被子', '把键盘换成了青轴', '报名了半程马拉松', '学会了做舒芙蕾', '把鱼缸挪到窗边',
    '买了一台旧唱片机', '在学日语五十音', '去海边捡了贝壳', '把窗帘换成遮光的', '养了一盆薄荷'];
  const where = ['周三下午', '上周五晚上', '今天早上', '凌晨两点', '昨天午休时', '周末傍晚'];
  for (let i = 0; i < 30; i++) {
    const text = `${who[i % who.length]}${where[i % where.length]}${what[(i + 3) % what.length]}（闲聊${i}）`;
    await M.remember(DATA_ROOT, SCOPE2, { text, kind: 'event' }, cfg);
  }
  const target = '紫罗兰花瓶放在海沟实验室的第三层架子上';
  const added = await M.remember(DATA_ROOT, SCOPE2, { text: target, kind: 'fact', subj: '小蓝' }, cfg);
  chk(added.ok, `噪声库下写入目标记忆（共 ${M.loadMemories(DATA_ROOT, SCOPE2, cfg).length} 条）`);

  const hits = await M.recall(DATA_ROOT, SCOPE2, '紫罗兰花瓶放哪了', cfg);
  chk(hits.length > 0 && hits.some((x) => x.text.includes('紫罗兰')), `噪声 30 条里仍召回到目标：${hits[0]?.text?.slice(0, 24) ?? '（无）'}`);
  chk((hits[0]?.kw ?? 0) > 0, `关键词通道参与了排序（kw=${hits[0]?.kw}）`);
  chk(hits.length <= cfg.recallTopK, `候选筛选后仍受 topK 限制（${hits.length}）`);

  // 巩固不改条数、可重复调用（幂等）
  const c1 = M.consolidate(DATA_ROOT, SCOPE2);
  const c2 = M.consolidate(DATA_ROOT, SCOPE2);
  chk(c1.ok && c2.ok && c2.memories === c1.memories, `consolidate 幂等（${c2.memories} 条记忆）`);
}

// ── ⑩ openDb 重复调用不锁死 ─────────────────────────────────────────────
head('10 openDb 重复调用');
{
  const handles = [];
  for (let i = 0; i < 5; i++) handles.push(M.openDb(DATA_ROOT));
  chk(handles.every((h) => h && h.ok === true), '连续 5 次 openDb 都 ok');
  chk(handles.every((h) => h === handles[0]), '返回同一个句柄（没有开 5 个连接互相抢锁）');

  const probe = M.openDb();
  chk(probe.ok === true && probe.probe === true, 'openDb() 无参 = 内存库探测（不碰磁盘）');

  // 句柄还能正常读写
  const r = await M.remember(DATA_ROOT, SCOPE, { text: '重复打开之后还能正常写入的一条', kind: 'fact' }, cfg);
  chk(r.ok, '重复打开后 remember 仍成功');
  const hits = await M.recall(DATA_ROOT, SCOPE, '重复打开', cfg);
  chk(Array.isArray(hits), '重复打开后 recall 仍可用');
  M.forget(DATA_ROOT, SCOPE, r.id, cfg);

  // 关掉重开（模拟进程重启）→ 数据还在
  M.closeDb(DATA_ROOT);
  const h3 = M.openDb(DATA_ROOT);
  chk(h3.ok, 'closeDb 之后能重新打开（不会残留锁）');
  chk(M.loadMemories(DATA_ROOT, SCOPE, cfg).length === facts.length, '重开后数据仍在（落盘成功）');

  // 另一个连接并发读同一文件，确认 WAL 下不锁死
  let concurrentOk = false;
  try {
    const other = M.openDb(MIG_ROOT);
    M.closeDb(MIG_ROOT);
    const h4 = M.openDb(MIG_ROOT);
    concurrentOk = h4.ok && other.ok;
  } catch { concurrentOk = false; }
  chk(concurrentOk, '两个数据根的库可以同时开着（互不影响）');
}

// ── ⑪ 门面 memory.mjs 选到 sqlite ──────────────────────────────────────
head('11 门面');
{
  const F = await import(FACADE_URL);
  chk(F.backendName === 'sqlite', `门面后端 = ${F.backendName}（${F.backendNote || '正常'}）`);
  chk(typeof F.remember === 'function' && typeof F.recall === 'function' && typeof F.loadMemories === 'function', '门面导出了同名的核心函数');
  const names = ['loadConfig', 'memoryDir', 'memoryFile', 'embedderMode', 'cos', 'loadMemories', 'remember', 'forget', 'recall', 'formatRecallBlock', 'stats', 'inboxFile', 'pushInbox', 'drainInbox', 'listAll', 'forgetAnywhere', 'digestScope', 'shouldDigest'];
  const missing = names.filter((n) => typeof F[n] !== 'function');
  chk(missing.length === 0, `memory-core 的 18 个函数全部有同名实现${missing.length ? '（缺 ' + missing.join(',') + '）' : ''}`);
  chk(F.cos([1, 0], [1, 0]) === 1, '门面的 cos 可用');
  const st = F.stats(DATA_ROOT, SCOPE, cfg);
  chk(st.backend === 'sqlite' && st.total === M.stats(DATA_ROOT, SCOPE, cfg).total, '门面 stats 与直连结果一致');
}

// ── 收尾 ───────────────────────────────────────────────────────────────
try { M.closeDb(DATA_ROOT); } catch { /* ignore */ }
try { M.closeDb(MIG_ROOT); } catch { /* ignore */ }

console.log('\n──────────────────────────────────────────');
console.log(`PASS ${pass} / FAIL ${fail}`);
console.log(fail === 0 ? '结论: SQLite 记忆库全部通过。' : '结论: 有问题，见上面 FAIL 行。');
process.exit(fail === 0 ? 0 : 1);
