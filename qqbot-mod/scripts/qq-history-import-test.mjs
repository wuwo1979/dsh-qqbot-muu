/**
 * qq-history-import-test.mjs — 聊天记录导入 + 人物归一 + 脱敏 测试
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseQQText, parseQQJson, parseHistory, maskPrivacy, infoScore,
  profileOf, describeProfile, importHistory,
} from '../../dshqqbot/.qqbot-extensions/lib/qq-history-import.mjs';
import {
  personIdOf, normalizeNick, registerPerson, loadRegistry, saveRegistry,
} from '../../dshqqbot/.qqbot-extensions/lib/person-registry.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ── 解析 ────────────────────────────────────────────────────────────────
console.log('\n[parseQQText]');
const TXT = `消息记录（此消息记录为文本格式）
================================================================
消息分组:我的好友
================================================================

2024-01-15 20:31:02 张三(123456789)
你好啊，那个项目方案我看了

2024-01-15 20:32:10 李四(987654321)
哪里有问题你说

2024-01-16 09:02:00 张三(123456789)
预算那一块要重新算，因为成本涨了两成
`;
{
  const m = parseQQText(TXT);
  eq('解析出 3 条', m.length, 3);
  eq('昵称正确', m[0].nick, '张三');
  eq('QQ 号正确', m[0].uin, '123456789');
  ok('正文多行合并', m[1].text === '哪里有问题你说', m[1].text);
  ok('时间戳可解析', m[0].ts > 0, String(m[0].ts));
  ok('表头没被当成消息', !m.some((x) => x.nick.includes('消息')));
}
{
  const m = parseQQText('2024-01-15 20:31:02 王五\n没写QQ号的也认');
  eq('无 QQ 号也能解析', m.length, 1);
  eq('无 QQ 号时 uin 为空', m[0].uin, '');
}

console.log('\n[parseQQJson]');
{
  const m = parseQQJson(JSON.stringify([
    { time: '2024-02-01 10:00:00', sender: '赵六', uin: '555666777', content: '我下周三去上海出差' },
    { timestamp: 1706770000, from: '钱七', qq: '111222333', text: '记得带伞' },
  ]));
  eq('解析 2 条', m.length, 2);
  eq('sender→nick', m[0].nick, '赵六');
  eq('qq→uin', m[1].uin, '111222333');
  ok('第二个时间戳可解析', m[1].ts > 0);
}
{
  const m = parseQQJson('{bad json');
  eq('坏 JSON 返回空', m.length, 0);
}

console.log('\n[parseHistory]');
{
  eq('自动识别 txt', parseHistory(TXT).format, 'qq-text');
  eq('自动识别 json', parseHistory('[{"text":"a","sender":"b"}]').format, 'json');
  eq('空输入', parseHistory('').format, 'empty');
}

// ── 脱敏 ────────────────────────────────────────────────────────────────
console.log('\n[maskPrivacy]');
{
  const a = maskPrivacy('我的手机是13812345678');
  ok('手机号打码', a.includes('138****5678') && !a.includes('12345678'), a);
}
{
  const a = maskPrivacy('身份证号110101199003071234');
  ok('身份证保留前6后4', a.includes('110101') && a.includes('1234') && a.includes('*'), a);
}
{
  const a = maskPrivacy('邮箱 zhangsan@example.com');
  ok('邮箱本地部分打码', a.includes('z***@example.com'), a);
}
{
  const a = maskPrivacy('加我QQ 123456789 聊');
  ok('QQ 号打码', !a.includes('123456789'), a);
}
{
  const a = maskPrivacy('今年2024年，花了35元');
  ok('年份/小额不受影响', a.includes('2024') && a.includes('35'), a);
}
{
  const a = maskPrivacy('卡号6222021234567890123');
  ok('银行卡只留后4', !a.includes('6222021234567890123'), a);
}

// ── 信息量筛选 ──────────────────────────────────────────────────────────
console.log('\n[infoScore]');
{
  ok('寒暄得分低', infoScore('在吗') < 0.2, String(infoScore('在吗')));
  ok('"哈哈"为 0', infoScore('哈哈哈哈哈哈') === 0);
  ok('[图片] 为 0', infoScore('[图片]') === 0);
  ok('"收到"为 0', infoScore('收到') === 0);
  const fact = infoScore('预算那一块要重新算，因为成本涨了两成');
  ok('事实句得分高', fact >= 0.55, String(fact));
  ok('叙述句 >= 寒暄', infoScore('我下周三去上海出差') > infoScore('好的'));
  ok('空串为 0', infoScore('') === 0);
}

// ── 画像 ────────────────────────────────────────────────────────────────
console.log('\n[profileOf]');
{
  const p = profileOf([
    { text: '预算那一块要重新算，因为成本涨了两成', ts: new Date(2024, 0, 15, 22, 30).getTime() },
    { text: '这个项目的进度是不是有问题？', ts: new Date(2024, 0, 15, 23, 10).getTime() },
    { text: '我觉得应该先做用户调研再动手', ts: new Date(2024, 0, 16, 22, 5).getTime() },
  ]);
  eq('条数', p.count, 3);
  ok('平均长度 > 0', p.avgLen > 5, String(p.avgLen));
  ok('活跃时段含 22 点', p.activeHours.includes(22), JSON.stringify(p.activeHours));
  ok('高频词有产出', p.topWords.length >= 0, String(p.topWords.length));
  ok('问句率 > 0', p.questionRate > 0, String(p.questionRate));
  ok('空输入返回 null', profileOf([]) === null);
}
{
  const line = describeProfile(profileOf([
    { text: '预算要重算因为成本涨了', ts: new Date(2024, 0, 15, 22, 0).getTime() },
    { text: '预算这块还要再确认一下', ts: new Date(2024, 0, 15, 22, 30).getTime() },
  ]), '张三');
  ok('人话描述含次数', /出现 \d+ 次/.test(line), line);
  ok('人话描述以句号结尾', line.endsWith('。'), line);
}

// ── 人物归一 ────────────────────────────────────────────────────────────
console.log('\n[person-registry]');
{
  eq('QQ 号优先做主键', personIdOf({ uin: '123456789', nick: '张三' }), 'qq:123456789');
  ok('无 QQ 号用昵称哈希', personIdOf({ nick: '张三' }).startsWith('nick:'));
  eq('昵称规范化去括号', normalizeNick('张三（管理员）'), '张三');
  eq('昵称规范化去空白', normalizeNick(' 张 三 '), '张三');
  eq('空身份返回空', personIdOf({}), '');
}
const tmpRoot = mkdtempSync(join(process.env.TEMP || 'F:/qqbot/tmp', 'qqimp-'));
{
  const reg = { version: 1, people: {}, aliases: {} };
  const a = registerPerson(reg, { uin: '123456789', nick: '张三' });
  const b = registerPerson(reg, { uin: '123456789', nick: '老张' });
  eq('同号不同昵称归一人', a.personId, b.personId);
  ok('第二个昵称不新建', b.created === false);
  eq('两个昵称都记下', reg.people[a.personId].nicks.length, 2);

  const c = registerPerson(reg, { uin: '999888777', nick: '张三' });
  ok('同昵称不同号不合并', c.personId !== a.personId, c.personId);
  eq('歧义昵称标记', reg.aliases['张三'], '?ambiguous');

  const r = saveRegistry(tmpRoot, reg);
  ok('注册表落盘', r.ok === true, r.error || '');
  const back = loadRegistry(tmpRoot);
  ok('读回来还有两个人', Object.keys(back.people).length >= 2, String(Object.keys(back.people).length));
}

// ── 导入（dryRun）────────────────────────────────────────────────────────
console.log('\n[importHistory dryRun]');
{
  const r = await importHistory({ raw: TXT, dataRoot: tmpRoot, dryRun: true, groupId: '12345' });
  ok('dryRun 成功', r.ok === true, r.error || '');
  eq('解析到 3 条', r.parsed, 3);
  ok('筛掉了寒暄', r.kept <= 3 && r.kept >= 1, 'kept=' + r.kept);
  ok('有一个人以上', r.people >= 2, 'people=' + r.people);
  ok('dryRun 不写库', !existsSync(join(tmpRoot, '.qqbot', 'memory.db')), 'memory.db 不该存在');
  ok('给出样例', Array.isArray(r.samples) && r.samples.length >= 1);
}
{
  const r = await importHistory({ raw: '', dataRoot: tmpRoot, dryRun: true });
  ok('空输入报错', r.ok === false && /empty/.test(r.error || ''), r.error);
}

// ── 导入（真写）─────────────────────────────────────────────────────────
console.log('\n[importHistory 真写]');
{
  const r = await importHistory({ raw: TXT, dataRoot: tmpRoot, limit: 10, groupId: '12345' });
  ok('导入成功', r.ok === true, r.error || '');
  ok('写入了记忆', (r.added + r.deduped) >= 1, `added=${r.added} deduped=${r.deduped}`);
  ok('注册表已落盘', existsSync(join(tmpRoot, '.qqbot', 'person-registry.json')));
}
{
  // 幂等：再导一次应该全是 deduped，不重复膨胀
  const r2 = await importHistory({ raw: TXT, dataRoot: tmpRoot, limit: 10, groupId: '12345' });
  ok('二次导入全部去重', r2.ok === true && r2.added === 0, `added=${r2.added}`);
}

try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
