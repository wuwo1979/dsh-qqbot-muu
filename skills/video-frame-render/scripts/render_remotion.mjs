#!/usr/bin/env node
/**
 * render_remotion.mjs — 路子 D · Remotion 立绘动画（2026-10-31 新增）
 *
 * 用 DSH 自带的 Remotion runtime（AppData\dsh-desktop\harness\data\dsh-remotion\runtime）
 * 把 v1 立绘做成程序化动作视频：
 *   · 桌宠用：透明 webm（VP8+alpha），直接落 pet/xiaolan-animation/ 即生效；
 *   · 短视频用：不透明 mp4（spec.bg 给底色/渐变时）。
 * 画风零风险：整图变换（呼吸/浮动/弹性/摇摆），不重绘不拆图层。
 *
 * 用法（在仓库根 F:\qqbot 下跑，cwd 必须有 package.json —— Remotion 浏览器缓存
 * 按 cwd/package.json 定位下载到 <cwd>/node_modules/.remotion）：
 *
 *   node skills/video-frame-render/scripts/render_remotion.mjs --spec tmp/pet.json
 *
 * spec 字段：
 *   image     旧版单图模式（与新 poses 二选一），立绘绝对路径
 *   poses     v3 多姿势模式：{ idle, wave, happy, point, talk } → 各姿势绝对路径
 *             （RGBA 透明底 png，由 scripts/make_alpha.py 从 v2 白底 jpg 抠出）
 *   motion    动作 key，见 remotion/PetAnim.jsx MOTIONS：
 *             idle-cute / wave-hello / happy-jump / talk-babble / point-out / lift-dangle
 *             （旧 key idle-breathe/sway/talk-nod 等已由 v3 取代，传旧 key 自动回退 idle-cute）
 *   out       必填，输出路径（.webm=透明 / .mp4=不透明）
 *   seconds   时长秒（循环动作建议取周期整数倍：breathe 3s、float 4s、sway 2.5s、nod 1.5s）
 *   fps       默认 30
 *   width/height  默认 720/980（v1 立绘尺寸）
 *   shadow    默认 true，脚下接地阴影（浮得越高越小越淡）
 *   bg        底色/渐变（mp4 用；空=透明，webm 桌宠保持空）
 *
 * 退出码：0 成功；2 用法/环境问题；其他=渲染失败（看 stderr）。
 * 环境自检：node scripts/render_remotion.mjs --check
 */
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))); // F:\qqbot
const TEMPLATE_DIR = join(REPO, 'skills', 'video-frame-render', 'remotion');
const RUNTIME_NM = join(
  process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'dsh-desktop', 'harness', 'data', 'dsh-remotion', 'runtime', 'node_modules',
);

function die(code, msg) {
  console.error(`[remotion] ${msg}`);
  process.exit(code);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : '';
}

// ── 环境自检 ───────────────────────────────────────────────────────────
if (process.argv.includes('--check')) {
  const rows = {
    'remotion runtime (node_modules)': existsSync(join(RUNTIME_NM, 'remotion', 'package.json')),
    '@remotion/bundler': existsSync(join(RUNTIME_NM, '@remotion', 'bundler', 'package.json')),
    '@remotion/renderer': existsSync(join(RUNTIME_NM, '@remotion', 'renderer', 'package.json')),
    '模板工程 remotion/index.jsx': existsSync(join(TEMPLATE_DIR, 'index.jsx')),
    'node_modules junction 已接': existsSync(join(TEMPLATE_DIR, 'node_modules', 'remotion')),
    'cwd 有 package.json（浏览器缓存落这里）': existsSync(join(process.cwd(), 'package.json')),
  };
  for (const [k, v] of Object.entries(rows)) console.log(`  ${v ? '✔' : '✘'} ${k}`);
  console.log(`  runtime: ${RUNTIME_NM}`);
  process.exit(Object.values(rows).every(Boolean) ? 0 : 2);
}

// ── junction：模板工程 → runtime node_modules（react/esbuild 可 resolve）──
const nmLink = join(TEMPLATE_DIR, 'node_modules');
if (!existsSync(join(nmLink, 'remotion'))) {
  try {
    mkdirSync(TEMPLATE_DIR, { recursive: true });
    symlinkSync(RUNTIME_NM, nmLink, 'junction');
    console.log('[remotion] 已创建 node_modules junction → dsh-remotion runtime');
  } catch (e) {
    die(2, `建 junction 失败（${e.message}）。手动执行：cmd /c mklink /J "${nmLink}" "${RUNTIME_NM}"`);
  }
}

const specPath = argValue('--spec');
if (!specPath) die(2, '用法：node render_remotion.mjs --spec <spec.json>（cwd 需在 F:\\qqbot）');
const absSpec = resolve(specPath);
let spec;
try {
  spec = JSON.parse(readFileSync(absSpec, 'utf8'));
} catch (e) {
  die(2, `spec JSON 读不了：${e.message}`);
}
if (!spec.image && !spec.poses) die(2, 'spec 缺 image / poses（v3 建议传 poses 五姿势）');
if (spec.image && !existsSync(spec.image)) die(2, `立绘不存在：${spec.image}`);
for (const [k, v] of Object.entries(spec.poses || {})) {
  if (!existsSync(v)) die(2, `姿势 ${k} 不存在：${v}`);
}
if (!existsSync(join(process.cwd(), 'package.json'))) {
  die(2, '请在仓库根（有 package.json 的目录）运行：浏览器缓存按 cwd 定位，落别处会撞 dsh-remotion 的只读 ACL');
}

const outAbs = resolve(spec.out);
mkdirSync(dirname(outAbs), { recursive: true });
const isWebm = outAbs.toLowerCase().endsWith('.webm');
const log = (s) => console.log(`[remotion] ${s}`);

// 浏览器优先用本机 Chrome/Edge（Remotion 官方下载源在国内常卡死，本机 Chromium 内核即可用）
function findLocalBrowser() {
  if (spec.browserExecutable) return spec.browserExecutable;
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return cands.find((p) => existsSync(p)) || null;
}
const browserExecutable = findLocalBrowser();
if (browserExecutable) log(`浏览器：本机 ${browserExecutable}`);
else log('浏览器：未找到本机 Chrome/Edge，将用 Remotion 官方 chrome-headless-shell（下载慢请耐心）');

// ── 动态 require dsh-remotion runtime 的包（版本统一 4.0.532）──────────
const requireFrom = createRequire(pathToFileURL(join(RUNTIME_NM, 'remotion', 'package.json')));
let bundle, selectComposition, renderMedia, ensureBrowser;
try {
  bundle = requireFrom('@remotion/bundler').bundle;
  const renderer = requireFrom('@remotion/renderer');
  selectComposition = renderer.selectComposition;
  renderMedia = renderer.renderMedia;
  ensureBrowser = renderer.ensureBrowser;
} catch (e) {
  die(2, `加载 dsh-remotion runtime 失败：${e.message}`);
}

const t0 = Date.now();

// 浏览器（本机 Chrome/Edge 优先；否则下载 chrome-headless-shell ~150MB 到 <cwd>/node_modules/.remotion）
try {
  await ensureBrowser(browserExecutable ? { browserExecutable } : {});
} catch (e) {
  die(2, `浏览器准备失败：${e.message}`);
}
log(`浏览器就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const inputProps = {
  motion: spec.motion || 'idle-breathe',
  width: spec.width || 720,
  height: spec.height || 980,
  fps: spec.fps || 30,
  seconds: spec.seconds || 3,
  shadow: spec.shadow !== false,
  bg: spec.bg || '',
  fit: spec.fit > 0 ? spec.fit : 1, // [pet-v3.2] 角色安全缩放（防举手出框）
};

// 立绘拷进 bundle 的 public/：http 页面直接加载 file:// 会被 Chromium 拦死（delayRender 永不 resolve）
const publicDir = join(TEMPLATE_DIR, 'public');
mkdirSync(publicDir, { recursive: true });
if (spec.poses) {
  // v3：五个姿势各拷一份（换文件名防旧缓存串图）
  inputProps.poses = {};
  for (const [name, p] of Object.entries(spec.poses)) {
    const ext = (extname(p) || '.png').toLowerCase();
    copyFileSync(p, join(publicDir, `pose-${name}${ext}`));
    inputProps.poses[name] = `/pose-${name}${ext}`;
  }
} else {
  const imgExt = (extname(spec.image) || '.png').toLowerCase();
  copyFileSync(spec.image, join(publicDir, 'input' + imgExt));
  inputProps.image = '/input' + imgExt;
}

log('bundling…');
// 注意：旧式签名 bundle(entry, onProgressFn, opts) —— 第二参必须是回调或省略，不能放 options
const serveUrl = await bundle(join(TEMPLATE_DIR, 'index.jsx'));
log(`serveUrl: ${serveUrl}`);

const composition = await selectComposition({
  serveUrl,
  id: 'PetAnim',
  inputProps,
});
log(`组合 ${composition.width}x${composition.height} @${composition.fps} × ${composition.durationInFrames} 帧`);

const transparent = isWebm && !spec.bg;
await renderMedia({
  composition,
  serveUrl,
  // 2026-10-31：透明 webm 用 vp9（与旧版桌宠 webm 一致；vp8 的 alpha 后处理链在三把 ffmpeg 上都解不出来）
  codec: isWebm ? 'vp9' : 'h264',
  // 透明 webm 必须：pixelFormat yuva420p + PNG 中间帧（这版 Remotion 不会因 transparent 自动切）
  ...(transparent ? { transparent: true, pixelFormat: 'yuva420p', imageFormat: 'png' } : {}),
  outputLocation: outAbs,
  inputProps,
  browserExecutable: browserExecutable || undefined,
  onProgress: ({ progress }) => {
    if (Math.round(progress * 100) % 20 === 0) log(`渲染 ${Math.round(progress * 100)}%`);
  },
});

const kb = Math.round(statSync(outAbs).size / 1024);
log(`完成 → ${outAbs}（${kb} KB，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
