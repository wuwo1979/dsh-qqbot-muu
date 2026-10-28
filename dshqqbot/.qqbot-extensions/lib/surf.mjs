/**
 * lib/surf.mjs — 逛网站的小本子
 *
 * 记录她看过什么（URL/标题/摘要/时间），并把"值得记的一点"写进记忆。
 * 不做整页存档（省空间/隐私），只留标题 + 600 字摘要 + 她自己提炼的一句。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { remember } from './memory.mjs';

export function surfFile(dataRoot) {
  return join(String(dataRoot || '.'), '.qqbot', 'surf.jsonl');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

export async function readPage(url, { timeoutMs = 20000, maxChars = 4000 } = {}) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只支持 http/https 网址' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; qqbot-muu/1.0)' }, signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/json/i.test(type)) return { ok: false, error: `不是网页（${type}）` };
    const raw = (await res.text()).slice(0, 200000);
    const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
    const text = stripHtml(raw).slice(0, maxChars);
    return { ok: true, url: u, title: title.slice(0, 120), text, type };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function recordVisit(dataRoot, { url, title = '', text = '', note = '', ts = Date.now() } = {}) {
  const u = String(url || '').trim();
  if (!u) return { ok: false, error: '缺少 url' };
  try {
    mkdirSync(join(String(dataRoot || '.'), '.qqbot'), { recursive: true });
    const row = {
      ts, at: new Date(ts).toISOString(), url: u,
      title: String(title || '').slice(0, 120),
      excerpt: String(text || '').replace(/\s+/g, ' ').slice(0, 600),
      note: String(note || '').slice(0, 200),
    };
    appendFileSync(surfFile(dataRoot), JSON.stringify(row) + '\n', 'utf8');
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function listVisits(dataRoot, { limit = 20, q = '' } = {}) {
  try {
    const p = surfFile(dataRoot);
    if (!existsSync(p)) return [];
    const ql = String(q || '').toLowerCase();
    const rows = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
    return rows.filter((r) => !ql || JSON.stringify(r).toLowerCase().includes(ql)).slice(-Math.max(1, Number(limit) || 20)).reverse();
  } catch { return []; }
}

/** 把她自己写的一句"学到什么"写进记忆；不写原文。 */
export async function learnFromVisit(dataRoot, { url, note, title = '' } = {}) {
  const n = String(note || '').trim();
  if (!n) return { ok: false, error: '缺少 note（她自己的收获）' };
  try {
    await remember(dataRoot, 'surf', { text: `在${title || url}看到：${n}`.slice(0, 300), kind: 'fact' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default { surfFile, readPage, recordVisit, listVisits, learnFromVisit };
