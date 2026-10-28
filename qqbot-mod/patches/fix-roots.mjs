// fix-roots.mjs —— 浮窗群列表为空 / 群名变成人名的根因：这些路由拿 bot.cwd 当数据根，
//   实际数据在 {cwd}/dshqqbot/.qqbot（resolveMemoryRoot 才知道）。统一改成 resolveMemoryRoot。
// 用法：node qqbot-mod/patches/fix-roots.mjs [--check|--apply]
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const HOST = pluginPath('settings-host.js');
const OPS = [];

// ① group/accounts：群注册表 / 待审 / 表情包台账都从 bot.cwd 读 → 改成数据根
OPS.push({
  label: 'group/accounts 用数据根',
  old: `      const reg = readGroupsJson(bot.cwd);
      const pend = readPendingJson(bot.cwd);`,
  neu: `      const _qaRoot = (typeof resolveMemoryRoot === 'function') ? resolveMemoryRoot(bot) : bot.cwd;
      const reg = readGroupsJson(_qaRoot);
      const pend = readPendingJson(_qaRoot);`,
});
OPS.push({
  label: 'group/accounts 表情包台账用数据根',
  old: `        const store = getStickerStore(bot.cwd ? join(bot.cwd, '表情包') : undefined);`,
  neu: `        const store = getStickerStore(_qaRoot ? join(_qaRoot, '表情包') : undefined);`,
});

// ② contact 路由：群名优先用 groups.json，取不到就显示「群 xxxx」，别再把人名当群名
OPS.push({
  label: 'contact 群名兜底',
  old: `      try { gNames = JSON.parse(readFileSync(join(root, '.qqbot', 'groups.json'), 'utf8')) || {}; } catch { }`,
  neu: `      try { gNames = JSON.parse(readFileSync(join(root, '.qqbot', 'groups.json'), 'utf8')) || {}; } catch { }
      try {
        // [qqbot-mod] 群注册表可能被清空：从 msg-history 目录兜底补齐"有哪些群"
        const _mh = join(root, '.qqbot', 'msg-history');
        for (const d of readdirSync(_mh)) {
          const m = /^group_(.+)$/.exec(String(d));
          if (!m) continue;
          if (!gNames[m[1]]) gNames[m[1]] = { name: '', from: 'msg-history' };
        }
      } catch (e) {}`,
});

export {};
const mode = process.argv.includes('--apply') ? 'apply' : 'check';
announce('浮窗数据根修正');
let src = readFileSync(HOST, 'utf8');
const crlf = src.includes('\r\n');
src = src.replace(/\r\n/g, '\n');
let hit = 0;
const miss = [];
for (const op of OPS) {
  if (src.includes(op.neu)) { console.log('  = 已是新版：' + op.label); continue; }
  if (!src.includes(op.old)) { console.log('  ✗ 找不到锚点：' + op.label); miss.push(op.label); continue; }
  src = src.replace(op.old, op.neu); hit++; console.log('  ✔ ' + op.label);
}
if (!hit) { console.log(miss.length ? '有锚点没命中' : '无需写入'); process.exit(miss.length ? 2 : 0); }
if (mode === 'check') { console.log(`\n[--check] ${hit} 处需要写入（加 --apply 生效）`); process.exit(0); }
copyFileSync(HOST, HOST + '.orig-muu-roots');
writeFileSync(HOST, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');
try {
  execFileSync(process.execPath, ['--check', HOST], { stdio: 'pipe' });
  console.log(`\n✔ 已写入 ${HOST}（${src.length} 字符，语法通过）`);
} catch (e) {
  copyFileSync(HOST + '.orig-muu-roots', HOST);
  console.log('✗ 语法检查失败，已回滚：' + String(e.stderr || e.message).slice(0, 300));
  process.exit(3);
}
