/**
 * tools/surf.mjs — 逛网站并记下来
 *   action=read  读一个网址，存标题+摘要；learn=true 时把她自己的收获写进记忆
 *   action=list  看最近逛过什么
 */
import { readPage, recordVisit, listVisits, learnFromVisit } from '../lib/surf.mjs';

export const name = 'surf';
export const description =
  '逛网页：read=读网址并存标题/摘要（可顺手学一点）；list=最近逛过什么。主人让你看某个网页、或你自己想查资料并用上时用。';

export const inputSchema = {
  action: { type: 'string', required: true, enum: ['read', 'list'], description: 'read 读网页；list 看记录' },
  url: { type: 'string', description: 'read 的 http(s) 网址' },
  note: { type: 'string', description: 'read 可选：你自己的收获（learn=true 时写进记忆）' },
  learn: { type: 'boolean', description: 'read 时是否把 note 写进记忆' },
  q: { type: 'string', description: 'list 可选：搜索词' },
  limit: { type: 'number', description: 'list 条数，默认 20' },
};

function dataRootOf(env) {
  return String((env && (env.caps && env.caps.dataRoot)) || process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot');
}

export async function run(args = {}, env = {}) {
  const dataRoot = dataRootOf(env);
  try {
    if (String(args.action || 'read') === 'list') {
      const rows = listVisits(dataRoot, { limit: Number(args.limit) || 20, q: args.q || '' });
      return { ok: true, count: rows.length, rows, msg: rows.length ? rows.map((r) => `${r.at || ''} ${r.title || r.url}`).join('\n') : '还没逛过什么' };
    }
    if (!args.url) return { ok: false, error: '缺少 url' };
    const r = await readPage(args.url, { maxChars: 6000 });
    if (!r.ok) return { ok: false, error: r.error };
    recordVisit(dataRoot, { url: r.url, title: r.title, text: r.text, note: args.note || '' });
    let learned = null;
    if (args.learn === true && args.note) learned = await learnFromVisit(dataRoot, { url: r.url, title: r.title, note: args.note });
    return {
      ok: true, url: r.url, title: r.title, excerpt: r.text.slice(0, 1200),
      learned: learned ? learned.ok : false,
      msg: `看完了：${r.title || r.url}\n${r.text.slice(0, 600)}${learned?.ok ? '\n（这条收获已记下）' : ''}`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default { name, description, inputSchema, run, expose: 'all' };
