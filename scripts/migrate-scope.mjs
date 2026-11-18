import { existsSync as __existsSync } from 'node:fs'
const __repoRoot = (() => {
  let cached = ''
  const norm = (p) => String(p || '').split(String.fromCharCode(92)).join('/')
  return () => {
    if (cached) return cached
    const cands = []
    const env = String(process.env.QQBOT_ROOT || process.env.QQBOT_REPO_ROOT || '').trim()
    if (env) cands.push(norm(env))
    try {
      let here = decodeURIComponent(new URL('.', import.meta.url).pathname)
      if (here[0] === '/' && here[2] === ':') here = here.slice(1)
      here = norm(here).replace(/\/+$/, '')
      let d = here
      for (let i = 0; i < 6; i += 1) {
        if (!d) break
        cands.push(d)
        const k = d.lastIndexOf('/')
        d = k > 0 ? d.slice(0, k) : ''
      }
    } catch { /* noop */ }
    try { cands.push(norm(process.cwd())) } catch { /* noop */ }
    for (const c of cands) {
      try {
        if (c && (__existsSync(c + '/qqbot-mod/muu-shared.mjs') || __existsSync(c + '/dshqqbot'))) { cached = c; return cached }
      } catch { /* noop */ }
    }
    cached = norm(cands.find(Boolean) || '.')
    return cached
  }
})()
// 旧 scope 迁移：把历史上「按渠道形状」写的记忆并到「按人」的规范 scope。
//
// 背景（2026-11-13）：写侧已经从 person-link 归一（wechat:<wxid> / c2c:<腕表id> → c2c:<personId>），
// 但库里还留着旧 scope（例如把昵称当 id 的脏数据、wechat:<wxid> 私聊）。
// 读侧 aliasesFor 已经能兜住一部分，这个脚本把存量真正改过来，避免同一件事记两遍。
//
// 默认 dry-run，只打印会改什么；确认后加 --apply 才写，写前自动备份 memory.db。
//
// 用法：
//   node F:\qqbot\scripts\migrate-scope.mjs
//   node F:\qqbot\scripts\migrate-scope.mjs --apply
//   可选 --db <memory.db 路径>（默认 F:/qqbot/dshqqbot/.qqbot/memory.db）
//   可选 --data-root <机器人数据根>（默认 F:/qqbot/dshqqbot）

import { existsSync, copyFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const argOf = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const DATA_ROOT = argOf('--data-root', __repoRoot() + "/dshqqbot")
const DB = argOf('--db', join(DATA_ROOT, '.qqbot', 'memory.db'))

const { loadPeople } = await import(pathToFileURL(join(__repoRoot(), "dshqqbot/.qqbot-extensions/lib/person-link.mjs")).href)

if (!existsSync(DB)) {
  console.error(`找不到库：${DB}`)
  process.exit(1)
}

const reg = loadPeople(DATA_ROOT)
/** 老 scope → 新 scope（只改 c2c:/wechat: 私聊；群和 __global__ 不动） */
function targetOf(scope) {
  const s = String(scope || '')
  if (!/^(c2c|wechat):/.test(s)) return ''
  if (s.includes('@chatroom') || s.includes('@gid')) return ''
  const p = reg.byAlias.get(s) || reg.byAlias.get(`c2c:${s.replace(/^[a-z]+:/, '')}`)
  if (!p || !p.scope || p.scope === s) return ''
  return p.scope
}

const db = new DatabaseSync(DB, { readOnly: !APPLY })
// 只动「带 scope 列」的表，动态发现，避免漏掉以后新加的表
const tables = db.prepare("select name, sql from sqlite_master where type = ?").all('table')
  .map((t) => String(t.name))
  .filter((n) => {
    if (n.startsWith('sqlite_')) return false
    try {
      return db.prepare(`pragma table_info("${n}")`).all().some((c) => c.name === 'scope')
    } catch { return false }
  })

console.log(`库：${DB}`)
console.log(`表：${tables.join(', ')}`)
console.log(APPLY ? '模式：APPLY（会写库）' : '模式：dry-run（只看不改，加 --apply 才写）')

const plan = []
for (const t of tables) {
  const rows = db.prepare(`select scope, count(*) n from "${t}" group by scope`).all()
  for (const r of rows) {
    const to = targetOf(r.scope)
    if (!to) continue
    plan.push({ table: t, from: String(r.scope), to, n: Number(r.n) || 0 })
  }
}

if (!plan.length) {
  console.log('没有需要迁移的 scope。')
  db.close()
  process.exit(0)
}
for (const p of plan) console.log(`  ${p.table}: ${p.from} → ${p.to}（${p.n} 行）`)

if (!APPLY) {
  console.log(`\n共 ${plan.length} 组。确认后加 --apply 执行（会先备份）。`)
  db.close()
  process.exit(0)
}

// 备份：同一秒内多次跑也不覆盖
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const bak = `${DB}.bak-${stamp}`
copyFileSync(DB, bak)
console.log(`已备份 → ${bak}（${Math.round(statSync(bak).size / 1024)} KB）`)

db.exec('begin')
try {
  for (const p of plan) {
    // 同表同组只跑一次（scope 分布已按组聚合）
    const r = db.prepare(`update "${p.table}" set scope = ? where scope = ?`).run(p.to, p.from)
    console.log(`  ✓ ${p.table}: ${p.from} → ${p.to}（${Number(r.changes) || 0} 行）`)
  }
  db.exec('commit')
  console.log('\n迁移完成。重启 DSH 后生效。')
} catch (e) {
  try { db.exec('rollback') } catch { /* ignore */ }
  console.error(`迁移失败，已回滚：${e?.message ?? e}`)
  process.exitCode = 1
} finally {
  db.close()
}
