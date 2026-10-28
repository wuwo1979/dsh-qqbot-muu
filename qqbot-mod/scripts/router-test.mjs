#!/usr/bin/env node
/**
 * router-test.mjs — 分流分档回归（v2，按修正后的三档语义）
 *
 * 核心断言只有一条：**只有退化输入才判 trivial（可以本地快答）**。
 * 任何正常中文闲聊都必须判 chat（走云端，保住人格）。
 */

const R = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/router-core.mjs');

const CASES = [
  // ── 退化输入：唯一允许走本地快答的 ──
  ['哈', 'trivial'],
  ['哈哈哈', 'trivial'],
  ['哈哈哈哈哈哈', 'trivial'],
  ['😂', 'trivial'],
  ['……', 'trivial'],
  ['嗯嗯嗯', 'trivial'],
  ['哦哦哦哦', 'trivial'],
  ['[表情]', 'trivial'],

  // ── 普通闲聊：必须走云端（判错就等于把她变复读机）──
  ['今天好累', 'chat'],
  ['摸鱼啊笨蛋人类', 'chat'],
  ['哦鲸鲸...', 'chat'],
  ['你们觉得用A方案还是B方案好', 'chat'],
  ['那个东西后来怎么样了', 'chat'],
  ['妈妈昨天几点睡的来着？', 'chat'],
  ['哈哈哈哈这什么鬼', 'chat'],

  // ── 要她干活 ──
  ['帮我写个 Python 脚本，读 csv 然后按日期聚合，最后导出 xlsx', 'task'],
  ['你上次说的那个配置文件在哪？怎么改才能把端口从 3000 改成 8080？', 'task'],
  ['帮我查一下这个报错是为什么，是不是权限问题？顺便看看日志\n[图片: /tmp/x.png]', 'task'],
];

let pass = 0;
const fails = [];
console.log('分档回归 v2:\n');
for (const [text, expect] of CASES) {
  const r = R.classify(text);
  const good = r.tier === expect;
  if (good) pass += 1; else fails.push({ text, expect, got: r.tier, score: r.score });
  console.log(`${good ? '✅' : '❌'} [${r.tier.padEnd(7)}] 期望=${expect.padEnd(7)} ${text.replace(/\n/g, ' ⏎ ').slice(0, 44)}`);
}

console.log(`\n命中 ${pass}/${CASES.length}`);
if (fails.length) {
  console.log('\n未命中:');
  for (const f of fails) console.log(`  ${f.expect} → ${f.got} (score=${f.score})  ${f.text.slice(0, 40)}`);
}

// 关键安全断言：任何非退化输入都不许判 trivial
const dangerous = CASES.filter(([t]) => !R.isTrivial(t) === false && !['哈', '哈哈哈', '哈哈哈哈哈哈', '😂', '……', '嗯嗯嗯', '哦哦哦哦', '[表情]'].includes(t));
if (dangerous.length) { console.log('\n❌ 有正常消息被判成退化输入（危险）'); process.exit(1); }

console.log(fails.length === 0 ? '\n结论: 分档全部正确。' : '\n结论: 有偏差，见上。');
process.exit(fails.length === 0 ? 0 : 1);
