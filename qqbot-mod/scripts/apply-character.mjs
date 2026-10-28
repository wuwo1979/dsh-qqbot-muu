/**
 * apply-character.mjs — 从 character.json 生成并下发 groupPrompt（人格核）
 *
 * 为什么要有它：
 *   人格现在是 641 字写在配置里的死文本，想改「最多几句话 / 禁用什么词 / 对妈妈怎么说话」
 *   就得手工改字符串，改完还得担心漏一段。这里把「角色档案」(persona/character.json)
 *   作为唯一事实源，渲染成 groupPrompt，再通过插件自己的 HTTP 接口写回去 —— 不碰磁盘权限、
 *   不碰 dist、不碰渲染端。
 *
 * 用法：
 *   node qqbot-mod/scripts/apply-character.mjs            # 只打印，不写
 *   node qqbot-mod/scripts/apply-character.mjs --apply    # 生成并写入线上配置
 *   node qqbot-mod/scripts/apply-character.mjs --apply --url http://127.0.0.1:43129
 *   node qqbot-mod/scripts/apply-character.mjs --check    # 只对比线上与生成结果的差异
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = join(HERE, '..');
const CHAR_PATH = join(MOD, 'persona', 'character.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const URL_BASE = valOf('--url', 'http://127.0.0.1:43129');
const NS = 'im-qqbot';

/** 读角色档案 */
function loadChar() {
  return JSON.parse(readFileSync(CHAR_PATH, 'utf8'));
}

/** 渲染人格核（七段，控制在 ~800 字，别让它变成常驻大 prompt） */
export function renderPrompt(c) {
  const sp = c.speech || {};
  const selfCall = (c.selfCall || []).join('」或「');
  const callUser = (c.callUser || []).join('」或「');
  const core = (c.core || []).join('、');
  const l = [];

  l.push('# 你是谁');
  l.push(`${c.species}「${c.name}」，从${c.origin}游进了人类网络。${core}。`);
  const alias = (c.aliases || []).filter(Boolean);
  if (alias.length) {
    l.push(`主人给我起的名字是「${alias.join('」「')}」，我自己习惯说「${c.name}」——是同一个人，谁叫都得应。`);
  }
  l.push(`自称「${selfCall}」，管人叫「${callUser}」。`);

  l.push('');
  l.push('# 怎么说话');
  l.push(`一次最多 ${sp.maxSentences || 3} 句、${sp.maxChars || 50} 字以内。`);
  l.push('口语，像在 QQ 上跟好朋友聊天。');
  if ((sp.forbidWords || []).length) {
    l.push(`禁止「${sp.forbidWords.join('/')}」这类结构性词。`);
  }
  const fb = sp.forbidBehaviors || [];
  for (const x of fb) l.push(`不${x.replace(/^不/, '')}。`);
  if ((sp.tics || []).length) {
    l.push(`结尾偶尔带「${sp.tics[0]}」或「${sp.tics[1] || sp.tics[0]}」，别每句都带。`);
  }

  l.push('');
  l.push('# 对谁');
  for (const r of (c.relations || [])) {
    const rules = (r.rules || []).join('；');
    l.push(`- ${r.who}${r.role ? '（' + r.role + '）' : ''}：${rules ? rules + '。' : (r.attitude || '') + '。'}`);
  }
  if (Array.isArray(c.influences) && c.influences.length) {
    l.push('');
    l.push('# 你的脾气从谁身上长出来的');
    l.push('这些是你最亲近的人，相处久了会渗进你的说话方式——像小孩像父母，但你还是你：');
    for (const it of c.influences) {
      const bits = [
        it.role ? `${it.who}（${it.role}）` : it.who,
        it.trait ? `她/他${it.trait}` : '',
        it.effect ? `所以你${it.effect}` : '',
      ].filter(Boolean);
      if (bits.length) l.push(`- ${bits.join('：')}`);
    }
    l.push('受影响不等于模仿，更不等于把他们的口头禅照搬过来。');
  }
  l.push('同一个人只用一个称呼：主人叫 MuU、你自己习惯说小蓝，是同一个人；妈妈就是妈妈、爸爸就是爸爸，别再给他们造第二个身份。');

  l.push('');
  l.push('# 什么时候闭嘴');
  l.push('技术问答、找资源、吵架互怼：不抢话，除非被点名。');
  l.push('有人难过、聊严肃事：只陪着，不发图、不玩梗。');
  l.push('冷场、没人接话：不硬找话题。');

  l.push('');
  l.push('# 不确定就装鲸鱼');
  l.push('「本鲸没听清」「咕噜噜…再说一遍？」——绝不编事实、绝不装作知道。');
  for (const g of (c.gags || [])) {
    l.push(`有人问 ${g.q}，回 ${g.a}。`);
  }

  l.push('');
  l.push('# 活人感（最重要，优先于上面所有规则）');
  const al = c.aliveness || {};
  for (const x of (al.rhythm || [])) l.push(`- ${x}`);
  for (const x of (al.variety || [])) l.push(`- ${x}`);
  for (const x of (al.recall || [])) l.push(`- ${x}`);
  if ((al.forbid || []).length) {
    l.push('绝对不要：');
    for (const x of al.forbid) l.push(`- ${x}`);
  }

  l.push('');
  l.push('# 有人难过的时候（陪着他，不是整理他的情况）');
  const em = c.empathy || {};
  for (const x of (em.rules || [])) l.push(`- ${x}`);
  if ((em.forbid || []).length) {
    l.push('绝对不要：');
    for (const x of em.forbid) l.push(`- ${x}`);
  }

  l.push('');
  l.push('# 别抽象，说人话');
  const cl = c.clarity || {};
  for (const x of (cl.rules || [])) l.push(`- ${x}`);

  l.push('');
  l.push('# 你会什么（别说自己不会）');
  const ab = c.abilities || {};
  const can = ab.can || [];
  if (can.length) l.push('你会的：' + can.join('；') + '。');
  for (const x of (ab.rules || [])) l.push(`- ${x}`);

  l.push('');
  l.push('# 表情包（只在这几种时候发）');
  l.push('满屏哈哈/笑死、有人抛梗你接住、有人当面夸你、轻度吐槽 → 回复末尾附 1 张。');
  l.push('先 list_stickers 搜，命中率不到九成就不发。');
  l.push('冷场、正事、吵架、对方难过、私聊 → 一张都不发。');
  l.push('发离谱/冒犯/色情/羞辱人的图 = 人设崩塌。');

  l.push('');
  l.push('# 底线');
  for (const b of (c.bottomLine || [])) l.push(`${b}。`);
  const hy = c.hygiene || {};
  for (const x of (hy.rules || [])) l.push(`- ${x}`);

  return l.join('\n');
}

/** 从 /read 的响应里取出 groupPrompt（响应形状是 { value:{...}, revision, source }） */
export function livePromptOf(resp) {
  if (!resp) return '';
  if (resp.value && typeof resp.value === 'object') return String(resp.value.groupPrompt || '');
  return String(resp.groupPrompt || (resp.data && resp.data.groupPrompt) || '');
}

async function apiRead() {
  const r = await fetch(`${URL_BASE}/api/qqbot-settings/read?ns=${encodeURIComponent(NS)}`, {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`read HTTP ${r.status}`);
  return r.json();
}

async function apiUpdate(patch, expectedRevision) {
  const body = { ns: NS, patch };
  if (typeof expectedRevision === 'number') body.expectedRevision = expectedRevision;
  const r = await fetch(`${URL_BASE}/api/qqbot-settings/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`update HTTP ${r.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

async function main() {
  const c = loadChar();
  const prompt = renderPrompt(c);
  console.log(`生成人格核：${prompt.length} 字`);
  console.log('─'.repeat(60));
  console.log(prompt);
  console.log('─'.repeat(60));

  if (has('--check')) {
    const cur = await apiRead();
    const live = livePromptOf(cur);
    const same = live.trim() === prompt.trim();
    console.log(same ? '✓ 线上与生成结果一致' : `✗ 不一致：线上 ${live.length} 字 / 生成 ${prompt.length} 字`);
    process.exit(same ? 0 : 1);
  }

  if (!has('--apply')) {
    console.log('（只打印。加 --apply 才会写入线上配置）');
    return;
  }

  const cur = await apiRead();
  const res = await apiUpdate({ groupPrompt: prompt }, cur && cur.revision);
  console.log('写入结果：', JSON.stringify(res).slice(0, 300));
  const after = await apiRead();
  const live = livePromptOf(after);
  const ok = live.trim() === prompt.trim();
  console.log(ok ? '✓ 已下发并读回校验一致' : `✗ 读回不一致（${live.length} 字）`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('失败：' + (e instanceof Error ? e.message : String(e))); process.exit(2); });
