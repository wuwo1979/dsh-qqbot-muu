#!/usr/bin/env node
/**
 * context-fix-test.mjs — 上下文三处修复的本地自检
 *
 * 覆盖：
 *  1) 桥接 / 入站兜底：`<type:sticker>` 等裸标签绝不原样进上下文；
 *  2) 意图提示：分享/自嘲/难受/引用才注入 [听懂]，普通聊天零注入；
 *  3) 反馈识别：只把直接评价她回复的话记成反馈，普通消息不误伤。
 *
 * 运行：node qqbot-mod/scripts/context-fix-test.mjs
 */

const EXT = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/';
const { normalizeTypeTags, readableFallback } = await import(EXT + 'lib/placeholder-text.mjs');
const guard = await import(EXT + 'inbound/a0-tag-guard.mjs');
const und = await import(EXT + 'inbound/ab-understand.mjs');
const fb = await import(EXT + 'inbound/az-feedback.mjs');
const { sanitize } = await import(EXT + 'outbound/aa-sanitize.mjs');
const { cleanInjected, hasInjected } = await import(EXT + 'lib/text-clean.mjs');

let pass = 0, fail = 0;
const chk = (cond, s) => {
  if (cond) { pass += 1; console.log('  PASS  ' + s); }
  else { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; }
};

console.log('\n[1] 裸标签归一');
{
  chk(normalizeTypeTags('<type:sticker>') === '对方发来一个表情', 'sticker → 人话');
  chk(normalizeTypeTags('<type:image>') === '对方发来一张图片', 'image → 人话');
  chk(normalizeTypeTags('<type:foo>') === '对方发来一条暂不支持的消息', '未知标签有兜底');
  chk(!/<type:/i.test(normalizeTypeTags('<type:foo> 123')), '归一结果不含裸标签');
  chk(readableFallback('<msg><type:sticker></msg>') === '对方发来一条消息（暂时看不到内容）', '残留 XML 不直接进上下文');
}

console.log('\n[2] 入站兜底 hook');
{
  const log = [];
  let n = 0;
  await guard.onInbound({ text: '<type:sticker>', rewrite: (o) => log.push(o.text) }, async () => { n += 1; });
  chk(log.length === 1 && log[0] === '对方发来一个表情', `a0 rewrite 正确（${log[0] || '无'}）`);
  chk(n === 1, 'next() 只调 1 次');
  const log2 = [];
  await guard.onInbound({ text: '今天下雨', rewrite: (o) => log2.push(o.text) }, async () => {});
  chk(log2.length === 0, '普通文本不触发 rewrite');
}

console.log('\n[3] 意图提示');
{
  const run = async (text, extra = {}) => {
    const log = [];
    let n = 0;
    await und.onInbound({ text, message: { groupOpenid: 'g' + pass + 'x', content: text, ...extra }, rewrite: (o) => log.push(o.text) }, async () => { n += 1; });
    return { log, n };
  };
  const share = await run('难绷，这也太离谱了');
  chk(share.log.length === 1 && /\[听懂\](.+)\[\/听懂\]/.test(share.log[0]), '分享 → 注入 [听懂]');
  chk(share.log[0].length <= 60, `提示长度受控（${share.log[0].length} 字）`);
  const dep = await run('我太菜了，又搞砸了');
  chk(dep.log.length === 1 && dep.log[0].includes('自嘲'), '自嘲 → 提示“不是评价你”');
  const neg = await run('今天真的好累');
  chk(neg.log.length === 1 && neg.log[0].includes('陪着'), '难受 → 提示“先陪着”');
  const plain = await run('下午三点开会');
  chk(plain.log.length === 0, '普通消息零注入');
  const shared = await run('这图好玩', {});
  chk(shared.log.length === 1 && shared.log[0].includes('共鸣'), '好玩 → 共鸣提示');
}

console.log('\n[4] 反馈识别');
{
  chk(fb.isFeedback('你刚才太凶了，别这样'), '直接负反馈命中');
  chk(fb.isFeedback('别反问了，我不是在问你'), '“别反问”命中');
  chk(fb.isFeedback('这句听着像客服，观感差'), '观感反馈命中');
  chk(!fb.isFeedback('今天下雨了'), '普通聊天不误记');
  chk(!fb.isFeedback('你好凶啊'), '没有指向她刚才回复的不算');
}

console.log('\n[5] [听懂] 不许漏到出站/台账');
{
  const t = '哈哈哈[听懂]他在分享，先共鸣。[/听懂]';
  chk(sanitize(t) === '哈哈哈', '出站 sanitize 剥掉 [听懂]');
  chk(cleanInjected(t) === '哈哈哈', '台账/记忆 clean 剥掉 [听懂]');
  chk(hasInjected('残句[听懂]没有闭块') === true, '截断回显也能识别');
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
