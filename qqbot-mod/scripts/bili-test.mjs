#!/usr/bin/env node
/**
 * bili-test.mjs — B 站能力的离线/半离线自检
 *
 * 覆盖：未登录话术（不误写失效标记）/ 扫码二维码生成与轮询 /
 *       Cookie 存取 / 失效标记 / 评论每日额度提前拦截。
 * 真正的读动态/发评论需要主人扫码，无法在无人值守测试里自动完成。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-bili';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, '.qqbot'), { recursive: true });
process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;

const TOOL = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/bili.mjs';
const API = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/bili-api.mjs';

let pass = 0, fail = 0;
const ok = (s) => { pass += 1; console.log('  PASS  ' + s); };
const bad = (s) => { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; };
const chk = (c, s) => (c ? ok(s) : bad(s));

const t = (await import(TOOL)).default;
const B = await import(API);
const env = { logger: { info() {}, warn() {}, debug() {} } };
const flag = path.join(ROOT, '.qqbot', 'bili-login-lost.flag');

console.log('\n[1] 未登录');
{
  const s = await t.run({ action: 'status' }, env);
  chk(s.ok && /未登录/.test(s.msg), 'status 明确说未登录');
  const d = await t.run({ action: 'dynamics' }, env);
  chk(!d.ok && /还没登录/.test(d.msg), '读动态提示先扫码');
  chk(!fs.existsSync(flag) || fs.readFileSync(flag, 'utf8').trim() === '', '未登录不误写“登录失效”标记');
}

console.log('\n[2] 扫码');
{
  const g = await t.run({ action: 'login_start' }, { ...env, caps: { scope: 'group:g1' } });
  chk(!g.ok && /私聊/.test(g.msg), '群聊拒绝生成二维码（谁扫谁登录）');
  const q = await t.run({ action: 'login_start' }, env);
  chk(q.ok && /MEDIA:image\|https:/.test(q.msg), '生成二维码图片链接');
  chk(/只发给主人/.test(q.msg), '提醒二维码不要发群');
  const p = await t.run({ action: 'login_poll' }, env);
  chk(p.ok && /还没扫码|已扫码/.test(p.msg), `轮询返回合理状态（${p.msg}）`);
}

console.log('\n[3] Cookie / 失效标记');
{
  chk(B.saveCookie(ROOT, { SESSDATA: 'fake', bili_jct: 'x', DedeUserID: '1' }), 'Cookie 写入成功');
  const c = B.loadCookie(ROOT);
  chk(c && c.cookies.SESSDATA === 'fake', 'Cookie 读回一致');
  const nav = await B.nav(ROOT);
  chk(!nav.ok && nav.needLogin, '假 Cookie 被识别为需要重新登录');
}

console.log('\n[4] 评论额度');
{
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(ROOT, '.qqbot', 'bili-comment-count.json'), JSON.stringify({ date: today, n: 5 }), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'bili-config.json'), JSON.stringify({ enabled: true, comment: { dailyLimit: 5 } }), 'utf8');
  const r = await t.run({ action: 'comment', bvid: 'BV1xx411c7mD', message: '测试' }, env);
  chk(!r.ok && /额度已用完/.test(r.msg), '额度用完时在请求视频前就拦住');
}

console.log('\n[5] 未知动作');
{
  const r = await t.run({ action: 'nope' }, env);
  chk(!r.ok && /未知 action/.test(r.msg), '未知动作返回清单而不是抛错');
}

console.log(`\n结论：${pass} 通过 / ${fail} 失败`);
