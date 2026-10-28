/**
 * bili-share-test.mjs — B 站分享必须「链接 + 封面」一条卡片 + 留档（2026-10-24）
 *
 * 盯的四件事：
 *   · 卡片文本里封面和链接在同一条消息里（不再拆成两条烧主动额度）；
 *   · 卡片发不出去时降级为一条纯文本，且只发一次；
 *   · 每次分享都写 .qqbot/bili-shares.jsonl（失败也写），浮窗能倒序读；
 *   · peer.scope 的 'group'/'group:xxx' 两种写法都能解析。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildShareMarkdown, buildShareText, splitPeer, sendShareCard,
  recordShare, readShares, saveCover, videoUrlOf,
} from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/bili-share.mjs';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-bilishare';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

const V = {
  bvid: 'BV1xx411c7mD',
  title: '测试视频标题',
  owner: '某UP',
  views: 123456,
  likes: 789,
  cover: 'https://i0.hdslb.com/bfs/archive/xxx.jpg',
};

function seed() {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(ROOT, { recursive: true });
}

async function main() {
  seed();

  // ── 卡片文本：封面 + 链接必须在同一条 ──
  const md = buildShareMarkdown(V, 'F:/tmp/cover.jpg');
  ok('卡片含标题', md.includes('测试视频标题'), md);
  ok('卡片含封面图（本地路径）', md.includes('![封面](F:/tmp/cover.jpg)'), md);
  ok('卡片含跳转链接', md.includes('https://www.bilibili.com/video/BV1xx411c7mD'), md);
  ok('封面与链接之间没有额外分隔消息', md.split('\n').filter((l) => l.startsWith('![')).length === 1, md);
  ok('卡片带 UP/播放/点赞', md.includes('UP：某UP') && md.includes('播放'), md);
  ok('无封面也能出卡片', buildShareMarkdown(V, '').includes('https://www.bilibili.com/video/'), buildShareMarkdown(V, ''));
  ok('评论后分享带评论文字', buildShareMarkdown({ ...V, comment: '这期真不错' }, '').includes('我的评论：这期真不错'), buildShareMarkdown({ ...V, comment: '这期真不错' }, ''));

  const txt = buildShareText(V);
  ok('纯文本兜底含链接与标题', txt.includes('测试视频标题') && txt.includes(videoUrlOf(V.bvid)), txt);
  ok('纯文本兜底不含图片语法', !txt.includes('!['), txt);

  // ── peer 解析两种写法 ──
  ok('peer scope=group', splitPeer({ scope: 'group', peerId: 'G1' }).scope === 'group' && splitPeer({ scope: 'group', peerId: 'G1' }).id === 'G1');
  ok('peer scope=group:id', splitPeer({ scope: 'group:G2', peerId: 'X' }).id === 'G2');
  ok('peer scope=c2c', splitPeer({ scope: 'c2c', peerId: 'C1' }).scope === 'c2c');
  ok('peer 缺省按群', splitPeer({}).scope === 'group');

  // ── 发送优先级：当前会话卡片 → 显式目标卡片 → 纯文本 → 全失败 ──
  {
    const calls = [];
    const env = {
      caps: { markdown: async (s) => { calls.push('md'); return true; }, text: async () => { calls.push('txt'); return true; } },
      qq: { sendMarkdown: async () => { calls.push('qqmd'); return true; } },
    };
    const r = await sendShareCard(env, md, txt, { scope: 'group', peerId: 'G' });
    ok('首选当前会话 markdown', r.ok && r.via === 'card' && calls.join(',') === 'md', { r, calls });
  }
  {
    const calls = [];
    const env = {
      caps: { markdown: async () => { calls.push('md'); return false; }, text: async () => { calls.push('txt'); return true; } },
      qq: { sendMarkdown: async (scope, id, s) => { calls.push('qqmd:' + scope + ':' + id + ':' + String(s).slice(0, 2)); return true; } },
    };
    const r = await sendShareCard(env, md, txt, { scope: 'group', peerId: 'G' });
    ok('当前会话失败后走显式目标卡片', r.ok && r.via === 'card-active' && calls[1] === 'qqmd:group:G:**', { r, calls });
  }
  {
    const calls = [];
    const env = {
      caps: { markdown: async () => false, text: async () => { calls.push('txt'); return true; } },
      qq: { sendMarkdown: async () => false },
    };
    const r = await sendShareCard(env, md, txt, { scope: 'c2c', peerId: 'C' });
    ok('卡片全失败降级一条纯文本', r.ok && r.via === 'text' && calls.length === 1, { r, calls });
  }
  {
    const env = { caps: {}, qq: {} };
    const r = await sendShareCard(env, md, txt, { scope: 'group', peerId: 'G' });
    ok('无发送能力时明确失败', r.ok === false);
  }

  // ── 留档：失败也写，倒序读 ──
  ok('空账本读出空数组', readShares(ROOT).length === 0);
  recordShare(ROOT, { bvid: 'BV1', title: '旧视频', sent: false, url: videoUrlOf('BV1') });
  recordShare(ROOT, { bvid: 'BV2', title: '新视频', sent: true, via: 'card', url: videoUrlOf('BV2') });
  {
    const list = readShares(ROOT, { limit: 10 });
    ok('账本按时间倒序', list.length === 2 && list[0].bvid === 'BV2' && list[1].sent === false, list);
    ok('账本行是合法 JSONL', readFileSync(join(ROOT, '.qqbot', 'bili-shares.jsonl'), 'utf8').trim().split('\n').every((l) => JSON.parse(l)));
  }
  {
    const list = readShares(ROOT, { limit: 1 });
    ok('limit 生效', list.length === 1 && list[0].bvid === 'BV2', list);
  }
  {
    // 坏行不许把整本账炸掉
    writeFileSync(join(ROOT, '.qqbot', 'bili-shares.jsonl'), '{"bvid":"BV9"}\n不是 JSON\n', 'utf8');
    const list = readShares(ROOT, { limit: 5 });
    ok('坏行跳过', list.length === 1 && list[0].bvid === 'BV9', list);
  }

  // ── 封面下载：没 bvid 直接失败，不发任何请求 ──
  {
    const r = await saveCover(ROOT, '', '');
    ok('缺 bvid 明确失败', r.ok === false && !!r.error, r);
  }

  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\nB站分享 PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}

try { await main(); } catch (e) {
  if (e && typeof e === 'object' && '__verifyExit' in e) throw e;
  console.error(e);
  process.exit(1);
}
