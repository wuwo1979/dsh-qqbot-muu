#!/usr/bin/env node
/**
 * apply-persona.mjs — 把新的人格核写进 qqbot 的活配置（groupPrompt）
 *
 * 为什么改这个文件：插件的 Web 设置落在
 *   %APPDATA%\dsh-desktop\harness\qqbot-settings\web\im-qqbot.json
 * 直接写它 = 等价于在面板里改了「群聊守则」并保存。
 * ⚠️ 直接写文件不会触发插件的 settings-changed 事件 → 需要 /bot-restart 才生效。
 *    （这也正好和 P0/P1 的补丁重启合并成一次。）
 *
 * 用法：
 *   node apply-persona.mjs            # 应用
 *   node apply-persona.mjs --check    # 只看差异，不写
 *   node apply-persona.mjs --revert   # 回滚到最近一次备份
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const SETTINGS = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/qqbot-settings/web/im-qqbot.json';
const NEW_PROMPT = 'F:/qqbot/qqbot-mod/persona/group-prompt.md';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const REVERT = args.has('--revert');
const log = (...a) => console.log(...a);

if (!existsSync(SETTINGS)) { log(`✗ 找不到设置文件: ${SETTINGS}`); process.exit(1); }

const dir = dirname(SETTINGS);
const backups = readdirSync(dir)
  .filter((f) => f.startsWith('im-qqbot.json.persona-'))
  .sort()
  .map((f) => join(dir, f));

if (REVERT) {
  const last = backups[backups.length - 1];
  if (!last) { log('✗ 没有可用的备份'); process.exit(1); }
  copyFileSync(last, SETTINGS);
  log(`已回滚: ${SETTINGS}\n     ← ${last}`);
  process.exit(0);
}

if (!existsSync(NEW_PROMPT)) { log(`✗ 找不到新人设: ${NEW_PROMPT}`); process.exit(1); }

// 新人设：去掉 markdown 标题行的 #，保留结构（模型对 # 分段不敏感，但省字符）
const prompt = readFileSync(NEW_PROMPT, 'utf8').trim();

const raw = readFileSync(SETTINGS, 'utf8');
let cfg;
try { cfg = JSON.parse(raw); } catch (e) { log('✗ 设置文件不是合法 JSON: ' + e.message); process.exit(1); }

const oldPrompt = String(cfg.groupPrompt ?? '');
log('对比:');
log(`  旧 groupPrompt: ${oldPrompt.length} 字符`);
log(`  新 groupPrompt: ${prompt.length} 字符`);
const delta = oldPrompt.length - prompt.length;
log(`  变化: ${delta >= 0 ? '↓ 省 ' + delta : '↑ 多 ' + (-delta)} 字符`);

// 关键规则必须都在（防止写丢）
const mustHave = ['妈妈', '2+3', 'DeepSeek', '表情包', '咕噜噜'];
const missing = mustHave.filter((k) => !prompt.includes(k));
if (missing.length) { log(`✗ 新人设缺少关键规则: ${missing.join(', ')}`); process.exit(1); }
log('  关键规则自检: ' + mustHave.join(' / ') + ' ✅');

if (CHECK) { log('\n(--check) 未写入。'); process.exit(0); }

// 备份
const stamp = Date.now();
const backupPath = join(dir, `im-qqbot.json.persona-${stamp}`);
copyFileSync(SETTINGS, backupPath);
log(`\n备份: ${backupPath}`);

cfg.groupPrompt = prompt;
writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2), 'utf8');

// 回读校验
try {
  const back = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  if (back.groupPrompt !== prompt) { throw new Error('回读不一致'); }
  log(`写入并回读校验通过 (${back.groupPrompt.length} 字符)`);
} catch (e) {
  copyFileSync(backupPath, SETTINGS);
  log('✗ 回读校验失败 → 已回滚: ' + e.message);
  process.exit(1);
}

log(`
生效方式: QQ 里发 /bot-restart（或重启 DSH Desktop）。
回滚:     node apply-persona.mjs --revert
`);
