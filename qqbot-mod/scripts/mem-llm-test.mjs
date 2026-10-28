/**
 * mem-llm-test.mjs — 「记忆库 + 本地小模型压成一句话」自测（退出码 0=全过）
 *
 * 这套是用户提的方案：召回的记忆别直接塞编号列表，让本地模型压成一句第一人称
 * （"你之前答应要给我装语音"），既是她的口吻，也省字。
 * 铁律：本地模型没起 / 超时 / 吐废话 → 一律回退编号列表，绝不阻塞入站。
 *
 * 跑法：node F:\qqbot\qqbot-mod\scripts\mem-llm-test.mjs [-v]
 */
import { loadLlmRecallCfg, tidyRecallText, rewriteRecall, REFUSAL_RE, DEFAULTS } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-llm.mjs';

const ROOT = 'F:/qqbot/dshqqbot';
let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const sk = (name, why) => { skip++; console.log('  ~ ' + name + ' (SKIP: ' + why + ')'); };

const HITS = [
  { kind: 'promise', text: '答应给小鲸鱼装个语音模块', ts: Date.now() - 3600_000 },
  { kind: 'event', text: '语音模块……明天测试吧', ts: Date.now() - 7200_000 },
  { kind: 'event', text: '原本还想着给小鲸鱼装个语音模块给你点小惊喜', ts: Date.now() - 9000_000 },
];

console.log('[1] 配置读取');
const cfg = loadLlmRecallCfg();
ok('默认 enabled=true', cfg.enabled === true, JSON.stringify(cfg));
ok('默认 timeoutMs=1500', cfg.timeoutMs === 1500);
ok('默认 minHits=2', cfg.minHits === 2);
ok('默认 maxChars=60', cfg.maxChars === 60);
const off = loadLlmRecallCfg({ llmRecall: { enabled: false } });
ok('memCfg 里 enabled:false 能关掉', off.enabled === false);
const tuned = loadLlmRecallCfg({ llmRecall: { timeoutMs: 800, maxChars: 30 } });
ok('局部覆盖生效', tuned.timeoutMs === 800 && tuned.maxChars === 30);
ok('未覆盖的键保留默认', tuned.maxInChars === DEFAULTS.maxInChars);

console.log('[2] 文本整理 tidyRecallText');
ok('去引号', tidyRecallText('"你之前说过要减肥"') === '你之前说过要减肥');
ok('去结尾句号', tidyRecallText('你之前说过要减肥。') === '你之前说过要减肥');
ok('压成一行', !tidyRecallText('你之前\n说过\t要减肥').includes('\n'));
ok('超长截断', tidyRecallText('啊'.repeat(200), 20).length <= 21, String(tidyRecallText('啊'.repeat(200), 20).length));
ok('空字符串不炸', tidyRecallText('') === '');
ok('null 不炸', tidyRecallText(null) === '');

console.log('[3] 废话识别 REFUSAL_RE');
ok('"抱歉，没有相关信息" → 判废', REFUSAL_RE.test('抱歉，没有相关信息'));
ok('"作为AI我无法…" → 判废', REFUSAL_RE.test('作为 AI 我无法回答'));
ok('"你不知道上次说要减肥吗" → 不判废', !REFUSAL_RE.test('你上次说要减肥那个'));
ok('"你答应给我装语音模块了" → 不判废', !REFUSAL_RE.test('你答应给我装语音模块了'));

console.log('[4] 本地模型离线 → 必须回退（不能抛、不能阻塞）');
const bad = { ...cfg, enabled: true };
let r = null;
try {
  r = await rewriteRecall(HITS, '上次那个语音的事怎么样了', { llmRecall: bad }, {
    dataRoot: ROOT,
    llmCfgOverride: { baseUrl: 'http://127.0.0.1:59999', model: 'qwen2.5:7b', timeoutMs: 800, healthTtlMs: 0 },
  });
} catch (e) {
  ok('离线时未抛异常', false, e && e.message);
}
if (r) {
  ok('离线返回 ok:false', r.ok === false, JSON.stringify(r));
  ok('离线带 reason', typeof r.reason === 'string' && r.reason.length > 0, r.reason);
}

console.log('[5] 命中太少 → 不调模型');
const few = await rewriteRecall([HITS[0]], '语音', { llmRecall: { enabled: true, minHits: 2 } }, { dataRoot: ROOT });
ok('1 条命中不触发改写', few.ok === false && /hits/.test(String(few.reason || '')), JSON.stringify(few));

console.log('[6] 开关关闭 → 立刻返回');
const disabled = await rewriteRecall(HITS, '语音', { llmRecall: { enabled: false } }, { dataRoot: ROOT });
ok('disabled 时不调模型', disabled.ok === false && /disabled/.test(String(disabled.reason || '')), JSON.stringify(disabled));

console.log('[7] 真模型（有 ollama 就跑）');
const live = await rewriteRecall(HITS, '上次那个语音的事怎么样了', { llmRecall: { enabled: true, timeoutMs: 6000, minHits: 2 } }, { dataRoot: ROOT });
if (live.ok) {
  console.log('  · 模型输出: ' + live.text + '  (' + live.ms + 'ms)');
  ok('真模型产出非空', typeof live.text === 'string' && live.text.length >= 2);
  ok('真模型产出 ≤ maxChars+10', live.text.length <= 70, 'len=' + live.text.length);
  ok('真模型产出不含拒绝词', !REFUSAL_RE.test(live.text), live.text);
  ok('真模型产出是一行', !live.text.includes('\n'));
} else if (String(live.reason || '').includes('offline') || String(live.reason || '').includes('health')) {
  sk('真模型改写', 'ollama 没起/模型没拉');
} else {
  ok('真模型改写（失败原因不是离线，说明逻辑有问题）', false, JSON.stringify(live));
}

console.log('\n──────────────────────────────────────────');
console.log('PASS ' + pass + ' / FAIL ' + fail + (skip ? ' / SKIP ' + skip : ''));
if (fail === 0) console.log('结论: 记忆+本地模型改写链路正常。');
process.exit(fail === 0 ? 0 : 1);
