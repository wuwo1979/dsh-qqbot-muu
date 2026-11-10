/**
 * live/persona.mjs — 直播口吻生成（人设短句 + 严格 token 预算）
 *
 * 普通聊天由本地模型/主链路处理；直播要求低延迟，因此只在高价值事件上走云端，
 * 输入固定为「人设摘要 + 单条事件」，不拼历史，不拼长规则。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSecret } from '../lib/bili-ops.mjs';
import { cloudChat } from '../lib/script-writer.mjs';
import { EVENT_TYPES } from './event-model.mjs';
import { estimateTokens, pickTemplate, sanitizeReply } from './reply-policy.mjs';

let cache = { at: 0, dataRoot: '', brief: null };

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function loadPersona(dataRoot) {
  const now = Date.now();
  if (cache.brief && cache.dataRoot === String(dataRoot) && now - cache.at < 300000) return cache.brief;
  const dr = String(dataRoot || '');
  const candidates = [
    String(process.env.QQBOT_PERSONA_FILE || '').trim(),
    join(dr, '..', 'qqbot-mod', 'persona', 'character.json'),
    'F:/qqbot/qqbot-mod/persona/character.json',
    join(dr, 'persona', 'character.json'),
  ].filter(Boolean);
  let j = null;
  for (const f of candidates) { j = readJson(f); if (j) break; }
  const name = String(j?.name || '小蓝');
  const species = String(j?.species || '深海鲸鱼娘');
  const core = Array.isArray(j?.core) ? j.core.slice(0, 5).join('、') : '迷糊、心软、爱玩';
  const tics = Array.isArray(j?.speech?.tics) ? j.speech.tics.slice(0, 3) : ['咕噜', '咕噜噜'];
  const oral = j?.speech?.oral !== false;
  const brief = {
    name,
    species,
    core,
    tics,
    brief: `${name}，${species}；性格${core}；说话${oral ? '口语短句' : '简洁'}，偶尔带「${tics.join('/')}」，不客服腔、不说教、不复述观众原话`,
    maxChars: Number(j?.speech?.maxChars) || 26,
  };
  cache = { at: now, dataRoot: dr, brief };
  return brief;
}

function eventHint(event) {
  if (event.type === EVENT_TYPES.SUPERCHAT) return `观众发了一条 ${event.amount?.rmb || ''} 元的醒目留言，内容：${event.text}`;
  if (event.type === EVENT_TYPES.GUARD) return `观众刚开通了大航海（等级 ${event.extra?.guardLevel || ''}），来道谢`;
  if (event.type === EVENT_TYPES.GIFT) return `观众送了「${event.gift?.name || '礼物'}」×${event.gift?.num || 1}，来道谢`;
  if (event.type === EVENT_TYPES.FOLLOW) return '有观众刚关注了直播间，来招呼一句';
  return `直播间弹幕：${event.text}`;
}

export async function generateReply(dataRoot, event, cfg, { state } = {}) {
  const p = loadPersona(dataRoot);
  const maxChars = Math.min(Number(cfg?.maxChars || 26), p.maxChars || 26);
  const fallback = () => ({ text: pickTemplate(event, cfg, state), source: 'template', tokens: 0 });

  const sec = readSecret(dataRoot);
  if (!sec?.apiKey) return fallback();

  const llm = cfg.llm || {};
  const hint = eventHint(event);
  const sys = `你是${p.brief}。`;
  const ask = `${hint}。用你自己的口吻回一句，不超过${maxChars}个字，像直播时随口搭话，只输出回复本身。`;
  const inputChars = sys.length + ask.length + String(event.user?.name || '').length + 6;
  if (inputChars > Number(llm.maxInputChars || 260)) return fallback();

  try {
    const r = await cloudChat({
      model: String(llm.model || 'deepseek-chat'),
      temperature: Number(llm.temperature ?? 0.85),
      max_tokens: Number(llm.maxOutputTokens || 60),
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `${event.user?.name ? '观众「' + event.user.name + '」' : '观众'}：${ask}` },
      ],
    }, { model: String(llm.model || 'deepseek-chat'), timeoutMs: Number(llm.timeoutMs || 15000), tag: 'live-reply' }, { apiKey: sec.apiKey });
    if (!r?.ok) return { ...fallback(), error: String(r?.error || 'cloud-failed').slice(0, 80) };
    const text = sanitizeReply(r.text, maxChars);
    if (!text) return fallback();
    const tokens = r.usage ? Number(r.usage.p || 0) + Number(r.usage.c || 0) : estimateTokens(inputChars, Number(llm.maxOutputTokens || 60));
    return { text, source: 'llm', tokens };
  } catch (e) {
    return { ...fallback(), error: String((e && e.message) || e).slice(0, 80) };
  }
}
