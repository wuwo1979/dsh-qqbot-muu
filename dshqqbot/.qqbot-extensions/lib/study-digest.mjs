/**
 * lib/study-digest.mjs —— 给「自我反思」用的外部学习素材摘要
 *
 * 主人 2026-10-27 的要求（原话）：
 *   「我们的小肥鱼是会自己学习完善性格和记忆的…从特别关心和网络（B站、抖音及其他网络）
 *    进行学习和自我优化，提高情感模块。」
 *
 * 这个模块只做一件事：把散在各处的**真事件**压成一段几百字的中文摘要，喂给
 * `runSelfReflection()`（产出 kind='growth' 心得 + persona growth:latest）。
 * 自己不调模型、不写库，纯读盘；任何失败都返回空摘要，绝不挡主流程。
 *
 * 素材（都是本机真数据）：
 *   1. 特别关心：`.qqbot-extensions/data/group-tiers.json` 的 priorityPeople / priority 群
 *      + `persona` 表里这些人的印象卡一句话。
 *   2. B 站：`data/bili-ops/jobs/<id>/meta.json` 的片子标题与状态、`comment-replied.json` 回复数。
 *   3. 抖音：`douyin-cookie.json` 是否存在 + `records.jsonl` 里近 7 天的 douyin 记录。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const clean = (s, n = 80) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function readJson(p, dflt = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return dflt; }
}

function readTail(p, max = 300) {
  try {
    const txt = readFileSync(p, 'utf8').trim();
    if (!txt) return [];
    return txt.split(/\r?\n/).slice(-max);
  } catch { return []; }
}

/** 印象卡（`persona` 表 card:*）/ 熟识度名字，失败返回 [] */
export async function personaCards(root) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(root, '.qqbot', 'memory.db'), { readOnly: true });
    const rows = db.prepare("SELECT ckey, cvalue, ts FROM persona WHERE ckey LIKE 'card:%'").all();
    db.close();
    return rows.map((r) => ({
      key: String(r.ckey || ''),
      name: String(r.ckey || '').slice(5).replace(/（.*?）/g, '').trim(),
      text: String(r.cvalue || '').replace(/^[^：]{0,12}：/, '').trim(),
      ts: Number(r.ts) || 0,
    }));
  } catch { return []; }
}

/** 特别关心的人（含印象卡一句话） */
export async function priorityPeople(root) {
  const t = readJson(join(root, '.qqbot-extensions', 'data', 'group-tiers.json'), {}) || {};
  const ids = (Array.isArray(t.priorityPeople) ? t.priorityPeople : []).map((x) => String(x).replace(/^(c2c:|qq:)/, ''));
  const groups = (Array.isArray(t.priority) ? t.priority : []).map(String);
  if (!ids.length && !groups.length) return { people: [], groups: [] };
  const cards = await personaCards(root);
  const people = ids.map((id) => {
    // 卡片名可能是 openid 也可是名字，正文里通常也提到 id
    const hit = cards.find((c) => c.key.includes(id)) || cards.find((c) => c.text.includes(id));
    return { id, name: hit ? hit.name || id.slice(-6) : id.slice(-6), note: hit ? clean(hit.text, 60) : '' };
  });
  return { people, groups };
}

/** 最近 B 站/抖音的学习素材（纯本地，不发请求） */
export function netLearnings(root, { days = 7 } = {}) {
  const since = Date.now() - Math.max(1, days) * 86400000;
  const lines = [];
  // ① bili-ops 任务标题（发布过的 / 最近在做的）
  try {
    const jobsDir = join(root, '..', 'data', 'bili-ops', 'jobs');
    if (existsSync(jobsDir)) {
      const rows = [];
      for (const id of readdirSync(jobsDir).slice(-60)) {
        const meta = readJson(join(jobsDir, id, 'meta.json'));
        if (!meta || !meta.title) continue;
        const at = Number(meta.updatedAt || meta.createdAt || 0);
        if (at && at < since) continue;
        rows.push({ at, title: clean(meta.title, 40), status: String(meta.status || '') });
      }
      rows.sort((a, b) => b.at - a.at);
      for (const r of rows.slice(0, 6)) lines.push(`B站片子「${r.title}」（${r.status}）`);
    }
  } catch { /* ignore */ }
  // ② 评论区回复过的条数
  try {
    const replied = readJson(join(root, '..', 'data', 'bili-ops', 'comment-replied.json'), {}) || {};
    const n = Object.keys(replied).length;
    if (n) lines.push(`B站评论区回复过 ${n} 条`);
  } catch { /* ignore */ }
  // ③ 抖音：登录态 + 近 7 天运营记录
  try {
    if (readJson(join(root, 'douyin-cookie.json'))) {
      const recs = readTail(join(root, '..', 'data', 'bili-ops', 'records.jsonl'), 300)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((x) => x && /douyin/i.test(String(x.type || '')) && Number(x.at || 0) >= since);
      lines.push(`抖音已登录${recs.length ? `，近 7 天 ${recs.length} 条运营记录` : ''}`);
    }
  } catch { /* ignore */ }
  return lines;
}

/**
 * 汇总成给 prompt 的中文摘要。
 * @returns {Promise<{text:string, people:number, learnings:number}>}
 */
export async function buildStudyDigest(root, { days = 7 } = {}) {
  const r = String(root || '').trim();
  if (!r) return { text: '', people: 0, learnings: 0 };
  let people = [];
  try { people = (await priorityPeople(r)).people || []; } catch { people = []; }
  let nets = [];
  try { nets = netLearnings(r, { days }) || []; } catch { nets = []; }
  const parts = [];
  if (people.length) {
    parts.push('特别关心的人：' + people.slice(0, 4)
      .map((p) => (p.note ? `${p.name}（${p.note}）` : p.name)).join('；'));
  }
  if (nets.length) parts.push('最近在网上做的事：' + nets.slice(0, 6).join('；'));
  return { text: parts.join('\n').slice(0, 600), people: people.length, learnings: nets.length };
}

export default { personaCards, priorityPeople, netLearnings, buildStudyDigest };
