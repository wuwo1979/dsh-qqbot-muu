/**
 * memory-llm.mjs — 用本地小模型"过一遍"记忆（用户 2026-10-23 提的方案）
 *
 * 为什么需要它：
 *   向量召回只能保证"字面/语义相近"，不能保证"有用"。实测里常见两种噪声：
 *     ① 召回上来的其实是上一轮她自己的话（自匹配，已在 caller 侧按文本滤掉）；
 *     ② 四条记忆彼此无关，直接列成 `1. … 2. …` 塞进上下文，读起来像"念资料"，
 *        人格上也不像"我自己记得的事"。
 *   小模型（qwen2.5:7b，热态 200~300ms）正好擅长两件小事：
 *     · 判定：这几条里哪几条跟"当前这句"真的有关（丢掉噪声）；
 *     · 转写：把留下的压成**一句第一人称**的回忆（"我记得你上次说要减肥"）。
 *   于是既省 token（4 条 → 1 句），又更像活人。
 *
 * 安全契约（与其它扩展一致）：
 *   · 永不抛：任何异常/超时/模型离线都返回 {ok:false}，caller 回退到原来的编号列表；
 *   · 有硬超时（默认 1500ms）：宁可这一轮不带记忆，也不能让回复卡住；
 *   · 只**读**记忆，不写库、不删条目 —— 原始记忆永远保留。
 */

import { chat, loadConfig, health } from './local-llm.mjs';

export const DEFAULTS = {
  enabled: true,
  timeoutMs: 1500,     // 记忆这一跳的预算（热态模型 200~300ms）
  minHits: 2,          // 只有 1 条时没必要过模型（直接原文更准）
  maxChars: 60,        // 转写结果上限（一句口语）
  maxInChars: 400,     // 喂进去的记录总长上限，超了只取前几条
  model: '',           // 空 = 用 local-llm-config.json 里的 model
};

export function loadLlmRecallCfg(memCfg) {
  const raw = (memCfg && memCfg.llmRecall && typeof memCfg.llmRecall === 'object') ? memCfg.llmRecall : {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  }
  return out;
}

const SYSTEM = [
  '你在帮一个叫小蓝的鲸鱼娘回忆往事。她说话很短、很口语，像个真人。',
  '任务：从"记录"里挑出跟"当前这句"有关的，压成她自己的**一句**回忆。',
  '要求：不超过30字；第一人称；口语；不要列条目、不要编号、不要"根据记录/据说"这种说法；',
  '如果记录跟当前这句没关系，就只回两个字：无关。',
  '',
  '例：',
  '当前这句：你还记得我上次说要减肥吗',
  '记录：丙说下周开始减肥 / 甲问了天气 / 群里聊了游戏',
  '输出：记得啊，你上次说要减肥',
].join('\n');

/** 去掉小模型爱加的前后缀/列表符号/引号 */
export function tidyRecallText(s, maxChars = 60) {
  let t = String(s || '').trim();
  t = t.replace(/^```[\s\S]*?```$/g, (m) => m.replace(/```/g, ''));
  t = t.replace(/^(输出|回答|回忆)[:：]\s*/g, '');
  t = t.replace(/^\s*[-*·•]\s*/gm, '');
  t = t.replace(/^\d+[.、)]\s*/gm, '');
  t = t.replace(/[\r\n]+/g, ' ');
  t = t.replace(/^["'「『]+|["'」』]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  // 一句话回忆不需要句末句号（省一个字符，也更像聊天）
  t = t.replace(/[。.．]+$/, '').trim();
  if (t.length > maxChars) t = t.slice(0, maxChars);
  return t;
}

/** 明显是"我没法回答"的废话，一律当失败处理 */
export const REFUSAL_RE = /(无法|抱歉|作为|没有(相关)?信息|不知道|无关|记录中没有)/;

/**
 * 把召回结果压成一句"她自己的回忆"。
 *
 * @param {Array<{text:string,subj?:string,kind?:string}>} hits
 * @param {string} query 当前这句（已去掉注入块）
 * @param {object} memCfg memory-config.json 的整份配置（用它取 llmRecall 段）
 * @param {object} [env] { logger, dataRoot } 可选，只用于日志
 * @returns {Promise<{ok:boolean,text?:string,ms?:number,reason?:string}>}
 */
export async function rewriteRecall(hits, query, memCfg, env = {}) {
  const cfg = loadLlmRecallCfg(memCfg);
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  const list = Array.isArray(hits) ? hits.filter((h) => h && typeof h.text === 'string' && h.text.trim()) : [];
  if (list.length < Math.max(1, Number(cfg.minHits) || 1)) return { ok: false, reason: 'too-few-hits' };

  // 拼记录：总长有上限，多的丢掉（宁少勿滥）
  const lines = [];
  let used = 0;
  for (const h of list) {
    const one = String(h.text).replace(/\s+/g, ' ').slice(0, 120);
    const line = (h.subj ? String(h.subj).slice(0, 12) + '：' : '') + one;
    if (used + line.length > (Number(cfg.maxInChars) || 400)) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return { ok: false, reason: 'no-input' };

  // 健康检查走 5 秒缓存，不会每条都探一次；模型离线就整块跳过（不能卡住回复）
  // env.llmCfgOverride 只为测试/临时指路用（换 baseUrl、换模型、调超时）。
  let llmCfg;
  try {
    llmCfg = { ...loadConfig({ dataRoot: env.dataRoot }), ...(env.llmCfgOverride || {}) };
  } catch {
    llmCfg = { ...(env.llmCfgOverride || {}) };
  }
  try {
    const h = await health(llmCfg);
    if (!h || !h.ok || !h.hasModel) return { ok: false, reason: 'llm-offline' };
  } catch {
    return { ok: false, reason: 'health-throw' };
  }

  const started = Date.now();
  let r;
  try {
    r = await chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `当前这句：${String(query || '').slice(0, 80)}\n记录：\n${lines.map((l, i) => (i + 1) + '. ' + l).join('\n')}` },
      ],
      cfg: llmCfg,
      maxTokens: 60,
      temperature: 0.3,
      timeoutMs: Number(cfg.timeoutMs) || 1500,
      model: cfg.model || undefined,
    });
  } catch (e) {
    return { ok: false, reason: 'chat-throw:' + (e && e.message ? String(e.message).slice(0, 60) : '') };
  }
  const ms = Date.now() - started;
  if (!r || !r.ok || !r.text) return { ok: false, reason: 'chat-fail', ms };

  const text = tidyRecallText(r.text, Number(cfg.maxChars) || 60);
  if (!text) return { ok: false, reason: 'empty', ms };
  if (REFUSAL_RE.test(text)) return { ok: false, reason: 'refusal', ms, text };
  // 太短的（"嗯""记得"）没有信息量，不如用原来的列表
  if (text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length < 4) return { ok: false, reason: 'too-short', ms, text };
  return { ok: true, text, ms, used: lines.length };
}

export default { rewriteRecall, loadLlmRecallCfg, tidyRecallText, DEFAULTS, REFUSAL_RE };
