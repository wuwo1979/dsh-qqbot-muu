#!/usr/bin/env node
/**
 * text-video-test.mjs — 文字动效视频自检
 *
 * 不联网、不占显存：真实调用 .venv-draw 的 PIL 渲染 0.8 秒帧；
 * 如果本机没有 python/Pillow 就只测降级路径（不误报失败）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let ROOT = 'F:/qqbot/qqbot-mod/.devdata-textvideo';
// 目录里帧数一多，宿主沙箱的批量删除护栏会拦 rmSync。拦了就换一个全新的目录，
// 不要沿用它——里面的旧帧会让"帧数/时长"这类断言算错。
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { ROOT += '-t' + Date.now().toString(36); }
fs.mkdirSync(ROOT, { recursive: true });

const TV_URL = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/text-video.mjs';
const TV = await import(TV_URL);

let pass = 0;
let fail = 0;
const ok = (s) => { pass += 1; console.log('  PASS  ' + s); };
const bad = (s) => { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; };
const chk = (c, s) => (c ? ok(s) : bad(s));

const PY = 'F:/qqbot/.venv-draw/Scripts/python.exe';
const cfg = { pythonBin: fs.existsSync(PY) ? PY : 'python' };

// 用 PIL 量像素：文字安全区这类"视觉约束"只有真的看图才能断言
const pyScript = (code, args = []) => {
  const r = spawnSync(cfg.pythonBin, ['-c', code, ...args], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
};

console.log('\n[1] 环境探测');
{
  chk(TV.defaultScriptPath().endsWith(path.join('qqbot-mod', 'scripts', 'text_render.py')), '默认渲染脚本路径正确');
  chk(TV.resolvePython(cfg) === cfg.pythonBin, '解释器复用 draw-config 的 pythonBin');
  const av = await TV.available(cfg);
  chk(av.ok, 'python + Pillow + 脚本可用' + (av.ok ? '' : '（' + av.reason + '）'));
  const av2 = await TV.available(cfg);
  chk(av2.ok === av.ok, '探测结果有缓存（第二次同结果）');
}

console.log('\n[2] 参数校验');
{
  const r1 = await TV.renderFrames({ outDir: path.join(ROOT, 'a'), text: '   ', durationSec: 1, ...cfg });
  chk(!r1.ok && r1.reason === 'empty-text', '空文案被拒');
  const r2 = await TV.renderFrames({ text: 'x', durationSec: 1, ...cfg });
  chk(!r2.ok && r2.reason === 'no-outdir', '缺输出目录被拒');
  const r3 = await TV.renderFrames({ outDir: path.join(ROOT, 'b'), text: 'x', textScript: path.join(ROOT, 'nope.py'), ...cfg });
  chk(!r3.ok && /no-script/.test(r3.reason), '脚本不存在时明确失败（不回退到空帧）');
}

console.log('\n[3] 真渲染（0.8 秒 / 8fps）');
{
  const av = await TV.available(cfg);
  if (!av.ok) {
    console.log('  SKIP  本机没有 python/Pillow，跳过真渲染');
  } else {
    const outDir = path.join(ROOT, 'frames');
    const r = await TV.renderFrames({
      outDir,
      text: '深海里的鲸鱼娘，今天讲一个关于光的冷知识。\n第二行用来验证换行和打字机。',
      title: '鲸鱼娘 · 冷知识',
      width: 640,
      height: 360,
      fps: 8,
      durationSec: 0.8,
      style: 'typewriter',
      seed: 7,
      ...cfg,
    });
    chk(r.ok, 'renderFrames 成功' + (r.ok ? '' : '：' + r.reason));
    chk(r.frames >= 6, '帧数 = 时长×fps（' + r.frames + '）');
    chk(r.width === 640 && r.height === 360, '尺寸按配置生效');
    chk(fs.existsSync(path.join(outDir, '0001.png')), '首帧存在');
    chk(fs.existsSync(path.join(outDir, String(r.frames).padStart(4, '0') + '.png')), '末帧存在');
    const j = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'));
    chk(j.ok === true && j.style === 'typewriter', 'result.json 是唯一结果通道');
    const png = fs.readFileSync(path.join(outDir, '0001.png'));
    chk(png.length > 2000 && png.slice(1, 4).toString() === 'PNG', '帧是合法 PNG');
    chk(TV.firstFrame(outDir).endsWith('0001.png'), 'firstFrame 可用于封面/剪映素材');
    chk(TV.firstFrame(path.join(ROOT, 'nope')) === '', '没有帧时 firstFrame 返回空');

    // 另两种风格各渲一帧量级，确认分支不炸
    for (const style of ['code', 'fade']) {
      const d2 = path.join(ROOT, 'style-' + style);
      const r2 = await TV.renderFrames({ outDir: d2, text: 'const whale = "深海";', width: 480, height: 270, fps: 8, durationSec: 0.5, style, ...cfg });
      chk(r2.ok && fs.existsSync(path.join(d2, '0001.png')), style + ' 风格可渲染');
    }
  }
}

console.log('\n[4] 角色安全区（文字不许压到小蓝身上）');
{
  const av = await TV.available(cfg);
  if (!av.ok) {
    console.log('  SKIP  本机没有 python/Pillow，跳过');
  } else {
    // 造两帧纯色角色：颜色不同，顺便用来判断当前取的是第几帧
    const charDir = path.join(ROOT, 'char');
    fs.mkdirSync(charDir, { recursive: true });
    const mk = spawnSync(PY, ['-c', `
import sys
from PIL import Image, ImageDraw
for i, c in enumerate([(200, 40, 40, 255), (40, 40, 200, 255)]):
    im = Image.new('RGBA', (120, 160), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle([20, 20, 100, 150], fill=c)
    im.save(sys.argv[1] + '/%04d.png' % i)
`, charDir], { encoding: 'utf8' });
    chk(mk.status === 0, '假角色帧生成成功');
    // fps=1：offset 差 1 秒就整整差一帧，取帧对错一眼可判
    fs.writeFileSync(path.join(charDir, 'result.json'), JSON.stringify({ ok: true, frames: 2, fps: 1, duration: 2 }));

    const W = 640;
    const H = 360;
    const SIZE = 150;
    const charLeft = W - SIZE - Math.round(W * 0.02);
    const long = '她叫小蓝，住在海沟的第三条裂缝里，每天做的事只有一件：把沉下来的话捡起来，洗干净，再放回去。';

    const oSafe = path.join(ROOT, 'safe');
    const rs = await TV.renderFrames({
      outDir: oSafe, text: long, width: W, height: H, fps: 8, durationSec: 1,
      style: 'typewriter', charDir, charSize: SIZE, ...cfg,
    });
    chk(rs.ok, '带角色渲染成功' + (rs.ok ? '' : '：' + rs.reason));
    const ink = JSON.parse(pyScript(`
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
W, H = im.size
px = im.load()
lo, hi = int(H * 0.30), int(H * 0.75)
cols = []
for x in range(W):
    hit = False
    for y in range(lo, hi):
        r, g, b = px[x, y]
        if r > 150 and g > 150 and b > 150:
            hit = True
            break
    if hit:
        cols.append(x)
print(json.dumps({'l': min(cols) if cols else -1, 'r': max(cols) if cols else -1}))
`, [path.join(oSafe, '0008.png')]) || '{}');
    chk(ink.l > 0, '能测到正文墨迹（l=' + ink.l + ', r=' + ink.r + '）');
    chk(ink.r > 0 && ink.r < charLeft - 2, '正文右端不越过角色左边界（' + ink.r + ' < ' + charLeft + '）');
    chk(ink.l > 0 && ink.l >= Math.round(W * 0.085) - 4, '正文左端不越出安全区（' + ink.l + '）');

    // 同一段文案不带角色时应当居中占满更宽的区域——否则说明安全区根本没参与排版
    const oFull = path.join(ROOT, 'full');
    await TV.renderFrames({ outDir: oFull, text: long, width: W, height: H, fps: 8, durationSec: 1, style: 'typewriter', ...cfg });
    const ink2 = JSON.parse(pyScript(`
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
W, H = im.size
px = im.load()
lo, hi = int(H * 0.30), int(H * 0.75)
cols = []
for x in range(W):
    for y in range(lo, hi):
        r, g, b = px[x, y]
        if r > 150 and g > 150 and b > 150:
            cols.append(x)
            break
print(json.dumps({'l': min(cols) if cols else -1, 'r': max(cols) if cols else -1}))
`, [path.join(oFull, '0008.png')]) || '{}');
    chk(ink2.r > ink.r + 20, '没有角色时正文用得上更宽的空间（' + ink2.r + ' > ' + ink.r + '）');
  }
}

console.log('\n[5] 角色时间线按全片对齐（charOffset）');
{
  const av = await TV.available(cfg);
  const charDir = path.join(ROOT, 'char');
  if (!av.ok || !fs.existsSync(path.join(charDir, 'result.json'))) {
    console.log('  SKIP  本机没有 python/Pillow，跳过');
  } else {
    const W = 640;
    const H = 360;
    const SIZE = 150;
    const probe = [W - SIZE - Math.round(W * 0.02) + 75, H - Math.round(150 * 160 / 120) - Math.round(H * 0.02) + 100];
    const runOne = async (offset) => {
      const d = path.join(ROOT, 'off-' + offset);
      const r = await TV.renderFrames({
        outDir: d, text: '光早就放弃了。', width: W, height: H, fps: 8, durationSec: 0.5,
        style: 'typewriter', charDir, charSize: SIZE, charOffset: offset, ...cfg,
      });
      if (!r.ok) return null;
      return pyScript(`
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
print(json.dumps(list(im.getpixel((int(sys.argv[2]), int(sys.argv[3]))))))
`, [path.join(d, '0001.png'), String(probe[0]), String(probe[1])]);
    };
    const c0 = JSON.parse((await runOne(0)) || 'null');
    const c1 = JSON.parse((await runOne(1)) || 'null');
    chk(!!c0 && !!c1, '两次偏移都渲染成功');
    if (c0 && c1) {
      chk(c0[0] > c0[2] && c0[0] > 150, 'offset=0 → 取第 1 帧（偏红 ' + c0.join(',') + '）');
      chk(c1[2] > c1[0] && c1[2] > 150, 'offset=1 → 取第 2 帧（偏蓝 ' + c1.join(',') + '）');
    }
  }
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nPASS ${pass} / FAIL ${fail}`);
console.log(`结论：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
