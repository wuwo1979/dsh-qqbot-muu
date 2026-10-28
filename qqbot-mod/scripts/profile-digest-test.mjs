/**
 * profile-digest-test.mjs — 历史消息 → 切片 → 高维印象卡（全库、本地模型汇总）
 *
 * 用户口径：历史消息本身就是对一个人的印象；印象卡是数据库全体数据的高维抽象，
 * 由本地模型汇总（可切片保存）。这里用假模型验证：切片、汇总、增量、节流、
 * relation 只写备注不改分数。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-digest';
const OWNER = 'OWNERID_0123456789ABCDEF';
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

function seedChat(appendChat, now) {
  const base = now - 40 * 86400000;
  for (let i = 0; i < 40; i += 1) {
    appendChat(ROOT, {
      scope: 'c2c:' + OWNER, ts: base + i * 3600000, dir: 'in', senderId: OWNER, sender: '爸爸',
      kind: 'text', text: i === 7 ? '[记忆]注入块[/记忆]今天在写毕业设计，猫叫年糕' : `第 ${i} 句：在写代码，年糕又在键盘上睡觉`,
      msgId: 'in' + i, src: 'test',
    });
    appendChat(ROOT, {
      scope: 'c2c:' + OWNER, ts: base + i * 3600000 + 1000, dir: 'out', senderId: '', sender: '小蓝',
      kind: 'text', text: `第 ${i} 句回应：那就先写到这，摸摸年糕`, msgId: 'out' + i, src: 'test',
    });
  }
  // 另一个私聊（消息更少）和一个群友
  for (let i = 0; i < 10; i += 1) {
    appendChat(ROOT, {
      scope: 'c2c:OTHER_0123456789ABCDEF', ts: base + i * 7200000, dir: 'in',
      senderId: 'OTHER_0123456789ABCDEF', sender: '妈妈', kind: 'text', text: `你好 ${i}`, msgId: 'o' + i, src: 'test',
    });
  }
  appendChat(ROOT, {
    scope: 'group:G1', ts: base, dir: 'in', senderId: 'GROUPER_0123456789ABCD', sender: '群友',
    kind: 'text', text: '群里路过一句', msgId: 'g1', src: 'test',
  });
  // 主人在群里也说过话（普通群不应因此拿到私聊卡）
  appendChat(ROOT, {
    scope: 'group:G1', ts: base + 5000, dir: 'in', senderId: OWNER, sender: '爸爸',
    kind: 'text', text: '群里也说一句：今晚继续写毕业设计', msgId: 'g2', src: 'test',
  });
  // A 群里对某人的负面话术：绝不能带到 B 群
  for (let i = 0; i < 8; i += 1) {
    appendChat(ROOT, {
      scope: 'group:G2', ts: base + 6000 + i * 60000, dir: 'in', senderId: 'ANGRY_0123456789ABCDEF', sender: '阿怒',
      kind: 'text', text: `第 ${i} 句：这破群天天吵架，谁都想骂两句，烦死了`, msgId: 'n' + i, src: 'test',
    });
  }
  for (let i = 0; i < 8; i += 1) {
    appendChat(ROOT, {
      scope: 'group:G3', ts: base + 6000 + i * 60000, dir: 'in', senderId: 'ANGRY_0123456789ABCDEF', sender: '阿怒',
      kind: 'text', text: `第 ${i} 句：今天在 B 群聊摄影，讨论光圈和构图`, msgId: 'b' + i, src: 'test',
    });
  }
}

function fakeChat(cardText) {
  return async ({ messages }) => {
    const sys = String((messages && messages[0] && messages[0].content) || '');
    if (sys.includes('印象官')) {
      return { ok: true, text: JSON.stringify({ card: cardText, traits: ['熬夜', '养猫', '写代码'], relation: { note: '比之前更熟了' } }) };
    }
    return {
      ok: true,
      text: JSON.stringify({ summary: '这段时间在写毕业设计，常熬夜，猫叫年糕，会互相道晚安。', traits: ['熬夜', '养猫'], relation: { note: '日常陪伴' } }),
    };
  };
}

// 按输入内容给卡：用来验证「A 群的负面印象不会污染 B 群」
function fakeChatFromInput() {
  return async ({ messages }) => {
    const sys = String((messages && messages[0] && messages[0].content) || '');
    const user = String((messages && messages[1] && messages[1].content) || '');
    const neg = user.includes('吵架');
    const photo = user.includes('摄影');
    if (sys.includes('印象官')) {
      const card = neg ? '阿怒：爱吵架、脾气暴躁，天天骂人' : (photo ? '阿怒：爱摄影，常聊光圈和构图' : '阿怒：普通群友');
      return { ok: true, text: JSON.stringify({ card, traits: [neg ? '暴躁' : '摄影'], relation: { note: '测试' } }) };
    }
    const summary = neg ? '这段时间天天在群里吵架骂人' : (photo ? '这段时间在群里聊摄影和构图' : '普通聊天');
    return { ok: true, text: JSON.stringify({ summary, traits: [neg ? '暴躁' : '摄影'], relation: { note: '测试' } }) };
  };
}

async function main() {
  clean();
  const now = Date.now();
  const { appendChat } = await import(LIB + 'chatlog-db.mjs');
  const { openDb } = await import(LIB + 'memory-db.mjs');
  const digest = await import(LIB + 'profile-digest.mjs');
  const { setPersona, getPersonaValue } = await import(LIB + 'memory.mjs');
  const { setFamiliarity, getFamiliarity } = await import(LIB + 'profile-core.mjs');

  seedChat(appendChat, now);
  openDb(ROOT);

  const targets = digest.listTargets(ROOT, { limit: 10 });
  ok('可整理对象列出', targets.length >= 3, targets.map((t) => t.name));
  ok('主人（最活跃私聊）排第一', targets[0].senderId === OWNER && targets[0].isOwner === true, targets[0]);
  ok('私聊排在群友前', targets.findIndex((t) => t.kind === 'c2c') < targets.findIndex((t) => t.kind === 'group'));

  const conv = digest.conversationOf(ROOT, OWNER);
  ok('对话取到该人 + 她的回应', conv.length >= 60, conv.length);
  ok('对话里没有注入块', !conv.some((m) => m.text.includes('[记忆]')), conv.find((m) => m.text.includes('[记忆]')));
  ok('对话里保留了正文', conv.some((m) => m.text.includes('年糕')), conv[0]);

  const slices = digest.makeSlices(conv, { sliceSize: 60, overlap: 8 });
  ok('切片数 ≥2', slices.length >= 2, slices.length);
  ok('首片 60 条', slices[0].rows.length === 60, slices[0].rows.length);
  ok('切片有重叠', slices.length > 1 && slices[1].start === 52, slices.length > 1 && slices[1].start);

  // relation 不能改分数：先固定 50/50
  setFamiliarity(ROOT, 'c2c:' + OWNER, { senderId: OWNER, senderName: '爸爸' }, { a: 50, t: 50, note: '旧备注' });
  const before = getFamiliarity(ROOT, 'c2c:' + OWNER, { senderId: OWNER, senderName: '爸爸' });
  ok('初始熟识度 50/50', before.a === 50 && before.t === 50, before);

  const r1 = await digest.digestPerson({
    dataRoot: ROOT, senderId: OWNER, scope: 'c2c:' + OWNER, chatImpl: fakeChat('爸爸：研究生，长期熬夜写毕业设计，养猫年糕，和小蓝是每天互相道晚安的伴。'),
  });
  ok('整理成功', r1.ok === true, r1);
  ok('写了切片', r1.slices >= 2 && r1.slicesAdded >= 2, { slices: r1.slices, added: r1.slicesAdded });
  ok('写出高维卡', /年糕/.test(r1.card || ''), r1.card);
  const { GLOBAL_SCOPE, getProfileCard, compactBlockFor } = await import(LIB + 'profile-core.mjs');
  const cardGlobal = getPersonaValue(ROOT, GLOBAL_SCOPE, 'card:' + OWNER);
  ok('卡片落个人层（跨群统一）', !!cardGlobal && /年糕/.test(cardGlobal.value), cardGlobal && cardGlobal.value);
  ok('卡片不再按会话复制', !getPersonaValue(ROOT, 'c2c:' + OWNER, 'card:' + OWNER));
  const sliceRow = getPersonaValue(ROOT, GLOBAL_SCOPE, 'slice:' + OWNER + ':000');
  ok('切片落个人层', !!sliceRow && /毕业设计/.test(sliceRow.value), sliceRow && sliceRow.value);
  ok('同一个群聊也能读到这张统一卡（认人）',
    !!getProfileCard(ROOT, 'group:G1', { senderId: OWNER, senderName: '爸爸' }));
  ok('群里的聊天台账仍只取本群',
    digest.conversationOf(ROOT, OWNER, 'group:G1').every((m) => m.scope === 'group:G1'));

  // ── 群等级：普通群不参与个人卡（只认人、不画像） ──
  const tiers = await import(LIB + 'group-tiers.mjs');
  ok('未列出的群默认普通群', tiers.tierOf(ROOT, 'group:G3') === 'normal');
  const rn = await digest.digestPerson({ dataRoot: ROOT, senderId: 'GROUPER_0123456789ABCD', scope: 'group:G1', chatImpl: fakeChatFromInput(), force: true });
  ok('普通群整理被等级跳过', rn.ok === false && rn.reason === 'tier-skip', rn);
  ok('普通群没有个人卡（个人层也没有）', !getPersonaValue(ROOT, GLOBAL_SCOPE, 'card:GROUPER_0123456789ABCD'));

  // ── 特别关心群：A 群负面只进个人层卡，不得进 B 群聊天记忆 ──
  const saved = tiers.setGroupTier(ROOT, ['G2'], 'priority');
  ok('设置特别关心群', saved.ok === true && tiers.tierOf(ROOT, 'group:G2') === 'priority', saved.tiers);
  const ra = await digest.digestPerson({ dataRoot: ROOT, senderId: 'ANGRY_0123456789ABCDEF', scope: 'group:G2', chatImpl: fakeChatFromInput(), force: true });
  ok('特别关心群整理成功', ra.ok === true, ra);
  const cardUnified = getPersonaValue(ROOT, GLOBAL_SCOPE, 'card:ANGRY_0123456789ABCDEF');
  ok('A 群的卡写入个人层（跨群统一）', !!cardUnified && /吵架/.test(cardUnified.value), cardUnified && cardUnified.value);
  const compactB = compactBlockFor(ROOT, 'group:G3', { senderId: 'ANGRY_0123456789ABCDEF', senderName: '阿怒' }, {});
  ok('普通群只给精简认人块（不带 A 群负面正文）',
    compactB.startsWith('\n[印象]') && compactB.includes('阿怒') && !compactB.includes('吵架'), compactB);
  ok('B 群聊天记忆不含 A 群内容',
    digest.conversationOf(ROOT, 'ANGRY_0123456789ABCDEF', 'group:G3').every((m) => !m.text.includes('吵架')));
  ok('私聊聊天记忆不含群内容',
    digest.conversationOf(ROOT, 'ANGRY_0123456789ABCDEF', 'c2c:ANGRY_0123456789ABCDEF').length === 0);
  const scopes = digest.listDigestScopes(ROOT, {}).map((s) => s.scope);
  ok('批量只覆盖私聊 + 特别关心群', scopes.includes('c2c:' + OWNER) && scopes.includes('group:G2') && !scopes.includes('group:G3'), scopes);

  const after = getFamiliarity(ROOT, 'c2c:' + OWNER, { senderId: OWNER, senderName: '爸爸' });
  ok('relation 只写备注', after.note === '比之前更熟了', after.note);
  ok('relation 不改分数', after.a === 50 && after.t === 50, { a: after.a, t: after.t });

  const r2 = await digest.digestPerson({ dataRoot: ROOT, senderId: OWNER, scope: 'c2c:' + OWNER, chatImpl: fakeChat('x') });
  ok('同一天重复整理被节流', r2.ok === false && r2.reason === 'throttled', r2);

  const r3 = await digest.digestPerson({ dataRoot: ROOT, senderId: OWNER, scope: 'c2c:' + OWNER, chatImpl: fakeChat('爸爸：更新后的卡'), force: true });
  ok('force 可绕过节流', r3.ok === true && /更新后的卡/.test(r3.card), r3);

  const r4 = await digest.digestPerson({ dataRoot: ROOT, senderId: 'NOBODY', chatImpl: fakeChat('x') });
  ok('没历史的人明确跳过', r4.ok === false && (r4.reason === 'no-history' || r4.reason === 'no-scope' || r4.reason === 'too-few' || r4.reason === 'tier-skip'), r4);

  ok('切片键前缀正确', !!getPersonaValue(ROOT, GLOBAL_SCOPE, 'slice:' + OWNER + ':001'));
  setPersona(ROOT, 'c2c:' + OWNER, { ckey: 'sanity', cvalue: 'ok', weight: 1 });

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
