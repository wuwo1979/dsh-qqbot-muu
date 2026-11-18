#!/usr/bin/env node
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
/**
 * 平板微信媒体文件归档（图片 / 语音 / 视频 / 表情）
 *
 * 为什么要单独拉：WCX 的历史接口只回 `<type:image>` 这种占位符，没有媒体地址；
 * 真正的文件在平板 `/data/data/com.tencent.mm/MicroMsg/<hash>/{image2,voice2,video,emoji}`。
 * 图片是微信加密的 .dat（XOR 头 0x?? 与 aeskey 有关），这里只做**原样归档 + 索引**，
 * 解密留着后面按需做（原始字节保住就不会丢）。
 *
 * 用法：node scripts/wechat-media-pull.mjs [--dry]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = __repoRoot() + ""
const ADB = (process.env.ADB_PATH || __repoRoot() + '/adb/platform-tools/adb')
const SERIAL = 'HA1TPTBF'
const DEV = '/data/data/com.tencent.mm/MicroMsg/f8fedb0ab60712a89bf5b4943671d654'
const OUT = join(ROOT, 'data/wx-media')
const DB = join(ROOT, 'dshqqbot/.qqbot/private/private-chat.db')
const dry = process.argv.includes('--dry')
const indexOnly = process.argv.includes('--index-only')
const DIRS = [['image2', 'image'], ['voice2', 'voice'], ['video', 'video'], ['emoji', 'emoji']]

function adb(args, timeout = 180000) {
  return execFileSync(ADB, ['-s', SERIAL, ...args], { timeout, maxBuffer: 1024 * 1024 * 8 })
}

mkdirSync(OUT, { recursive: true })
const db = dry ? null : new DatabaseSync(DB)
if (db) {
  db.exec(`create table if not exists media(
    name text primary key, kind text, bytes integer, mtime integer,
    local_path text, src text default 'tablet', imported_at integer)`)
}

let total = 0
const TAR = '/sdcard/Download/wxmedia.tar'
const dirsArg = DIRS.map(([r]) => r).join(' ')
if (indexOnly) { console.log('index-only: skip pull') } else try {
  adb(['shell', `su -c 'cd ${DEV} && tar cf ${TAR} ${dirsArg} 2>/dev/null; chmod 644 ${TAR}'`], 300000)
  adb(['pull', TAR, join(OUT, 'wxmedia.tar')], 300000)
  execFileSync('tar', ['--force-local', 'xf', join(OUT, 'wxmedia.tar'), '-C', OUT], { cwd: ROOT })
  console.log('tar pulled & extracted')
} catch (e) {
  console.log('tar failed:', String(e.message).slice(0, 160))
}
for (const [remote, kind] of DIRS) {
  const localDir = join(OUT, remote)
  if (!existsSync(localDir)) continue
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      total += 1
      if (db) {
        db.prepare(`insert or replace into media(name,kind,bytes,mtime,local_path,src,imported_at) values(?,?,?,?,?,?,?)`)
          .run(`${remote}/${name}`, kind, st.size, Math.floor(st.mtimeMs / 1000), p, 'tablet', Date.now())
      }
    }
  }
  walk(localDir)
  console.log(`${remote} -> ${kind}`)
}
if (db) {
  const rows = db.prepare(`select kind, count(*) n, sum(bytes) b from media group by kind`).all()
  for (const r of rows) console.log(`${r.kind}: ${r.n} files, ${(Number(r.b) / 1048576).toFixed(1)} MB`)
  db.close()
}
console.log('files', total)
