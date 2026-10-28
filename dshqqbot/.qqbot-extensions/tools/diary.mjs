/**
 * tools/diary.mjs — 伪日记工具
 *   action=generate 写一篇今天的日记（默认）
 *   action=list     看最近几篇
 *   action=append   手写一条（要 text）
 */
import * as Diary from '../lib/diary.mjs';

export const name = 'diary';
export const description =
  '写/看小蓝的伪日记。generate=根据记忆与当天聊天写一篇（默认）；list=最近几篇；append=手写一条。只在主人问「写日记/今天记了什么」或自己确实想记时用。';

export const inputSchema = {
  action: { type: 'string', required: true, enum: ['generate', 'list', 'append'], description: 'generate 写一篇；list 看最近；append 手写' },
  text: { type: 'string', description: 'append 的正文（generate 不用）' },
  date: { type: 'string', description: '可选：YYYY-MM-DD（generate/list）' },
  limit: { type: 'number', description: 'list 条数，默认 7' },
  scope: { type: 'string', description: '可选：只用这个会话的记忆生成' },
};

function dataRootOf(env) {
  return String((env && (env.caps && env.caps.dataRoot)) || process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot');
}

export async function run(args = {}, env = {}) {
  const dataRoot = dataRootOf(env);
  const action = String(args.action || 'generate');
  try {
    if (action === 'list') {
      const rows = Diary.listDiary(dataRoot, { limit: Number(args.limit) || 7, date: args.date || '' });
      return { ok: true, count: rows.length, rows, msg: rows.length ? rows.map((r) => `${r.at || ''} ${String(r.text).slice(0, 60)}`).join('\n') : '还没写过日记' };
    }
    if (action === 'append') {
      const r = Diary.appendDiary(dataRoot, { text: args.text, source: 'manual' });
      return r.ok ? { ok: true, file: r.file, msg: '日记写好了' } : { ok: false, error: r.error };
    }
    const r = await Diary.generateDiary(dataRoot, { date: args.date || new Date(), scope: args.scope || '' });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, text: r.text, via: r.via, file: r.file, msg: `日记写好了（${r.via}）：\n${r.text}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default { name, description, inputSchema, run, expose: 'all' };
