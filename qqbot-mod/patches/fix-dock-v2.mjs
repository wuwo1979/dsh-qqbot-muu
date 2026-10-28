/**
 * fix-dock-v2.mjs —— 悬浮窗第二轮可用性修复
 *   E1 顶栏「当前会话 → 未命中 QQ 会话」整块隐藏（主人："没用，去掉吧"）
 *   E2 隐藏「本会话: …(手动指定)」小字
 *   E3 隐藏「最近评分」旁的会话小字
 *   E4 去掉「无上下文模式」里的"作用对象"小字
 *   E5 模型改成**一键按钮**：点哪个立刻切换并保存（下拉"看着选了又跳回去"的真因=重绘回填）
 *
 * 用法：node patches/fix-dock-v2.mjs [--check|--apply|--revert]
 * 备份：F:/qqbot/qqbot-mod/backups/qqbot-settings.js.orig-v2
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

import { pluginPath } from './plugin-dir.mjs';
const FILE = pluginPath('client/qqbot-settings.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/qqbot-settings.js.orig-v2'

const mode = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--revert') ? 'revert' : 'check'

/** E1: 顶栏整块隐藏 */
const E1_OLD = `        var d = panel.querySelector('.dk-detect')
        if (!d) return`

const E1_NEW = `        var d = panel.querySelector('.dk-detect')
        if (!d) return
        // 2026-08 主人: 「当前会话 → 未命中 QQ 会话」这块判定没用, 整条去掉(含下面的小字)
        d.style.display = 'none'
        if (d) return`

/** E2: 「本会话: …」小字 */
const E2_OLD = `              + '<span class="dk-msg" style="font-size:12px;color:#7c6bd6">本会话: ' + esc(curHitLabel()) + '</span>'`

const E2_NEW = `              + ''`

/** E3: 最近评分旁的会话小字（整行删除；用正则，删除后 old 不再存在才算成功） */
const E3_RE = /\s*\+ '<span class="dk-msg" style="font-size:11px;color:#7c6bd6" id="dk-vs-scope">' \+ esc\(curHitLabel\(\)\) \+ '<\/span>'/

/** E4: 无上下文模式的"作用对象"小字 */
const E4_OLD = `            body += '<div class="dk-msg" style="color:#888;font-size:12px;margin:2px 0 6px">作用对象: <b>' + (ctxHit || '（当前会话不是 QQ 会话）') + '</b></div>'`

const E4_NEW = `            body += ''`

/** E5a: 模型一行改成按钮组（整段用正则替换，避免缩进/中文标点漂移导致字面量匹配失败） */
const E5A_RE = /body \+= '<div class="dk-row" style="gap:6px;margin:4px 0;flex-wrap:wrap">'\s*\r?\n[\s\S]*?id="dk-lm-check">🔄 重新检测<\/button>'/

const E5A_NEW = `            // 2026-08 主人反复反馈"模型还是选不了": 下拉改了输入框却没触发重载 / 重绘又按旧值回填 ⇒ 看着跳回去。
            // 改成**一键按钮**: 点哪个当场写配置 + 重载, 不需要再点保存。
            var _curName = lmName || 'bge-small-zh'
            body += '<div class="dk-row" style="gap:6px;margin:4px 0;flex-wrap:wrap;align-items:center">'
              + '<span style="font-size:12px;color:#666">模型:</span>'
              + [['bge-small-zh', '小 · 23MB 最快'], ['bge-base-zh', '中 · 98MB 更准'], ['bge-large-zh', '大 · 330MB 最准']].map(function (c) {
                var _sel = (c[0] === _curName)
                return '<button class="dk-btn dk-lm-pick' + (_sel ? ' ok' : '') + '" data-dir="' + c[0] + '" style="font-size:12px;padding:3px 10px"' + (_sel ? ' title="当前在用"' : '') + '>' + (_sel ? '✅ ' : '') + c[1] + '</button>'
              }).join('')
              + '<span style="font-size:11px;color:#7c6bd6" id="dk-lm-hint"></span>'
              + '</div>'
            body += '<div class="dk-row" style="gap:6px;margin:4px 0;flex-wrap:wrap;align-items:center">'
              + '<input class="qqs-inp" id="dk-lm-dir" style="flex:1;min-width:200px" placeholder="自定义: 模型目录或别名(如 bge-base-zh)" value="' + esc(lm.modelDir || '') + '">'
              + '<button class="dk-btn" id="dk-lm-save">💾 用这个路径</button>'
              + '<button class="dk-btn" id="dk-lm-check">🔄 重新检测</button>'`

/** E5b: 绑定按钮 + 一键切换函数 */
const E5B_OLD = `        var presetEl = panel.querySelector('#dk-lm-preset')
        if (presetEl) presetEl.onchange = function () {
          var dirB = panel.querySelector('#dk-lm-dir')
          if (!dirB) return
          if (presetEl.value === '__custom') { dirB.focus(); if (dirB.select) dirB.select(); return }
          dirB.value = presetEl.value
          var h2 = panel.querySelector('#dk-lm-hint')
          if (h2) h2.textContent = '已选 ' + presetEl.value + ' —— 点「💾 保存」生效(重载约 0.3 秒)'
        }`

const E5B_NEW = `        // 一键切换模型: 点按钮 → 写配置 → 重绘 → 重新加载(不用再点保存)
        panel.querySelectorAll('.dk-lm-pick').forEach(function (b) {
          b.onclick = function () { applyModelDir(b.getAttribute('data-dir')) }
        })`

const PATCHES = [
  ['E1 隐藏顶栏命中判定', E1_OLD, E1_NEW],
  ['E2 隐藏「本会话」小字', E2_OLD, E2_NEW],
  ['E4 去掉无上下文作用对象小字', E4_OLD, E4_NEW],
  ['E5b 绑定一键切换', E5B_OLD, E5B_NEW],
]

/** E5c: 新增 applyModelDir()（插在 saveLocalModel 定义之前） */
const E5C_OLD = `      function saveLocalModel() {`
const E5C_NEW = `      // 2026-08 新增: 一键切换本地模型(按钮点选, 立刻写配置并重载)
      function applyModelDir(dir) {
        var hint = panel ? panel.querySelector('#dk-lm-hint') : null
        if (!dir) return
        if (hint) hint.textContent = '切换中…'
        fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
          var cur = (d && d.value) || {}
          var lm = Object.assign({}, cur.localModel || {})
          lm.modelDir = String(dir)
          var patch = Object.assign({}, cur, { localModel: lm })
          return fetch(UPDATE, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ns: state.ns || undefined, patch: patch, expectedRevision: d && d.revision }),
          }).then(function (r2) { return r2.json() })
        }).then(function (res) {
          if (res && !res.error) {
            var lm2 = Object.assign({}, state.lmCfg || {})
            lm2.modelDir = String(dir)
            state.lmCfg = lm2
            if (hint) hint.textContent = '已切到 ' + dir + ' ✓ 正在重载'
            paintBody()
            setTimeout(function () { loadLocalModel() }, 1500)
          } else if (hint) hint.textContent = '切换失败: ' + ((res && res.error) || '未知响应')
        }).catch(function (e) { if (hint) hint.textContent = '切换异常: ' + e.message })
      }
      function saveLocalModel() {`

if (mode === 'revert') {
  if (!existsSync(BAK)) { console.error('没有备份: ' + BAK); process.exit(1) }
  writeFileSync(FILE, readFileSync(BAK, 'utf8'), 'utf8')
  console.log('已回滚到 ' + BAK)
  process.exit(0)
}

let src = readFileSync(FILE, 'utf8')
const EOL = src.includes('\r\n') ? '\r\n' : '\n'
const toEol = (s) => s.split('\n').join(EOL)
let applied = 0, already = 0, missing = []

for (const [name, oldS0, newS0] of [...PATCHES, ['E5c 新增 applyModelDir()', E5C_OLD, E5C_NEW]]) {
  const oldS = toEol(oldS0), newS = toEol(newS0)
  if (src.includes(newS)) { console.log(`  = ${name}  [已应用]`); already++; continue }
  if (!src.includes(oldS)) { console.log(`  ! ${name}  [未匹配]`); missing.push(name); continue }
  if (mode === 'apply') { src = src.split(oldS).join(newS); applied++ }
  console.log(`  + ${name}  [${mode === 'apply' ? '已打' : '可打'}]`)
}

// E3 走正则（整行删除）
{
  const name = 'E3 隐藏评分旁会话小字'
  if (!src.includes('dk-vs-scope')) { console.log(`  = ${name}  [已应用]`); already++ }
  else if (!E3_RE.test(src)) { console.log(`  ! ${name}  [未匹配]`); missing.push(name) }
  else {
    if (mode === 'apply') { src = src.replace(E3_RE, ''); applied++ }
    console.log(`  + ${name}  [${mode === 'apply' ? '已打' : '可打'}]`)
  }
}

// E5a 走正则（整段多行 + 中文标点，字面量匹配容易因缩进漂移失败）
{
  const name = 'E5a 模型改一键按钮'
  const newS = toEol(E5A_NEW)
  if (src.includes('dk-lm-pick')) { console.log(`  = ${name}  [已应用]`); already++ }
  else if (!E5A_RE.test(src)) { console.log(`  ! ${name}  [未匹配]`); missing.push(name) }
  else {
    const next = src.replace(E5A_RE, () => newS)
    if (mode === 'apply') { src = next; applied++ }
    console.log(`  + ${name}  [${mode === 'apply' ? '已打' : '可打'}]`)
  }
}

if (mode === 'apply') {
  if (!existsSync(BAK)) {
    mkdirSync('F:/qqbot/qqbot-mod/backups', { recursive: true })
    writeFileSync(BAK, readFileSync(FILE, 'utf8'), 'utf8')
    console.log('已备份 → ' + BAK)
  }
  writeFileSync(FILE, src, 'utf8')
  console.log(`\n写入完成: 新打 ${applied} 处, 已应用 ${already} 处`)
} else {
  console.log(`\n检查完成: 可打 ${7 - already - missing.length} 处, 已应用 ${already} 处, 未匹配 ${missing.length} 处`)
}
if (missing.length) console.log('⚠️ 未匹配: ' + missing.join(', '))
