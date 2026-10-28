#!/usr/bin/env node
/**
 * fix-panel-v4.mjs —— 「打开产物目录」把目录里有多少项也带回来（空目录要说清是空的）
 *
 * 用法：node qqbot-mod/patches/fix-panel-v4.mjs --check | --apply
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath } from './plugin-dir.mjs';

const HOST = pluginPath('settings-host.js');
const CLIENT = pluginPath('client/qqbot-settings.js');
const MARK = '[[qqbot-mod] panel-v4]';

const ops = [
  {
    file: HOST, label: 'host-open-dir-count',
    run: (s) => {
      const old = `          const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
          c.on?.('error', () => { });
          c.unref();
          return writeJson(res, 200, { ok: true, path: abs, via: cmd, msg: '已打开 ' + abs });`;
      const neu = `          const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
          c.on?.('error', () => { });
          c.unref();
          // ${MARK} 顺手数一下目录里有几项：空目录要明说，别让人以为"打不开"
          let _cnt = -1;
          try { _cnt = readdirSync(abs).length } catch { }
          return writeJson(res, 200, { ok: true, path: abs, via: cmd, count: _cnt, msg: '已打开（' + _cnt + ' 项）' });`;
      if (s.includes(MARK)) return { ok: true, skipped: true };
      if (!s.includes(old)) return { ok: false, why: '找不到锚点' };
      return { ok: true, src: s.replace(old, neu) };
    },
  },
  {
    file: CLIENT, label: 'client-open-dir-count',
    run: (s) => {
      const old = `            var okText = (r && r.ok) ? ('已打开（' + ((r && r.via) || 'explorer') + '）') : ('没弹出来：' + ((r && r.error) || '未知原因'))`;
      const neu = `            var cnt = (r && typeof r.count === 'number') ? r.count : -1
            var cntText = cnt < 0 ? '项数未知' : (cnt === 0 ? '空目录：还没渲染过视频' : cnt + ' 项')
            var okText = (r && r.ok) ? ('已打开（' + ((r && r.via) || 'explorer') + '，' + cntText + '）') : ('没弹出来：' + ((r && r.error) || '未知原因'))`;
      if (s.includes('var cntText = cnt < 0')) return { ok: true, skipped: true };
      if (!s.includes(old)) return { ok: false, why: '找不到锚点' };
      return { ok: true, src: s.replace(old, neu) };
    },
  },
];

const apply = process.argv.includes('--apply');
let pending = 0;

for (const file of [HOST, CLIENT]) {
  const raw = readFileSync(file, 'utf8');
  let s = raw.replace(/\r\n/g, '\n');
  const fileOps = ops.filter((o) => o.file === file);
  if (!fileOps.length) continue;
  console.log('[fix-panel-v4] ' + file);
  for (const op of fileOps) {
    const r = op.run(s);
    if (r.ok && r.skipped) { console.log('  = ' + op.label + '：已是新版'); continue; }
    if (!r.ok) { console.log('  ✗ ' + op.label + '：' + r.why); process.exitCode = 1; continue; }
    s = r.src;
    pending += 1;
    console.log('  ✔ ' + op.label);
  }
  if (s !== raw.replace(/\r\n/g, '\n') && apply) {
    copyFileSync(file, file + '.orig-muu');
    writeFileSync(file, s.replace(/\n/g, '\r\n'), 'utf8');
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      console.log('  ✔ 语法检查通过');
    } catch (e) {
      copyFileSync(file + '.orig-muu', file);
      console.error('  ✗ 语法失败已回滚：' + String(e.stderr || e.message));
      process.exit(4);
    }
  }
}

if (!apply) console.log((pending ? '--check：需要写入 ' + pending + ' 处（加 --apply 落盘）' : '--check：已是新版，无需写入'));
