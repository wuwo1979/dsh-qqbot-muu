/**
 * local-persona-eval.mjs — 本地小模型的"人设遵循度"体检（不是硬性验收，是打分表）
 *
 * 目的：本机模型换了 / prompt 改了，用同一条命令重跑，看人设有没有退步。
 *
 * 跑法：node qqbot-mod/scripts/local-persona-eval.mjs [模型名]
 * 退出码：人设污染（自称猫狗/AI/助手）超过 20% 才返回 1，其余情况 0。
 */
import { makeCtx, runLocal } from './_local-harness.mjs';

const MODEL = process.argv[2] || '';
const CASES = [
  '在吗',
  '哈哈哈',
  '鲸鲸',
  '吃了吗',
  '好累啊',
  '2+3等于几',
  '你是谁啊',
  '今天好无聊',
  '你会唱歌吗',
  '嗯',
];

const BREACH = /(喵星人|是只猫|猫|狗|AI|人工智能|语言模型|助手|为您服务|很高兴|有什么可以帮|作为一只|程序)/i;
const BAD_TAIL = /(首先|其次|综上|总的来说|希望以上|如需)/;

const rows = [];
let breach = 0;
let tooLong = 0;
let empty = 0;

for (const text of CASES) {
  const r = await runLocal(text, { model: MODEL || undefined });
  const reply = r.sent[0] || '';
  const isBreach = !!reply && BREACH.test(reply);
  const isLong = reply.length > 40;
  if (isBreach) breach += 1;
  if (isLong) tooLong += 1;
  if (!reply) empty += 1;
  rows.push({ text, reply: reply || '（未接管）', ms: r.ms, breach: isBreach, long: isLong });
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log('\n输入'.padEnd(14) + '耗时代答回复');
console.log('-'.repeat(72));
for (const r of rows) {
  console.log(pad(r.text, 12) + pad(r.ms ? r.ms + 'ms' : '-', 8) + (r.breach ? '⚠' : ' ') + (r.long ? '✂' : ' ') + ' ' + r.reply);
}

const judged = rows.filter((r) => r.reply !== '（未接管）').length;
console.log('\n共 ' + CASES.length + ' 条：代答 ' + judged + ' / 空 ' + empty + ' / 人设跑偏 ' + breach + ' / 超长 ' + tooLong);
const rate = judged ? breach / judged : 0;
console.log('人设污染率 ' + (rate * 100).toFixed(0) + '%（阈值 20%）');

if (!judged) {
  console.log('\n⚠ 一条都没代答 —— 检查 Ollama 是否在跑、模型是否已拉、或触发词是否被门禁挡住');
}
process.exit(judged > 0 && rate > 0.2 ? 1 : 0);
