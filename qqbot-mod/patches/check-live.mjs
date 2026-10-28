#!/usr/bin/env node
/**
 * check-live.mjs — DSH 升级「三道闸」体检（手动版，学自 ops-handoff-design 11 号文档）
 *
 * 背景：DSH 升级/重装后 live 包 generation 路径整个换掉（zaofan+dsh-qqbot+<版本>+<hash>），
 * 我们打的补丁（settings-host.js / client/qqbot-settings.js）会全部丢失 —— 「没报错不等于没坏」。
 * 启动时的自动自检在 hooks/overlay-check.mjs（含自动重放）；本脚本是升级前后的手动体检：
 *
 *   node check-live.mjs            # 体检：generation 探测 + 补丁标记核验 + 与 ours 源文件 diff
 *   node check-live.mjs --apply    # 体检发现不一致时，直接用 ours 源文件覆盖 live 包
 *
 * 判据三条：①最新 generation 能找到 ②所有补丁标记在位 ③live 文件与 ours 源一致。
 * 任何一条不过 = 该重新 cp（--apply）或跑 install.mjs --apply 三路合并。
 */

import { readFileSync, existsSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = 'F:/qqbot/qqbot-mod/patches/live-overlay/ours'
const APPLY = process.argv.includes('--apply')

// ── ① 探测最新 generation ──
const GENROOT = join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', 'profiles', '.generations', 'live')
const REL = 'node_modules/@zaofan/dsh-qqbot'
let best = null
for (const name of readdirSync(GENROOT)) {
  const m = /^zaofan\+dsh-qqbot\+([^+]+)\+/.exec(name)
  if (!m) continue
  const dir = join(GENROOT, name, REL)
  let mt = 0
  try { mt = statSync(dir).mtimeMs } catch { continue }
  if (!best || mt > best.mt) best = { name, dir, mt, version: m[1] }
}
if (!best) {
  console.error('✗ 找不到任何 zaofan+dsh-qqbot generation —— DSH 没装或路径变了')
  process.exit(1)
}
console.log(`① live generation：${best.name}（${new Date(best.mt).toLocaleString()}）`)

// ── ② 补丁标记核验（与 overlay-check.mjs 探针同源，新增标记两边都要加）──
const PROBES = [
  { file: 'settings-host.js', mark: 'known-chats-merge', desc: '聊天页目标下拉合并' },
  { file: 'settings-host.js', mark: 'groups-bom-tolerant', desc: 'groups.json BOM 容忍' },
  { file: 'settings-host.js', mark: 'group-title-fix', desc: '群标题不用昵称兜底' },
  { file: 'settings-host.js', mark: 'login-qr-start', desc: 'B站扫码登录服务端' },
  { file: 'settings-host.js', mark: 'douyin-comments', desc: '抖音路由组' },
  { file: 'settings-host.js', mark: 'overview-cache 2026-10-27', desc: '总览 TTL+单飞' },
  { file: 'client/qqbot-settings.js', mark: 'acct-tabs 2026-10-27', desc: 'B站/抖音分页签' },
  { file: 'client/qqbot-settings.js', mark: 'api-timeout', desc: 'api 超时' },
  { file: 'client/qqbot-settings.js', mark: 'bili-qr-login', desc: 'B站扫码登录' },
  { file: 'client/qqbot-settings.js', mark: 'arm-confirm', desc: '两段式确认' },
  { file: 'settings-host.js', mark: 'video-radar', desc: '视频雷达路由（拉取/生评/B站直发/笔记，10/27）' },
  { file: 'client/qqbot-settings.js', mark: 'video-radar', desc: '视频雷达页签（10/27）' },
  { file: 'settings-host.js', mark: 'preview-sample', desc: '试听预录样本缓存（10/27）' },
  { file: 'settings-host.js', mark: 'lm-bases-permodel', desc: '判定模型下载源按所选模型走（10/27）' },
  { file: 'client/qqbot-settings.js', mark: 'llm-tab-extbind 2026-10-27', desc: '本地模型页绑定代答/语音/工具报错卡' },
  { file: 'settings-host.js', mark: 'lm-bases-permodel 2026-10-27', desc: '判定模型下载源按所选模型走' },
]
let missing = 0
for (const p of PROBES) {
  const f = join(best.dir, p.file)
  let ok = false
  try { ok = existsSync(f) && readFileSync(f, 'utf8').includes(p.mark) } catch { }
  console.log(`  ${ok ? '✓' : '✗'} [${p.file}] ${p.desc}（标记 ${p.mark}）`)
  if (!ok) missing++
}

// ── ③ 与 ours 源文件逐字节比对 ──
let drift = 0
for (const f of ['settings-host.js', 'client/qqbot-settings.js']) {
  const src = join(REPO, f)
  const dst = join(best.dir, f)
  if (!existsSync(src)) { console.log(`  ⚠ ours 源缺失：${src}`); continue }
  let same = false
  try { same = readFileSync(src, 'utf8') === readFileSync(dst, 'utf8') } catch { }
  console.log(`  ${same ? '✓' : '✗'} diff ${f}${same ? '' : '（live 与 ours 不一致）'}`)
  if (!same) drift++
}

console.log(`\n③ 扩展目录：${existsSync('F:/qqbot/dshqqbot/.qqbot-extensions/lib/platforms/index.mjs') ? '✓ 在位（升级不影响）' : '✗ 丢失！'}`)

if (missing === 0 && drift === 0) {
  console.log('\n体检通过：补丁全在位，live 与 ours 一致。')
  process.exit(0)
}
console.log(`\n体检不通过：缺标记 ${missing} 个，源不一致 ${drift} 个文件。`)
if (APPLY) {
  for (const f of ['settings-host.js', 'client/qqbot-settings.js']) {
    copyFileSync(join(REPO, f), join(best.dir, f))
    console.log(`已覆盖：${f} → ${best.dir}/${f}`)
  }
  console.log('完成。宿主重启后生效（settings-host 是启动时加载的）。')
} else {
  console.log('处置：node check-live.mjs --apply  直接用 ours 覆盖；或 live-overlay/install.mjs --apply 三路合并（有冲突报告）。')
  process.exit(2)
}
