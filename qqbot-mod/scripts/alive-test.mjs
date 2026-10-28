/**
 * alive-test.mjs —— 「活人感」三件套的回归：
 *   ① split-reply 的气泡切分（连发短句）
 *   ② self-echo 的反重复块（把她刚说过的句子喂回去）
 *   ③ local-answer 的重复折叠（qwen2.5:7b 会吐"在呀，在呀。"）
 *
 * 纯本地逻辑，不需要 Ollama / 网络。数据根用工作区内的 .devdata-alive。
 */
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-alive';
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
mkdirSync(ROOT, { recursive: true });
process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;

const { splitBubbles, onOutbound } = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/outbound/split-reply.mjs');
const { formatEchoBlock, recentSelfLines } = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/self-echo.mjs');
const { collapseRepeat } = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/inbound/local-answer.mjs');
const { remember, loadConfig } = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory.mjs');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail += 1; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

// ── ① 气泡切分 ───────────────────────────────────────────────
{
  const a = splitBubbles('哈哈哈哈这什么鬼！笑死我了。', 3);
  ok('按句末标点切成多条', a.length === 2, JSON.stringify(a));
  ok('保留标点', a[0].includes('！'), a[0]);
  const b = splitBubbles('在呀，本鲸刚浮上来，你要干嘛呢人类', 3);
  ok('长句按逗号再切', b.length >= 2, JSON.stringify(b));
  const c = splitBubbles('好', 3);
  ok('单句不切', c.length === 1, JSON.stringify(c));
  const d = splitBubbles('哈！嗯？', 3);
  ok('过短的并进上一条', d.length === 1, JSON.stringify(d));
  const e = splitBubbles('第一句。第二句。第三句。第四句。', 3);
  ok('受 maxBubbles 限制', e.length === 3, JSON.stringify(e));
}

// ── ② 反重复块 ────────────────────────────────────────────────
{
  const cfg = loadConfig(ROOT);
  const scope = 'group:TEST_ALIVE';
  await remember(ROOT, scope, { text: '在呀，本鲸刚浮上来', kind: 'say' }, cfg);
  await remember(ROOT, scope, { text: '那就摸鱼啊，笨蛋人类', kind: 'say' }, cfg);
  await remember(ROOT, scope, { text: '普通的用户消息不该被当成她说的', kind: 'event' }, cfg);

  const lines = recentSelfLines(ROOT, scope, 3);
  ok('只取她说过的(kind=say/promise)', lines.length === 2, JSON.stringify(lines));
  ok('不含用户 event 记忆', !lines.some((t) => t.includes('不该被当成')), JSON.stringify(lines));

  const blk = formatEchoBlock(ROOT, scope, { maxChars: 110 });
  ok('块以 [别重复] 开头', blk.block.startsWith('\n[别重复]刚说过：'), JSON.stringify(blk.block));
  ok('块不超过预算', blk.block.length <= 110 + 20, String(blk.block.length));

  const empty = formatEchoBlock(ROOT, 'group:NOBODY', {});
  ok('没说过话时不出块', empty.block === '', JSON.stringify(empty.block));
}

// ── ③ 重复折叠 ────────────────────────────────────────────────
{
  ok('在呀，在呀。→ 在呀。', collapseRepeat('在呀，在呀。') === '在呀。', collapseRepeat('在呀，在呀。'));
  ok('在呀。在呀。→ 在呀。', collapseRepeat('在呀。在呀。') === '在呀。', collapseRepeat('在呀。在呀。'));
  ok('哈哈哈哈哈哈→ 收短', collapseRepeat('哈哈哈哈哈哈') === '哈哈哈', collapseRepeat('哈哈哈哈哈哈'));
  ok('正常回复不动', collapseRepeat('笑啥呢？') === '笑啥呢？', collapseRepeat('笑啥呢？'));
}

// ── ④ 出站拆句链路（onOutbound 真跑一遍）─────────────────────
{
  const writes = ['F:/qqbot/qqbot-mod/.devdata-alive/alive-config.json'];
  writeFileSync(writes[0], JSON.stringify({ enabled: true, prob: 1, maxBubbles: 3, gapMs: 200, minLen: 6, maxLen: 80 }), 'utf8');

  const sent = [];
  const ctx = {
    phase: 'send',
    kind: 'text',
    isLastChunk: true,
    text: '哈哈哈哈这什么鬼！笑死我了。',
    logger: { debug() {} },
    rewrite(t) { this.text = t; },
    async send(t) { sent.push(t); return true; },
  };
  let nexted = 0;
  await onOutbound(ctx, async () => { nexted += 1; });
  ok('正文被改写成第一条气泡', ctx.text !== '哈哈哈哈这什么鬼！笑死我了。', ctx.text);
  ok('补发了第二条', sent.length === 1, JSON.stringify(sent));
  ok('只 next 一次', nexted === 1, String(nexted));

  // 带媒体的不拆
  const ctx2 = { phase: 'send', kind: 'text', isLastChunk: true, text: '[MEDIA:image|D:/a.png] 给你看！好看吧！', logger: { debug() {} }, rewrite() { throw new Error('不该改写'); }, async send() { throw new Error('不该补发'); } };
  await onOutbound(ctx2, async () => {});
  ok('带 MEDIA 的回复不拆', true);

  // turnEnd 不拆
  const ctx3 = { phase: 'turnEnd', isLastChunk: true, text: '第一句。第二句。', logger: { debug() {} }, rewrite() { throw new Error('不该改写'); } };
  await onOutbound(ctx3, async () => {});
  ok('turnEnd 阶段不动正文', true);
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
