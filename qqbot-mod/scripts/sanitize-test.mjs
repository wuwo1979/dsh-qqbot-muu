/**
 * sanitize-test.mjs — 出站清洗闸（aa-sanitize.mjs）
 *
 * 盯的是真机事故：她把上下文里的内部消息号 m01013b 当证据念出来，
 * 群里就是一条乱码；以及偶尔漏出的 [记忆]…[/记忆] 注入块。
 */
import { sanitize, onOutbound } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/outbound/aa-sanitize.mjs';

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

// ── 纯函数 ──
ok('纯函数：内部消息号被剥掉', sanitize('m01013b\n\n本鲸张嘴就说了') === '本鲸张嘴就说了', sanitize('m01013b\n\n本鲸张嘴就说了'));
ok('纯函数：句中消息号也剥', sanitize('就是这条 m001f2 啊') === '就是这条 啊', sanitize('就是这条 m001f2 啊'));
ok('纯函数：正常英文 m 开头词不动', sanitize('mint 是薄荷，max 是最大') === 'mint 是薄荷，max 是最大');
ok('纯函数：短 m 词不动', sanitize('m3 螺丝') === 'm3 螺丝');
ok('纯函数：记忆块剥掉', sanitize('哦\n[记忆]1. 你答应过[/记忆]\n嗯') === '哦\n\n嗯', sanitize('哦\n[记忆]1. 你答应过[/记忆]\n嗯'));
ok('纯函数：设定块剥掉', sanitize('[设定]海底来的[/设定]对啊') === '对啊', sanitize('[设定]海底来的[/设定]对啊'));
ok('纯函数：别重复行剥掉', sanitize('好\n[别重复]刚说过：A / B') === '好', sanitize('好\n[别重复]刚说过：A / B'));
ok('纯函数：裸消息号 #0913a 剥掉', sanitize('你看 #0913a 这条') === '你看 这条', sanitize('你看 #0913a 这条'));
ok('纯函数：引用语法 [rf:0913a] 保留', sanitize('[rf:0913a] 哈哈') === '[rf:0913a] 哈哈', sanitize('[rf:0913a] 哈哈'));
ok('纯函数：@ 语法保留', sanitize('<@0123456789ABCDEF0123456789ABCDEF> 早') === '<@0123456789ABCDEF0123456789ABCDEF> 早');
ok('纯函数：@全体 保留', sanitize('<qqbot-at-everyone />开饭') === '<qqbot-at-everyone />开饭');
ok('纯函数：MEDIA 保留', sanitize('[MEDIA:image|D:/a.png]') === '[MEDIA:image|D:/a.png]');
ok('纯函数：连续空格收一格', sanitize('啊    这') === '啊 这', sanitize('啊    这'));
ok('纯函数：null/undefined 不抛', sanitize(null) === '' && sanitize(undefined) === '');

// ── 钩子 ──
function mkCtx(text, phase = 'send', kind = 'text') {
  const c = { text, phase, kind, rewritten: null, notes: 0 };
  c.rewrite = (t) => {
    c.rewritten = String(t);
    c.text = String(t);
  };
  c.note = () => {
    c.notes += 1;
  };
  return c;
}

let nexted = 0;
const next = async () => {
  nexted += 1;
};

{
  const c = mkCtx('m01013b\n本鲸在');
  await onOutbound(c, next);
  ok('钩子：脏文本被改写', c.rewritten === '本鲸在', c.rewritten);
  ok('钩子：改写后继续 next', nexted === 1 && c.text === '本鲸在');
}
{
  const c = mkCtx('干净的一句话');
  await onOutbound(c, next);
  ok('钩子：干净文本不改写', c.rewritten === null);
}
{
  const c = mkCtx('[记忆]全被剥掉[/记忆]');
  await onOutbound(c, next);
  ok('钩子：全剥光时兜底不空发', c.text === '……', c.text);
}
{
  const n0 = nexted;
  const c1 = mkCtx('m01013b', 'send');
  await onOutbound(c1, next);
  ok('钩子：send 阶段脏文本被改写且 next 一次', c1.rewritten === '' || c1.text === '……', c1.text);
  ok('钩子：send 阶段确实 next 了', nexted === n0 + 1);
  const c2 = mkCtx('m01013b', 'turnEnd');
  await onOutbound(c2, next);
  ok('钩子：非 send 阶段直通不改', c2.rewritten === null && nexted === n0 + 2);
}
{
  const c = { phase: 'send', kind: 'media', text: 'm01013b' };
  await onOutbound(c, next);
  ok('钩子：媒体消息不处理', c.text === 'm01013b');
}

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
