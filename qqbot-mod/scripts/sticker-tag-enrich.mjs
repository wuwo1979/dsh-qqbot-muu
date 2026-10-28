#!/usr/bin/env node
/**
 * sticker-tag-enrich.mjs — 给已有标签的表情包补「标准化情绪标签」v2（2026-10-28）
 *
 * v1 教训：直接让 qwen2.5vl:3b 看图选情绪词，极性经常反（疲惫图给「开心」）。
 * v2 改两段式：
 *   ① 已有 desc 的（86/86 非垃圾位都有）：直接用文本模型 qwen2.5:7b 从
 *      「描述+原标签」分类情绪——描述是之前视觉模型写的，里面"疲惫或无奈"
 *      这类词足够判断，且文本模型对极性远比 3B VL 靠谱；
 *   ② 没有 desc 的：先 VL 自由描述一段，再走 ①。
 *
 * 原标签一个不动，新情绪词去重后追加（总量封顶 12）。固定词表让查询端的
 * 「无语」「晚安」能和库里的标签撞上同一个词。
 *
 * 用法：
 *   node sticker-tag-enrich.mjs --dry          # 只看会补什么，不写
 *   node sticker-tag-enrich.mjs                # 全量（candidate+library）
 *   node sticker-tag-enrich.mjs --limit 10
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';

const DIR = process.argv.find((a) => a.startsWith('--dir='))?.slice(6) || 'F:/qqbot/dshqqbot/表情包';
function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : '';
}
const LIMIT = Number(argValue('--limit')) || 999;
const DRY = process.argv.includes('--dry');

const TEXT_MODEL = process.env.STICKER_TEXT_MODEL || 'qwen2.5:7b';
const VL_MODEL = process.env.STICKER_VISION_MODEL || 'qwen2.5vl:3b';
const HOST = (() => {
  let h = String(process.env.OLLAMA_HOST || '').trim().replace(/\/+$/, '');
  if (!h) h = 'http://127.0.0.1:11434';
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  h = h.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, '$1127.0.0.1');
  if (!/:\d+$/.test(h)) h += ':11434';
  return h;
})();

/** 标准情绪词表：检索端的常用说法都在里面；要加词改这一行 */
const EMOTIONS = [
  '开心', '大笑', '无语', '尴尬', '委屈', '想哭', '生气', '惊讶', '害怕',
  '累', '躺平', '得意', '疑惑', '吃瓜', '晚安', '睡觉', '吃饭', '加油',
  '拒绝', '赞同', '思考', '害羞', '嚣张', '无奈', '期待', '心疼', '震惊',
];
const MAX_TAGS = 12;

const CLASSIFY_PROMPT =
  '你是表情包库的管理员。下面是一张表情包的描述和已有标签，请从固定词表里选出最符合它情绪/含义的 1-2 个词。\n' +
  '规则：图上人物疲惫/无奈/崩溃绝不选开心大笑；嚣张炫耀选得意或嚣张；只选词表里的词；宁少勿多。\n' +
  '词表：' + EMOTIONS.join(',') + '\n只输出词，逗号分隔，不要解释。\n\n';

function looksDegenerate(text) {
  const t = String(text || '').trim();
  if (!t || !/[\u4e00-\u9fa5]/.test(t)) return true;
  const head = t.slice(0, 40);
  const chars = {};
  for (const ch of head) chars[ch] = 1 + (chars[ch] || 0);
  return Math.max(...Object.values(chars)) / head.length > 0.6;
}

async function chat(model, prompt, imgB64, attempt = 0, numPredict = 64) {
  const msg = { role: 'user', content: prompt };
  if (imgB64) msg.images = [imgB64];
  const body = {
    model,
    stream: false,
    keep_alive: '10m',
    messages: [msg],
    options: {
      temperature: [0.2, 0.5, 0.7][attempt] || 0.7,
      seed: attempt === 0 ? 7 : attempt * 131 + 7,
      num_predict: numPredict,
      repeat_penalty: 1.1,
    },
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    const res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return { text: String(data?.message?.content || '').trim() };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 从描述文本分类情绪（文本模型，比 3B VL 的极性判断可靠） */
async function emotionsFromDesc(desc, oldTags) {
  const input = `【描述】${desc}\n【已有标签】${(oldTags || []).join('/') || '无'}`;
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await chat(TEXT_MODEL, CLASSIFY_PROMPT + input, null, attempt);
    if (r.error) { lastErr = r.error; continue; }
    if (!looksDegenerate(r.text)) {
      const words = String(r.text).split(/[,，、\s]+|【[^】]*】/g).map((x) => x.trim()).filter(Boolean);
      const valid = words.filter((w) => EMOTIONS.includes(w));
      if (valid.length) return [...new Set(valid)].slice(0, 2);
      lastErr = '没认出词表词: ' + r.text.slice(0, 80);
    } else lastErr = '退化输出';
  }
  console.warn(`  ! 分类失败：${lastErr}`);
  return [];
}

/** 没有 desc 时：VL 自由描述一段（复用主 CLI 的宽松思路） */
async function describeByVL(file) {
  const buf = readFileSync(file);
  if (buf.length > 8 * 1024 * 1024) return '';
  const imgB64 = buf.toString('base64');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await chat(VL_MODEL, '用一句简体中文描述这张表情包：画面内容、人物情绪、图上文字。不要分点。', imgB64, attempt, 96);
    // looksDegenerate=true 表示文本退化（乱码/无汉字），这里要的是「没出错且不退化」
    if (!r.error && r.text && !looksDegenerate(r.text)) return String(r.text).slice(0, 200);
  }
  return '';
}

// ── 主流程 ─────────────────────────────────────────────
const indexFile = join(DIR, 'index.json');
const j = JSON.parse(readFileSync(indexFile, 'utf8'));
const items = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : []);
const todo = items
  .filter((it) => it && (it.layer === 'candidate' || it.layer === 'library') && !it.removed)
  .slice(0, LIMIT);

console.log(`情绪标签增强 v2：${todo.length} 张（词表 ${EMOTIONS.length} 词，分类模型 ${TEXT_MODEL}）${DRY ? ' · dry-run' : ''}`);
let ok = 0, noadd = 0, fail = 0;
for (const [i, it] of todo.entries()) {
  const ext = String(it.ext || 'jpg').replace(/^\./, '');
  const file = join(DIR, 'lib', String(it.layer || 'candidate'), `${it.id}.${ext}`);
  if (!existsSync(file)) { fail += 1; continue; }
  let desc = String(it.desc || it.descZh || '').trim();
  if (!desc) {
    // eslint-disable-next-line no-await-in-loop
    desc = await describeByVL(file);
    if (desc && !DRY) it.desc = desc;
  }
  if (!desc) { fail += 1; console.log(`- [${i + 1}/${todo.length}] ${it.id} 没有描述也没法生成，跳过`); continue; }
  const old = Array.isArray(it.tags) ? it.tags : [];
  // eslint-disable-next-line no-await-in-loop
  const emo = await emotionsFromDesc(desc, old);
  const add = emo.filter((w) => !old.some((t) => String(t).includes(w) || w.includes(String(t))));
  if (!add.length) { noadd += 1; console.log(`- [${i + 1}/${todo.length}] ${it.id} 无新增（${old.slice(0, 3).join('/')}）`); continue; }
  console.log(`- [${i + 1}/${todo.length}] ${it.id} +[${add.join(',')}]  原:[${old.join('/') || '无'}]`);
  ok += 1;
  if (!DRY) it.tags = [...old, ...add].slice(0, MAX_TAGS);
}

if (!DRY && ok > 0) {
  const out = JSON.stringify(j, null, 1);
  const tmp = indexFile + '.tmp-enrich';
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, indexFile);
  console.log(`\n已写回 ${indexFile}（原子替换，补了 ${ok} 张）`);
} else {
  console.log(`\n${DRY ? 'dry-run，未写。' : ''}新增 ${ok}，无新增 ${noadd}，失败 ${fail}`);
}
