/**
 * mem-context-test.mjs — 本地小模型也要"记得"（记忆库 → 本地模型）
 *
 * 为什么要单独测：入站扩展是按文件名排序装载的，改名前 `local-answer.mjs`
 * 排在 `memory-recall.mjs` 之前 —— 它一 annihilate 接管，后面的召回/沉淀都不会跑。
 * 后果：①走本地代答的消息根本没进记忆库；②本地小模型答题时拿不到召回的记忆。
 * 修法：召回逻辑搬到 `aa-memory-recall.mjs`（排最前），本地代答排最后，
 *       并把 `[记忆]/[设定]/[别重复]` 从注入文本里捡出来喂给本地模型。
 *
 * 跑法：node F:\qqbot\qqbot-mod\scripts\mem-context-test.mjs
 */
import { runLocal } from 'file:///F:/qqbot/qqbot-mod/scripts/_local-harness.mjs';
import { recallBlocksOf } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/local-answer.mjs';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (extra ? '  → ' + extra : '')); }
};

console.log('[1] 从注入文本里捡出记忆块');
const withMem = '今天好累啊\n[记忆]你上次说在赶项目，别熬夜[/记忆]';
const b1 = recallBlocksOf(withMem);
ok('记忆块被捡出来', b1.includes('赶项目'), b1);
ok('人话部分不进记忆块', !b1.includes('今天好累啊'), b1);

console.log('[2] 设定块 + 别重复行');
const b2 = recallBlocksOf('哈哈哈\n[设定]你住在马里亚纳海沟[/设定]\n[别重复]刚说过：笑死');
ok('设定被捡出来', b2.includes('马里亚纳'), b2);
ok('别重复被捡出来（换个说法给她）', b2.includes('别重复'), b2);

console.log('[3] 没有注入就是空串');
ok('普通文本 → 空串', recallBlocksOf('在吗') === '');
ok('null 不炸', recallBlocksOf(null) === '');

console.log('[4] 带注入的长文本仍然按"人话"判定（注入不撑爆门禁）');
// 人话只有 3 个字，注入块很长；如果不剥注入，长度会超 maxInputChars 而被交回云端
const longInjected = '哈哈哈' + '\n[记忆]' + '很长的记忆内容'.repeat(30) + '[/记忆]';
const r = await runLocal(longInjected, { cfg: { whoAnswers: 'simple', maxInputChars: 80, shortChatChars: 12, maxReplyChars: 60, timeoutMs: 12000 } });
ok('本地仍然接管（说明注入块被剥掉了）', r.took === true, JSON.stringify(r.sent));
ok('确实答了一句话', typeof r.sent[0] === 'string' && r.sent[0].length > 0, JSON.stringify(r.sent));
console.log('    回答：' + (r.sent[0] || '(无)'));

console.log('\n[5] 引用「子会话转发」时不抢答（会话隔离的地盘）');
const rq = await runLocal('在吗', { quote: '【子会话 bee798c0】那边聊到哪了', cfg: { whoAnswers: 'simple', maxInputChars: 80, shortChatChars: 12, maxReplyChars: 60, timeoutMs: 12000 } });
ok('不接管（交给 no-wake/route-isolate）', rq.took === false, JSON.stringify(rq.sent));
ok('确实放行给下一环', rq.nextCalls === 1, 'next=' + rq.nextCalls);

console.log('\n──────────────────────────────────────────');
console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
