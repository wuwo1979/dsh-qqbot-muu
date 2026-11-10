/**
 * sticker-token-bench.mjs — 表情选择策略的上下文开销实测
 *
 * 对比三档（同一批 query、同一份真实表情库）：
 *   A. 老做法：把候选 id + 完整描述 + 绝对路径塞进上下文
 *   B. 新做法：只给 id + 短标签（sticker_send 默认 compact）
 *   C. 主动配图：出站扩展直接追加图片，模型上下文 0 字符
 *
 * token 估算：CJK 字符约 1 token/字，ASCII 约 4 字符/token。
 * 这不是精确 tokenizer，但同一口径下的相对差距足够说明问题。
 *
 * 用法：node qqbot-mod/scripts/sticker-token-bench.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tool from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/sticker_send.mjs';

const ROOT = process.env.QQBOT_BENCH_ROOT || 'F:/qqbot/dshqqbot';
const QUERIES = ['无语', '开心 猫', '累 躺', '晚安', '震惊', '吃饭', '害羞', '吐槽 群聊', '工作 摸鱼', '加油'];

function estimateTokens(s) {
  let cjk = 0;
  let ascii = 0;
  for (const ch of String(s || '')) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
    else ascii += 1;
  }
  return cjk + Math.ceil(ascii / 4);
}

function loadItems() {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, '表情包', 'index.json'), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : []);
  } catch { return []; }
}

/** 模型实际拿到的 tool 结果 = msg + data（两部分都会进上下文） */
function payloadOf(r) {
  return String(r?.msg || '') + '\n' + JSON.stringify(r?.data || {});
}

async function main() {
  const items = loadItems();
  if (!items.length) {
    console.error('读不到表情库：' + ROOT);
    process.exit(2);
  }
  const rows = [];
  for (const q of QUERIES) {
    const compact = await tool.run({ query: q, limit: 3 }, { dataRoot: ROOT });
    const pathMode = compact.ok ? await tool.run({ query: q, limit: 3, mode: 'path' }, { dataRoot: ROOT }) : compact;
    if (!compact.ok) { rows.push({ q, ok: false }); continue; }
    const picks = pathMode.data?.candidates || [];
    const oldText = payloadOf(pathMode);
    const newText = payloadOf(compact);
    rows.push({
      q,
      ok: true,
      n: picks.length,
      oldChars: oldText.length,
      newChars: newText.length,
      oldTok: estimateTokens(oldText),
      newTok: estimateTokens(newText),
      ids: picks.map((p) => p.id).join(','),
    });
  }

  const good = rows.filter((r) => r.ok);
  const sumOld = good.reduce((a, r) => a + r.oldChars, 0);
  const sumNew = good.reduce((a, r) => a + r.newChars, 0);
  const tokOld = good.reduce((a, r) => a + r.oldTok, 0);
  const tokNew = good.reduce((a, r) => a + r.newTok, 0);

  console.log('表情库：%d 张 · query %d 个（命中 %d）', items.length, QUERIES.length, good.length);
  console.log('query'.padEnd(10), '候'.padEnd(3), '旧字符'.padEnd(8), '新字符'.padEnd(8), '旧tok'.padEnd(7), '新tok');
  for (const r of rows) {
    if (!r.ok) { console.log(r.q.padEnd(10), '无命中'); continue; }
    console.log(r.q.padEnd(10), String(r.n).padEnd(3), String(r.oldChars).padEnd(8), String(r.newChars).padEnd(8), String(r.oldTok).padEnd(7), String(r.newTok));
  }
  const pct = sumOld ? Math.round(((sumOld - sumNew) / sumOld) * 100) : 0;
  console.log('合计：旧 %d 字符 / %d tok → 新 %d 字符 / %d tok，省 %d%% 字符、%d%% token',
    sumOld, tokOld, sumNew, tokNew, pct, tokOld ? Math.round(((tokOld - tokNew) / tokOld) * 100) : 0);
  console.log('单次平均：旧 %d tok → 新 %d tok；主动配图路径 0 tok',
    good.length ? Math.round(tokOld / good.length) : 0,
    good.length ? Math.round(tokNew / good.length) : 0);
}

main();
