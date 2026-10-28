/**
 * sticker-send-test.mjs — 表情检索/发送闭环（本地索引解析 + 语义排序 + 直发）
 *
 * 盯的两件事：
 *   · 模型只吐裸文件名时，能不能靠谱地解析成真实文件；
 *   · 检索不到时绝不编造文件名，发送失败要说清原因。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadIndex, resolveToken, search, lexicalScore,
} from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/sticker-resolve.mjs';
import tool from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/sticker_send.mjs';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-stickersend';
const A = 'c36d2851221a';
const B = '0077253deef5';
const C = 'aabbccddeeff';
const GID = 'GROUP_OPENID_1234567890';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

function seed() {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  const lib = join(ROOT, '表情包', 'lib');
  mkdirSync(join(lib, 'library'), { recursive: true });
  mkdirSync(join(lib, 'candidate'), { recursive: true });
  writeFileSync(join(lib, 'library', A + '.jpg'), 'x');
  writeFileSync(join(lib, 'candidate', B + '.png'), 'x');
  writeFileSync(join(lib, 'candidate', C + '.gif'), 'x');
  writeFileSync(join(ROOT, '表情包', 'index.json'), JSON.stringify({
    version: 1,
    items: [
      { id: A, layer: 'library', ext: 'jpg', hash: A + 'ffff', tags: ['无语'], desc: '一只无语的猫' },
      { id: B, layer: 'candidate', ext: 'png', hash: B + 'eeee', tags: ['笑哭'], desc: '笑到流泪' },
      { id: C, layer: 'candidate', ext: 'gif', hash: C + 'dddd', tags: ['晚安'], desc: '钻被窝睡觉' },
    ],
  }), 'utf8');
}

function fakeQQ(sendOk = true) {
  return {
    groups: [{ name: '测试群', openid: GID }],
    c2c: [{ name: '主人', openid: 'C2C_OPENID_1234567890' }],
    sendImage: async () => sendOk,
    sendText: async () => true,
  };
}

async function main() {
  seed();
  const libA = join(ROOT, '表情包', 'lib', 'library', A + '.jpg').replace(/\\/g, '/');
  const libC = join(ROOT, '表情包', 'lib', 'candidate', C + '.gif').replace(/\\/g, '/');

  ok('索引读进来', loadIndex(ROOT).items.length === 3);
  ok('按 id 解析', resolveToken(ROOT, A).path === libA.replace(/\//g, '\\') || resolveToken(ROOT, A).path === libA, resolveToken(ROOT, A));
  ok('按 id.ext 解析', resolveToken(ROOT, A + '.jpg').ok === true);
  ok('按 hash 前缀解析', resolveToken(ROOT, A.slice(0, 8)).ok === true);
  ok('按绝对路径解析', resolveToken(ROOT, libA).ok === true);
  ok('按标签解析', resolveToken(ROOT, '无语').ok === true);
  ok('不存在的 id 明确失败', resolveToken(ROOT, 'zzzzzzzzzz').ok === false);
  ok('空 token 明确失败', resolveToken(ROOT, '').ok === false);

  ok('关键词打分命中', lexicalScore('无语', { tags: ['无语'], desc: '' }) > 0.9);
  ok('关键词打分不命中', lexicalScore('风景', { tags: ['无语'], desc: '' }) === 0);

  {
    const picks = await search(ROOT, '无语', { limit: 2 });
    ok('本地检索返回候选', picks.length >= 1 && picks[0].item.id === A, picks.map((p) => p.item.id));
    ok('候选都指向真实文件', picks.every((p) => p.path.endsWith('.' + (p.item.ext || 'jpg'))));
  }
  {
    const picks = await search(ROOT, '无语', {
      limit: 2,
      semantic: async () => ([{ item: { id: C, layer: 'candidate', ext: 'gif' }, score: 0.99 }]),
    });
    ok('语义结果参与合并', picks.some((p) => p.item.id === C), picks.map((p) => p.item.id));
  }
  {
    const picks = await search(ROOT, '无语', { layer: 'library' });
    ok('layer 过滤', picks.every((p) => p.item.layer === 'library'), picks.map((p) => p.item.layer));
  }

  // ── 工具：只检索不发送 ──
  {
    const r = await tool.run({ id: A }, { dataRoot: ROOT, qq: fakeQQ() });
    ok('工具按 id 返回标记', r.ok === true && r.msg.includes('[MEDIA:image|') && r.data.candidates[0].id === A, r.msg);
  }
  {
    const r = await tool.run({ query: '无语' }, { dataRoot: ROOT, qq: fakeQQ() });
    ok('工具按语义检索', r.ok === true && r.data.candidates.length >= 1, r.msg);
  }
  {
    // 空库：语义/关键词都拿不到候选时必须明确说没有，绝不编造文件名
    const EMPTY = ROOT + '-empty';
    mkdirSync(join(EMPTY, '表情包'), { recursive: true });
    writeFileSync(join(EMPTY, '表情包', 'index.json'), JSON.stringify({ version: 1, items: [] }), 'utf8');
    const r = await tool.run({ query: '完全不存在的画面' }, { dataRoot: EMPTY, qq: fakeQQ() });
    ok('检索不到时不编造', r.ok === false && /没有匹配/.test(r.msg), r.msg);
    rmSync(EMPTY, { recursive: true, force: true });
  }
  {
    const r = await tool.run({}, { dataRoot: ROOT, qq: fakeQQ() });
    ok('缺 query/id 明确报错', r.ok === false && /query|id/.test(r.msg), r.msg);
  }

  // ── 工具：直接发送 ──
  {
    const r = await tool.run({ id: C, target: GID, scope: 'group', caption: '晚安' }, { dataRoot: ROOT, qq: fakeQQ(true) });
    ok('直发成功', r.ok === true && r.data.sentId === C, r.msg);
  }
  {
    const r = await tool.run({ id: A, target: GID, scope: 'group' }, { dataRoot: ROOT, qq: fakeQQ(false) });
    ok('QQ 拒绝时明确失败', r.ok === false && /没发出去/.test(r.msg), r.msg);
    ok('失败时仍给出兜底标记', r.msg.includes('[MEDIA:image|'), r.msg);
  }
  {
    const r = await tool.run({ id: A, target: '测试群' }, { dataRoot: ROOT, qq: fakeQQ(true) });
    ok('按唯一群名解析目标', r.ok === true, r.msg);
  }
  {
    const r = await tool.run({ id: A, target: '不存在的群' }, { dataRoot: ROOT, qq: fakeQQ(true) });
    ok('解析不到目标明确失败', r.ok === false && /找不到/.test(r.msg), r.msg);
  }
  {
    const r = await tool.run({ id: A, target: GID }, { dataRoot: ROOT, qq: null });
    ok('没有发送能力时明确失败', r.ok === false && /发送能力/.test(r.msg), r.msg);
  }
  {
    const r = await tool.run({ id: A }, { dataRoot: '', qq: fakeQQ() });
    ok('没有数据根时明确失败', r.ok === false && /数据根/.test(r.msg), r.msg);
  }
  ok('文件路径带盘符', libC.includes(':/'));

  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\nPASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

try { await main(); } catch (e) {
  if (e && typeof e === 'object' && '__verifyExit' in e) throw e;
  console.error(e);
  console.log('\nPASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
}
