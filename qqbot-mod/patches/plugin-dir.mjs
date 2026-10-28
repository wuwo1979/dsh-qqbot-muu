/**
 * plugin-dir.mjs — 一处解析"真正在跑的" qqbot 插件目录
 *
 * 血泪教训（2026-10-22）：这台机器上有**两套 profile**：
 *   ① C:\Users\Administrator\AppData\Roaming\dsh-desktop\harness\profiles\web\...   ← 桌面端真正在跑的（DSH_HOME 指这里）
 *   ② C:\Users\Administrator\.dsh\profiles\web\...                                 ← 老的/残留的，不跑
 * 我一开始只看到 ②，把补丁全打在了死副本上，验证当然"全绿"，线上一点变化都没有。
 *
 * 血泪教训 2（2026-10-25）：桌面端的插件市场会**自动升级并生成新的 generation**：
 *   profiles/.generations/live/zaofan+dsh-qqbot+<版本>+<hash>/node_modules/@zaofan/dsh-qqbot
 * 升级一次，旧 generation 里打好的补丁就**全部作废**（新目录是干净的官方文件）。
 *   实测 16:57 插件从 1.10.22 自动升到 1.10.39，浮窗的「记忆」页/主题/聊天补全当场全没了。
 * 所以现在解析顺序是：**最新的 generation → profiles/web 可见副本**，并且把挑中的路径打印出来。
 * 补丁脚本一律走本文件，不许再硬编码路径 —— 否则升级后又会"打在死副本上"。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const APPDATA = process.env.APPDATA || (HOME ? join(HOME, 'AppData', 'Roaming') : '');
const HARNESS = APPDATA ? join(APPDATA, 'dsh-desktop', 'harness') : '';
const REL = 'node_modules/@zaofan/dsh-qqbot';

/** 版本号比较（1.10.39 > 1.10.22） */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => Number(x.replace(/\D.*$/, '')) || 0);
  const pb = String(b).split('.').map((x) => Number(x.replace(/\D.*$/, '')) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 列出所有 generation 里的 qqbot 插件目录，按版本从新到旧 */
function generationDirs() {
  const root = HARNESS ? join(HARNESS, 'profiles', '.generations', 'live') : '';
  if (!root || !existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const m = name.match(/^zaofan\+dsh-qqbot\+([^+]+)\+/);
    if (!m) continue;
    const dir = join(root, name, REL);
    if (!existsSync(join(dir, 'package.json'))) continue;
    out.push({ version: m[1], dir, name, mtime: statSync(dir).mtimeMs });
  }
  out.sort((a, b) => cmpVersion(b.version, a.version) || b.mtime - a.mtime);
  return out;
}

const CANDS = [
  process.env.QQBOT_PLUGIN_DIR || '',
  (generationDirs()[0] || {}).dir || '',
  HARNESS ? join(HARNESS, 'profiles', 'web', REL) : '',
  HOME ? join(HOME, '.dsh', 'profiles', 'web', REL) : '',
].filter(Boolean);

export const PLUGIN = CANDS.find((p) => existsSync(p)) || CANDS[0] || '';

/** 是不是活跃实例（harness 下、且是 generation 里的那份） */
export const IS_LIVE = PLUGIN.includes('dsh-desktop') || PLUGIN.includes('.generations');

/** 当前 generation 的名字（日志里一眼看出打的是不是升级后的新目录） */
export const GENERATION = (() => {
  const m = String(PLUGIN).match(/\.generations[\\/]live[\\/]([^\\/]+)/);
  return m ? m[1] : '';
})();

export function pluginPath(rel) {
  return PLUGIN.replace(/\/+$/, '') + '/' + String(rel).replace(/^\/+/, '');
}

/** 打印一行"我正在改哪个"，方便一眼看出有没有打错 */
export function announce(label = 'plugin') {
  console.log(`[${label}] 目标插件目录: ${PLUGIN}`);
  if (GENERATION) console.log(`  ✔ generation: ${GENERATION}`);
  if (!IS_LIVE) {
    console.log('  ⚠️ 这不是桌面端正在跑的那套（harness）—— 改它线上不会有任何变化。');
  }
}
