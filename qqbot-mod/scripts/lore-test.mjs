/**
 * lore-test.mjs — 世界书检索自测（零依赖，退出码 0=全过）
 * 跑法：node F:\qqbot\qqbot-mod\scripts\lore-test.mjs
 */
import { loreFor, loadWorldbook, scoreLore, formatLoreBlock } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/lore-core.mjs';

const ROOT = 'F:/qqbot/dshqqbot';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

console.log('[1] 世界书能读出来');
const entries = loadWorldbook(ROOT);
ok('条数 > 10', entries.length > 10, 'got ' + entries.length);
ok('每条都有 text', entries.every((e) => e.text && e.text.length > 0));
ok('每条都有 keys', entries.every((e) => e.keys.length > 0));

console.log('[2] 关键词命中');
const a = loreFor(ROOT, '你老家在哪啊');
ok('老家 → 命中 home', a.hits.some((h) => h.id === 'home'), a.hits.map((h) => h.id).join(','));
ok('输出带 [设定] 标记', a.block.includes('[设定]') && a.block.includes('[/设定]'));

const b = loreFor(ROOT, '今天好累啊不想动');
ok('喊累 → 命中 spray', b.hits.some((h) => h.id === 'spray'), b.hits.map((h) => h.id).join(','));

const c = loreFor(ROOT, '2+3等于多少');
ok('2+3 → 命中 gag23', c.hits.some((h) => h.id === 'gag23'), c.hits.map((h) => h.id).join(','));
ok('gag23 文本含 6', c.block.includes('6'));

const d = loreFor(ROOT, '妈妈你在吗');
ok('妈妈 → 命中 qixing', d.hits.some((h) => h.id === 'qixing'), d.hits.map((h) => h.id).join(','));

console.log('[3] 不相关的话不该触发');
const e = loreFor(ROOT, 'zzz qqq');
ok('无关键词 → 空块', e.block === '', JSON.stringify(e.block));
ok('无关键词 → 0 命中', e.hits.length === 0);

console.log('[4] 预算硬约束');
const f = loreFor(ROOT, '老家 吃 累了 冷笑话 手机 表情包 妈妈 2+3 睡了 唱歌 哈哈 潜水 饲养员');
ok('最多 2 条', (f.block.match(/^- /gm) || []).length <= 2, f.block);
ok('总字数 ≤ 200', f.block.length <= 200 + 20, 'len=' + f.block.length);

console.log('[5] 关闭开关');
const g = loreFor(ROOT, '老家', { enabled: false });
ok('enabled:false → 空块', g.block === '');

console.log('[6] 异常输入不炸');
for (const bad of [null, undefined, '', 123, {}]) {
  let threw = false;
  try { loreFor(ROOT, bad); } catch { threw = true; }
  ok('loreFor(' + JSON.stringify(bad) + ') 不抛', !threw);
}
let threw2 = false;
try { formatLoreBlock(null, {}); } catch { threw2 = true; }
ok('formatLoreBlock(null) 不抛', !threw2);

console.log('');
console.log(fail === 0 ? `全部通过 ${pass}/${pass}` : `失败 ${fail} / 通过 ${pass}`);
process.exit(fail === 0 ? 0 : 1);
