#!/usr/bin/env node
/**
 * fix-panel-v5.mjs —— 边栏「QQ 机器人扩展」报「推不出 dataRoot（还没绑过机器人？）」
 *
 * 根因：resolveDataRootForWorkspace()/resolveContextlessDataRoot() 只读 profile 的
 *       cordis.patch.yml 里的 bot cfg；而 cwd/appSecret 早已搬进插件自有存储
 *       （mergeOwnIntoCfg），patch 里没有 cwd/dataRoot → 推出来是空 → 面板 500。
 *       另：带 ?cwd= 时能推出来，说明只是"无 cwd 兜底"这一条挂了。
 *
 * 修法：两条兜底都补上 nsBot('im-qqbot') 的合并配置（自有存储优先）。
 *
 * 用法：node qqbot-mod/patches/fix-panel-v5.mjs --check | --apply
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath } from './plugin-dir.mjs';

const HOST = pluginPath('settings-host.js');
const MARK = '[qqbot-mod] panel-v5';

const ops = [
  {
    label: 'contextless-fallback',
    run: (s) => {
      const old = `    } catch { /* 推不出来就交给 ensurePath 兜底 */ }
    return '';
  }`;
      const neu = `    } catch { /* 推不出来就交给 ensurePath 兜底 */ }
    // ${MARK} patch 里没有 cwd/dataRoot（早在 2026-09-24 就搬进插件自有存储了）时，
    // 用 nsBot 合并自有存储后的 dataRoot 兜底——否则边栏扩展面板会报「还没绑过机器人？」。
    try {
      const b = nsBot('im-qqbot');
      if (b && b.cfg && b.cfg.dataRoot) return String(b.cfg.dataRoot);
    } catch { /* ignore */ }
    return '';
  }`;
      if (s.includes(MARK + ' patch 里没有')) return { ok: true, skipped: true };
      if (!s.includes(old)) return { ok: false, why: '找不到锚点 resolveContextlessDataRoot 尾部' };
      return { ok: true, src: s.replace(old, neu) };
    },
  },
  {
    label: 'workspace-default-fallback',
    run: (s) => {
      const old = `    return { dataRoot: resolveContextlessDataRoot(), source: 'default' };
  }`;
      const neu = `    // ${MARK} 无 cwd 且 patch 里没配置时，仍优先 nsBot 的合并配置
    try {
      const b = nsBot('im-qqbot');
      if (b && b.cfg && b.cfg.dataRoot) return { dataRoot: String(b.cfg.dataRoot), source: 'bot.merged' };
    } catch { /* ignore */ }
    return { dataRoot: resolveContextlessDataRoot(), source: 'default' };
  }`;
      if (s.includes(MARK + ' 无 cwd 且 patch')) return { ok: true, skipped: true };
      if (!s.includes(old)) return { ok: false, why: '找不到锚点 resolveDataRootForWorkspace 尾部' };
      return { ok: true, src: s.replace(old, neu) };
    },
  },
];

const apply = process.argv.includes('--apply');
const raw = readFileSync(HOST, 'utf8');
let s = raw.replace(/\r\n/g, '\n');
let pending = 0;
console.log('[fix-panel-v5] ' + HOST);
for (const op of ops) {
  const r = op.run(s);
  if (r.ok && r.skipped) { console.log('  = ' + op.label + '：已是新版'); continue; }
  if (!r.ok) { console.log('  ✗ ' + op.label + '：' + r.why); process.exitCode = 1; continue; }
  s = r.src;
  pending += 1;
  console.log('  ✔ ' + op.label);
}
if (pending && apply) {
  copyFileSync(HOST, HOST + '.orig-muu');
  writeFileSync(HOST, s.replace(/\n/g, '\r\n'), 'utf8');
  try {
    execFileSync(process.execPath, ['--check', HOST], { stdio: 'pipe' });
    console.log('  ✔ 语法检查通过');
  } catch (e) {
    copyFileSync(HOST + '.orig-muu', HOST);
    console.error('  ✗ 语法失败已回滚：' + String(e.stderr || e.message));
    process.exit(4);
  }
}
if (!apply) console.log(pending ? '--check：需要写入 ' + pending + ' 处' : '--check：已是新版');
