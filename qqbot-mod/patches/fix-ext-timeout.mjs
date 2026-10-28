/**
 * fix-ext-timeout.mjs —— 出站扩展链 3 秒硬超时太短（真机证据在 harness.log）
 *
 * 现场（2026-10-23 00:43:45Z / 00:44:59Z）：
 *   error im-qqbot: 出站扩展链超时(3000ms)，已放弃改写/配图、按原文发出
 * 代码：`dist/transport/outbound-buffer.js:52`
 *   const EXT_HOOK_TIMEOUT_MS = 3000;
 *
 * 为什么咬人：语音合成（edge-tts 走网络，1~3 秒）、拆条、表情包搜索全在出站链里。
 *   一旦超时，宿主**回退原文**：文字照发，语音/拆条全被丢掉 —— 用户看到的就是
 *   "她说要发语音，结果什么都没来"。冷启动时尤其容易踩线。
 *
 * 修法：常量改成可配（环境变量 QQBOT_EXT_HOOK_TIMEOUT_MS），默认 8000ms，上限 30s。
 *   出站链现在把合成挪进了 ctx.background()（不占这个预算），所以 8 秒是"富余"而不是"更慢"。
 *
 * 用法：node fix-ext-timeout.mjs --check|--apply|--revert（apply 需 danger-full-access）
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;

import { PLUGIN } from './plugin-dir.mjs';
const FILE = join(PLUGIN, 'dist', 'transport', 'outbound-buffer.js');
const BACKUP_DIR = 'F:/qqbot/qqbot-mod/backups';
const BACKUP = join(BACKUP_DIR, 'outbound-buffer.js.orig-hooktimeout');

const mode = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--revert') ? 'revert'
    : 'check';

if (!existsSync(FILE)) {
  console.error('找不到 ' + FILE);
  process.exit(1);
}

const raw = readFileSync(FILE, 'utf8');
const src = raw.split(CR).join('').split(LF).join(EOL);

const OLD = `            const EXT_HOOK_TIMEOUT_MS = 3000;`;

const NEW = [
  `            // 2026-10-23 修：3000ms 太短（合成/拆条/搜表情都在这条链里），`,
  `            //   超时宿主会回退原文 ⇒ 语音被静默丢掉。改成可配，默认 8000ms。`,
  `            const EXT_HOOK_TIMEOUT_MS = (() => {`,
  `                const v = Number(process.env.QQBOT_EXT_HOOK_TIMEOUT_MS);`,
  `                return Number.isFinite(v) && v >= 500 ? Math.min(v, 30000) : 8000;`,
  `            })();`,
].join(EOL);

const MARK = 'QQBOT_EXT_HOOK_TIMEOUT_MS';
const applied = src.indexOf(MARK) >= 0;

if (mode === 'check') {
  console.log('文件: ' + FILE + ' (' + raw.length + ' 字符)');
  console.log('EXT-TIMEOUT: ' + (applied ? '已应用' : (src.indexOf(OLD) >= 0 ? '可打' : '未匹配')));
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
