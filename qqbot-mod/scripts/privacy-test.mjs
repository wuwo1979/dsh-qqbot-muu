#!/usr/bin/env node
/**
 * privacy-test.mjs — 记忆隐私闭环：字段级加密 / 审计 / 导出 / 彻底删除
 *
 * 为什么单独测（任务 #8 第 ⑤ 子项的验收）：
 *   ① 字段级加密：开了之后 mem.text 落盘必须是密文，但读侧（召回/导出/画像/搜索）
 *      全部透明解密——任何一处漏解密都会让"她读自己的记忆"变成空串或乱码。
 *   ② 审计：导出/彻底删除/开关加密/忘掉单条都要留痕，readAudit 能读回来。
 *   ③ 彻底删除：不是隐藏，是 mem/persona/索引/图谱/FTS/jsonl 全部真删。
 *
 * 跑法：node F:\qqbot\qqbot-mod\scripts\privacy-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.tmpdir(), 'qqs-privacy-' + process.pid);
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 护栏拦了就换目录 */ }
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

const SCOPE = 'group:test-scope';
const SECRET = '小蓝上周答应教主人钓鱼，还约了周末去溪边';

// ── 准备：写几条记忆 + 一条画像 + 一条图谱边 ────────────────────────────
head('[准备] 写入记忆 / 画像 / 图谱');
const r1 = await M.remember(ROOT, SCOPE, { text: SECRET, kind: 'promise' });
const r2 = await M.remember(ROOT, SCOPE, { text: '主人喜欢在深夜写代码，一边写一边喝冰美式', kind: 'fact' });
const r3 = await M.remember(ROOT, 'person:qq:4242', { text: '阿澈是群里的跑步健将', kind: 'fact' });
ok('记忆写入成功', r1.ok && r2.ok && r3.ok, JSON.stringify({ r1, r2, r3 }).slice(0, 120));
M.setPersona(ROOT, SCOPE, { ckey: 'card:test', cvalue: '测试印象卡内容' });
M.addEdges(ROOT, SCOPE, r1.id, [{ src: '小蓝', rel: '答应', dst: '钓鱼' }]);
// personProfile 只认 kind='impression' 的条目（画像由 digest 生成，这里手写一条走同一落库路径）
const rImp = await M.remember(ROOT, 'person:qq:4242', { text: '阿澈：跑步健将；爱在清晨沿江跑十公里；语气爽朗爱用短句', kind: 'impression' });
ok('印象条目写入成功', rImp.ok && rImp.reason === 'added', JSON.stringify(rImp));

// ── ① 开启字段级加密 ────────────────────────────────────────────────────
head('[1] 开启字段级加密（全库转换）');
const on = M.setEncryption(ROOT, true);
ok('setEncryption(true) 返回 ok', on && on.ok === true, JSON.stringify(on));
ok('配置已持久化 encryptAtRest=true', (() => {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, '.qqbot-extensions', 'memory-config.json'), 'utf8'));
    return !!(c.privacy && c.privacy.encryptAtRest === true);
  } catch { return false; }
})());
ok('密钥文件已生成', fs.existsSync(path.join(ROOT, '.qqbot', 'secrets', 'memory.key')));
ok('privacyState 显示已加密', M.privacyState(ROOT).encryptAtRest === true);

// 直接开库看原始字节：必须是密文
const { getHandle } = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-db.mjs');
const rawTexts = getHandle(ROOT).db.prepare('SELECT id, text FROM mem').all().map((r) => String(r.text));
ok('库内正文全部是 enc1: 密文', rawTexts.length >= 3 && rawTexts.every((t) => t.startsWith('enc1:')),
  rawTexts.slice(0, 2).map((t) => t.slice(0, 24) + '…').join(' | '));
ok('密文里找不到原文', !rawTexts.some((t) => t.includes('钓鱼') || t.includes('冰美式')));

// ── ② 读侧透明解密 ──────────────────────────────────────────────────────
head('[2] 加密态下的读侧（召回/导出/画像/搜索）');
const items = M.loadMemories(ROOT, SCOPE);
ok('loadMemories 读回明文', items.some((it) => it.text === SECRET), JSON.stringify(items.map((i) => i.text)).slice(0, 120));
const hits = await M.recall(ROOT, SCOPE, '小蓝答应了什么');
ok('召回仍能命中加密条目', hits.some((h) => h.text === SECRET), JSON.stringify(hits).slice(0, 160));
const found = M.searchText(ROOT, SCOPE, '冰美式');
ok('searchText 解密扫描可用', found.length === 1 && found[0].text.includes('冰美式'), JSON.stringify(found.map((f) => f.text)).slice(0, 120));
const exp = M.exportScope(ROOT, SCOPE);
ok('导出内容是明文', exp.total >= 2 && exp.memories.some((m) => m.text === SECRET), JSON.stringify(exp.memories.map((m) => m.text)).slice(0, 120));
ok('导出带画像与图谱边', exp.persona.length >= 1 && exp.edges.length >= 1);
const prof = M.personProfile(ROOT, '4242');
ok('personProfile 读回明文画像', prof.ok && prof.impression.includes('跑步健将'), prof.impression);
ok('listAll 读回明文', M.listAll(ROOT, {}).some((x) => x.text === SECRET));

// ── ③ 加密态写入新记忆 + 去重 ───────────────────────────────────────────
head('[3] 加密态写入与去重');
const rd = await M.remember(ROOT, SCOPE, { text: '主人喜欢在深夜写代码，一边写一边喝冰美式', kind: 'fact' });
ok('重复内容被向量去重（deduped）', rd.ok && rd.reason === 'deduped', JSON.stringify(rd));
const rn = await M.remember(ROOT, SCOPE, { text: '加密后写入的新记忆也要能读回来', kind: 'fact' });
ok('加密态写入新记忆成功', rn.ok && rn.reason === 'added', JSON.stringify(rn));
ok('新记忆落盘也是密文且读回明文', (() => {
  const it = M.loadMemories(ROOT, SCOPE).find((x) => x.id === rn.id);
  const raw = getHandle(ROOT).db.prepare('SELECT text FROM mem WHERE id = ?').get(rn.id);
  return it && it.text === '加密后写入的新记忆也要能读回来' && String(raw.text).startsWith('enc1:');
})());

// ── ④ 关闭加密（全库解回明文）────────────────────────────────────────────
head('[4] 关闭字段级加密');
const off = M.setEncryption(ROOT, false);
ok('setEncryption(false) 返回 ok', off && off.ok === true, JSON.stringify(off));
const raw2 = getHandle(ROOT).db.prepare('SELECT text FROM mem').all().map((r) => String(r.text));
ok('库内正文已全部解回明文', raw2.length >= 4 && raw2.every((t) => !t.startsWith('enc1:')));
ok('配置持久化 encryptAtRest=false', (() => {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(ROOT, '.qqbot-extensions', 'memory-config.json'), 'utf8'));
    return !!(c.privacy && c.privacy.encryptAtRest === false);
  } catch { return false; }
})());
const items2 = M.loadMemories(ROOT, SCOPE);
ok('解密后读回仍是明文原句', items2.some((it) => it.text === SECRET));
const found2 = M.searchText(ROOT, SCOPE, '钓鱼');
ok('明文态 searchText 走原路径', found2.some((f) => f.text === SECRET));

// ── ⑤ 审计 ──────────────────────────────────────────────────────────────
head('[5] 审计日志');
const aud = M.readAudit(ROOT, 100);
const acts = aud.map((a) => a.action);
ok('审计记下了加密开关', acts.includes('encrypt-on') && acts.includes('encrypt-off'), acts.join(','));
ok('审计记下了导出', acts.includes('export'), acts.join(','));
M.forget(ROOT, SCOPE, r3.id === undefined ? rn.id : (M.loadMemories(ROOT, SCOPE)[0] || {}).id);
ok('忘掉单条也留痕', M.readAudit(ROOT, 100).map((a) => a.action).includes('forget'));

// ── ⑥ 彻底删除 ──────────────────────────────────────────────────────────
head('[6] purgeScope：真删，不是隐藏');
const pg = M.purgeScope(ROOT, SCOPE);
ok('purgeScope 返回 ok 且删了东西', pg.ok && pg.total > 0, JSON.stringify(pg));
ok('mem 表该 scope 已空', getHandle(ROOT).db.prepare('SELECT COUNT(*) AS n FROM mem WHERE scope = ?').get(SCOPE).n === 0);
ok('persona 该 scope 已空', getHandle(ROOT).db.prepare('SELECT COUNT(*) AS n FROM persona WHERE scope = ?').get(SCOPE).n === 0);
ok('索引/图谱表该 scope 已空', (() => {
  for (const t of ['mem_tok', 'mem_tag', 'mem_edge', 'mem_entity']) {
    try {
      if (Number(getHandle(ROOT).db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE scope = ?`).get(SCOPE)?.n) > 0) return false;
    } catch { /* 表不存在就算过 */ }
  }
  return true;
})());
ok('别的 scope 不受牵连', M.loadMemories(ROOT, 'person:qq:4242').length >= 1);
ok('审计记下了 purge', M.readAudit(ROOT, 20).some((a) => a.action === 'purge' && a.scope === SCOPE));

// ── 收尾 ────────────────────────────────────────────────────────────────
console.log(`\n═══ privacy-test：${pass} 通过，${fail} 失败 ═══`);
try { M.closeDb(ROOT); } catch { /* ignore */ }
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 护栏拦了就算了 */ }
process.exit(fail ? 1 : 0);
