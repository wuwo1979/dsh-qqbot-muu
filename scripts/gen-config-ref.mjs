/**
 * 生成 docs/配置参考.md —— 端口/路径来自代码常量，插件默认值从 Config 定义摘录。
 * 人工只维护说明文字；改完常量/配置后重跑：
 *   node scripts/gen-config-ref.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PORTS, PATHS, SERVICES, HEALTH, BAD_WCX_VERSIONS, PORT_META } from '../wechat-bridge/constants.mjs'

const ROOT = PATHS.root
const BRIDGE_CONFIG = join(PATHS.bridge, 'config.json')
const PLUGIN = join(ROOT, 'dsh-wechat-muu', 'index.mjs')
const OUT = join(ROOT, 'docs', '配置参考.md')

const redacted = new Set(['token', 'secret', 'password', 'pin', 'appsecret', 'appSecret', 'accessKey', 'agentKey'])

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out.push({ key, value: Array.isArray(v) ? JSON.stringify(v) : String(v), secret: redacted.has(k) || [...redacted].some((r) => k.toLowerCase().includes(String(r).toLowerCase())) })
  }
  return out
}

function pluginDefaults() {
  if (!existsSync(PLUGIN)) return []
  const src = readFileSync(PLUGIN, 'utf8')
  const block = (src.match(/export const Config = Schema\.object\(\{([\s\S]*?)\n\}\)/) || [])[1] || ''
  const rows = []
  for (const line of block.split('\n')) {
    const m = line.match(/\s*([A-Za-z0-9_]+):\s*Schema\.[^/]*?\.default\(([\s\S]*)$/)
    if (!m) continue
    let def = m[2].trim().replace(/\),?\s*$/, '').replace(/^['"`]|['"`]$/g, '')
    if (def.length > 90) def = def.slice(0, 87) + '…'
    rows.push({ key: `wechat-muu.${m[1]}`, value: def })
  }
  return rows
}

const cfg = existsSync(BRIDGE_CONFIG) ? JSON.parse(readFileSync(BRIDGE_CONFIG, 'utf8')) : {}
const bridgeRows = flatten(cfg).map((r) => ({ ...r, value: r.secret ? '<见 secrets，已脱敏>' : r.value }))
const pluginRows = pluginDefaults()

const lines = []
lines.push('# 配置参考（自动生成）')
lines.push('')
lines.push('> 状态：现行（本文件由 `scripts/gen-config-ref.mjs` 从代码常量与 Config 定义导出，**不要手改**）。')
lines.push(`> 生成时间：${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}`)
lines.push('')
lines.push('## 1. 端口（唯一事实源：`wechat-bridge/constants.mjs`）')
lines.push('')
lines.push('| 端口键 | 值 | 监听侧 | 方向 | 是否入站 | 用途与关联 |')
lines.push('|---|---|---|---|---|---|')
for (const [k, v] of Object.entries(PORTS)) {
  const m = PORT_META[k] || {}
  lines.push(`| ${k} | ${v} | ${m.where || ''} | ${m.direction || ''} | ${m.inbound || ''} | ${m.role || SERVICES.find((s) => s.port === v)?.name || ''} |`)
}
lines.push('')
lines.push('## 2. 路径')
lines.push('')
lines.push('| 路径 | 值 |')
lines.push('|---|---|')
for (const [k, v] of Object.entries(PATHS)) {
  if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) lines.push(`| ${k}.${k2} | \`${v2}\` |`)
  else lines.push(`| ${k} | \`${v}\` |`)
}
lines.push('')
lines.push('## 3. 健康阈值与已知坏版本')
lines.push('')
lines.push('| 项 | 值 |')
lines.push('|---|---|')
for (const [k, v] of Object.entries(HEALTH)) lines.push(`| HEALTH.${k} | ${v} |`)
lines.push(`| 已知坏 WCX 版本 | ${BAD_WCX_VERSIONS.join(', ')} |`)
lines.push('')
lines.push('## 4. 桥接配置（`wechat-bridge/config.json`）')
lines.push('')
lines.push('| 键 | 值 |')
lines.push('|---|---|')
for (const r of bridgeRows) lines.push(`| ${r.key} | ${r.value} |`)
lines.push('')
lines.push('## 5. 微信插件默认值（`dsh-wechat-muu/index.mjs`）')
lines.push('')
lines.push('| 键 | 默认值 |')
lines.push('|---|---|')
for (const r of pluginRows) lines.push(`| ${r.key} | ${r.value} |`)
lines.push('')
lines.push('## 6. adb 隧道字段含义')
lines.push('')
lines.push('| 字段 | 含义 | 约束 |')
lines.push('|---|---|---|')
lines.push('| `bridge.listenHost` / `bridge.listenPort` | PC 上桥接监听的地址/端口 | 默认 `127.0.0.1:4311`；只应监听回环 |')
lines.push('| `adb.remotePort` | 平板 WCX REST 端口（`3001`） | 是 forward 的**目标**；绝不能被 reverse 占用 |')
lines.push('| `adb.localPort` | PC 上 forward 的本地端口 | `adb forward tcp:<localPort> tcp:<remotePort>`；不得与本机 bridge/gh-proxy 撞 |')
lines.push('| `adb.reversePort` | 平板上的 reverse 端口（可省略，默认 = `bridge.listenPort`） | `adb reverse tcp:<reversePort> tcp:<bridgePort>`；必须等于 bridge 端口，且不得等于 `remotePort(3001)` |')
lines.push('')
lines.push('记忆口径：**forward 是 PC → 平板**（把平板 3001 拉到本机，起点在 PC）；**reverse 是平板 → PC**（把 PC 的桥接端口搬到平板，起点在平板）。历史事故就是把 reverse 的平板起点写成了 3001，占掉了平板 WCX 自己的端口。')
lines.push('')
lines.push('## 7. 启动期冲突校验')
lines.push('')
lines.push('桥接启动时执行 `validateConfig()`，下列情况**拒绝启动**：')
lines.push('')
lines.push('- `adb.reversePort` 等于 `adb.remotePort(3001)`：reverse 会占用平板 WCX 自己的端口（历史事故）；')
lines.push('- `adb.reversePort` 与 `bridge.listenPort` 不一致：反向往平板搬的端口必须回指桥接；')
lines.push('- `adb.localPort` 与 `bridge.listenPort`/`ghProxy.port` 相同：forward 的 PC 起点撞本机服务；')
lines.push('- `ghProxy.port` 与 `bridge.listenPort` 相同。')
lines.push('')
lines.push('仅提示风险（warnings，不拦启动）：`bridge.listenHost` 非回环、`adb.autoUnlock`/`adb.autoTailscale` 打开、`tablet.token` 内联密钥、`wcx.knownBadVersions` 为空。')
lines.push('')

writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`已生成 ${OUT}（桥接 ${bridgeRows.length} 项 / 插件 ${pluginRows.length} 项）`)
