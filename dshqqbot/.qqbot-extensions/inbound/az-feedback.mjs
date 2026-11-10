/**
 * az-feedback.mjs — 把“用户对刚才回复的真实评价”收进记忆，喂给自我反思
 *
 * 背景（2026-11-07）：runSelfReflection 只吃 insight/growth，等于只吃自己总结的
 * 正面/中性心得，用户说“你刚才太凶了 / 别反问”这类真实反馈根本没进闭环。
 *
 * 这里只做一件事：识别**直接指向她**的负反馈，连同她上一条回复一起记为
 * kind='insight', subj='feedback'（GLOBAL_SCOPE）。每天一次的本地反思会优先读它。
 *
 * 安全契约：
 *   · 严格正则 + 长度上限，宁漏不误记；
 *   · 同 scope 10 分钟最多记一条，避免刷屏式重复；
 *   · 任何异常只记日志并 next()，不影响聊天。
 */
import {
  cleanChatText, getChatState, loadConfig, queryChat, remember, setChatState,
} from '../lib/memory.mjs';
import { GLOBAL_SCOPE } from '../lib/profile-core.mjs';

export const name = 'az-feedback';

const FB_RE = [
  /(你|小蓝|肥鱼|鲸)[^\n]{0,14}(刚才|刚刚|上一条|上一句|这次|这话|说话|回复|接话|语气|态度)[^\n]{0,16}(凶|冲|敷衍|机械|说教|反讽|反问|抬杠|听不懂|不像人|过头|太冷|奇怪|差|不好|别扭|观感)/,
  /(别|不要|以后别)[^\n]{0,12}(反问|反讽|抬杠|说教|复述|总结|抢话|自作聪明|阴阳|阴阳怪气|冷嘲热讽|杠我)/,
  /(观感|听起来|看起来)[^\n]{0,10}(差|不好|怪|别扭|像客服|不像人)/,
  /(答非所问|没听懂|听不懂|你没理解|理解错|会错意|不是问你|我在说自己|别接我的)/,
  // 2026-11-07：分享/自嘲被反向嘲讽是最伤观感的一类，必须进反思
  /(我在分享|只是分享|我在吐槽|我在自嘲|我自嘲[^\n]{0,8}你还|你杠我|你阴阳我|你嘲讽我)/,
  /(别(?:再)?(?:拿我|开我)玩笑|别(?:再)?(?:嘲讽|阴阳|杠)我)/,
];

function dataRootOf() {
  const env = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (env) return env;
  try {
    const cfg = loadConfig('F:/qqbot/dshqqbot');
    return (cfg && cfg.dataRoot) || 'F:/qqbot/dshqqbot';
  } catch {
    return 'F:/qqbot/dshqqbot';
  }
}

function scopeOf(ctx) {
  const m = ctx?.message || {};
  if (m.groupOpenid) return 'group:' + m.groupOpenid;
  if (m.senderId) return 'c2c:' + m.senderId;
  return '';
}

/** 纯函数：这条消息是不是在评价她刚才的回复 */
export function isFeedback(text) {
  const s = String(text == null ? '' : text).trim();
  if (s.length < 3 || s.length > 120) return false;
  return FB_RE.some((re) => re.test(s));
}

export async function onInbound(ctx, next) {
  try {
    const m = ctx?.message || {};
    if (m.dir === 'out' || m.fromSelf === true) return next();
    const scope = scopeOf(ctx);
    if (!scope) return next();
    const root = dataRootOf();
    const text = cleanChatText(String(m.content ?? ctx?.text ?? '')).slice(0, 120);
    if (!isFeedback(text)) return next();

    const key = 'feedback:last:' + scope;
    const st = getChatState(root, key) || {};
    if (Date.now() - Number(st.ts || 0) < 10 * 60 * 1000) return next();

    const lastOut = (queryChat(root, scope, { limit: 1, dir: 'out' }) || [])
      .map((r) => cleanChatText(String(r?.text || '')))
      .find(Boolean) || '';
    const body = `用户反馈：${text}${lastOut ? `（我上一条：${lastOut.slice(0, 60)}）` : ''}`;
    const r = await remember(root, GLOBAL_SCOPE, { text: body, kind: 'insight', subj: 'feedback' });
    if (r && r.ok) {
      setChatState(root, key, { ts: Date.now() });
      ctx?.logger?.info?.('[feedback] 已记录一条用户反馈');
    }
  } catch (e) {
    ctx?.logger?.debug?.(`[feedback] 失败(已忽略): ${e?.message || e}`);
  }
  return next();
}
