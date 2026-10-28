#!/usr/bin/env node
/**
 * memory-hippo-test.mjs — 类海马体层端到端自检（真跑）
 *
 * 覆盖：回放巩固（聚类→gist→链接、二次回放不重复）→ 类海马体召回
 *       （时间邻近扩散 / gist 补全 / MMR 不重复）→ 人格信念漂移护栏
 *       （步长上限、负向要重复、锚点限幅）→ 面板统计。
 */
const DATA_ROOT = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'F:/qqbot/qqbot-mod/.devdata';
const SCOPE = 'hippotest';
const SCOPE2 = 'hippotest-trait';

const fs = await import('node:fs');
const path = await import('node:path');

const LIB = 'F:/qqbot/dshqqbot/.qqbot-extensions/lib/';
const M = await import(new URL('file:///' + (LIB + 'memory-db.mjs')).href);
const H = await import(new URL('file:///' + (LIB + 'memory-hippo.mjs')).href);

let pass = 0;
let fail = 0;
const ok = (s) => { pass += 1; console.log('  PASS  ' + s); };
const bad = (s) => { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; };
const chk = (c, s) => (c ? ok(s) : bad(s));
const info = (s) => console.log('        ' + s);
const head = (s) => console.log('\n[' + s + ']');

fs.mkdirSync(path.join(DATA_ROOT, '.qqbot'), { recursive: true });
const h0 = M.openDb(DATA_ROOT);
for (const sc of [SCOPE, SCOPE2]) {
  for (const t of ['mem', 'mem_tok', 'mem_tag', 'mem_edge', 'mem_entity', 'mem_gist', 'mem_link', 'belief', 'hippo_log']) {
    try { h0.db.prepare(`DELETE FROM ${t} WHERE scope = ?`).run(sc); } catch { /* 表可能还没建 */ }
  }
}

head('写入情节');
const coffee = [
  '妈妈说他每天早上必须喝一杯手冲咖啡，不喝就脑子转不动',
  '妈妈早上手冲咖啡要磨豆子，水温九十二度，说这样才不酸',
  '他手冲咖啡的滤杯是 V60，豆子固定买浅烘的耶加雪菲',
  '加班到十一点，妈妈说今天第三杯手冲咖啡了，心跳有点快',
];
const cat = [
  '妈妈家里养了一只橘猫叫团团，特别能吃',
  '团团的猫砂盆放在阳台，妈妈每天早上铲一次',
  '妈妈说团团最近掉毛掉得厉害，沙发上全是橘色的毛',
];
for (const t of coffee) await M.remember(DATA_ROOT, SCOPE, { text: t, kind: 'event', subj: '妈妈' });
for (const t of cat) await M.remember(DATA_ROOT, SCOPE, { text: t, kind: 'event', subj: '妈妈' });
await M.remember(DATA_ROOT, SCOPE, { text: '主人说这周先把群公告改一改，别急着上新功能', kind: 'fact', subj: '主人' });
const total = M.loadMemories(DATA_ROOT, SCOPE).length;
info('库内条数：' + total);
chk(total >= 6, '情节写入成功（≥6 条）');

head('回放巩固');
const r1 = H.replay(DATA_ROOT, SCOPE, { minSize: 3, threshold: 0.08, windowDays: 60 });
info(JSON.stringify({ ok: r1.ok, pool: r1.pool, clusters: r1.clusters, gists: r1.gists, note: r1.note }));
chk(r1.ok === true, 'replay 返回 ok');
chk(r1.gists >= 1, '至少生成 1 条归纳（gist）');
if (r1.made && r1.made[0]) info('gist 示例：' + r1.made[0].text);

const r2 = H.replay(DATA_ROOT, SCOPE, { minSize: 3, threshold: 0.08, windowDays: 60 });
chk(r2.gists === 0, '二次回放不重复造 gist（已链接的情节不再参与）');

head('类海马体召回');
const cfgT = { ...M.loadConfig(DATA_ROOT), recallMinCos: 0.05 };
const hits = await H.hippoRecall(DATA_ROOT, SCOPE, '妈妈早上喝什么', cfgT, { topK: 4 });
info('召回 ' + hits.length + ' 条');
for (const h of hits) info(`  [${h.kind}] ${String(h.text).slice(0, 34)} … why=${h.why.join('+')} score=${h.score}`);
chk(hits.length >= 2, '召回有结果');
chk(new Set(hits.map((x) => x.id)).size === hits.length, '结果不重复');
chk(hits.some((x) => x.why.includes('temporal')), '时间邻近扩散生效（why 含 temporal）');
chk(hits.length <= 4, 'topK 名额被遵守');

// MMR：3 条几乎同义的咖啡记忆，不应全部占满
const coffeeHits = hits.filter((x) => /咖啡|磨豆|滤杯/.test(x.text));
chk(coffeeHits.length <= 3, '近义情节不会无限占名额');

head('人格信念漂移护栏');
let e1 = H.observeTrait(DATA_ROOT, SCOPE2, { key: 'warmth', delta: 0.9, weight: 1 });
info('第一次强正向：' + JSON.stringify(e1));
chk(e1.ok && Math.abs(e1.step) <= 0.12, '单次更新步长有上限（≤0.12）');
chk(e1.value <= 0.12, '单条证据推不动整体认知');
// 一次强负向：方向反转时要打折
const e2 = H.observeTrait(DATA_ROOT, SCOPE2, { key: 'warmth', delta: -1, weight: 1 });
info('一次强负向：' + JSON.stringify(e2));
chk(e2.value > e1.value - 0.12, '负向翻转被打折（不会一次翻盘）');
// 多次负向才真的下去
for (let i = 0; i < 8; i += 1) H.observeTrait(DATA_ROOT, SCOPE2, { key: 'warmth', delta: -0.8, weight: 1 });
const bs = H.beliefs(DATA_ROOT, SCOPE2);
const w = bs.find((b) => b.key === 'warmth');
info('累积后：' + JSON.stringify(w));
chk(w && w.n >= 10, '证据条数在累积');
chk(w && w.value > -1 && w.value < 0.2, '累积负向证据后仍受限幅约束');

const dr = H.driftReport(DATA_ROOT, SCOPE2);
info('稳定性：' + dr.stability + ' / 报警数：' + dr.alarm);
chk(dr.stability >= 0 && dr.stability <= 100, '稳定性指标在 0~100');
chk(['ok', 'watch', 'alarm'].includes(dr.rows[0]?.level), '漂移分级有值');

const anchor = H.anchorBeliefs(DATA_ROOT, SCOPE2);
chk(anchor.ok === true, '锚点写入成功');
const dr2 = H.driftReport(DATA_ROOT, SCOPE2);
chk(dr2.rows.every((r) => Math.abs(r.drift) < 1e-9), '锚定后漂移归零');

head('统计');
const st = H.hippoStats(DATA_ROOT, SCOPE);
info(JSON.stringify({ gists: st.gists, links: st.links, stability: st.stability, lastReplay: !!st.lastReplay }));
chk(st.ok === true && st.gists >= 1, 'hippoStats 能读到归纳条数');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
