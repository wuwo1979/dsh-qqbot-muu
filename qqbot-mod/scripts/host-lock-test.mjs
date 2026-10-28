// 验证 bootstrap.js 里新加的 qqbotHostLock()：直接从活插件文件里抠出函数体跑，测完不改动它。
// 用例：无锁 → 抢到；别人活着持有 → 拒绝；别人锁已过期 → 抢到；持有者进程不存在 → 抢到；心跳会刷新 at。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN } from '../patches/plugin-dir.mjs'

const SRC = join(PLUGIN, 'dist', 'gateway', 'bootstrap.js')
const ROOT = 'F:/qqbot/qqbot-mod/.devdata-lock'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')) }
}

const src = readFileSync(SRC, 'utf8')
const at = src.indexOf('function qqbotHostLock(')
if (at < 0) { console.log('FAIL  活插件里没有 qqbotHostLock（补丁没打？）'); process.exit(1) }
let depth = 0
let end = -1
for (let i = src.indexOf('{', at); i < src.length; i += 1) {
  const c = src[i]
  if (c === '{') depth += 1
  else if (c === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
}
const body = src.slice(at, end)
const factory = new Function('join', 'qqReadFileSync', 'qqWriteFileSync', 'qqMkdirSync', 'process', 'logger', body + '\nreturn qqbotHostLock;')
const lock = factory(join, readFileSync, writeFileSync, mkdirSync, process, { warn() {} })

if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
const LOCKFILE = join(ROOT, '.qqbot', 'bot-host.lock')

// [1] 没有锁 → 抢到
const a = lock(ROOT)
ok('[1] 没锁时抢到', a.ok === true)
ok('[2] 锁文件已写、带我的 pid', existsSync(LOCKFILE) && JSON.parse(readFileSync(LOCKFILE, 'utf8')).pid === process.pid)

// [3] 别人活着持有 → 拒绝
writeFileSync(LOCKFILE, JSON.stringify({ pid: process.ppid, at: Date.now() }), 'utf8')
const b = lock(ROOT)
ok('[3] 另一个活进程持有时拒绝', b.ok === false)
ok('[4] 拒绝时回报持有者 pid', b.holder && b.holder.pid === process.ppid)

// [5] 别人的锁已过期（心跳停太久）→ 抢到
writeFileSync(LOCKFILE, JSON.stringify({ pid: process.ppid, at: Date.now() - 200000 }), 'utf8')
const c = lock(ROOT)
ok('[5] 过期锁可以抢', c.ok === true)

// [6] 持有者进程根本不存在 → 抢到
writeFileSync(LOCKFILE, JSON.stringify({ pid: 999999, at: Date.now() }), 'utf8')
const d = lock(ROOT)
ok('[6] 死进程的锁可以抢', d.ok === true)

// [7] 坏 JSON 不抛、能抢到
writeFileSync(LOCKFILE, '{oops', 'utf8')
const e = lock(ROOT)
ok('[7] 坏 JSON 不抛且能抢', e.ok === true)

// [8] release 后 at 归零（下一次别人就能抢）
if (e && typeof e.release === 'function') {
  e.release()
  const j = JSON.parse(readFileSync(LOCKFILE, 'utf8'))
  ok('[8] release 后 at=0', j.at === 0)
}

// [9] 同一进程重复拿锁不互斥（自己的锁不算别人）
const f = lock(ROOT)
const g = lock(ROOT)
ok('[9] 同进程重复拿锁都成功', f.ok === true && g.ok === true)

console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
