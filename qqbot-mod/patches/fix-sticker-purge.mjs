#!/usr/bin/env node
/**
 * fix-sticker-purge.mjs —— 表情包图库「回收站」加一个「🧹 清空回收站」按钮。
 *
 * 后端路由 hooks/sticker-trash.mjs 早就挂好了 `POST /api/qqbot-settings/stickers/trash-purge`
 * （内部 store.cleanupTrash(0) 物理删除），只是浮窗里没有入口 —— 这个补丁补入口。
 *
 * 用法：node qqbot-mod/patches/fix-sticker-purge.mjs [--check|--apply]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pluginPath, announce } from './plugin-dir.mjs'

const MARK = '[qqbot-mod] sticker-purge'
const ANN = '[qqbot-mod] sticker-purge'

function nn(s) { return String(s).replace(/\r\n/g, '\n') }
function rr(s) { return String(s).replace(/\n/g, '\r\n') }

function editClient(src) {
  if (src.includes(MARK)) return { src, hit: false, label: '客户端：已是最新' }

  // 1) 工具条加按钮（只在「回收站」这一层显示）
  const anchor1 = "          h('button', { className: 'qqs-btn', onClick: load }, '刷新')),"
  if (!src.includes(anchor1)) throw new Error('找不到锚点：工具条刷新按钮')
  const ins1 = [
    "          h('button', { className: 'qqs-btn', onClick: load }, '刷新'),",
    "          // " + MARK,
    "          layer === 'trash' ? h('button', {",
    "            className: 'qqs-btn',",
    "            style: { color: '#c92a2a', borderColor: '#c92a2a66', fontWeight: 700 },",
    "            title: '把回收站里的图彻底删掉（不可恢复）',",
    "            onClick: function () {",
    "              var _n = items.length",
    "              if (!_n) { setMsg('回收站已经是空的'); return }",
    "              if (!confirm('⚠️ 将彻底删除回收站里的 ' + _n + ' 张图（含索引与文件），不可恢复。\\n确定清空？')) return",
    "              fetch('/api/qqbot-settings/stickers/trash-purge', {",
    "                method: 'POST',",
    "                headers: { 'content-type': 'application/json' },",
    "                body: JSON.stringify({ dataDir: DD || undefined }),",
    "              }).then(function (r) { return r.json() }).then(function (d) {",
    "                setMsg(d && d.ok ? ('回收站已清空，删除 ' + (d.purged !== undefined ? d.purged : _n) + ' 张 ✓') : ('清空失败：' + ((d && d.error) || '未知错误')))",
    "                load()",
    "              }).catch(function (e) { setMsg('清空失败：' + e.message) })",
    "            },",
    "          }, '🧹 清空回收站') : null),",
  ].join('\n')

  src = src.replace(anchor1, ins1)
  return { src, hit: true, label: '客户端：回收站清空按钮' }
}

function main() {
  const mode = process.argv.includes('--apply') ? 'apply' : 'check'
  announce('fix-sticker-purge')
  const rel = 'client/qqbot-settings.js'
  const p = pluginPath(rel)
  if (!existsSync(p)) throw new Error('找不到 ' + p)
  const raw = readFileSync(p, 'utf8')
  const src = nn(raw)
  const out = editClient(src)
  console.log(out.hit ? `✓ ${out.label}` : `= ${out.label}`)
  if (!out.hit) return
  if (mode !== 'apply') { console.log('\n(dry run，加 --apply 才写)'); return }
  const bak = p + '.orig-muu'
  if (!existsSync(bak)) copyFileSync(p, bak)
  writeFileSync(p, rr(out.src), 'utf8')
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' })
  } catch (e) {
    copyFileSync(bak, p)
    throw new Error('语法检查失败，已回滚：' + String(e.stderr || e.message).slice(0, 400))
  }
  console.log('✔ 已写入 ' + p)
}

main()
