/**
 * fix-inbound-retry.mjs —— 入站消息被静默丢弃的兜底（对着 harness.log 的实证）
 *
 * 现场（2026-10-23 08:25~08:33，每条消息一次）：
 *   error im-qqbot: ERROR creating session: session "2cb509e7-…" already exists
 * 代码路径：`dist/transport/inbound.js:246-252`
 *   record = await manager.getOrCreate(...)   // 里面 resume 失败 → 走 create
 *   catch (err) { logger.error(...); return; } // ← 整条消息就这么没了（连着用户的话一起）
 *
 * 成因：`dist/session/session-manager.js:685-703` 的 `catch { create(...) }` ——
 *   resume 失败的错误被**裸 catch 吞掉**，随后 create 撞上宿主里已存在的同 id 会话
 *   ⇒ 抛 "already exists" ⇒ 一路冒到 inbound.js ⇒ return。
 *
 * 修法（只改 inbound.js，最小侵入）：失败后用 `{ forceNew: true }` 再要一次 ——
 *   forceNew 会把该 peer 的 sessionId 轮换成全新随机 id，绕开"已存在"的坏档，
 *   代价是这段群聊历史另起一档（旧档原样保留可回看），换来的是**消息不再丢**。
 *
 * 用法：node fix-inbound-retry.mjs --check|--apply|--revert（apply 需 danger-full-access）
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;

import { PLUGIN } from './plugin-dir.mjs';
const FILE = join(PLUGIN, 'dist', 'transport', 'inbound.js');
const BACKUP_DIR = 'F:/qqbot/qqbot-mod/backups';
const BACKUP = join(BACKUP_DIR, 'inbound.js.orig-retry');

const mode = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--revert') ? 'revert'
    : 'check';

if (!existsSync(FILE)) {
  console.error('找不到 ' + FILE);
  process.exit(1);
}

const raw = readFileSync(FILE, 'utf8');
const src = raw.split(CR).join('').split(LF).join(EOL);

const OLD = [
  `    let record;`,
  `    try {`,
  `        record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);`,
  `    }`,
  `    catch (err) {`,
  `        logger.error(\`ERROR creating session: \${err instanceof Error ? err.message : String(err)}\`);`,
  `        return;`,
  `    }`,
].join(EOL);

const NEW = [
  `    let record;`,
  `    try {`,
  `        record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);`,
  `    }`,
  `    catch (err) {`,
  `        const _msg1 = err instanceof Error ? err.message : String(err);`,
  `        logger.error(\`ERROR creating session: \${_msg1}\`);`,
  `        // 2026-10-23 修（真机 harness.log 里每条消息一次的 "already exists"）：`,
  `        //   resume 失败 → create 撞上宿主里同 id 的会话 ⇒ 抛错 ⇒ 这里原来直接 return，`,
  `        //   把用户刚发的整条消息静默吞掉（这就是"漏消息"的一条真因）。`,
  `        //   改成：换一个 sessionId 重开（forceNew）。宁可这段历史另起一档，也不丢消息。`,
  `        try {`,
  `            record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget, { forceNew: true });`,
  `            logger.warn(\`getOrCreate 自愈成功(已轮换 sessionId 重开): \${_msg1}\`);`,
  `        }`,
  `        catch (err2) {`,
  `            logger.error(\`ERROR creating session (重试也失败, 这条只能丢): \${err2 instanceof Error ? err2.message : String(err2)}\`);`,
  `            return;`,
  `        }`,
  `    }`,
].join(EOL);

const MARK = 'getOrCreate 自愈成功';
const applied = src.indexOf(MARK) >= 0;

if (mode === 'check') {
  console.log('文件: ' + FILE + ' (' + raw.length + ' 字符)');
  console.log('IN-RETRY: ' + (applied ? '已应用' : (src.indexOf(OLD) >= 0 ? '可打' : '未匹配')));
  process.exit(!applied && src.indexOf(OLD) < 0 ? 2 : 0);
}

if (mode === 'revert') {
  if (!applied) { console.log('未应用，无需回滚'); process.exit(0); }
  const out = src.split(NEW).join(OLD);
  writeFileSync(FILE, out, 'utf8');
  console.log('已回滚 (' + src.length + ' → ' + out.length + ')');
  process.exit(0);
}

if (applied) { console.log('已应用，跳过'); process.exit(0); }
if (src.indexOf(OLD) < 0) { console.error('未匹配（源文件形状变了）'); process.exit(2); }

try {
  mkdirSync(BACKUP_DIR, { recursive: true });
  if (!existsSync(BACKUP)) { copyFileSync(FILE, BACKUP); console.log('备份 → ' + BACKUP); }
} catch (e) {
  console.error('备份失败（权限？需要 danger-full-access）: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

const out = src.split(OLD).join(NEW);
writeFileSync(FILE, out, 'utf8');
console.log('已打补丁 (' + src.length + ' → ' + out.length + ' 字符)');
