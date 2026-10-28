/**
 * fix-session-rescue2.mjs — 把 resume 重试窗口拉长，少轮换（少开新会话）
 *
 * `fix-session-rescue.mjs` 里的阶梯是 `[250, 800]` 毫秒两次重试，太短：
 * 宿主里那条会话可能正在被 web 端/上一轮 agent 占着，1 秒内还没释放 ⇒ 直接 create
 * ⇒ 撞 `already exists` ⇒ 轮换新 id ⇒ **主人看到的就是"又开了一个新会话"**。
 * 这里改成 `[250, 1000, 2500]`，给足 3.75 秒让旧句柄释放。
 *
 *   node qqbot-mod/patches/fix-session-rescue2.mjs --check | --apply | --revert
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pluginPath } from './plugin-dir.mjs';

const FILE = pluginPath('dist/session/session-manager.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/session-manager.js.orig-rescue2';

const OLD = 'for (const waitMs of [250, 800])';
const NEW = 'for (const waitMs of [250, 1000, 2500])';

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--revert')
    ? 'revert'
    : 'check';

let src = readFileSync(FILE, 'utf8');
const has = src.includes(NEW);
const can = src.includes(OLD);

if (mode === 'check') {
  console.log('目标文件: ' + FILE);
  console.log((has ? '= 已应用' : can ? '+ 可打' : '! 未匹配') + '  RESCUE2');
  process.exit(has || can ? 0 : 1);
}

if (mode === 'revert') {
  if (!has) {
    console.log('= 没有可回滚的改动');
    process.exit(0);
  }
  writeFileSync(FILE, src.split(NEW).join(OLD), 'utf8');
  console.log('✓ 已回滚 RESCUE2');
  process.exit(0);
}

if (has) {
  console.log('= 已应用，无需重复');
  process.exit(0);
}
if (!can) {
  console.log('! 未匹配：找不到 `for (const waitMs of [250, 800])`（先跑 fix-session-rescue.mjs）');
  process.exit(1);
}
if (!existsSync(BAK)) writeFileSync(BAK, src, 'utf8');
src = src.split(OLD).join(NEW);
writeFileSync(FILE, src, 'utf8');
const after = readFileSync(FILE, 'utf8');
console.log('✓ RESCUE2：' + (after.includes(NEW) ? '读回一致' : '读回不一致！'));
process.exit(after.includes(NEW) ? 0 : 1);
