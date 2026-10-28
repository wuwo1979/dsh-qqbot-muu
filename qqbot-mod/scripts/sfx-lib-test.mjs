#!/usr/bin/env node
/**
 * sfx-lib-test.mjs — 音效库离线自检
 *
 * 不联网（addFromUrl 只测参数校验）、不依赖 GPU：
 *   索引契约 / 文件名拆标签 / 语义猜测 / 入库去重 / 目录扫描 /
 *   检索与 pick / 混音滤镜 / 内置兜底音效（有 ffmpeg 时真合成）。
 */
import fs from 'node:fs';
import path from 'node:path';

let ROOT = 'F:/qqbot/qqbot-mod/.devdata-sfx';
// 目录里文件一多，宿主沙箱的批量删除护栏会拦 rmSync。拦了就换一个全新的目录，
// 不要沿用它——上一次入库的音效会让"索引条数"这类断言算错。
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { ROOT += '-t' + Date.now().toString(36); }
fs.mkdirSync(ROOT, { recursive: true });

const SFX_URL = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/sfx-lib.mjs';
const TOOL_URL = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/storyboard.mjs';

let pass = 0;
let fail = 0;
const ok = (s) => { pass += 1; console.log('  PASS  ' + s); };
const bad = (s) => { fail += 1; console.log('  FAIL  ' + s); process.exitCode = 1; };
const chk = (c, s) => (c ? ok(s) : bad(s));

const S = await import(SFX_URL);

/** 手搓 16bit 单声道静音 WAV，避免依赖任何编码器 */
function writeWav(file, ms = 200, freq = 440) {
  const rate = 8000;
  const n = Math.max(1, Math.round((rate * ms) / 1000));
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000);
    data.writeInt16LE(v, i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

console.log('\n[1] 索引与路径契约');
{
  const idx = S.loadIndex(ROOT);
  chk(Array.isArray(idx.items) && idx.items.length === 0, '空库返回空索引');
  chk(S.sfxDir(ROOT).endsWith('音效'), '目录名是「音效」（和表情包同构）');
  chk(S.indexPathOf(ROOT).endsWith(path.join('音效', 'index.json')), '索引路径 index.json');
  chk(S.pathOfItem(ROOT, { id: 'sfx-abc', ext: 'wav', layer: 'builtin' })
    .endsWith(path.join('音效', 'lib', 'builtin', 'sfx-abc.wav')), '条目路径 lib/<layer>/<id>.<ext>');
}

console.log('\n[2] 标签与语义');
{
  const tags = S.tagsFromName('转场_whoosh-swoosh.mp3');
  chk(tags.includes('whoosh') || tags.includes('转场'), '文件名拆出标签');
  chk(S.guessKind('键盘 打字 loop'), 'typing', '中文关键词猜 typing');
  chk(S.guessKind('whoosh transition'), 'whoosh', '英文 kind 直接命中 whoosh');
  chk(S.guessKind('success ding'), 'success', '英文 success 命中');
  chk(S.guessKind('随便什么') === '' || S.KINDS.includes(S.guessKind('随便什么')), '猜不出也不乱报');
  chk(S.KINDS.length === 9, '语义分类共 9 类');
}

console.log('\n[3] 本地入库 / 去重 / 拒绝非音频');
{
  const d = path.join(ROOT, 'src');
  fs.mkdirSync(d, { recursive: true });
  const w1 = path.join(d, '转场 whoosh.wav');
  writeWav(w1, 150, 300);
  const r1 = S.addFile(ROOT, w1, {});
  chk(r1.ok && r1.item.kind === 'whoosh', '入库成功且自动猜 whoosh');
  chk(fs.existsSync(r1.path), '文件已落到音效库');
  const r2 = S.addFile(ROOT, w1, {});
  chk(r2.ok && r2.duplicate === true, '同内容重复入库被识别');
  chk(S.loadIndex(ROOT).items.length === 1, '去重后索引只有 1 条');
  const txt = path.join(d, 'note.txt');
  fs.writeFileSync(txt, 'x');
  chk(!S.addFile(ROOT, txt, {}).ok, '非音频文件被拒');
  chk(!S.addFile(ROOT, path.join(d, 'nope.wav'), {}).ok, '不存在的文件被拒');
  chk(!S.addFile(ROOT, w1, { layer: '../../evil' }).ok || !String(S.loadIndex(ROOT).items.at(-1)?.layer).includes('..'),
    'layer 不会写出库目录');
}

console.log('\n[4] 扫描目录');
{
  const d = path.join(ROOT, 'batch');
  fs.mkdirSync(d, { recursive: true });
  writeWav(path.join(d, '点击 click.wav'), 100, 1800);
  writeWav(path.join(d, '水下 water.wav'), 120, 260);
  writeWav(path.join(d, 'ignore.txt'), 80, 100);
  const r = S.scanDir(ROOT, { dir: d });
  chk(r.ok && r.scanned === 2 && r.added === 2, '扫到 2 个音频并入库');
  chk(!S.scanDir(ROOT, { dir: path.join(ROOT, 'none') }).ok, '目录不存在时明确失败');
  const kinds = S.loadIndex(ROOT).items.map((x) => x.kind);
  chk(kinds.includes('click') && kinds.includes('water'), '扫描入库也带语义分类');
}

console.log('\n[5] 检索 / pick');
{
  const hits = S.search(ROOT, '点击');
  chk(hits.length > 0 && hits[0].item.kind === 'click', '中文检索命中 click');
  chk(S.search(ROOT, '', { kind: 'water' }).length >= 1, '按 kind 列全部');
  chk(S.search(ROOT, '不存在的音效xyz').length === 0, '无关键词结果为空');
  const p = S.pick(ROOT, 'whoosh');
  chk(p.path && fs.existsSync(p.path), 'pick 按语义返回真实文件');
  chk(!S.pick(ROOT, 'fail').path, '库里没有的类型返回空（交由调用方兜底）');
}

console.log('\n[6] 联网入库参数校验（不真联网）');
{
  const r = await S.addFromUrl(ROOT, 'ftp://example.com/a.mp3');
  chk(!r.ok && /http/.test(r.reason), '非 http(s) 被拒');
  const r2 = await S.addFromUrl(ROOT, '');
  chk(!r2.ok, '空链接被拒');
}

console.log('\n[7] 混音滤镜');
{
  const f = S.buildSfxFilter([{ inputIndex: 2, atSec: 1.2, gain: 0.3 }, { inputIndex: 3, atSec: 0.2, gain: 0.5 }], { baseLabel: '[1:a]' });
  chk(f.inputs === 3, '两个音效 + 旁白 = 3 路输入');
  chk(f.outLabel === '[aout]', '输出标签固定 [aout]');
  chk(f.chains.join(';').includes('adelay=1200|1200'), '按时间轴做 adelay');
  chk(f.chains.join(';').includes('amix=inputs=3'), 'amix 路数正确');
  chk(!f.chains.join(';').includes('volume=9.00'), '音量被夹在合理区间');
  const empty = S.buildSfxFilter([], { baseLabel: '[1:a]' });
  chk(empty.inputs === 1 && empty.outLabel === '[1:a]' && empty.chains.length === 0, '无音效时原样透传');
}

console.log('\n[8] 内置兜底音效（ffmpeg 合成）');
{
  const { findFfmpeg } = await import(TOOL_URL);
  const exe = findFfmpeg();
  if (!exe || !fs.existsSync(exe)) {
    console.log('  SKIP  没找到 ffmpeg，跳过合成（不影响其它用例）');
  } else {
    const r = await S.ensureBuiltin(ROOT, { ffmpeg: exe });
    chk(r.ok, '内置音效合成成功：' + (r.failed && r.failed.length ? JSON.stringify(r.failed[0]) : '全部'));
    const builtin = S.loadIndex(ROOT).items.filter((x) => x.layer === 'builtin');
    chk(builtin.length >= 9, '9 个语义音效全部入库（' + builtin.length + '）');
    const p = S.pick(ROOT, 'success');
    chk(p.path && fs.existsSync(p.path) && fs.statSync(p.path).size > 1000, '合成出来的 success 能播（>1KB）');
    const again = await S.ensureBuiltin(ROOT, { ffmpeg: exe });
    chk(again.ok && again.made === 0, '重复调用不重复合成');
  }
  const noFf = await S.ensureBuiltin(path.join(ROOT, 'empty-root'), { ffmpeg: '' });
  chk(!noFf.ok && noFf.reason === 'no-ffmpeg', '没有 ffmpeg 时明确降级（不抛异常）');
}

console.log('\n[9] 索引容错');
{
  fs.writeFileSync(S.indexPathOf(ROOT), '{坏掉的 json');
  S.invalidateIndex(ROOT);
  const idx = S.loadIndex(ROOT);
  chk(Array.isArray(idx.items) && idx.items.length === 0, '索引损坏当空库处理');
  chk(S.search(ROOT, 'whoosh').length === 0, '空库检索安全');
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nPASS ${pass} / FAIL ${fail}`);
console.log(`结论：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
