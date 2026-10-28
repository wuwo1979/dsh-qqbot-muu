/**
 * fix-video-ui —— 2026-10-27
 *  浮窗「B站管理」的视频块：
 *   ① 加「📐 画幅（竖屏/横屏）」「🎬 屏数」两个参数，plan 时一起传下去；
 *   ② 任务状态显示成人话（写分镜/出图配音/待审核/失败），失败把原因红字列出来，
 *      并显示"脚本来源"（云端/本地/模板兜底）与屏数；
 *   ③ 生成后自动轮询，直到没有 scripting/rendering 的任务 —— 这才有"一键"的感觉。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { PLUGIN, pluginPath } from './plugin-dir.mjs'

const CLIENT = pluginPath('client/qqbot-settings.js')
const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')

const orig = readFileSync(CLIENT, 'utf8')
let src = orig.replace(/\r\n/g, '\n')
const report = []
let hits = 0

function rep(label, oldStr, newStr) {
  const i = src.indexOf(oldStr)
  if (i < 0) { report.push(`✗ ${label}：锚点没找到`); return false }
  if (src.indexOf(oldStr, i + 1) >= 0) { report.push(`✗ ${label}：锚点不唯一`); return false }
  if (src.includes(newStr)) { report.push(`= ${label}：已是新版`); return true }
  src = src.slice(0, i) + newStr + src.slice(i + oldStr.length)
  hits += 1
  report.push(`✓ ${label}`)
  return true
}

// ── ① 画幅/屏数参数 ───────────────────────────────────────────────────
rep(
  '加画幅/屏数控件',
  `          + '<span>🛤 路子</span>'`,
  `          + '<span>📐 画幅</span>'
          + '<select id="dk-bili-orient" class="qqs-sel" style="font-size:12px"><option value="vertical">竖屏 1080×1920</option><option value="horizontal">横屏 1280×720</option></select>'
          + '<span>🎬 屏数</span>'
          + '<input id="dk-bili-panels" class="qqs-txt" type="number" min="2" max="12" value="7" style="width:54px;font-size:12px" title="分镜屏数 2~12">'
          + '<span>🛤 路子</span>'`
)

// ── ② plan 带上参数 + 自动轮询 ────────────────────────────────────────
rep(
  'plan 传画幅/屏数并自动轮询',
  `        async function make(kind) {
          var topic = (cmd && cmd.value || '').trim()
          if (!topic) { alert('先写一句要求'); return }
          try {
            var r = await apiPost('bili', { action: 'plan', topic: topic })
            alert(r && r.ok ? ('已开始：' + (r.msg || r.jobId)) : ('失败：' + ((r && r.error) || '?')))
            load()
          } catch (e) { alert('失败：' + ((e && e.message) || e)) }
        }`,
  `        async function make(kind) {
          var topic = (cmd && cmd.value || '').trim()
          if (!topic) { alert('先写一句要求'); return }
          var orientEl = document.querySelector('#dk-bili-orient')
          var panelsEl = document.querySelector('#dk-bili-panels')
          var orientation = (orientEl && orientEl.value) || 'vertical'
          var panels = Number((panelsEl && panelsEl.value) || 0) || 7
          if (panels < 2 || panels > 12) { alert('屏数要在 2~12 之间'); return }
          try {
            var r = await apiPost('bili', { action: 'plan', topic: topic, orientation: orientation, panels: panels })
            if (r && r.ok) {
              state._biliPollUntil = Date.now() + 15 * 60 * 1000
              dkPollJobs(0)
              alert('已开始（' + (orientation === 'vertical' ? '竖屏' : '横屏') + ' · ' + panels + ' 屏）：\\n先写分镜脚本，再出图、配音、拼片。\\n任务 ' + (r.jobId || '') + '，下面列表会自动刷新。')
            } else {
              alert('失败：' + ((r && r.error) || '?'))
            }
            load()
          } catch (e) { alert('失败：' + ((e && e.message) || e)) }
        }`
)

// ── ③ 任务行：人话状态 + 失败原因 + 脚本来源 + 轮询器 ─────────────────
rep(
  '任务行状态人话化',
  `            var jobRow = function (j) {`,
  `            var dkJobStatusLabel = function (j) {
              var s = String(j.status || '')
              if (s === 'scripting') return '✍️ 正在写分镜'
              if (s === 'scripted') return '📝 分镜好了，准备出图'
              if (s === 'rendering') return '🎨 正在出图/配音'
              if (s === 'awaiting_review') return '✅ 待审核'
              if (s === 'publishing') return '📤 正在投稿'
              if (s === 'published') return '📤 已投稿'
              if (s === 'failed') return '❌ 失败'
              return s || '新建'
            }
            var _dkJobPoll = null
            function dkPollJobs(n) {
              if (_dkJobPoll) { clearTimeout(_dkJobPoll); _dkJobPoll = null }
              if (n > 150) return
              if (state._biliPollUntil && Date.now() > state._biliPollUntil) return
              _dkJobPoll = setTimeout(async function () {
                var d = null
                try { d = await api('bili') } catch (e) { return }
                if (!d || d.ok === false) return
                var active = (d.jobs || []).some(function (j) {
                  return j.status === 'scripting' || j.status === 'rendering' || j.status === 'scripted'
                })
                try { load() } catch (e) {}
                if (active) dkPollJobs(n + 1)
              }, 6000)
            }
            var jobRow = function (j) {`
)

rep(
  '任务行展示失败原因与脚本来源',
  `                + '<div style="font-size:11px;color:#888">' + esc(j.status || '') + (j.durationSec ? ' · ' + j.durationSec + 's' : '') + (j.warnings ? ' · ⚠' + j.warnings : '') + (j.error ? ' · ' + esc(j.error) : '') + '</div>'`,
  `                + '<div style="font-size:11px;color:#888">' + esc(dkJobStatusLabel(j)) + (j.panels && j.panels.length ? ' · ' + j.panels.length + ' 屏' : '') + (j.durationSec ? ' · ' + j.durationSec + 's' : '') + (j.tts && j.tts.voice ? ' · 🔊 ' + esc(j.tts.voice) : '') + (j.warnings ? ' · ⚠' + (j.warnings.length || j.warnings) : '') + '</div>'
                + (j.error ? '<div style="font-size:11px;color:#e03131;line-height:1.5">❌ ' + esc(String(j.error).slice(0, 180)) + '</div>' : '')
                + (j.script && j.script.llm ? '<div style="font-size:11px;color:#adb5bd">脚本：' + esc(j.script.llm === 'template' ? '模板兜底（模型没回话）' : j.script.llm === 'cloud' ? '云端大模型' : j.script.llm === 'local' ? '本地模型' : j.script.llm) + '</div>' : '')`
)

for (const line of report) console.log(line)
if (!APPLY) {
  console.log(hits ? `\n需要写入 ${hits} 处（--apply 才写）` : '\n= 已是最新，无需写入')
  process.exit(0)
}
if (!hits) { console.log('\n= 已是最新，无需写入'); process.exit(0) }

const out = String(orig).includes('\r\n') ? src.replace(/\n/g, '\r\n') : src
try {
  copyFileSync(CLIENT, CLIENT + '.orig-muu-videoui')
  writeFileSync(CLIENT, out, 'utf8')
} catch (e) {
  console.log('✗ 写入失败：' + (e && e.message))
  process.exit(1)
}
console.log(`\n✔ 已写入 ${CLIENT}`)
console.log('  插件目录：' + PLUGIN)
