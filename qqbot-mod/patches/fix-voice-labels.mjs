// 给浮窗音色下拉补「类型 · 大小」，并确保差音色已移除（2026-10-24）
// 用法：node fix-voice-labels.mjs --check | --apply
import fs from 'node:fs';

import { pluginPath } from './plugin-dir.mjs';
const P = pluginPath('settings-host.js');
const OLD = [
  "['zh-CN-XiaoxiaoNeural', '晓晓 · 女 · 温柔 · edge 在线']",
  "['zh-CN-XiaoyiNeural', '小艺 · 女 · 活泼 · edge 在线']",
  "['zh-CN-XiaochenNeural', '晓辰 · 女 · 慵懒 · edge 在线']",
  "['zh-CN-YunjianNeural', '云健 · 男 · 沉稳/硬气 · edge 在线']",
];
const NEW = [
  "['zh-CN-XiaoxiaoNeural', '晓晓 · 女 · 温柔 · edge 在线 · 0MB']",
  "['zh-CN-XiaoyiNeural', '小艺 · 女 · 活泼 · edge 在线 · 0MB']",
  "['zh-CN-XiaochenNeural', '晓辰 · 女 · 慵懒 · edge 在线 · 0MB']",
  "['zh-CN-YunjianNeural', '云健 · 男 · 沉稳/硬气 · edge 在线 · 0MB']",
];
const mode = process.argv.includes('--apply') ? 'apply' : 'check';
let src = fs.readFileSync(P, 'utf8');
let applied = 0, missing = 0;
for (let i = 0; i < OLD.length; i++) {
  if (src.includes(OLD[i])) { src = src.split(OLD[i]).join(NEW[i]); applied++; }
  else if (src.includes(NEW[i])) { applied++; }
  else missing++;
}
console.log(mode === 'apply' ? 'apply' : 'check', 'applied', applied, 'missing', missing);
if (mode === 'apply' && applied) {
  const bak = P + '.orig-voicelabels';
  if (!fs.existsSync(bak)) fs.copyFileSync(P, bak);
  fs.writeFileSync(P, src, 'utf8');
  console.log('written', P, 'bytes', src.length);
}
if (missing) process.exitCode = 1;
