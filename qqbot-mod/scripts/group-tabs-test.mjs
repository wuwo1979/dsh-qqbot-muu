/**
 * group-tabs-test.mjs — 浮窗「群组管理」合并（锤子 / 群发 / 入群审批 → 子标签）
 *
 * 用户 2026-10-23：群组管理有点混乱，把锤子、群发、入群审批都收进群组管理里。
 * 补丁把主标签三个入口收掉，改成面板顶部的四个子标签；旧 state.tab 值保持不变，
 * 所以旧链接/旧状态仍然能用。
 */
import { readFileSync, existsSync } from 'node:fs';
import { pluginPath } from '../patches/plugin-dir.mjs';

const FILE = pluginPath('client/qqbot-settings.js');
const MARK = '── 群组管理子标签（补丁 merge-group-tabs）';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

ok('找得到客户端文件', existsSync(FILE), FILE);
const src = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';

ok('补丁已应用', src.includes(MARK), '未应用：node qqbot-mod/patches/merge-group-tabs.mjs --apply');
ok('有子标签渲染函数', src.includes('function groupSubTabsHtml()'));
ok('子标签只定义一次', (src.match(/function groupSubTabsHtml\(\)/g) || []).length === 1);
ok('目标子标签', src.includes("['roster', '📇 目标'"));
ok('锤子子标签', src.includes("['mute', '🔨 锤子'"));
ok('群发子标签', src.includes("['send', '📤 群发'"));
ok('审批子标签', src.includes("['join', '📥 入群审批'"));
ok('子标签带 data-gsub', src.includes("data-gsub=\"' + it[0] + '\""), '没有 data-gsub 属性');
ok('主标签三个入口已移除', !src.includes('data-t="join"') && !src.includes('data-t="mute"') && !src.includes('data-t="send"'), '主标签仍在');
ok('点选切回旧 tab', src.includes("var v = sb.getAttribute('data-gsub')") && src.includes('state.tab = v'));
ok('入群/锤子按需加载', src.includes('if (v === \'join\') loadJoins(); else if (v === \'mute\') loadMutes()'));
ok('red 角标保留在审批子标签', src.includes('dk-join-badge'));
ok('四个面板都插入子标签', (src.match(/body \+= groupSubTabsHtml\(\)/g) || []).length === 4, (src.match(/body \+= groupSubTabsHtml\(\)/g) || []).length);
ok('旧群发子标签仍保留', src.includes('sendSubTabs()'));

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
