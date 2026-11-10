/**
 * a1-restart-guard.mjs —— 重启类指令的权限闸（2026-11-10 主人要求）
 *
 * 背景：群里有人发 `/bot-restart`，宿主没有这一层拦截，指令原样掉进模型上下文，
 *   她只能回一句"命令没到插件那层" —— 既没重启、也没拒绝，看着像出了 bug。
 * 现在的规矩（主人定）：**重启只认爸爸妈妈**，而且必须是 @ 她 / 私聊的场景，
 *   其余一律当场回绝，不惊动云端。
 *
 * 策略：
 *   · 命中「重启意图」→ 判断发送者是否在 OWNERS 白名单；
 *       - 是：放行（真重启交给宿主内置命令 /bot-restart）
 *       - 否：annihilate 摘掉这条消息（云端就不会被调），本地回一句拒绝
 *   · 任何异常只记日志并 next()，绝不吞消息
 *   · 同一会话 60 秒内只回绝一次，避免刷屏；annihilate 有插件熔断（20 次/10s），这里天然够用
 *
 * 排序：a1- 紧跟 a0-tag-guard，排在记忆召回之前，脏指令不进任何沉淀链路。
 */

export const name = 'a1-restart-guard';

/**
 * 只有家里人（爸爸、妈妈）能重启
 * ★ v0.1.6：openid 从代码里搬到本机（`data/ids.json` 或 QQBOT_OWNER_IDS），
 *   代码里不留真人标识 —— 否则一发布就把家里人的账号编号印在 npm 包上。
 *   读不到就没人能重启（宁可关掉，也不用猜的 id 放行）。
 */
import { ownerIds } from '../lib/personal-ids.mjs';

let _ownersCache = { at: 0, set: new Set() };
function ownerSet() {
  const now = Date.now();
  if (now - _ownersCache.at < 10000) return _ownersCache.set;
  let set = new Set();
  try { set = new Set(ownerIds()); } catch { set = new Set(); }
  _ownersCache = { at: now, set };
  return set;
}

/** 每个会话上一次回绝的时间，防止连刷 */
const _lastRefuse = new Map();

/** 命中重启意图？只在"明确叫它重启"时算，普通聊到重启（聊电脑、聊手机）不管 */
function isRestartIntent(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // ① 斜杠命令形态：/bot-restart、/botrestart、/restart、/重启
  if (/^[/／]\s*(bot[\s_-]?restart|restart|reboot|重启)\b/i.test(t)) return true;
  // ② 口语形态：必须同时出现"重启"和"机器人/bot/宿主/小蓝/程序"才算，避免误伤日常闲聊
  if (/(重启|重新启动|restart|reboot)/i.test(t) && /(机器人|bot|宿主|dsh|小蓝|程序|服务)/i.test(t)) return true;
  return false;
}

export async function onInbound(ctx, next) {
  try {
    const text = String(ctx?.text == null ? '' : ctx.text);
    if (!isRestartIntent(text)) return next();

    const sender = String(ctx?.sender || ctx?.message?.senderId || '');
    const groupId = String(ctx?.groupId || '');
    const mentioned = Boolean(
      ctx?.platform?.mentioned
      || (Array.isArray(ctx?.message?.mentions) && ctx.message.mentions.length > 0)
      || /\[CQ:at,qq=|@小蓝|@MuU/i.test(text),
    );
    const isOwner = ownerSet().has(sender);
    const isC2c = !groupId;

    // 主人本人：私聊直接放行；群里必须 @ 她
    if (isOwner && (isC2c || mentioned)) {
      ctx?.logger?.debug?.(`[restart-guard] 放行（${ctx?.senderName || sender}）`);
      return next();
    }

    // 其他人（或主人没 @ 的群里闲聊）→ 回绝
    const scope = String(ctx?.scope || (groupId ? 'group:' + groupId : 'c2c:' + sender) || 'global');
    const now = Date.now();
    const last = Number(_lastRefuse.get(scope) || 0);
    let killed = false;
    try {
      killed = ctx?.annihilate?.({ reason: '重启指令越权', ownerAck: true }) === true;
    } catch (e) {
      ctx?.logger?.warn?.(`[restart-guard] 摘除失败: ${e instanceof Error ? e.message : String(e)}`);
      killed = false;
    }
    if (!killed) return next(); // 摘不掉就不拦，交回正常链路，宁可多说一句也不能吞消息

    if (now - last > 60000) {
      _lastRefuse.set(scope, now);
      const tip = isOwner
        ? '要重启就 @ 我一下，不然我当没听见。'
        : '这台机器不归你按重启。只有爸爸妈妈叫我的时候，我才会去动它。';
      try {
        await ctx?.caps?.text?.(tip);
      } catch { /* 回复失败不影响拦截 */ }
    }
    ctx?.logger?.debug?.(`[restart-guard] 已回绝（${ctx?.senderName || sender}）`);
    return;
  } catch (e) {
    ctx?.logger?.warn?.(`[restart-guard] 失败(已忽略): ${e instanceof Error ? e.message : String(e)}`);
    return next();
  }
}
