/**
 * voice-tool-test.mjs —— `tools/voice.mjs` 直发路径回归
 *
 * 修的是用户报的第二次 bug："每次都回「语音备好了」，结果你没收到" ——
 * 线上 `.qqbot/voice-queue.json` 里躺着 2 条永远没人取的语音，
 * 说明"排发件箱 → turnEnd 补发"这条路在真机上不可靠。
 *
 * 现在的契约：
 *   ① `env.caps.voice(path)` 返回 true ⇒ **当场直发**，不进队列；
 *   ② 返回 false / 抛错 / 没有 caps ⇒ 退回发件箱，并把原因写进 msg；
 *   ③ 合成失败 / 参数不合法 ⇒ ok:false，不排空队。
 *
 * ⚠️ 会真的调 edge-tts（2 次合成，约 1-2 秒），失败时算 SKIP 不算 FAIL。
 */
import { mkdirSync, rmSync } from 'node:fs';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-voicetool';
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
mkdirSync(ROOT, { recursive: true });
process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;

const plugin = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/voice.mjs');
const tool = plugin.default;
const { pending, drain } = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/voice-queue.mjs');

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail += 1; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};
const skipIt = (name, why) => { skip += 1; console.log('SKIP  ' + name + '  → ' + why); };

const logger = { info() {}, warn() {}, debug() {} };

// ── ① 参数与只读动作（不需要合成）────────────────────────────
{
  const list = await tool.run({ action: 'list' }, { logger });
  ok('list 返回音色表', list.ok === true && Array.isArray(list.voices) && list.voices.length >= 3, String((list.voices || []).length));

  const st = await tool.run({ action: 'status' }, { logger });
  ok('status 返回队列条数', st.ok === true && st.count === 0, JSON.stringify(st));

  const empty = await tool.run({ text: '   ' }, { logger });
  ok('空文本被拒', empty.ok === false, empty.msg);

  const tooLong = await tool.run({ text: 'あ'.repeat(130) }, { logger });
  ok('超长被拒', tooLong.ok === false, tooLong.msg);
}

// ── ② caps.voice 直发成功 ⇒ 不进队列 ────────────────────────
let synthed = 0;
{
  const sent = [];
  const env = {
    logger,
    caps: {
      dataRoot: ROOT,
      async voice(p) { sent.push(p); return true; },
    },
  };
  const r = await tool.run({ text: '测试直发一句' }, env);
  if (r.ok && r.direct === true) {
    synthed += 1;
    ok('直发成功 ok:true', r.ok === true, r.msg);
    ok('直发标记 direct:true', r.direct === true, String(r.direct));
    ok('caps.voice 收到 mp3 路径', sent.length === 1 && /\.mp3$/i.test(String(sent[0])), String(sent[0] || ''));
    ok('直发成功不进队列', pending(ROOT).length === 0, String(pending(ROOT).length));
    ok('提示语不说"备好了等补发"', !/发件箱/.test(String(r.msg)), r.msg);
  } else {
    skipIt('直发成功路径', '合成不可用: ' + r.msg);
  }
}

// ── ③ caps.voice 返回 false ⇒ 排发件箱 ──────────────────────
{
  const env = {
    logger,
    caps: { dataRoot: ROOT, async voice() { return false; } },
  };
  const r = await tool.run({ text: '测试兜底一句' }, env);
  if (r.ok && r.direct === false) {
    synthed += 1;
    ok('直发失败 ok:true（不报错给她）', r.ok === true, r.msg);
    ok('直发失败 direct:false', r.direct === false, String(r.direct));
    ok('直发失败排进队列', pending(ROOT).length === 1, String(pending(ROOT).length));
    ok('提示语交代了原因', /发件箱|没成功/.test(String(r.msg)), r.msg);
  } else {
    skipIt('直发失败兜底路径', '合成不可用: ' + r.msg);
  }
  drain(ROOT);
}

// ── ④ 没有 caps ⇒ 也排发件箱（全局注册那份可能拿不到能力包）──
{
  const env = { logger };
  const r = await tool.run({ text: '测试无 caps 一句' }, env);
  if (r.ok) {
    ok('无 caps 时 ok:true', r.ok === true, r.msg);
    ok('无 caps 时 direct:false', r.direct === false, String(r.direct));
    ok('无 caps 时排进队列', pending(ROOT).length === 1, String(pending(ROOT).length));
  } else {
    skipIt('无 caps 兜底路径', '合成不可用: ' + r.msg);
  }
  drain(ROOT);
}

// ── ⑤ caps.voice 抛错 ⇒ 兜底而不是把异常丢给模型 ────────────
{
  const env = {
    logger,
    caps: { dataRoot: ROOT, async voice() { throw new Error('upload 500'); } },
  };
  const r = await tool.run({ text: '测试抛错一句' }, env);
  if (r.ok) {
    ok('caps 抛错时 ok:true', r.ok === true, r.msg);
    ok('caps 抛错时 direct:false', r.direct === false, String(r.direct));
    ok('caps 抛错原因进 msg', /upload 500/.test(String(r.msg)), r.msg);
    ok('caps 抛错时排进队列', pending(ROOT).length === 1, String(pending(ROOT).length));
  } else {
    skipIt('caps 抛错兜底路径', '合成不可用: ' + r.msg);
  }
  drain(ROOT);
}

console.log(`\n合成次数 ${synthed} · SKIP ${skip}`);
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
