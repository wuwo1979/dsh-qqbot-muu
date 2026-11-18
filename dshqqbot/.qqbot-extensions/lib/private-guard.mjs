// 私聊护城河：私人聊天不进常规记忆。
//
// 主人 2026-11-16 定：抖音私信、微信私聊、QQ 私聊里「只属于人」的对话带 private 标签，
// 单独存在 .qqbot/private/private-chat.db；常规记忆（memory.db / memory/*.json）不得读取，
// 要读必须人当场同意（manual dump）。
//
// ★ 2026-11-18：名单不再写死在代码里（发布包不能带任何人的 openid）。
//   来源优先级：环境变量 QQBOT_PRIVATE_PEERS（逗号分隔）→ {root}/.qqbot/private-people.json → 空。
//   scope 约定：
//   qq:dm:<openid>      wechat:dm:<wxid>      douyin:dm:<name>
//   常规：group:<gid> / c2c:<对方id> / xtc 等
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRIVATE_PREFIXES = ['douyin:dm:', 'qq:dm:', 'wechat:dm:']
// 默认数据根：从本文件位置往上三级 = <repo>/dshqqbot（QQ_DATA_ROOT）
function defaultRoot() {
  try { return dirname(dirname(dirname(fileURLToPath(import.meta.url)))) } catch { return '' }
}
let _root = process.env.QQBOT_ROOT || defaultRoot()
let _cache = { at: 0, mtime: 0, ids: new Set() }

/** 由插件启动时调用，告诉它数据根在哪（不调用也能用 env / 默认根兜底） */
export function configurePrivateGuard(opts = {}) {
  if (opts.root) _root = String(opts.root)
}

function fromEnv() {
  const raw = String(process.env.QQBOT_PRIVATE_PEERS || '').trim()
  if (!raw) return []
  return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
}

function fromFile(root) {
  if (!root) return []
  const f = join(root, '.qqbot', 'private-people.json')
  try {
    if (!existsSync(f)) return []
    const st = statSync(f)
    if (_cache.mtime === st.mtimeMs && Date.now() - _cache.at < 60000) return [..._cache.ids]
    const arr = JSON.parse(readFileSync(f, 'utf8'))
    const ids = new Set()
    if (Array.isArray(arr)) for (const it of arr) {
      if (typeof it === 'string') { ids.add(it); continue }
      if (!it || typeof it !== 'object') continue
      for (const k of ['qq', 'id', 'openid']) if (it[k]) ids.add(String(it[k]))
    }
    else if (arr && typeof arr === 'object') for (const v of Object.values(arr)) { if (typeof v === 'string') ids.add(v) }
    _cache = { at: Date.now(), mtime: st.mtimeMs, ids }
    return [...ids]
  } catch { return [] }
}

function peerIds() {
  const ids = new Set(fromEnv())
  for (const id of fromFile(_root)) ids.add(id)
  return ids
}

export function isPrivateScope(scope) {
  const s = String(scope || '').trim()
  if (!s) return false
  if (PRIVATE_PREFIXES.some((p) => s.startsWith(p))) return true
  if (!s.startsWith('c2c:')) return false
  return peerIds().has(s.slice(4))
}

export default { isPrivateScope, configurePrivateGuard }
