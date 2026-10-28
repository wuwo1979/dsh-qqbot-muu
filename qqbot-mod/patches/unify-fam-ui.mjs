/**
 * unify-fam-ui.mjs — 「单会话设置」里的熟识度指向统一的记忆库
 *
 * 用户 2026-10-23：浮窗里的印象卡、单会话设置里的熟识度要统一，改底层。
 * 底层已统一到 persona.fam:<senderId>（profile-core.mjs）；本补丁只补一句人话 +
 * 一个「去记忆页」的入口，免得两个数字摆在一起让人以为各算各的。
 *
 * 用法：node patches/unify-fam-ui.mjs --check | --apply | --revert
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const FILE = pluginPath('client/qqbot-settings.js');
const BACKUP = FILE + '.orig-famui';
const MARK = '── 熟识度统一入口（补丁 unify-fam-ui）';

const HEAD_ANCHOR = "              + '<span>🧠 熟识度(记你多牢) ｜ 💗 好感度(对你什么态度)(观察期·只统计)</span>'";
const BIND_ANCHOR = '        var affToggle = panel.querySelector(\'#dk-aff-toggle\')';

const HEAD_NEW =
  "              + '<div class=\"dk-msg\" style=\"font-size:11px;color:#888;margin:8px 0 0\">"
  + '🧠 熟识度已与印象卡统一存进记忆库 <code>persona.fam</code>（这里是她的原生统计，已按 0.7/0.3 温和融合导入） · '
  + '<a href=\"#\" id=\"dk-fam-go\" style=\"color:#1971c2\">去「记忆」页看统一熟识度</a></div>\' // ' + MARK + '\n'
  + HEAD_ANCHOR;

const BIND_NEW =
  "        var famGo = panel.querySelector('#dk-fam-go')\n"
  + "        if (famGo) famGo.onclick = function (e) { e.preventDefault(); state.tab = 'memory'; paintBody() } // " + MARK + "\n"
  + BIND_ANCHOR;

const args = process.argv.slice(2);
const rx = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\n/g, '\\r?\\n'));
const src = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';

if (args.includes('--revert')) {
  if (!existsSync(BACKUP)) { console.error('没有备份，无法回滚'); process.exit(1); }
  copyFileSync(BACKUP, FILE);
  console.log('已回滚 qqbot-settings.js');
  process.exit(0);
}

if (args.includes('--check')) {
  const applied = src.includes(MARK);
  const ok = applied || (rx(HEAD_ANCHOR).test(src) && rx(BIND_ANCHOR).test(src));
  console.log(applied ? '已应用' : (ok ? '可应用：锚点存在' : '不可应用：锚点不存在'));
  process.exit(ok ? 0 : 1);
}

if (!args.includes('--apply')) {
  console.log('用法: --check | --apply | --revert');
  process.exit(0);
}
if (src.includes(MARK)) { console.log('已应用，跳过'); process.exit(0); }
if (!rx(HEAD_ANCHOR).test(src) || !rx(BIND_ANCHOR).test(src)) {
  console.error('锚点不存在，插件结构可能变了；未做修改');
  process.exit(1);
}

let next = src
  .replace(rx(HEAD_ANCHOR), () => HEAD_NEW)
  .replace(rx(BIND_ANCHOR), () => BIND_NEW);

if (!existsSync(BACKUP)) copyFileSync(FILE, BACKUP);
writeFileSync(FILE, next, 'utf8');
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'pipe' });
  console.log('补丁已写入 qqbot-settings.js 并通过 node --check');
  announce('fam-ui');
} catch (e) {
  copyFileSync(BACKUP, FILE);
  console.error('语法检查失败，已自动还原：', String(e.stderr || e.message).slice(0, 600));
  process.exit(1);
}
