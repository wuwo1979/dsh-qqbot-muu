/**
 * channel-store.mjs — 三渠道统一的「聊天原始台账」写入
 *
 * 补回（catchup）、事件任务、记忆检索都依赖 chat 表里「谁在什么时候说了什么」。
 * 以前只有 QQ 写；微信/小天才只写提炼后的 mem，所以补回永远没素材。
 *
 * 这一层只做两件事：把 convId 归一成人的 scope，然后 appendChat。
 * 失败一律静默 —— 台账丢一条可以补，但绝不能因为它把回复流程弄挂。
 */

import { scopeFor, aliasesFor, nameForScope } from './person-link.mjs'

const PLATFORM_SRC = { qq: 'qq', wechat: 'wechat', xtc: 'xtc' }

function clean(text) {
  return String(text == null ? '' : text).replace(/\u0000/g, '').trim()
}

/**
 * @param {object} mem      memory.mjs 门面（插件里已加载的那份）
 * @param {string} dataRoot 数据根（F:/qqbot/dshqqbot）
 * @param {object} m        { platform, convId, isGroup, dir:'in'|'out', text, ts, senderId, sender, kind, media, msgId, src }
 * @returns {Promise<boolean>} 是否真的写进去了（重复消息会返回 false）
 */
export async function recordChat(mem, dataRoot, m = {}) {
  try {
    if (!mem || typeof mem.appendChat !== 'function') return false
    const platform = String(m.platform || 'qq')
    const text = clean(m.text)
    const media = clean(m.media)
    if (!text && !media) return false
    const scope = scopeFor(dataRoot, platform, m.convId, { isGroup: Boolean(m.isGroup) })
    if (!scope) return false
    const dir = m.dir === 'out' ? 'out' : 'in'
    const sender = clean(m.sender) || (dir === 'out' ? '小蓝' : nameForScope(dataRoot, scope))
    const ok = await mem.appendChat(dataRoot, {
      scope,
      ts: Number(m.ts) || Date.now(),
      dir,
      senderId: clean(m.senderId) || (dir === 'out' ? 'bot' : ''),
      sender,
      kind: clean(m.kind) || 'text',
      text: text.slice(0, 500),
      media,
      msgId: clean(m.msgId),
      src: clean(m.src) || PLATFORM_SRC[platform] || platform,
    })
    return Boolean(ok)
  } catch {
    return false
  }
}

/** 读侧：某个会话/人对应的全部历史 scope（catchup、召回用） */
export function scopesOf(dataRoot, scope) {
  try { return aliasesFor(dataRoot, scope) } catch { return [scope] }
}

export default { recordChat, scopesOf }
