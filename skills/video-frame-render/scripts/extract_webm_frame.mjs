#!/usr/bin/env node
/**
 * extract_webm_frame.mjs — 用 Remotion 从透明 webm 抽单帧 PNG（保 alpha）
 *
 * 为什么不用 ffmpeg：机器上三把 ffmpeg 都解不出 WebM VP8 的 alpha
 * （imageio 无 libvpx、Trae 缺 muxer、Remotion 内置的 libvpx 解出来 swscale 转换失败）。
 * 而 Remotion 的 compositor（Rust）渲染/抽帧原生支持 alpha —— 它自己就是这些
 * webm 的生产者。用 1 帧组合 + OffthreadVideo 走 compositor 抽帧，稳。
 *
 * 用法：cd F:\qqbot && node skills/video-frame-render/scripts/extract_webm_frame.mjs \
 *        --in <webm绝对路径> [--frame 0] --out <png绝对路径>
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeFileSync, rmSync, readdirSync } from 'node:fs';

const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const TEMPLATE_DIR = join(REPO, 'skills', 'video-frame-render', 'remotion');
const RUNTIME_NM = join(
  process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'dsh-desktop', 'harness', 'data', 'dsh-remotion', 'runtime', 'node_modules',
);

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : '';
}

const input = argValue('--in');
const out = argValue('--out');
const frameNo = Number(argValue('--frame') || 0);
if (!input || !out) {
  console.error('用法：--in <webm> --out <png> [--frame N]');
  process.exit(2);
}
if (!existsSync(input)) { console.error('webm 不存在: ' + input); process.exit(2); }

// ⓪ 探 webm 实际分辨率（组合尺寸要在写入口文件前确定）
const { execFileSync } = await import('node:child_process');
const ffprobe = join(RUNTIME_NM, '@remotion', 'compositor-win32-x64-msvc', 'ffprobe.exe');
let w = 640, h = 360;
try {
  const j = JSON.parse(execFileSync(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', input]).toString());
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (v) { w = Number(v.width) || w; h = Number(v.height) || h; }
} catch { /* 默认 640x360 */ }

// ① 动态生成组合文件（必须 registerRoot）
const entry = join(TEMPLATE_DIR, 'webm-still.jsx');
writeFileSync(entry, `import React from 'react';
import { OffthreadVideo, AbsoluteFill, staticFile, Sequence, Composition, registerRoot } from 'remotion';
const WebmStill = ({ video }) => (
  <AbsoluteFill style={{ background: 'transparent' }}>
    <Sequence from={-${frameNo}} durationInFrames={${frameNo + 2}}>
      <OffthreadVideo src={staticFile(video)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    </Sequence>
  </AbsoluteFill>
);
const RemotionRoot = () => (
  <Composition id="WebmStill" component={WebmStill} width={${w}} height={${h}} fps={30}
    durationInFrames={${frameNo + 2}} defaultProps={{ video: '/extract-src.webm' }} />
);
registerRoot(RemotionRoot);
`);

// ② webm 拷进 public/
const publicDir = join(TEMPLATE_DIR, 'public');
mkdirSync(publicDir, { recursive: true });
copyFileSync(input, join(publicDir, 'extract-src.webm'));

// ③ bundle + renderStill
const requireFrom = createRequire(pathToFileURL(join(RUNTIME_NM, 'remotion', 'package.json')));
const { bundle } = requireFrom('@remotion/bundler');
const renderer = requireFrom('@remotion/renderer');
const { renderStill, selectComposition, ensureBrowser } = renderer;

let browserExecutable = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p)) || undefined;
await ensureBrowser(browserExecutable ? { browserExecutable } : {}).catch(() => {});

const serveUrl = await bundle(entry);
mkdirSync(dirname(out), { recursive: true });
const composition = await selectComposition({
  serveUrl,
  id: 'WebmStill',
  inputProps: { video: '/extract-src.webm' },
});
await renderStill({
  composition,
  serveUrl,
  inputProps: { video: '/extract-src.webm' },
  frame: frameNo,
  imageFormat: 'png',
  output: out,
  browserExecutable,
});
console.log(`[webm-still] ${input} @frame${frameNo} → ${out}（${w}x${h}）`);
rmSync(entry, { force: true });
process.exit(0);
