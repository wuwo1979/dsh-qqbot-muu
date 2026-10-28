/**
 * lib/diary.mjs — 伪日记
 *
 * 不是"每天定时写"，而是把当天发生的事压成一篇第一人称小日记：
 *   · 数据来源：记忆库最近条目 + 当天聊天台账（可选）
 *   · 生成优先走本地小模型，失败/不可用时退回抽取式模板（绝不编事实）
 *   · 存两份：{dataRoot}/.qqbot/diary/YYYY-MM-DD.jsonl（原文）+ 记忆库 kind=diary
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listAll, remember } from './memory.mjs';
import { chat as llmChat, health as llmHealth, loadConfig as loadLlmConfig } from './local-llm.mjs';

const MAX_ENTRIES = 40;

export function diaryDir(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot', 'diary');
}
export function diaryFile(dataRoot, date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(diaryDir(dataRoot), key + '.jsonl');
}

export function appendDiary(dataRoot, { text, mood = '', tags = [], source = 'manual', ts = Date.now() } = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '日记内容为空' };
  try {
    mkdirSync(diaryDir(dataRoot), { recursive: true });
    const row = { ts, at: new Date(ts).toISOString(), text: body.slice(0, 2000), mood: String(mood || ''), tags: Array.isArray(tags) ? tags.slice(0, 8) : [], source };
    appendFileSync(diaryFile(dataRoot, ts), JSON.stringify(row) + '\n', 'utf8');
    return { ok: true, file: diaryFile(dataRoot, ts), row };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function listDiary(dataRoot, { limit = 7, date = '' } = {}) {
  const dir = diaryDir(dataRoot);
  try {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
    const pick = date ? files.filter((f) => f.startsWith(String(date))) : files;
    const rows = [];
    for (const f of pick) {
      const lines = readFileSync(join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (r && r.text) rows.push({ ...r, file: f });
        } catch { /* 坏行跳过 */ }
      }
      if (rows.length >= limit) break;
    }
    return rows.slice(-Math.max(1, Number(limit) || 7)).reverse();
  } catch {
    return [];
  }
}

function fallbackDiary(entries, dateLabel) {
  const lines = entries.map((x) => String(x.text || '').replace(/\s+/g, ' ').slice(0, 42)).filter(Boolean);
  if (!lines.length) return '';
  const picked = lines.slice(0, 3);
  return `${dateLabel}：今天记住的都是些小事。${picked.join('；')}。有点乱，但是真的。`;
}

/**
 * 生成一篇日记（不覆盖已有；追加一条）。
 * @returns {Promise<{ok:boolean, text?:string, via?:string, file?:string, error?:string}>}
 */
export async function generateDiary(dataRoot, { date = new Date(), scope = '', maxChars = 240 } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  const dateLabel = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  let entries = [];
  try {
    entries = listAll(dataRoot, { limit: MAX_ENTRIES, scopeFilter: scope || '' }) || [];
  } catch { entries = []; }
  // 只留有点内容的，别把 [跳过]/空串喂进去
  entries = entries
    .map((x) => ({ text: String(x.text || '').trim(), kind: x.kind || '', ts: x.ts || 0 }))
    .filter((x) => x.text && x.text.length >= 6 && !x.text.startsWith('[跳过'))
    .slice(0, 24);
  const today = listDiary(dataRoot, { limit: 6, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` });
  const material = [...entries, ...today.map((x) => ({ text: x.text, kind: 'diary' }))]
    .map((x, i) => `${i + 1}. ${String(x.text).slice(0, 80)}`)
    .join('\n');

  let text = '';
  let via = 'template';
  try {
    const lc = loadLlmConfig({ dataRoot });
    const h = await llmHealth(lc);
    if (h && h.ok) {
      const r = await llmChat({
        cfg: lc,
        messages: [
          { role: 'system', content: '你是一只住在深海、刚学会用人类网络的鲸鱼娘。写一篇第一人称小日记，80~160字，只写下面素材里真实出现过的事，不要编造人物和地点，不要总结成列表。语气软、口语、可以有一点笨拙。' },
          { role: 'user', content: `今天是${dateLabel}。素材：\n${material || '（今天没什么特别的）'}` },
        ],
        maxTokens: 260,
        temperature: 0.8,
      });
      if (r && r.ok && r.text) { text = r.text.trim().slice(0, maxChars); via = 'local'; }
    }
  } catch { /* 本地失败就走模板 */ }
  if (!text) text = fallbackDiary(entries, dateLabel).slice(0, maxChars);
  if (!text) return { ok: false, error: '今天还没有可写的素材' };

  const saved = appendDiary(dataRoot, { text, source: via, tags: ['auto'], ts: d.getTime() });
  if (!saved.ok) return saved;
  try {
    await remember(dataRoot, 'persona', { text: `[日记]${text}`, kind: 'diary' });
  } catch { /* 记忆写失败不影响日记文件 */ }
  return { ok: true, text, via, file: saved.file };
}

export default { diaryDir, diaryFile, appendDiary, listDiary, generateDiary };
