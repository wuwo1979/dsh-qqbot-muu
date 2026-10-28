/**
 * media-fix-test.mjs — 出站媒体兜底（修「像图但没写成图」的消息）
 *
 * 真机事故：群里出现裸文件名 c36d2851221a.jpg / 0077253deef5.png，
 * 文件其实在表情库里，只是没包成 [MEDIA:image|<绝对路径>]。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixMedia, onOutbound } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/outbound/ac-media-fix.mjs';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-mediafix';
const A = 'c36d2851221a';
const B = '0077253deef5';

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
  writeFileSync(join(ROOT, '表情包', 'index.json'), JSON.stringify({
    version: 1,
    items: [
      { id: A, layer: 'library', ext: 'jpg', tags: ['无语'], desc: '一只无语的猫' },
      { id: B, layer: 'candidate', ext: 'png', tags: ['笑哭'], desc: '笑到流泪' },
    ],
  }), 'utf8');
}

function mkCtx(text, phase = 'send', kind = 'text', root = ROOT) {
  const c = { text, phase, kind, dataRoot: root, notes: [], rewritten: null };
  c.rewrite = (t) => { c.rewritten = String(t); c.text = String(t); };
  c.note = (m) => { c.notes.push(String(m)); };
  return c;
}

async function main() {
  seed();

  const pathA = join(ROOT, '表情包', 'lib', 'library', A + '.jpg').replace(/\\/g, '/');

  {
    const r = fixMedia('热场的来了\n' + A + '.jpg', ROOT);
    ok('裸文件名 → 媒体标记', r.text.includes('[MEDIA:image|' + pathA + ']'), r.text);
    ok('裸文件名不单独占一行', !/(^|\n)\s*c36d2851221a\.jpg/.test(r.text), r.text);
    ok('修复计数 1', r.fixed === 1 && r.dropped === 0, r);
  }
  {
    const r = fixMedia('看这个 deadbeefdead.jpg', ROOT);
    ok('解析不到的裸文件名被删', !r.text.includes('deadbeefdead'), r.text);
    ok('丢弃计数 1', r.dropped === 1, r);
  }
  {
    const r = fixMedia('[[MEDIA:image|' + pathA + ']]', ROOT);
    ok('双层方括号 → 单层', r.text === '[MEDIA:image|' + pathA + ']', r.text);
  }
  {
    const r = fixMedia('MEDIA:image|' + pathA, ROOT);
    ok('漏方括号 → 补成媒体标记', r.text === '[MEDIA:image|' + pathA + ']', r.text);
  }
  {
    const good = '看这个 [MEDIA:image|' + pathA + ']';
    const r = fixMedia(good, ROOT);
    ok('正常媒体标记不动', r.text === good && r.fixed === 0, r);
  }

  // ── 出站钩子 ──
  {
    const c = mkCtx('来张图\n' + B + '.png');
    let nexted = 0;
    await onOutbound(c, async () => { nexted += 1; });
    const pathB = join(ROOT, '表情包', 'lib', 'candidate', B + '.png').replace(/\\/g, '/');
    ok('send/text 阶段被改写', c.text.includes('[MEDIA:image|' + pathB + ']'), c.text);
    ok('改写后继续 next', nexted === 1 && c.notes.length === 1);
  }
  {
    const c = mkCtx(A + '.jpg', 'turnEnd');
    await onOutbound(c, async () => {});
    ok('非 send 阶段不处理', c.rewritten === null && c.text === A + '.jpg');
  }
  {
    const c = mkCtx(A + '.jpg', 'send', 'media');
    await onOutbound(c, async () => {});
    ok('媒体消息不处理', c.rewritten === null);
  }
  {
    const c = mkCtx('一句普通中文，没有图');
    await onOutbound(c, async () => {});
    ok('无媒体关键词直通', c.rewritten === null);
  }

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
