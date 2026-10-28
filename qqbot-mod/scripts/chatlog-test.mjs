#!/usr/bin/env node
/**
 * chatlog-test.mjs — 聊天原始台账（chat 表）端到端自检
 *
 * 覆盖：msg-history 增量导入 / 幂等重复导入 / 追加后再导入 / 注入块清洗 /
 *       图片占位不占行 / 实时 appendChat 去重 / 查询顺序 / 关键词检索 / stats / prune。
 *
 * 用假 msg-history 目录，不碰真实数据。沙箱禁写真实 .qqbot，这里写到 .devdata-chatlog。
 */

const DATA_ROOT = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'F:/qqbot/qqbot-mod/.devdata-chatlog';
const SCOPE_DIR = 'group_CHATTEST';
const SCOPE = 'group:CHATTEST';

const fs = await import('node:fs');
const path = await import('node:path');
const url = await import('node:url');

const FACADE_URL = url.pathToFileURL('F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory.mjs').href;

let pass = 0, fail = 0;
const ok = (s) => { pass += 1; console.log('  PASS  ' + s); };
const bad = (s) => { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; };
const chk = (cond, s) => (cond ? ok(s) : bad(s));
const head = (s) => console.log('\n[' + s + ']');

fs.rmSync(DATA_ROOT, { recursive: true, force: true });
const HIST = path.join(DATA_ROOT, '.qqbot', 'msg-history', SCOPE_DIR);
fs.mkdirSync(HIST, { recursive: true });

const now = Date.now();
const day = '2026-10-23';
const dayFile = path.join(HIST, day + '.jsonl');
const lines = [
  { id: 'm1', s: 'U1', n: '爸爸', t: now - 50000, k: 'text', x: '今天实验又跑崩了', me: false },
  { id: 'm2', s: 'self', n: '机器人', t: now - 49000, k: 'text', x: '啊这，又崩了？', me: true },
  {
    id: 'm3', s: 'U1', n: '爸爸', t: now - 40000, k: 'text',
    x: '嗯\n[记忆]上次也崩过，凌晨三点[/记忆]\n[别重复]刚说过：啊这', me: false,
  },
  { id: 'm4', s: 'U1', n: '爸爸', t: now - 30000, k: 'image', x: '[image]', me: false },
  { id: 'm5', s: 'U1', n: '爸爸', t: now - 20000, k: 'text', x: '   ', me: false },
  { id: 'm6', s: 'U2', n: '妈妈', t: now - 10000, k: 'text', x: '养猫叫年糕', me: false },
];
fs.writeFileSync(dayFile, lines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

const M = await import(FACADE_URL);
head('1 导入');
chk(M.backendName === 'sqlite', `后端是 sqlite（实际 ${M.backendName} / ${M.backendNote}）`);
{
  const r = M.ingestChatHistory(DATA_ROOT, { maxFilesPerRun: 8 });
  chk(r.ok === true, 'ingest ok');
  chk(r.imported === 5, `首次导入 5 条（空文本跳过；实际 ${r.imported}）`);
  const again = M.ingestChatHistory(DATA_ROOT, { maxFilesPerRun: 8 });
  chk(again.imported === 0, `重复导入 0 条（幂等；实际 ${again.imported}）`);
}

head('2 内容');
{
  const rows = M.queryChat(DATA_ROOT, SCOPE, { limit: 20 });
  chk(rows.length === 5, `查询 5 条（实际 ${rows.length}）`);
  chk(rows[0].ts <= rows[rows.length - 1].ts, '按时间正序返回');
  const injected = rows.find((r) => r.msgId === 'm3');
  chk(!!injected, 'm3 已入库');
  chk(injected && injected.text === '嗯', `注入块被清洗（实际「${injected && injected.text}」）`);
  chk(!rows.some((r) => /\[记忆\]|\[别重复\]/.test(r.text)), '库里没有注入块残留');
  const img = rows.find((r) => r.msgId === 'm4');
  chk(!!img && img.kind === 'image' && img.text === '', '纯图片行保留类型、正文为空');
  const out = rows.find((r) => r.msgId === 'm2');
  chk(!!out && out.dir === 'out' && out.senderId === 'self', '她自己的消息标记为 out');
}

head('3 追加');
{
  fs.appendFileSync(dayFile, JSON.stringify({
    id: 'm7', s: 'U2', n: '妈妈', t: now - 5000, k: 'text', x: '明天一起打本', me: false,
  }) + '\n', 'utf8');
  const r = M.ingestChatHistory(DATA_ROOT, { maxFilesPerRun: 8 });
  chk(r.imported === 1, `只补新增 1 条（实际 ${r.imported}）`);
  const rows = M.queryChat(DATA_ROOT, SCOPE, { limit: 3 });
  chk(rows[rows.length - 1].text === '明天一起打本', '最新一条在末尾');
}

head('4 实时写入');
{
  const a = M.appendChat(DATA_ROOT, {
    scope: SCOPE, ts: now, dir: 'in', senderId: 'U3', sender: '路人', text: '实时一条', msgId: 'live1',
  });
  const b = M.appendChat(DATA_ROOT, {
    scope: SCOPE, ts: now, dir: 'in', senderId: 'U3', sender: '路人', text: '实时一条', msgId: 'live1',
  });
  chk(a === true, '首次 append 成功');
  chk(b === false, '同 msgId 重复 append 被忽略');
  const rows = M.searchChat(DATA_ROOT, SCOPE, '实时一条', 5);
  chk(rows.length === 1, `关键词检索命中 1 条（实际 ${rows.length}）`);
}

head('5 清理');
{
  M.appendChat(DATA_ROOT, {
    scope: SCOPE, ts: now - 10 * 86400000, dir: 'in', senderId: 'U9', sender: '旧人', text: '十天前的老消息', msgId: 'old1',
  });
  const before = M.chatStats(DATA_ROOT, SCOPE).total;
  const p = M.pruneChat(DATA_ROOT, { retentionDays: 1, capPerScope: 0 });
  const after = M.chatStats(DATA_ROOT, SCOPE).total;
  chk(p.ok === true && p.deleted === 1, `按时间删掉 1 条（实际 ${p.deleted}）`);
  chk(after === before - 1, '删除后总数一致');
  const s = M.chatStats(DATA_ROOT);
  chk(s.total >= 6 && s.scopes.some((x) => x.scope === SCOPE), `stats 汇总正常（total=${s.total}）`);
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
