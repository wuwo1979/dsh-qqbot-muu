#!/usr/bin/env node
/**
 * fix-timers-reload.mjs —— 定时任务：外部改动后自动重载 timers.json
 *
 * 现状：ScheduleStore 只在构造函数里 load() 一次，之后一直用内存里的 jobs。
 * 于是「面板/另一个进程刚写进去的任务」运行中的宿主看不见，
 * 反过来「文件被删/被改」宿主也不知道，表现为主人觉得"定时任务失效了"。
 *
 * 本补丁：list() 与 nextFireAt 之外，在读之前按 mtimeMs 判断是否要重新 load；
 * 另加 reloadIfChanged() 供 ticker 调用。
 *
 * 用法：node qqbot-mod/patches/fix-timers-reload.mjs [--check|--apply]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const APPLY = process.argv.includes('--apply')
const FILE = join(PLUGIN, 'dist', 'features', 'schedule-store.js')
announce('timers-reload')

let src = readFileSync(FILE, 'utf8')
const crlf = src.includes('\r\n')
if (crlf) src = src.replace(/\r\n/g, '\n')

const marker = '[qqbot-mod] timers-reload'
if (src.includes(marker)) {
  console.log('  = 已是最新')
  process.exit(0)
}

// 1) load() 里记下 mtime
const loadHead = `    load() {\n        try {\n            const p = this.file();\n`
if (!src.includes(loadHead)) {
  console.log('  ✗ 找不到 load() 锚点')
  process.exit(1)
}
let out = src.replace(
  loadHead,
  `    load() {\n        try {\n            const p = this.file();\n            // ${marker}：记 mtime，供 reloadIfChanged() 判断文件是否被外部改过\n            try { this._mtime = existsSync(p) ? statSync(p).mtimeMs : 0 } catch { this._mtime = 0 }\n`,
)

// 2) 在 file() 之后插入 reloadIfChanged()
const fileFn = `    file() {\n        return join(this.dataDir, FILE_NAME);\n    }\n`
const reloadFn =
  fileFn +
  `    // ${marker}：外部（面板 / 另一个进程 / 手工编辑）改了 timers.json 就重读，
  // 免得运行中的宿主一直用启动时的内存快照，主人以为"定时任务失效了"。
    reloadIfChanged() {
        try {
            const p = this.file();
            const mt = existsSync(p) ? statSync(p).mtimeMs : 0;
            if (mt !== (this._mtime || 0)) {
                this.load();
                return true;
            }
        }
        catch {
            /* ignore */
        }
        return false;
    }
`
if (!out.includes(reloadFn)) {
  if (!out.includes(fileFn)) {
    console.log('  ✗ 找不到 file() 锚点')
    process.exit(1)
  }
  out = out.replace(fileFn, reloadFn)
}

// 3) list() 开头先 reload
const listHead = `    list() {\n`
if (!out.includes(listHead)) {
  console.log('  ✗ 找不到 list() 锚点')
  process.exit(1)
}
out = out.replace(listHead, `    list() {\n        this.reloadIfChanged();\n`)

// 4) 给 ticker 用的公共入口（如果已有 tick 相关函数就不重复加）
if (!out.includes('tickDue(')) {
  const anchor = `    list() {\n        this.reloadIfChanged();\n`
  out = out.replace(
    anchor,
    `    // ${marker}：给 bootstrap 的 30s ticker 用 —— 每次 tick 先对齐磁盘
    reloadForTick() {
        this.reloadIfChanged();
    }
` + anchor,
  )
}

const bad = []
if (!out.includes('reloadIfChanged()')) bad.push('reloadIfChanged')
if (!out.includes(String.raw`this._mtime`)) bad.push('_mtime')
if (!out.includes('reloadForTick')) bad.push('reloadForTick')
console.log(`  ${bad.length ? '✗' : '✔'} 插入点：${bad.length ? bad.join(', ') : 'load/_mtime/list/reloadForTick 全部就位'}`)
if (bad.length) process.exit(1)

if (!APPLY) {
  console.log('\n  dry run（加 --apply 才写盘）')
  process.exit(0)
}
if (!existsSync(FILE + '.orig-muu')) copyFileSync(FILE, FILE + '.orig-muu')
writeFileSync(FILE, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8')
console.log('\n  ✔ 已写入 dist/features/schedule-store.js')
console.log('\n装完记得：/bot-restart（或重启 DSH 桌面端）+ 页面 Ctrl+F5')
