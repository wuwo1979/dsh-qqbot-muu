#!/usr/bin/env node
/**
 * video-pipeline-test.mjs — 分镜编排 + 出图质检自检（真跑，不是推演）
 *
 * 覆盖：planStoryboard（节拍分配/真图额度/重复画面降级/转场/音效/时长体检）
 *       image-gate（清晰度/色彩/熵/色数指标、坏图、跨屏查重）
 *       drawGated（两次不合格 → 第三次合格才收；全废 → ok:false 让上层退回文字）
 */
const fs = await import('node:fs');
const path = await import('node:path');

const LIB = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/';
const SP = await import(LIB + 'shot-planner.mjs');
const IG = await import(LIB + 'image-gate.mjs');

let pass = 0;
let fail = 0;
const ok = (s) => { pass += 1; console.log('  PASS  ' + s); };
const bad = (s) => { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; };
const chk = (c, s) => (c ? ok(s) : bad(s));
const info = (s) => console.log('        ' + s);
const head = (s) => console.log('\n[' + s + ']');

const PY = 'F:/qqbot/.venv-draw/Scripts/python.exe';
const DEV = 'F:/qqbot/qqbot-mod/.devdata';

head('分镜编排：5 屏');
const script = {
  title: '深海里的鲸鱼娘',
  panels: [
    { narration: '你有没有想过，深海里其实一直在下雨？', imagePrompt: 'whale girl underwater, deep blue, bubbles, cinematic' },
    { narration: '海洋学家把它叫做"海雪"，是浮游生物的碎屑在往下沉。', imagePrompt: 'marine snow particles falling in dark water' },
    { narration: '但真正离谱的是：这些东西一年能沉下几千米。', imagePrompt: 'marine snow particles falling in dark water' },
    { narration: '它们把二氧化碳一起带到海底，一待就是几百年。', imagePrompt: 'deep sea floor, sediment, soft light' },
    { narration: '所以下次看到海，可以想想水底那场下了千年的雨。', imagePrompt: 'ocean surface at dusk, calm, wide shot' },
  ],
};
const plan = SP.planStoryboard(script, { imageProvider: 'cloud', maxImageShots: 2, shotMinSec: 2.4, shotMaxSec: 5.2 });
chk(plan.ok === true && plan.shots.length === 5, '5 屏全部编排出来');
info('节拍：' + plan.meta.beats.join(' → '));
chk(plan.meta.beats[0] === 'hook', '首屏是 hook');
chk(plan.meta.beats[plan.meta.beats.length - 1] === 'cta', '末屏是 cta');
chk(plan.meta.beats.includes('turn'), '中间有 turn（反差）');
chk(plan.meta.imageShots <= 2, '真图数量受额度限制（≤2）');
chk(plan.shots.filter((s) => s.mode === 'image').every((s) => s.beat === 'hook' || s.beat === 'proof'), '真图只出现在 hook/proof');
const dupShot = plan.shots[2];
chk(dupShot.mode === 'text', '与上一屏画面重复的那屏被降级成文字动效');
info('该屏 why：' + dupShot.why.join('；'));
chk(plan.shots.every((s) => s.textStyle || s.mode === 'image'), '文字屏都有动效样式');
chk(plan.shots[0].transition.type === 'cut', '首屏硬切（没有多余转场）');
chk(plan.shots.some((s) => s.sfx.some((x) => x.kind === 'whoosh' || x.kind === 'ambient')), '有转场/氛围音效提示');
chk(plan.meta.totalSec > 5 && plan.meta.totalSec < 90, '总时长在合理区间（' + plan.meta.totalSec + 's）');

head('分镜编排：8 屏 + 强制文字');
const longScript = {
  panels: Array.from({ length: 8 }, (_, i) => ({
    narration: `这是第${i + 1}句旁白，用来测试较长的脚本在八屏时是否还能保持节奏。`,
    imagePrompt: `scene number ${i + 1} of a whale girl in different rooms`,
  })),
};
const p8 = SP.planStoryboard(longScript, { imageProvider: 'local', maxImageShots: 1 });
chk(p8.shots.length === 8 && p8.meta.imageShots <= 1, '8 屏且真图只有 1 张（本地出图更保守）');
const pText = SP.planStoryboard(longScript, { preferText: true });
chk(pText.shots.every((s) => s.mode === 'text'), 'preferText 时全片文字动效');
chk(pText.issues.some((s) => /没有一张真图/.test(s)) === false, '强制文字不报"没有真图"的假告警');

head('分镜编排：异常输入');
const pShort = SP.planStoryboard({ panels: [{ narration: '只有一句' }] });
chk(pShort.ok === false, '少于 2 屏直接拒绝');
const pLong = SP.planStoryboard({ panels: [{ narration: '这是一句特别特别长的旁白用来触发时长告警'.repeat(6) }, { narration: '第二屏' }] });
chk(pLong.issues.some((x) => /超过单屏上限|拆/.test(x)), '过长旁白给出拆分建议');

head('出图质检：真实图');
const real = ['anim0.jpg', 'anim7.jpg', 'cloud-flux.jpg', 'f1.jpg'].map((f) => path.join(DEV, f)).filter((f) => fs.existsSync(f));
const g = await IG.gateImages(real, { pythonBin: PY, outFile: 'F:/qqbot/tmp/gate-test.json' });
chk(g.ok === true && g.items.length === real.length, '质检跑通（' + g.items.length + ' 张）');
chk(g.items.some((i) => i.usable), '至少一张合格');
info('分数：' + g.items.map((i) => `${path.basename(i.path)}=${i.score}`).join(' '));
chk(g.items.every((i) => typeof i.lap === 'number' && typeof i.dhash === 'string'), '每张都有清晰度与 dHash');

head('出图质检：坏图与查重');
const broken = path.join(DEV, 'no-such-image.jpg');
const gb = await IG.gateImages([broken], { pythonBin: PY, outFile: 'F:/qqbot/tmp/gate-broken.json' });
chk(gb.items.length === 1 && gb.items[0].ok === false, '坏图被明确判为不可用');
const base = g.items.map((i) => i.dhash);
const gd = await IG.gateImages([real[0]], { pythonBin: PY, baseline: base, outFile: 'F:/qqbot/tmp/gate-dup.json' });
const dupItem = gd.items[0];
chk((dupItem.issues || []).includes('duplicate'), '与已用图相同的画面被判重复');
chk(IG.hamming('0000000000000000', '000000000000000f') === 4, '汉明距离计算正确');

head('drawGated：重 roll 直到合格');
let calls = 0;
const fakeDraw = async (prompt, opt) => {
  calls += 1;
  const out = String(opt.out || '');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // 第 1 次给一张坏图（纯色块），第 2 次给真图
  if (calls === 1) {
    const PNG_FLAT = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    fs.writeFileSync(out, PNG_FLAT);
  } else {
    fs.copyFileSync(path.join(DEV, 'anim7.jpg'), out);
  }
  return { ok: true, path: out };
};
const gr = await IG.drawGated(fakeDraw, 'whale girl underwater', { width: 512, height: 512, out: 'F:/qqbot/tmp/gated.png' }, {
  attempts: 3,
  gate: { pythonBin: PY, outFile: 'F:/qqbot/tmp/gate-gated.json' },
  goodEnough: 0.99,
});
info('尝试次数：' + calls + '；结果：' + (gr.ok ? 'accepted score=' + gr.score : gr.reason));
chk(gr.ok === true, '坏图之后重 roll 拿到了可用图');
chk(calls >= 2, '确实重试过（不是一次就收）');
chk(Array.isArray(gr.tried) && gr.tried.length >= 2, '每次尝试都留了证据');

const allBad = await IG.drawGated(async (p, o) => {
  const out = String(o.out || '');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.alloc(0));
  return { ok: true, path: out };
}, 'x', { out: 'F:/qqbot/tmp/bad.png' }, { attempts: 2, gate: { pythonBin: PY, outFile: 'F:/qqbot/tmp/gate-bad.json' } });
chk(allBad.ok === false, '全废时返回 ok:false（上层可退回文字动效）');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
