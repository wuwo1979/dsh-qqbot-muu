/**
 * voice-smooth-test.mjs — 语音「合成感」治理自测（退出码 0=全过）
 *
 * 用户反馈："语音合成还有较强合成感不够丝滑"。
 * 机器音的三个来源在代码里对应三件事：
 *   ① 文本太"书面"（带 markdown、书名号、连串省略号、数字读法）→ speechify()
 *   ② 每句结尾都收得整整齐齐（真人口语会有"嗯/啊/嘛"这种尾巴）→ addTail()
 *   ③ 每次合成用一模一样的语速音高（像同一个人在重复同一句）→ jitterProsody()
 * 这里逐条钉住它们，并做一次真实合成确认链路没断。
 *
 * 跑法：node F:\qqbot\qqbot-mod\scripts\voice-smooth-test.mjs
 */
import { speechify, addTail, jitterProsody, synthesize, isAvailable } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/tts-core.mjs';

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const sk = (name, why) => { skip++; console.log('  ~ ' + name + ' (SKIP: ' + why + ')'); };

console.log('[1] speechify：把书面文本改成"能念出来的话"');
ok('去粗体', !speechify('**好耶**').includes('*'));
ok('去行内代码', !speechify('用 `ls` 看看').includes('`'));
ok('去标题井号', !speechify('## 标题').includes('#'));
ok('去链接只留文字', speechify('看[这个](https://a.b)').includes('这个') && !speechify('看[这个](https://a.b)').includes('http'));
ok('去裸网址', !speechify('去 https://example.com 看看').includes('example.com'));
ok('去引用标记 rf', !speechify('[rf:0913a] 你说的').includes('rf:'));
ok('去媒体标记', !speechify('[MEDIA:image|D:/a.png] 看图').includes('MEDIA'));
ok('去 @ 标记', !speechify('<@0123456789ABCDEF0123456789ABCDEF> 在吗').includes('<@'));
ok('波浪号不再上挑（句尾收回句号）', !/[~〜～]/.test(speechify('好啊~')) && speechify('好啊~').endsWith('。'), speechify('好啊~'));
ok('中文逗号不被吃掉', speechify('你好，本鲸在呢').includes('，'), JSON.stringify(speechify('你好，本鲸在呢')));
ok('句末补句号', /[。！？～…]$/.test(speechify('本鲸在呢')), JSON.stringify(speechify('本鲸在呢')));
ok('空输入不炸', speechify('') === '');
ok('null 不炸', speechify(null) === '');
ok('长串省略号收成一组', (speechify('哈哈哈哈哈……').match(/…/g) || []).length <= 3);

console.log('[2] addTail：偶尔加个口语尾巴（但不是每句都加）');
const r0 = () => 0.0;
const r9 = () => 0.99;
ok('rand=0 一定加', addTail('好耶', 0.3, r0) !== '好耶', addTail('好耶', 0.3, r0));
ok('rand=0.99 一定不加', addTail('好耶', 0.3, r9) === '好耶', addTail('好耶', 0.3, r9));
ok('已有句号不加', addTail('好耶。', 1, r0) === '好耶。', addTail('好耶。', 1, r0));
ok('已有感叹号不加', addTail('好耶！', 1, r0) === '好耶！');
ok('加的是语气词', /[嗯啊嘛哦呀]/.test(addTail('好耶', 1, r0)), addTail('好耶', 1, r0));
ok('尾巴收口带标点', /[。！？～]$/.test(addTail('好耶', 1, r0)), addTail('好耶', 1, r0));
ok('空串不炸', addTail('', 1, r0) === '');

console.log('[3] jitterProsody：每次语速/音高都抖一点');
const j1 = jitterProsody('+5%', '+6Hz', { rateJitter: 4, pitchJitter: 6 }, () => 0);
const j2 = jitterProsody('+5%', '+6Hz', { rateJitter: 4, pitchJitter: 6 }, () => 0.999);
ok('返回 rate/pitch 字符串', typeof j1.rate === 'string' && typeof j1.pitch === 'string');
ok('rate 落在 ±4% 内', Math.abs(j1.r - 5) <= 4 && Math.abs(j2.r - 5) <= 4, j1.r + '/' + j2.r);
ok('pitch 落在 ±6Hz 内', Math.abs(j1.p - 6) <= 6 && Math.abs(j2.p - 6) <= 6, j1.p + '/' + j2.p);
ok('两次结果不同（真的在抖）', j1.rate !== j2.rate || j1.pitch !== j2.pitch, j1.rate + ' vs ' + j2.rate);
ok('rate 带正负号', /^[+-]\d+%$/.test(j1.rate), j1.rate);
ok('pitch 带单位 Hz', /^[+-]\d+Hz$/.test(j1.pitch), j1.pitch);
ok('jitter=0 时不抖', jitterProsody('+5%', '+6Hz', { rateJitter: 0, pitchJitter: 0 }, () => 0).rate === '+5%');

console.log('[4] 真实合成（链路 + 清洗+抖动都被用上）');
const avail = await isAvailable();
if (!avail) {
  sk('真实合成', 'edge-tts 不可用');
} else {
  const r = await synthesize('**好耶**，本鲸在呢~[rf:0913a]', { dataRoot: 'F:/qqbot/qqbot-mod/.devdata-smooth' });
  if (r.ok) {
    ok('合成成功', r.ok === true);
    ok('产物非空', Number(r.bytes) > 2000, 'bytes=' + r.bytes);
    ok('返回说了什么（said）', typeof r.said === 'string' && r.said.length > 0, JSON.stringify(r.said));
    ok('said 已清洗（无 ** 无 rf:）', !r.said.includes('**') && !r.said.includes('rf:'), JSON.stringify(r.said));
    ok('返回抖动后的 rate', /^[+-]\d+%$/.test(String(r.rate)), String(r.rate));
    ok('返回抖动后的 pitch', /^[+-]\d+Hz$/.test(String(r.pitch)), String(r.pitch));
    ok('rate 不等于配置原值（抖动生效）', String(r.rate) !== '+5%' || String(r.pitch) !== '+6Hz', r.rate + '/' + r.pitch);
  } else {
    ok('合成成功', false, JSON.stringify(r));
  }
}

console.log('\n──────────────────────────────────────────');
console.log('PASS ' + pass + ' / FAIL ' + fail + (skip ? ' / SKIP ' + skip : ''));
if (fail === 0) console.log('结论: 语音"人味"三件事（文本口语化/尾巴/韵律抖动）都在工作。');
process.exit(fail === 0 ? 0 : 1);
