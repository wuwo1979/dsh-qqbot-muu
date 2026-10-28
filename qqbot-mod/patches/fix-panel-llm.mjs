#!/usr/bin/env node
// fix-panel-llm.mjs —— 修「🖥 本地模型」标签页白屏：paintBody 里调了不存在的 llmCardHtml()
//
// 现场（1.10.39 live，client/qqbot-settings.js:6084）：
//   } else if (state.tab === 'llm') {
//     body += llmCardHtml()
// 但全文件只有 extCardHtml() / gamesCardHtml() / biliCardHtml() 三个卡片函数，
// llmCardHtml 从来没定义过 ⇒ 点「本地模型」必抛
//   ReferenceError: llmCardHtml is not defined
// 被 paintBody 的 try/catch 接住，变成"这块渲染出错了（不是数据没了）"。
//
// 修法（只动一行，能跑起来且不丢东西）：
//   · 有 llmCardHtml 就用它（万一哪天上游补上）
//   · 没有则回落 extCardHtml() —— 那正是「本地代答 / 语音」两张卡片
//   · 前面加一行说明，避免以后有人再困惑为什么这页和「扩展」页内容一样
//
// 用法：node qqbot-mod/patches/fix-panel-llm.mjs [--check|--apply]

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { pluginPath, announce } from './plugin-dir.mjs'

const REL = 'client/qqbot-settings.js'
const MARK = '[qqbot-mod] panel-llm'

const OLD = `        } else if (state.tab === 'llm') {
          body += llmCardHtml()
`

const NEW = `        } else if (state.tab === 'llm') {
          // ${MARK} 「本地模型」页：原代码调 llmCardHtml()，但全文件只有 llmStatusHtml() / extCardHtml()，
          // llmCardHtml 从没定义过 ⇒ 点这页必抛 ReferenceError 白屏。这里拼正确的那两张卡。
          body += (typeof llmStatusHtml === 'function' ? llmStatusHtml() : '')
          body += (typeof extCardHtml === 'function' ? extCardHtml() : '')
`

function norm(s) { return s.replace(/\r\n/g, '\n') }
function denorm(s) { return s.replace(/\n/g, '\r\n') }

const file = pluginPath(REL)
if (!existsSync(file)) {
  console.error(`✗ 找不到 ${file}`)
  process.exit(2)
}
announce('fix-panel-llm')

const raw = readFileSync(file, 'utf8')
const src = norm(raw)

if (src.includes(MARK)) {
  console.log('  = 已是新版，无需写入')
  process.exit(0)
}
if (!src.includes(OLD)) {
  console.error('✗ 找不到锚点：state.tab === \'llm\' 分支（上游可能改过这段）')
  process.exit(3)
}

const out = src.replace(OLD, NEW)
if (process.argv.includes('--check')) {
  console.log('  · 命中 1 处：llmCardHtml → 守护 + extCardHtml 回落')
  console.log('（--check 模式，未写入）')
  process.exit(0)
}

copyFileSync(file, file + '.orig-muu')
writeFileSync(file, denorm(out))
const { execFileSync } = await import('node:child_process')
try {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
} catch (e) {
  copyFileSync(file + '.orig-muu', file)
  console.error('✗ 语法检查失败，已回滚：', String(e.stderr || e.message).slice(0, 400))
  process.exit(4)
}
console.log(`  ✔ 已写入 ${REL}（${out.length} 字符），语法检查通过`)
