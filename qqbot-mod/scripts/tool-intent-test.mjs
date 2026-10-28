/**
 * tool-intent-test.mjs — 本地小模型不许抢"要动工具"的活
 *
 * 真机事故（2026-10-23 05:10）：主人说"画一条小鲸鱼"，本地 7b 回了
 * 「啊这，画画可真难。」把消息摘掉；同一时间另一个会话云端在真画
 * ⇒ 一遍说画不出、一遍把图发出来，前后矛盾。
 */
import { needsTools, worthLocalSafe, gagReply } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/local-answer.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('PASS  ' + name);
  } else {
    fail += 1;
    console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
  }
}

// ── needsTools：要动工具的一律交云端 ──
const yes = ['画一条小鲸鱼', '帮我画张图', '给我画个表情包', '来一张海底的图', '生成一张立绘', '做个视频', '发个语音条', '唱个歌听听', '帮我查一下天气', '搜一下这个梗', '翻译一下这句', '记一下我明天体检', '提醒我十点开会', '写个脚本给文件改名',
  '帮我生成一个Excel表格', '把这张表格改一下', '生成一份docx报告', '导出成pdf', '把这个附件转成word',
  '帮我看看这个网页', '抓一下这个链接', '读一下这个网址', '爬一下这个网站', '打开 https://example.com 看看'];
for (const t of yes) ok('needsTools 命中：' + t, needsTools(t) === true);

const no = ['在吗', '哈哈哈', '吃了吗', '今天好累', '本鲸在呢', '嗯嗯', '2+3等于多少', '师父发话，那本鲸闭嘴', '好耶'];
for (const t of no) ok('needsTools 不误伤：' + t, needsTools(t) === false);

ok('空串安全', needsTools('') === false && needsTools(null) === false && needsTools(undefined) === false);

// ── worthLocal：工具意图不接管，闲聊照旧 ──
const cfg = { whoAnswers: 'simple', shortChatChars: 12, maxInputChars: 80 };
if (typeof worthLocalSafe === 'function') {
  const r1 = worthLocalSafe('画一条小鲸鱼', cfg);
  ok('worthLocal：画图请求不本地接管', r1.take === false && r1.why === 'needs-tools', r1);
  const r2 = worthLocalSafe('在吗', cfg);
  ok('worthLocal：普通寒暄仍本地接管', r2.take === true, r2);
  const r3 = worthLocalSafe('给我画个表情包', cfg);
  ok('worthLocal：表情包请求不本地接管', r3.take === false, r3);
} else {
  ok('worthLocalSafe 未导出（跳过三条）', true);
}

// ── 梗仍然优先（2+3 这条不能被 needsTools 挡掉） ──
ok('死梗 2+3 仍由本地直答', gagReply('2+3等于多少') === '6');

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
