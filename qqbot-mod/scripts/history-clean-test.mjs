/**
 * history-clean-test.mjs — 入站注入块清洗（扩展侧共用正则 + 插件落盘补丁）
 *
 * 真机事故：aa-memory-recall 用 ctx.rewrite() 注入 [记忆]/[印象]/[关系]，
 * 插件 transport/inbound.js 又把同一个 content 落进 .qqbot/msg-history，
 * 注入内容被永久写进聊天台账，再镜像进记忆库 → 自己的注入污染自己的历史。
 */
import { readFileSync, existsSync } from 'node:fs';
import { cleanInjected, hasInjected } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/text-clean.mjs';
import { pluginPath } from '../patches/plugin-dir.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

ok('剥 [记忆] 块', cleanInjected('早\n[记忆]1. 你答应过周末写代码\n2. 养猫[/记忆]\n嗯') === '早\n嗯', cleanInjected('早\n[记忆]1. 你答应过周末写代码\n2. 养猫[/记忆]\n嗯'));
ok('剥 [设定] 块', cleanInjected('[设定]海底来的鲸鱼[/设定]对啊') === '对啊');
ok('剥 [印象] 块', cleanInjected('嗯\n[印象]爸爸 · 熟悉（亲近 42/100）[/印象]') === '嗯');
ok('剥 [关系] 块', cleanInjected('[关系]爸爸 · 亲近 40/100[/关系]走') === '走');
ok('剥 [状态] 块', cleanInjected('好\n[状态]有点困[/状态]') === '好');
ok('剥 [B站] 块', cleanInjected('[B站]3 条新动态[/B站]看到了') === '看到了');
ok('剥 [别重复] 行', cleanInjected('好\n[别重复]刚说过：A / B') === '好');
ok('多块连剥', cleanInjected('[记忆]a[/记忆]\n正文\n[印象]b[/印象]\n[状态]c[/状态]') === '正文');
ok('正常文本不动', cleanInjected('今天写了 3 小时代码，猫在键盘上睡着了') === '今天写了 3 小时代码，猫在键盘上睡着了');
ok('旧版未闭合注入切到结尾', cleanInjected('好笨的回答 <@96313B33> [记忆] 1. （10-22 群里的 40 条消息…') === '好笨的回答 <@96313B33>', cleanInjected('好笨的回答 <@96313B33> [记忆] 1. （10-22 群里的 40 条消息…'));
ok('旧版 [状态] 无闭合也切', cleanInjected('嗯 [状态] 有点困') === '嗯');
ok('空值不抛', cleanInjected(null) === '' && cleanInjected(undefined) === '');
ok('hasInjected 命中', hasInjected('a[记忆]b[/记忆]') === true);
ok('hasInjected 不误报', hasInjected('普通一句话') === false);
ok('hasInjected 识别未闭合残留', hasInjected('[记忆]只有开头') === true);

// ── 插件落盘补丁（真机 dist）──
const historyFile = pluginPath('dist/features/msg-history.js');
ok('找得到 msg-history.js', existsSync(historyFile), historyFile);
const src = existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : '';
ok('落盘前剥离已打补丁', src.includes('qqs-clean-injected'), '补丁未应用：node qqbot-mod/patches/fix-history-injection.mjs --apply');

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
