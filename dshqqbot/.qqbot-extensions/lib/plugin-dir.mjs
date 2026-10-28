// plugin-dir.mjs —— 找到"真正在跑"的 @zaofan/dsh-qqbot 目录（2026-10-25 修）
//
// 背景：桌面端 1.10.39 起把插件装在
//   <APPDATA>/dsh-desktop/harness/profiles/.generations/live/zaofan+dsh-qqbot+<ver>+<hash>/node_modules/@zaofan/dsh-qqbot
// 而扩展里原来只写死 `profiles/web/node_modules/...`。插件升级后老目录消失，
// 这些写死路径就指向不存在的地方 —— 表现是本地向量模型加载不了、退回别的模型，
// 还很难看出原因（不报错，只是"变笨了"）。
//
// 这里按与 qqbot-mod/patches/plugin-dir.mjs 同样的顺序找：
//   QQBOT_PLUGIN_DIR → 环境 DSH_HOME → 最新 generation → profiles/web → ~/.dsh
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PKG = join('node_modules', '@zaofan', 'dsh-qqbot');

function versionOf(name) {
  const m = /^zaofan\+dsh-qqbot\+(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function harnessRoots() {
  const out = [];
  const appData = process.env.APPDATA || '';
  if (appData) out.push(join(appData, 'dsh-desktop', 'harness'));
  const dshHome = String(process.env.DSH_HOME || '').trim();
  if (dshHome) out.push(dshHome);
  out.push(join(homedir(), '.dsh'));
  return [...new Set(out)];
}

/** 列 generation 目录，最新的在前 */
export function generationDirs() {
  const out = [];
  for (const root of harnessRoots()) {
    const live = join(root, 'profiles', '.generations', 'live');
    if (!existsSync(live)) continue;
    let names = [];
    try { names = readdirSync(live); } catch { continue; }
    const gens = names
      .filter((n) => n.startsWith('zaofan+dsh-qqbot+'))
      .map((n) => ({ n, v: versionOf(n), p: join(live, n, PKG) }))
      .sort((a, b) => cmpVer(b.v, a.v));
    for (const g of gens) if (existsSync(join(g.p, 'dist', 'features', 'local-embed.js'))) out.push(g.p);
  }
  return out;
}

/** 返回可用于 import 的插件目录（找不到时返回空字符串） */
export function findPluginDir() {
  const env = String(process.env.QQBOT_PLUGIN_DIR || '').trim();
  const cands = [
    env,
    ...generationDirs(),
    ...harnessRoots().flatMap((r) => [
      join(r, 'profiles', 'web', PKG),
      join(r, PKG),
    ]),
    join('C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/web', PKG),
  ].filter(Boolean);
  for (const p of cands) {
    try { if (existsSync(join(p, 'dist', 'features', 'local-embed.js'))) return String(p).replace(/\\/g, '/'); } catch { /* 下一个 */ }
  }
  return '';
}

export default { findPluginDir, generationDirs };
