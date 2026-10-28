﻿/**
 * memory-panel-test.mjs — 浮窗「记忆」页数据源自检（不需要宿主、不需要模型）
 */
import { mkdirSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-mempanel';
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
  const { openDb } = await import(LIB + 'memory-db.mjs');
  const { collectMemoryPanel } = await import(LIB + 'memory-panel-core.mjs');
  const { trace } = await import(LIB + 'memory-trace.mjs');
  const { appendChat } = await import(LIB + 'chatlog-db.mjs');

  const h = openDb(ROOT);
  const db = h.db;
  const now = Date.now();

  appendChat(ROOT, { scope: 'group:g1', ts: now - 5000, dir: 'in', senderId: 'TEST_OWNER_0001ABCDEF', sender: '爸爸', kind: 'text', text: '今晚继续写代码', msgId: 'm1', src: 'test' });
  appendChat(ROOT, { scope: 'group:g1', ts: now - 4000, dir: 'out', senderId: '', sender: '小蓝', kind: 'text', text: '好呀，别熬太晚', msgId: 'm2', src: 'test' });
  appendChat(ROOT, { scope: 'c2c:u1', ts: now - 3000, dir: 'in', senderId: 'u1', sender: '对方', kind: 'text', text: '在吗', msgId: 'm3', src: 'test' });

  db.prepare('INSERT INTO mem(id, scope, kind, subj, text, vec, ts, hits, src) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('m1', 'group:g1', 'preference', '爸爸', '爸爸习惯熬夜写代码', null, now - 2000, 3, 'test');
  db.prepare('INSERT INTO mem(id, scope, kind, subj, text, vec, ts, hits, src) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('m2', 'c2c:u1', 'fact', '对方', '对方名叫妈妈', null, now - 1000, 0, 'test');

  const persona = db.prepare('INSERT INTO persona(id, scope, ckey, cvalue, weight, ts) VALUES (?,?,?,?,?,?)');
  persona.run('p1', 'group:g1', 'card:TEST_OWNER_0001ABCDEF', '爸爸：研究生，常熬夜，养猫叫年糕', 2, now - 1500);
  persona.run('p2', 'group:g1', 'bond:TEST_OWNER_0001ABCDEF', JSON.stringify({ a: 42, t: 35, note: '一起熬夜写代码', ts: now - 1200 }), 2, now - 1200);
  persona.run('p3', 'group:g1', '__mood', '有点困但还想聊', 1, now - 800);

  db.prepare('INSERT INTO chat_meta(k, v) VALUES (?, ?)').run('memory-agent:group:g1', JSON.stringify({ lastAttempt: now - 1000, lastRun: now - 900, lastTs: now - 2000 }));

  appendFileSync(join(ROOT, '.qqbot', 'memory-agent-log.jsonl'), JSON.stringify({
    ts: now - 900, scope: 'group:g1', ok: true, ms: 820, newMessages: 4,
    facts: ['preference:爸爸习惯熬夜写代码'], cards: ['爸爸：研究生'], mood: '有点困',
    relation: { name: '爸爸', delta: 2, note: '一起熬夜写代码', a: 42, t: 35 },
  }) + '\n', 'utf8');

  trace(ROOT, { kind: 'recall', scope: 'group:g1', query: '今晚写代码吗', raw: 3, hits: 1, rewritten: false, ok: true, ms: 12 });

  const d = collectMemoryPanel(ROOT, { limit: 10 });
  ok('返回 ok', d.ok === true);
  ok('台账总数 3', d.stats.chatTotal === 3, d.stats.chatTotal);
  ok('记忆总数 2', d.stats.memTotal === 2, d.stats.memTotal);
  ok('两个会话', d.stats.scopes.length === 2, d.stats.scopes);
  ok('最近消息按时间倒序', d.chat[0] && d.chat[0].text === '在吗', d.chat[0]);
  ok('私聊/群聊标记', d.chat.some((x) => x.kind === '私聊') && d.chat.some((x) => x.kind === '群聊'));
  ok('记忆带 kind/subj', d.memories[0] && d.memories[0].kind === 'fact' && d.memories[0].subj === '对方', d.memories[0]);
  ok('印象卡拆出名字', d.cards[0] && d.cards[0].name === '爸爸' && d.cards[0].text.includes('研究生'), d.cards[0]);
  ok('关系温度解析', d.bonds[0] && d.bonds[0].a === 42 && d.bonds[0].t === 35, d.bonds[0]);
  ok('关系名字回填（openid→爸爸）', d.bonds[0] && d.bonds[0].name === '爸爸', d.bonds[0]);
  ok('心情解析', d.moods[0] && d.moods[0].text.includes('困'), d.moods[0]);
  ok('分身状态 lastRun', d.agent.states[0] && d.agent.states[0].lastRun > 0, d.agent.states[0]);
  ok('分身日志 relation', d.agent.log[0] && d.agent.log[0].relation && d.agent.log[0].relation.delta === 2, d.agent.log[0]);
  ok('召回轨迹', d.recall[0] && d.recall[0].hits === 1 && d.recall[0].raw === 3, d.recall[0]);

  const g = collectMemoryPanel(ROOT, { scope: 'c2c:u1', limit: 10 });
  ok('按 scope 过滤', g.stats.chatTotal === 1 && g.chat.length === 1 && g.chat[0].text === '在吗', g.chat);

  const b = collectMemoryPanel('', { limit: 5 });
  ok('空 dataRoot 明确失败', b.ok === false && b.errors.length > 0, b.errors);

  try { db.close(); } catch { /* ignore */ }
  clean();
  console.log('\nPASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

try { await main(); } catch (e) {
  if (e && typeof e === 'object' && '__verifyExit' in e) throw e;
  console.error(e);
  console.log('\nPASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
}
