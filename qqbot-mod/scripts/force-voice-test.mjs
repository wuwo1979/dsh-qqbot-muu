/**
 * force-voice-test.mjs — 「嘴上说能发语音 → 这轮真发一条」的标记自测（退出码 0=全过）
 *
 * 背景：用户抓到最像机器的一次崩：问"能发语音吗"，她答"本鲸只会打字哦？"，
 *   转头又发来一条语音条。修法是入站侧写一个 force-voice 标记，出站侧读到就跳过概率直接发。
 *
 * 这里钉住标记的**匹配规则**，因为两边记的作用域格式本来不一样：
 *   入站：`group:<peer>`   （local-answer.mjs）
 *   出站：`group|<peer>`   （tts-voice.mjs 的 ctx.target.scope + '|' + peerId）
 * 曾经用 `includes` 直接比 ⇒ 永远不等 ⇒ 标记形同虚设。
 *
 * 跑法：node F:\qqbot\qqbot-mod\scripts\force-voice-test.mjs
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readForce, forceFile } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/outbound/tts-voice.mjs';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-force';
const PEER = 'TEST_GROUP_0002ABCDEF';
const SCOPE_KEY = 'group|' + PEER;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const write = (obj) => {
  mkdirSync(join(ROOT, '.qqbot'), { recursive: true });
  writeFileSync(forceFile(ROOT), JSON.stringify(obj), 'utf8');
};
const clear = () => { try { rmSync(forceFile(ROOT), { force: true }); } catch { /* ignore */ } };

console.log('[1] 没标记时不强制');
clear();
ok('文件不存在 → null', readForce(ROOT, SCOPE_KEY) === null);

console.log('[2] 入站写 group:<peer>，出站 scope 是 group|<peer> —— 必须能对上');
write({ scope: 'group:' + PEER, ts: Date.now(), ttlMs: 120000 });
const m1 = readForce(ROOT, SCOPE_KEY);
ok('格式不同也能命中', m1 && m1.scope === 'group:' + PEER, JSON.stringify(m1));

console.log('[3] 空的 scope 当通配（任何人问都算）');
write({ scope: '', ts: Date.now(), ttlMs: 120000 });
ok('空 scope → 任意会话命中', readForce(ROOT, SCOPE_KEY) !== null);
ok('空 scope → 私聊也命中', readForce(ROOT, 'c2c|TESTOWNER') !== null);

console.log('[4] 别的群不串台');
write({ scope: 'group:AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD', ts: Date.now(), ttlMs: 120000 });
ok('别的群 → 不命中', readForce(ROOT, SCOPE_KEY) === null, JSON.stringify(readForce(ROOT, SCOPE_KEY)));
write({ scope: 'c2c:TEST_OWNER_0001ABCDEF', ts: Date.now(), ttlMs: 120000 });
ok('私聊标记不影响群', readForce(ROOT, SCOPE_KEY) === null);
ok('私聊标记在自己会话命中', readForce(ROOT, 'c2c|TEST_OWNER_0001ABCDEF') !== null);

console.log('[5] 过期作废');
write({ scope: 'group:' + PEER, ts: Date.now() - 200000, ttlMs: 120000 });
ok('过期 → null', readForce(ROOT, SCOPE_KEY) === null);
write({ scope: 'group:' + PEER, ts: Date.now() - 600000, ttlMs: 120000 });
ok('很久以前 → null', readForce(ROOT, SCOPE_KEY) === null);
write({ scope: 'group:' + PEER, ts: 0, ttlMs: 120000 });
ok('ts=0 → null（没时间戳不可信）', readForce(ROOT, SCOPE_KEY) === null);

console.log('[6] 坏文件不炸');
mkdirSync(join(ROOT, '.qqbot'), { recursive: true });
writeFileSync(forceFile(ROOT), '{坏 json', 'utf8');
ok('坏 json → null 不抛', readForce(ROOT, SCOPE_KEY) === null);

console.log('[7] scopeKey 缺失时不误杀');
write({ scope: 'group:' + PEER, ts: Date.now(), ttlMs: 120000 });
ok('scopeKey 为空 → 命中（宁发勿哑）', readForce(ROOT, '', Date.now()) !== null);

clear();
console.log('\n──────────────────────────────────────────');
console.log('PASS ' + pass + ' / FAIL ' + fail);
if (fail === 0) console.log('结论: 「说会发语音」与「真发一条」的桥梁是通的。');
process.exit(fail === 0 ? 0 : 1);
