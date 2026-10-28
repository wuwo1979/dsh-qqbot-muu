/**
 * merge-group-tabs.mjs — 把 锤子 / 群发 / 入群审批 收进「群组管理」
 *
 * 用户 2026-10-23：浮窗主标签太多太乱，群组管理应该是一个入口，里面再分。
 *
 * 做法（只改入口，不搬移面板代码，降低回归风险）：
 *   · 主标签删掉 join / mute / send 三个按钮；
 *   · 在 roster / mute / send / join 四个面板顶部统一插一条子标签栏；
 *   · 点子标签 = 把 state.tab 切到对应旧值（旧状态/旧链接照样能用）；
 *   · 入群审批的红色角标挪到子标签里，计数逻辑不用改。
 *
 * 用法：--check / --apply / --revert
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const FILE = pluginPath('client/qqbot-settings.js');
const BACKUP = FILE + '.orig-groupmerge';
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const APPLY = args.includes('--apply');
const REVERT = args.includes('--revert');
const MARK = '── 群组管理子标签（补丁 merge-group-tabs）';

const MAIN_JOIN =
  "          + '<button data-t=\"join\" class=\"' + (state.tab === 'join' ? 'on' : '') + '\">📥 入群审批<span class=\"dk-join-badge\" style=\"display:none;background:#ff4d4f;color:#fff;border-radius:8px;font-size:11px;padding:0 5px;margin-left:4px\">0</span></button>'\n";
const MAIN_MUTE =
  "          + '<button data-t=\"mute\" class=\"' + (state.tab === 'mute' ? 'on' : '') + '\">🔨 锤子</button>'\n";
const MAIN_SEND =
  "          + '<button data-t=\"send\" class=\"' + (['send','broadcast','bp','card'].indexOf(state.tab) >= 0 ? 'on' : '') + '\">📤 群发</button>'\n";

const FN_ANCHOR = '      function paintBody() {';
const FN_NEW = `      // ${MARK}
      function groupSubTabsHtml() {
        var t = state.tab
        var cur = t === 'mute' ? 'mute'
          : (t === 'join' ? 'join'
            : ((['send', 'broadcast', 'bp', 'card'].indexOf(t) >= 0) ? 'send' : 'roster'))
        var items = [
          ['roster', '📇 目标', ''],
          ['mute', '🔨 锤子', ''],
          ['send', '📤 群发', ''],
          ['join', '📥 入群审批', '<span class="dk-join-badge" style="display:none;background:#ff4d4f;color:#fff;border-radius:8px;font-size:11px;padding:0 5px;margin-left:4px">0</span>']
        ]
        return '<div class="dk-row" style="gap:6px;margin:2px 0 6px;flex-wrap:wrap">'
          + items.map(function (it) {
            return '<button class="dk-btn' + (cur === it[0] ? ' ok' : '') + '" data-gsub="' + it[0] + '">' + it[1] + it[2] + '</button>'
          }).join('')
          + '</div>'
      }
${FN_ANCHOR}`;

const ROSTER_ANCHOR = "        } else if (state.tab === 'roster') {\n";
const ROSTER_NEW = ROSTER_ANCHOR + "          body += groupSubTabsHtml()\n";

const SEND_ANCHOR = "          body += sendSubTabs()\n";
const SEND_NEW = "          body += groupSubTabsHtml()\n" + SEND_ANCHOR;

const JOIN_ANCHOR = "        } else if (state.tab === 'join') {\n";
const JOIN_NEW = JOIN_ANCHOR + "          body += groupSubTabsHtml()\n";

const MUTE_ANCHOR = "          var hsub = state.hammerSub || 'mute'\n";
const MUTE_NEW = MUTE_ANCHOR + "          body += groupSubTabsHtml()\n";

const BIND_ANCHOR = `        // 📤 群发 · 次级标签切换(2026-09-10)
        panel.querySelectorAll('[data-subtab]').forEach(function (sb) {
          sb.onclick = function () {
            var v = sb.getAttribute('data-subtab')
            state.tab = v; state.msg = ''
            if (v === 'bp') loadBotplay()
            paintBody()
          }
        })`;
const BIND_NEW = BIND_ANCHOR + `
        // ${MARK}：点子标签 = 切旧 tab，保证旧逻辑/旧状态都能用
        panel.querySelectorAll('[data-gsub]').forEach(function (sb) {
          sb.onclick = function () {
            var v = sb.getAttribute('data-gsub')
            state.tab = v; state.msg = ''
            if (v === 'join') loadJoins(); else if (v === 'mute') loadMutes()
            paintBody()
          }
        })`;

function read() {
  if (!existsSync(FILE)) {
    console.error('找不到客户端文件: ' + FILE);
    process.exit(2);
  }
  return readFileSync(FILE, 'utf8');
}

const rx = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n'));

function strip(src) {
  let s = src;
  // 恢复被删的三个主标签按钮
  s = s.replace(ROSTER_NEW, ROSTER_ANCHOR);
  s = s.replace(nlEsc(SEND_NEW), SEND_ANCHOR);
  s = s.replace(JOIN_NEW, JOIN_ANCHOR);
  s = s.replace(MUTE_NEW, MUTE_ANCHOR);
  s = s.replace(/\n      \/\/ ── 群组管理子标签（补丁 merge-group-tabs）[\s\S]*?\n      function groupSubTabsHtml\(\)[\s\S]*?\n      \}\n(?=      function paintBody)/, '\n');
  s = s.replace(/\n        \/\/ ── 群组管理子标签（补丁 merge-group-tabs）：[\s\S]*?\n        \}\)/, '');
  s = s.replace(ERASED_JOIN, MAIN_JOIN + MAIN_MUTE + MAIN_SEND);
  return s;
}

function nlEsc(s) { return s; }

// 主标签删除后留一个可恢复的锚点注释
function eraseMainTabs(src) {
  const joined = MAIN_JOIN + MAIN_MUTE + MAIN_SEND;
  if (src.includes(joined)) return src.replace(joined, () => ERASED_JOIN);
  // 文件是 CRLF 时整段匹配不上：逐行用 rx（\r?\n）删，并在原位置留恢复锚点
  let s = src;
  let inserted = false;
  for (const line of [MAIN_JOIN, MAIN_MUTE, MAIN_SEND]) {
    s = s.replace(rx(line), () => {
      if (inserted) return '';
      inserted = true;
      return ERASED_JOIN;
    });
  }
  return s;
}
const ERASED_JOIN = '          // 主标签 join/mute/send 已并入「群组管理」（补丁 merge-group-tabs）\n';

function patch(src) {
  let s = src;
  for (const [label, a] of [
    ['主标签 join', MAIN_JOIN], ['主标签 mute', MAIN_MUTE], ['主标签 send', MAIN_SEND],
    ['roster 分支', ROSTER_ANCHOR], ['send 分支', SEND_ANCHOR], ['join 分支', JOIN_ANCHOR],
    ['mute 分支', MUTE_ANCHOR], ['paintBody', FN_ANCHOR], ['data-subtab 绑定', BIND_ANCHOR],
  ]) {
    if (!rx(a).test(s)) throw new Error('锚点丢失：' + label);
  }
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  const put = (anchor, text) => { s = s.replace(rx(anchor), () => text.replace(/\n/g, nl)); };

  s = eraseMainTabs(s);
  put(ROSTER_ANCHOR, ROSTER_NEW);
  put(SEND_ANCHOR, SEND_NEW);
  put(JOIN_ANCHOR, JOIN_NEW);
  put(MUTE_ANCHOR, MUTE_NEW);
  put(FN_ANCHOR, FN_NEW);
  put(BIND_ANCHOR, BIND_NEW);
  return s;
}

function syntaxCheck() {
  try {
    execFileSync(process.execPath, ['--check', FILE], { stdio: 'pipe' });
    console.log('  ✅ node --check 通过');
    return true;
  } catch (e) {
    console.error('  ❌ node --check 失败:\n' + String(e.stderr || e.message || e).slice(0, 1200));
    return false;
  }
}

announce('group-merge');
console.log('客户端文件: ' + FILE);

if (REVERT) {
  if (!existsSync(BACKUP)) { console.error('没有备份 ' + BACKUP); process.exit(2); }
  copyFileSync(BACKUP, FILE);
  console.log('已回滚。');
  process.exit(0);
}

const cur = read();
const applied = cur.includes(MARK);
if (CHECK) {
  console.log(applied ? '✅ 已应用' : (rx(MAIN_JOIN).test(cur) ? '⬜ 未应用（锚点存在）' : '❌ 未应用且锚点缺失'));
  process.exit(applied ? 0 : 1);
}
if (!APPLY) { console.log('用法：--check | --apply | --revert'); process.exit(2); }
if (applied) { console.log('已经应用过。'); process.exit(0); }
if (!existsSync(BACKUP)) copyFileSync(FILE, BACKUP);

const out = patch(cur);
writeFileSync(FILE, out, 'utf8');
if (!syntaxCheck()) {
  copyFileSync(BACKUP, FILE);
  console.error('语法检查失败，已自动还原。');
  process.exit(4);
}
console.log('✅ 已合并进「群组管理」（备份: ' + BACKUP + '）');
