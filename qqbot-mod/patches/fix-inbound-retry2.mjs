/**
 * fix-inbound-retry2.mjs — 兜底的"换会话重开"再收一层：先普通重试，最后才轮换
 *
 * 现状（`fix-inbound-retry.mjs` 打的）：getOrCreate 一抛错就 `forceNew: true`，等于
 * **每抛一次就新开一个 DSH 会话**（旧上下文全丢，侧边栏还多一条）。
 * 新的 session-manager 已经有了"复用活 agent → 250/1000/2500ms 重试 resume"的阶梯，
 * 真正抛到这里已经很罕见；再给它两次**普通**重试的机会，最后才轮换。
 *
 *   node qqbot-mod/patches/fix-inbound-retry2.mjs --check | --apply | --revert
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pluginPath } from './plugin-dir.mjs';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;
const FILE = pluginPath('dist/transport/inbound.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/inbound.js.orig-retry2';

const OLD = [
  '        try {',
  '            record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget, { forceNew: true });',
  '            logger.warn(`getOrCreate 自愈成功(已轮换 sessionId 重开): ${_msg1}`);',
  '        }',
  '        catch (err2) {',
  '            logger.error(`ERROR creating session (重试也失败, 这条只能丢): ${err2 instanceof Error ? err2.message : String(err2)}`);',
  '            return;',
  '        }',
].join(EOL);

const NEW = [
  '        // [qqbot-mod] retry2 —— 先普通重试两次（不换 id、不丢历史），最后才 forceNew',
  '        let _ok = false;',
  '        for (const _wait of [300, 700]) {',
  '            try {',
  '                await new Promise((r) => setTimeout(r, _wait));',
  '                record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);',
  '                logger.warn(`getOrCreate 第 ${_wait}ms 普通重试成功（会话没换）: ${_msg1}`);',
  '                _ok = true;',
  '                break;',
  '            }',
  '            catch (_e) {',
  '                logger.warn(`getOrCreate 第 ${_wait}ms 普通重试仍失败: ${_e instanceof Error ? _e.message : String(_e)}`);',
  '            }',
  '        }',
  '        if (!_ok) {',
  '            try {',
  '                record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget, { forceNew: true });',
  '                logger.warn(`getOrCreate 自愈成功(最后手段：已轮换 sessionId 重开): ${_msg1}`);',
  '            }',
  '            catch (err2) {',
  '                logger.error(`ERROR creating session (重试也失败, 这条只能丢): ${err2 instanceof Error ? err2.message : String(err2)}`);',
  '                return;',
  '            }',
  '        }',
].join(EOL);

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--revert')
    ? 'revert'
    : 'check';

let src = readFileSync(FILE, 'utf8');
const has = src.includes('[qqbot-mod] retry2');
const can = src.includes(OLD);

if (mode === 'check') {
  console.log('目标文件: ' + FILE);
  console.log((has ? '= 已应用' : can ? '+ 可打' : '! 未匹配') + '  RETRY2');
  process.exit(has || can ? 0 : 1);
}

if (mode === 'revert') {
  if (!has) {
    console.log('= 没有可回滚的改动');
    process.exit(0);
  }
  src = src.split(NEW).join(OLD);
  writeFileSync(FILE, src, 'utf8');
  console.log('✓ 已回滚 RETRY2');
  process.exit(0);
}

if (has) {
  console.log('= 已应用，无需重复');
  process.exit(0);
}
if (!can) {
  console.log('! 未匹配：找不到原来的 forceNew 兜底块（先跑 fix-inbound-retry.mjs）');
  process.exit(1);
}
if (!existsSync(BAK)) writeFileSync(BAK, src, 'utf8');
src = src.split(OLD).join(NEW);
writeFileSync(FILE, src, 'utf8');
const after = readFileSync(FILE, 'utf8');
console.log('✓ RETRY2：' + (after.includes('[qqbot-mod] retry2') ? '读回一致' : '读回不一致！'));
process.exit(after.includes('[qqbot-mod] retry2') ? 0 : 1);
