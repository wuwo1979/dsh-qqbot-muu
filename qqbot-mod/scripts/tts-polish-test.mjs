/**
 * tts-polish-test.mjs — 语音人味改造的单元测试 + 可选端到端
 *
 * 跑法：node qqbot-mod/scripts/tts-polish-test.mjs
 * 端到端（真合成）需要 python + edge-tts 可用，不可用则自动跳过。
 */
import { existsSync, statSync } from 'node:fs';

import {
  polishText, planBreath, warmProsody, postFilter, synthesizeWarm, findFfmpeg,
} from '../../dshqqbot/.qqbot-extensions/lib/tts-polish.mjs';
import { isAvailable } from '../../dshqqbot/.qqbot-extensions/lib/tts-core.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ── polishText ──────────────────────────────────────────────────────────
console.log('\n[polishText]');
{
  const t = polishText('你好！！这是什么？？');
  ok('感叹/问号折叠', !/[！？]{2}/.test(t), t);
}
{
  const t = polishText('这是（很长的括号注释说明文字超过十个字了）一个例子');
  ok('长括号去掉', !t.includes('括号注释'), t);
}
{
  const t = polishText('他说（笑）好的');
  ok('短括号转插入语', t.includes('，笑，'), t);
}
{
  const t = polishText('用 e.g. 这种方式');
  ok('e.g. 转中文', t.includes('例如'), t);
}
{
  const t = polishText('3个苹果和5只猫');
  ok('数字与量词留空', t.includes('3 个') && t.includes('5 只'), t);
}
{
  const t = polishText('  多   空格    ');
  ok('空白压缩', t === '多 空格', JSON.stringify(t));
}
{
  const t = polishText('好。行。走。');
  ok('极短句号连缀降级', (t.match(/。/g) || []).length < 3, t);
}

// ── planBreath ──────────────────────────────────────────────────────────
console.log('\n[planBreath]');
{
  const p = planBreath('第一句。第二句？第三句！');
  eq('按句切三段', p.length, 3);
  ok('末段无停顿', p[p.length - 1].pauseMs === 0);
  ok('句号停顿 170', p[0].pauseMs === 170, String(p[0].pauseMs));
  ok('问号停顿 165', p[1].pauseMs === 165, String(p[1].pauseMs));
}
{
  const long = '这一句话特别长'.repeat(10) + '。';
  const p = planBreath(long, { maxLen: 20 });
  ok('长句被切碎', p.length > 1, String(p.length));
  ok('每段不超太多', p.every((x) => x.text.length <= 42), JSON.stringify(p.map((x) => x.text.length)));
}
{
  const p = planBreath('省略号后面应该停很久……然后继续。');
  ok('省略号长停顿', p[0].pauseMs === 280, String(p[0].pauseMs));
}
{
  ok('空文本返回空数组', planBreath('   ').length === 0);
}
{
  const p = planBreath('甲，乙，丙。');
  ok('逗号不切段（段内停顿交给 TTS）', p.length === 1, String(p.length));
  ok('段内逗号保留', p[0].text.includes('，'), p[0].text);
}

// ── warmProsody ─────────────────────────────────────────────────────────
console.log('\n[warmProsody]');
{
  const d = warmProsody();
  eq('默认降速 -6%', d.rate, '-6%');
  eq('默认降调 -1Hz', d.pitch, '-1Hz');
}
{
  const d = warmProsody({ rate: '+10%', pitch: '+5Hz' });
  eq('可覆盖 rate', d.rate, '+10%');
  eq('可覆盖 pitch', d.pitch, '+5Hz');
}
{
  const d = warmProsody({ ratePct: -8, pitchHz: -2 });
  eq('数字参数 -8%', d.rate, '-8%');
  eq('数字参数 -2Hz', d.pitch, '-2Hz');
}
{
  const d = warmProsody({ ratePct: 3 });
  eq('正数补 + 号', d.rate, '+3%');
}

// ── postFilter ──────────────────────────────────────────────────────────
console.log('\n[postFilter]');
{
  const f = postFilter();
  ok('含高通', f.includes('highpass=f=78'), f);
  ok('含 5.2k 削减', f.includes('equalizer=f=5200'), f);
  ok('含压缩', f.includes('acompressor'), f);
  ok('含响度归一', f.includes('loudnorm=I=-16'), f);
  ok('默认不削低频厚度', f.includes('f=240'), f);
}
{
  const f = postFilter({ lufs: -14 });
  ok('响度可配', f.includes('loudnorm=I=-14'), f);
}

// ── 端到端（可选）───────────────────────────────────────────────────────
console.log('\n[e2e]');
const ffmpeg = findFfmpeg();
console.log('  ffmpeg =', ffmpeg || '(未找到)');
const ttsOk = isAvailable();
console.log('  edge-tts available =', ttsOk);

if (ttsOk && ffmpeg) {
  const text = '两万米以下，光早就放弃了。声音在往下沉，像有人轻轻把门关上。可我还是听见了——那一点点，从很深的地方传上来的回声。';
  const r = await synthesizeWarm(text, { dataRoot: 'F:/qqbot/tmp/tts-polish-data', ffmpeg });
  ok('合成成功', r.ok === true, r.error || '');
  if (r.ok) {
    console.log('  ->', r.path, '| parts:', r.parts, '| seconds:', r.seconds, '| post:', r.post);
    ok('产出多段（有呼吸）', (r.parts || 0) >= 2, 'parts=' + r.parts);
    ok('做了后处理', r.post === true);
    ok('文件存在且非空', existsSync(r.path) && statSync(r.path).size > 5000, String(r.path));
    ok('时长合理(3~40s)', r.seconds > 3 && r.seconds < 40, String(r.seconds));
  }
} else {
  console.log('  (跳过：缺 python/edge-tts 或 ffmpeg)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
