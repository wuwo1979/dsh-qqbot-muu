/**
 * token / 上下文用量统计（微信 + QQ 两通道，按会话聚合）。
 *
 * 数据源：
 *   · QQ：F:/qqbot/dshqqbot/token-usage.jsonl（aa-memory-recall 每轮写入的注入字数）
 *   · 微信：%APPDATA%/dsh-desktop/harness/dsh-wechat-muu/token-usage.jsonl（contextChars）
 *
 * 只含「会话哈希 / 字数 / 预算」，不含消息内容与真实 wxid/openid。
 *
 * 用法：
 *   node scripts/token-stats.mjs                 # 最近 7 天
 *   node scripts/token-stats.mjs --days 30
 *   node scripts/token-stats.mjs --baseline 2000 # 假设不省预算时每轮固定注入 2000 字
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATHS } from '../wechat-bridge/constants.mjs'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : dflt
}
const DAYS = Number(opt('--days', 7))
const BASELINE = Number(opt('--baseline', 2000))
const APPDATA = process.env.APPDATA || ''

const SOURCES = [
  { channel: 'QQ', file: join(PATHS.dataRoot, 'token-usage.jsonl'), defaultBudget: 1200 },
  { channel: '微信', file: join(APPDATA, 'dsh-desktop', 'harness', 'dsh-wechat-muu', 'token-usage.jsonl'), defaultBudget: 800 },
]

const since = Date.now() - DAYS * 86400_000
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((a, c) => a + (/[\u1100-\uFFDF\u3000-\u303F]/.test(c) ? 2 : 1), 0)))
const dw = (s) => [...String(s)].reduce((a, c) => a + (/[\u1100-\uFFDF\u3000-\u303F]/.test(c) ? 2 : 1), 0)
const table = (head, rows) => {
  const w = head.map((h, i) => Math.max(dw(h), ...rows.map((r) => dw(r[i]))))
  console.log(head.map((h, i) => pad(h, w[i])).join('  '))
  console.log(w.map((n) => '-'.repeat(n)).join('  '))
  for (const r of rows) console.log(r.map((c, i) => pad(c, w[i])).join('  '))
}

const perChannel = []
let totalTurns = 0
let totalChars = 0
let totalBaseline = 0
let totalOver = 0

for (const src of SOURCES) {
  const rows = []
  if (existsSync(src.file)) {
    for (const line of readFileSync(src.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (Number(o.ts) >= since && Number.isFinite(Number(o.chars))) rows.push(o)
      } catch { /* 跳过坏行 */ }
    }
  }
  if (!rows.length) {
    perChannel.push({ channel: src.channel, scopes: 0, turns: 0, avg: 0, max: 0, over: 0, chars: 0, budget: src.defaultBudget, note: '无记录' })
    continue
  }
  const byScope = new Map()
  let over = 0
  for (const r of rows) {
    const k = String(r.scope || 'unknown')
    const s = byScope.get(k) || { turns: 0, chars: 0, max: 0 }
    s.turns += 1
    s.chars += Number(r.chars)
    s.max = Math.max(s.max, Number(r.chars))
    byScope.set(k, s)
    const budget = Number(r.budget || src.defaultBudget)
    if (Number(r.chars) > budget) over += 1
  }
  const chars = rows.reduce((a, r) => a + Number(r.chars), 0)
  const avg = Math.round(chars / rows.length)
  const max = Math.max(...rows.map((r) => Number(r.chars)))
  const budgets = rows.map((r) => Number(r.budget || src.defaultBudget)).sort((a, b) => a - b)
  const budget = budgets.length ? budgets[Math.floor(budgets.length / 2)] : src.defaultBudget
  perChannel.push({ channel: src.channel, scopes: byScope.size, turns: rows.length, avg, max, over, chars, budget })
  totalTurns += rows.length
  totalChars += chars
  totalBaseline += rows.length * BASELINE
  totalOver += over
  // 最贵会话（哈希，不可反查身份）
  const top = [...byScope.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 3)
  console.log(`\n${src.channel} · 最贵会话（前 3）`)
  for (const [scope, s] of top) console.log(`  ${scope}  ${s.turns} 轮  合计 ${s.chars} 字  峰值 ${s.max} 字`)
}

console.log(`\n窗口：最近 ${DAYS} 天${totalTurns ? '' : '（暂无埋点数据）'}`)
table(['渠道', '会话数', '轮次', '平均注入', '峰值', '超预算', '合计字数', '预算'], perChannel.map((p) => [
  p.channel, p.scopes, p.turns, p.avg + ' 字', p.max + ' 字', p.over, p.chars, p.budget,
]))

if (totalTurns) {
  const saved = Math.max(0, totalBaseline - totalChars)
  const pct = totalBaseline ? Math.round((saved / totalBaseline) * 100) : 0
  const estTokens = Math.round(totalChars / 1.5) // 中文约 1.5 字/token 的保守估算
  console.log(`\n合计：${totalTurns} 轮注入 ${totalChars} 字（≈${estTokens} tokens），超预算 ${totalOver} 轮`)
  console.log(`对照：若每轮固定注入 ${BASELINE} 字（≈${Math.round(totalBaseline / 1.5)} tokens），本窗口节省 ${saved} 字（约 ${pct}%）`)
  console.log(totalOver === 0 ? '结论：预算守住了（trimBudget 生效，未出现超预算注入）' : `结论：有 ${totalOver} 轮超预算，检查 trimBudget 与配置`)
} else {
  console.log('结论：还没有任何埋点记录。QQ/微信各跑一轮对话后再看（记录文件在 dshqqbot 与插件 stateDir 下）。')
}
