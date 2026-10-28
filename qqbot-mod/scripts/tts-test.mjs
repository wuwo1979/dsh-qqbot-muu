/**
 * tts-test.mjs — 小蓝语音合成验收脚本（真跑 edge-tts，不 mock）
 * 跑法：node F:\qqbot\qqbot-mod\scripts\tts-test.mjs   （全过 exit 0，否则 1）
 *
 * 覆盖：python 可用性 / 中文合成落盘 / 字节数 / 时长估算 / 空文本 / 超长截断 /
 *       音色切换 / 失败路径不抛 / 旧文件清理。
 */
import { synthesize, pythonBin, isAvailable, listVoices, cleanText } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/tts-core.mjs';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = 'F:\\qqbot\\qqbot-mod\\.devdata';
const OUT_DIR = join(DATA_ROOT, '.qqbot', 'tts');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const mp3s = () => {
  try { return readdirSync(OUT_DIR).filter((f) => f.toLowerCase().endsWith('.mp3')); }
  catch { return []; }
};

let lastOk = null;

console.log('[1] python / edge-tts 可用性');
const bin = pythonBin();
console.log('    pythonBin() = ' + bin);
ok('pythonBin() 指向真实存在的文件', existsSync(bin), bin);
ok('isAvailable() === true', isAvailable() === true);
ok('listVoices() 至少 4 个', listVoices().length >= 4, 'got ' + listVoices().length);
ok('默认音色在列表里', listVoices().some((v) => v.id === 'zh-CN-XiaoyiNeural'));
ok('XiaoxiaoNeural 在列表里', listVoices().some((v) => v.id === 'zh-CN-XiaoxiaoNeural'));

console.log('[2] 合成一句中文「咕噜噜，本鲸在呢。」');
const r1 = await synthesize('咕噜噜，本鲸在呢。', { dataRoot: DATA_ROOT });
if (!r1.ok) console.log('    error = ' + r1.error);
ok('返回 ok:true', r1.ok === true, r1.ok ? '' : r1.error);
if (r1.ok) {
  lastOk = r1;
  ok('文件真的存在', existsSync(r1.path), r1.path);
  const sz = existsSync(r1.path) ? statSync(r1.path).size : 0;
  ok('字节数 > 2000', sz > 2000, 'bytes=' + sz);
  ok('返回的 bytes 与磁盘一致', r1.bytes === sz, `returned=${r1.bytes} disk=${sz}`);
  ok('扩展名 .mp3', r1.path.toLowerCase().endsWith('.mp3'), r1.path);
  ok('估算时长 ms > 500', r1.ms > 500, 'ms=' + r1.ms);
  ok('音色回显正确', r1.voice === 'zh-CN-XiaoxiaoNeural', r1.voice);
  ok('默认不截断', r1.truncated === false);
  console.log('    → ' + r1.path + '  (' + r1.bytes + ' bytes, ~' + r1.ms + 'ms)');
}

console.log('[3] 空文本 / 超长文本不抛异常');
let threw = false;
let rEmpty;
try {
  rEmpty = await synthesize('', { dataRoot: DATA_ROOT });
} catch (e) { threw = true; rEmpty = { ok: 'THREW', error: String(e) }; }
ok('空字符串不抛', threw === false);
ok('空字符串 → ok:false', rEmpty.ok === false, JSON.stringify(rEmpty));
ok('空白字符串 → ok:false', (await synthesize('   \n\t ', { dataRoot: DATA_ROOT })).ok === false);

const long = '今天海面上有好多泡泡，'.repeat(36); // ~396 字
const cleanLong = cleanText(long);
ok('原文超过 300 字', long.length > 300, 'len=' + long.length);
ok('cleanText 截到 300 字', cleanLong.text.length === 300, 'len=' + cleanLong.text.length);
ok('cleanText 标记 truncated', cleanLong.truncated === true);

const r2 = await synthesize(long, { dataRoot: DATA_ROOT });
ok('超长文本不抛（拿到结果对象）', typeof r2 === 'object' && r2 !== null);
ok('超长文本 truncated === true', r2.truncated === true, JSON.stringify(r2).slice(0, 120));
ok('超长文本仍能出文件', r2.ok === true && existsSync(r2.path), r2.ok ? r2.path : r2.error);
if (r2.ok) {
  const sz2 = statSync(r2.path).size;
  ok('超长文本字节数 > 2000', sz2 > 2000, 'bytes=' + sz2);
  ok('超长文本时长比短句长', r2.ms > (r1.ok ? r1.ms : 0), `long=${r2.ms} short=${r1.ok ? r1.ms : 0}`);
  lastOk = r2;
}

console.log('[4] 音色切换（zh-CN-XiaoxiaoNeural）');
let r3 = await synthesize('饲养员，今天也要开心呀。', { dataRoot: DATA_ROOT, voice: 'zh-CN-XiaoxiaoNeural' });
if (!r3.ok) {
  await new Promise((r) => setTimeout(r, 900));
  r3 = await synthesize('饲养员，今天也要开心呀。', { dataRoot: DATA_ROOT, voice: 'zh-CN-XiaoxiaoNeural' });
}
ok('换音色 ok:true', r3.ok === true, r3.ok ? '' : r3.error);
if (r3.ok) {
  lastOk = r3;
  ok('音色回显 = XiaoxiaoNeural', r3.voice === 'zh-CN-XiaoxiaoNeural', r3.voice);
  ok('换音色也落盘 > 2000 字节', existsSync(r3.path) && statSync(r3.path).size > 2000);
  ok('两次合成不是同一个文件', r3.path !== (r1.ok ? r1.path : ''), r3.path);
}

console.log('[5] 失败路径：python 指到不存在的路径');
let threw2 = false;
let r4;
try {
  r4 = await synthesize('这句应该合成失败', {
    dataRoot: DATA_ROOT,
    pythonOverride: 'F:\\no-such-dir\\definitely-not-python.exe',
    timeoutMs: 5000,
  });
} catch (e) { threw2 = true; r4 = { ok: 'THREW', error: String(e) }; }
ok('不抛异常', threw2 === false);
ok('返回 ok:false', r4.ok === false, JSON.stringify(r4).slice(0, 160));
ok('带 error 文案', typeof r4.error === 'string' && r4.error.length > 0, String(r4.error));
console.log('    error = ' + r4.error);

console.log('[6] 清理：keep 上限生效');
const before = mp3s().length;
for (let i = 0; i < 3; i++) {
  const rc = await synthesize('清理测试' + i, { dataRoot: DATA_ROOT, keep: 3 });
  if (!rc.ok) console.log('    清理测试第 ' + i + ' 次失败: ' + rc.error);
}
const after = mp3s().length;
ok('keep:3 后目录里 mp3 ≤ 3', after <= 3, `before=${before} after=${after}`);
ok('清理后仍有可用音频', after >= 1);

console.log('[7] 收尾：正式合成一句留给交付');
const rFinal = await synthesize('咕噜噜，本鲸在呢。', { dataRoot: DATA_ROOT, keep: 30 });
ok('收尾合成 ok:true', rFinal.ok === true, rFinal.ok ? '' : rFinal.error);
if (rFinal.ok) {
  lastOk = rFinal;
  ok('收尾文件存在且 > 2000 字节', existsSync(rFinal.path) && statSync(rFinal.path).size > 2000);
}

console.log('');
console.log('PASS ' + pass + ' / FAIL ' + fail);
if (lastOk) console.log('last mp3: ' + lastOk.path + '  (' + lastOk.bytes + ' bytes, ~' + lastOk.ms + 'ms)');
process.exit(fail === 0 ? 0 : 1);
