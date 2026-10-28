/**
 * familiarity-test.mjs — 熟识度统一底层（persona.fam 唯一事实源）
 *
 * 用户口径：浮窗里的印象卡和单会话的熟识度要统一，改底层而不是只并 UI。
 * 契约：
 *   · fam:<senderId> 是唯一事实源；旧 bond: 自动迁移；
 *   · 插件原生 affinity/attitude 只做温和融合（0.7/0.3），不能一把冲掉真实互动；
 *   · 印象卡 + 熟识度合并成一个 [印象] 注入块。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-fam';
const ID = 'USER_0123456789ABCDEF';
const NAT = 'NATIVE_0123456789ABCDEF';
const SCOPE = 'c2c:' + ID;
const LIB = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

function clean() {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(join(ROOT, '.qqbot'), { recursive: true });
}

async function main() {
  clean();
  const pc = await import(LIB + 'profile-core.mjs');
  const { setPersona, getPersonaValue } = await import(LIB + 'memory.mjs');

  // ── 等级映射 ──
  ok('等级 0 陌生', pc.levelOf(0) === 0 && pc.levelLabel(0) === '陌生');
  ok('等级 1 眼熟', pc.levelOf(15) === 1 && pc.levelLabel(1) === '眼熟');
  ok('等级 2 认识', pc.levelOf(30) === 2);
  ok('等级 3 熟悉', pc.levelOf(45) === 3);
  ok('等级 4 亲近', pc.levelOf(60) === 4);
  ok('等级 5 很熟', pc.levelOf(75) === 5);
  ok('等级 6 羁绊', pc.levelOf(90) === 6 && pc.levelLabel(6) === '羁绊');

  // ── 旧 bond 迁移到 fam ──
  setPersona(ROOT, SCOPE, { ckey: 'bond:' + ID, cvalue: JSON.stringify({ a: 40, t: 30, note: '老备注', ts: 1 }), weight: 2 });
  const f1 = pc.getFamiliarity(ROOT, SCOPE, { senderId: ID, senderName: '爸爸' });
  ok('从旧 bond 读出数值', f1 && f1.a === 40 && f1.t === 30, f1);
  ok('熟识度综合分 0.6a+0.4t', f1.s === Math.round(40 * 0.6 + 30 * 0.4), f1.s);
  ok('迁移到 fam 键（个人层）', !!getPersonaValue(ROOT, pc.GLOBAL_SCOPE, 'fam:' + ID));
  ok('昵称也保留在记录里', f1.note === '老备注', f1.note);

  // ── 写入 / 微调 ──
  const w = pc.setFamiliarity(ROOT, SCOPE, { senderId: ID }, { a: 50, t: 60, note: '一起熬夜' });
  ok('写熟识度成功', w.ok === true, w);
  const f2 = pc.getFamiliarity(ROOT, SCOPE, { senderId: ID });
  ok('写入值生效', f2.a === 50 && f2.t === 60, f2);
  ok('写入带历史', f2.hist.length === 1, f2.hist);

  const b = pc.bumpFamiliarity(ROOT, SCOPE, { senderId: ID }, { delta: 3, note: '聊得开心' });
  ok('微调成功', b.ok === true, b);
  ok('微调亲近 +3 信任 +2', b.a === 53 && b.t === 62, b);
  const f3 = pc.getFamiliarity(ROOT, SCOPE, { senderId: ID });
  ok('微调后历史累积', f3.hist.length === 2, f3.hist);

  const c = pc.bumpFamiliarity(ROOT, SCOPE, { senderId: ID }, { delta: 999 });
  ok('单次变化被钳制 +5', c.a === 58, c.a);

  ok('旧接口 getBond 走 fam', pc.getBond(ROOT, SCOPE, { senderId: ID }).a === 58);
  ok('旧接口 bumpBond 走 fam', pc.bumpBond(ROOT, SCOPE, { senderId: ID }, { delta: 1 }).a === 59);

  // ── 印象 + 熟识度合并块（默认稳定模式：为云端 prompt 缓存服务）──
  setPersona(ROOT, SCOPE, { ckey: 'card:' + ID, cvalue: '爸爸：研究生，常熬夜，养猫叫年糕', weight: 2 });
  const block = pc.familiarityBlockFor(ROOT, SCOPE, { senderId: ID, senderName: '爸爸' });
  ok('合并块有 [印象] 标签', block.startsWith('\n[印象]') && block.endsWith('[/印象]'), block);
  ok('合并块含印象卡内容', block.includes('年糕'), block);
  ok('合并块含等级', block.includes('熟悉') || block.includes('亲近') || block.includes('很熟'), block);
  ok('稳定模式不带亲近/信任数值', !/亲近 \d+\/100/.test(block) && !/信任 \d+\/100/.test(block), block);
  ok('稳定模式不带「最近」备注', !block.includes('最近：'), block);
  const nameCount = (block.match(/爸爸/g) || []).length;
  ok('昵称不重复（卡片已有「爸爸：」前缀）', nameCount === 1, block);
  // 数值微调后块必须字符级不变（缓存命中的关键）
  pc.bumpFamiliarity(ROOT, SCOPE, { senderId: ID }, { delta: 2, note: '又聊了一句' });
  const block2 = pc.familiarityBlockFor(ROOT, SCOPE, { senderId: ID, senderName: '爸爸' });
  ok('微调数值后备注不变（字符级稳定）', block2 === block, { block, block2 });
  // 需要看数值时显式 stable:false
  const rich = pc.familiarityBlockFor(ROOT, SCOPE, { senderId: ID, senderName: '爸爸' }, { stable: false, showNumbers: true });
  ok('stable:false 才输出数值与最近备注', /亲近 \d+\/100/.test(rich) && /最近：/.test(rich), rich);
  ok('旧接口 bondBlockFor 仍可用', pc.bondBlockFor(ROOT, SCOPE, { senderId: ID }).includes('[关系]'));
  ok('禁用时输出空', pc.familiarityBlockFor(ROOT, SCOPE, { senderId: ID }, { enabled: false }) === '');

  // ── 原生数据温和融合 ──
  writeFileSync(join(ROOT, '.qqbot', 'affinity.json'), JSON.stringify({
    map: { ['person:' + NAT]: { msgs: 182, mentions: 3, replies: 2, strength: 0.8, name: '老朋友' } },
  }), 'utf8');
  writeFileSync(join(ROOT, '.qqbot', 'attitude.json'), JSON.stringify({
    map: { ['person:' + NAT]: { a: 0.8, events: 10, name: '老朋友', lastWhy: '常聊' } },
  }), 'utf8');
  const nat = pc.readNativeFamiliarity(ROOT, NAT);
  ok('读原生亲近/信任', nat && nat.a === 80 && nat.t > 40 && nat.name === '老朋友', nat);
  const fN = pc.getFamiliarity(ROOT, 'c2c:' + NAT, { senderId: NAT, senderName: '老朋友' });
  ok('原生融合是温和的（不是一把 80）', fN && fN.a > 25 && fN.a < 40, fN && fN.a);
  ok('原生融合写入备注', fN && /原生互动/.test(fN.note), fN && fN.note);
  ok('原生记录落 fam（个人层）', !!getPersonaValue(ROOT, pc.GLOBAL_SCOPE, 'fam:' + NAT));

  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\nPASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

try { await main(); } catch (e) {
  if (e && typeof e === 'object' && '__verifyExit' in e) throw e;
  console.error(e);
  console.log('\nPASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
}
