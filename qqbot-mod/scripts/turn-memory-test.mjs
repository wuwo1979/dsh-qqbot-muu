/**
 * turn-memory-test.mjs — 「她自己说过的话进记忆库」验收
 *
 * 用假出站 ctx（phase='turnEnd'）跑 outbound/turn-memory.mjs，
 * 验证：什么时候记、记成什么 kind、重复不重复记、脏内容不记。
 *
 * 跑法：node qqbot-mod/scripts/turn-memory-test.mjs
 */
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = 'F:\\qqbot\\qqbot-mod\\.devdata-turnmem';
process.env.QQBOT_MEMORY_DATA_ROOT = DATA_ROOT;
// 干净开跑，免得上一次的数据影响计数。
// ★ 必须连 .qqbot-extensions 一起清：那里放着 memory-config.json，上一轮若留下
//   captureSelf:false，本轮的写入会被整体关掉，症状是 9 条断言集体失败。
try { if (existsSync(DATA_ROOT)) rmSync(DATA_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
mkdirSync(join(DATA_ROOT, '.qqbot-extensions'), { recursive: true });

const mem = await import('../../dshqqbot/.qqbot-extensions/lib/memory.mjs');
const mod = await import('../../dshqqbot/.qqbot-extensions/outbound/turn-memory.mjs');
const onOutbound = mod.onOutbound || mod.default;

let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass += 1; console.log('  PASS  ' + n + (extra ? '  ' + extra : '')); }
  else { fail += 1; console.log('  FAIL  ' + n + (extra ? '  ' + extra : '')); }
};

function makeCtx(text, opts = {}) {
  const state = { nextCalls: 0 };
  const ctx = {
    text,
    kind: 'text',
    isLastChunk: true,
    phase: opts.phase || 'turnEnd',
    // 真机出站 ctx 给的是 targetId（peerId 只存在于旧文档/旧测试桩）
    target: opts.targetId
      ? { scope: opts.scope || 'group', targetId: opts.targetId }
      : { scope: opts.scope || 'group', peerId: opts.peerId || 'GROUPTEST' },
    dataRoot: DATA_ROOT,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    async sendMedia() { return true; },
    async send() { return true; },
  };
  const next = async () => { state.nextCalls += 1; };
  return { ctx, state, next };
}

const cfg = mem.loadConfig(DATA_ROOT);
const scope = 'group:GROUPTEST';
// ★ listAll 的真实签名是 (dataRoot, { limit, scopeFilter })。
//   早先按 (root, scope, opts) 传，第二个参数被当成 options 对象，永远拿不到该 scope 的数据。
const list = () => mem.listAll(DATA_ROOT, { limit: 50, scopeFilter: scope });

console.log('数据根 ' + DATA_ROOT + '  后端 ' + (mem.backendName || '?'));

// 1. 回合收尾才记
{
  const a = makeCtx('本鲸今天教你钓鱼吧，人类要好好学哦。', { phase: 'send' });
  await onOutbound(a.ctx, a.next);
  ok('非 turnEnd 不记', list().length === 0, 'next=' + a.state.nextCalls);
}
{
  const a = makeCtx('本鲸今天教你钓鱼吧，人类要好好学哦。');
  await onOutbound(a.ctx, a.next);
  ok('turnEnd 记下来', list().length === 1);
  ok('正文照常放行', a.state.nextCalls === 1);
}
{
  const one = list()[0];
  ok('kind = promise（含"教你"）', one && one.kind === 'promise', one && one.kind);
  ok('subj = 小蓝', one && one.subj === '小蓝', one && one.subj);
}
// 1.5 真机 target 是 { scope, targetId }：也必须能拼出 scope（2026-10-23 真机踩到）
{
  // 用 c2c 作用域，避免 scopeFilter 前缀（group:GROUPTEST）把新用例也算进去
  const a = makeCtx('本鲸答应你明天带伞，一定不会忘。', { scope: 'c2c', targetId: 'UID9' });
  await onOutbound(a.ctx, a.next);
  const rows2 = mem.listAll(DATA_ROOT, { limit: 50, scopeFilter: 'c2c:UID9' });
  ok('targetId 形态能落库', rows2.length === 1, '现在 ' + rows2.length + ' 条');
}

// 2. 重复不重复记（去重交给记忆库）
{
  const a = makeCtx('本鲸今天教你钓鱼吧，人类要好好学哦。');
  await onOutbound(a.ctx, a.next);
  ok('同一句不会重复记', list().length === 1, '现在 ' + list().length + ' 条');
}

// 3. 太短 / 纯媒体不记
{
  const a = makeCtx('好呀');
  await onOutbound(a.ctx, a.next);
  const b = makeCtx('[MEDIA:image|D:/x.png]');
  await onOutbound(b.ctx, b.next);
  const c = makeCtx('![图](D:/x.png)');
  await onOutbound(c.ctx, c.next);
  ok('短句/纯媒体不记', list().length === 1, '现在 ' + list().length + ' 条');
}

// 4. 普通话记为 say
{
  const a = makeCtx('海里今天有点冷，本鲸不想动。');
  await onOutbound(a.ctx, a.next);
  const kinds = list().map((m) => m.kind);
  ok('普通话记为 say', kinds.includes('say'), kinds.join(','));
}

// 5. 私聊作用域
{
  const a = makeCtx('人类你怎么还不睡觉呀，都快三点了。', { scope: 'c2c', peerId: 'USERX' });
  await onOutbound(a.ctx, a.next);
  ok('私聊写进 c2c: 作用域', mem.listAll(DATA_ROOT, { limit: 5, scopeFilter: 'c2c:USERX' }).length === 1);
}

// 6. 记忆被召回（模拟下一条消息问"你说过啥"）
{
  // 线上默认 recallMinCos=0.45；"你还记得你说过要教我什么吗" 与原文是复述关系，
  // bge 给 0.415，比阈值略低。这里放到 0.3 只为验"写进去的东西召回得到"这条链路。
  const hits = await mem.recall(DATA_ROOT, scope, '你还记得你说过要教我什么吗', { ...cfg, recallMinCos: 0.3 });
  ok('她说过的话能被召回', Array.isArray(hits) && hits.some((h) => /钓鱼/.test(h.text)), (hits || []).map((h) => String(h.text).slice(0, 10)).join(' | '));
}

// 7. 开关
{
  // 记忆库没有 saveConfig —— 直接改配置文件（这才是线上真正读的那份）
  const cfgPath = join(DATA_ROOT, '.qqbot-extensions', 'memory-config.json');
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, captureSelf: false }, null, 2), 'utf8');
  const before = list().length;
  const a = makeCtx('这句话按理不该被记下来，因为开关关了。');
  await onOutbound(a.ctx, a.next);
  ok('captureSelf=false 时不记', list().length === before, before + ' -> ' + list().length);
  // ★ 无条件删掉，不做"备份-还原"：上一轮如果被中断（或两个测试进程并发跑到这里），
  //   备份里本身就已经是 captureSelf:false，"还原"等于把污染永久固化下来 ——
  //   症状是这个测试**第一次通过、之后永远失败**。这个目录整个属于本测试，删干净才对。
  rmSync(cfgPath, { force: true });
}

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
