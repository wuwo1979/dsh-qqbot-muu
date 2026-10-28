/**
 * fix-dock-ux.mjs —— 悬浮窗（主用界面）可用性修复，三个补丁：
 *   D1 模型改成**下拉可选**（原来是只能手敲路径的文本框 —— 用户反复说"模型还是选不了"）
 *   D2 下拉 ↔ 输入框联动（选中即写入，复用原保存逻辑；选"自定义路径"则聚焦手填）
 *   D3 **未命中 QQ 会话不再整体 return**：只有会话级覆盖项依赖 ovKey，账号级(模型目录/程序兜底/附件唤醒)
 *      照样能存 —— 这是"整块面板全废"的真因
 *
 * 用法：
 *   node patches/fix-dock-ux.mjs --check    只检查（默认）
 *   node patches/fix-dock-ux.mjs --apply    打补丁（改前备份 .orig-dockux）
 *   node patches/fix-dock-ux.mjs --revert   回滚
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
import { pluginPath } from './plugin-dir.mjs';
const FILE = pluginPath('client/qqbot-settings.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/qqbot-settings.js.orig'

const mode = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--revert') ? 'revert' : 'check'

/** D1: 模型输入框 → 下拉 + 输入框 */
const D1_OLD = `              + '<input class="qqs-inp" id="dk-lm-dir" style="flex:1;min-width:200px" placeholder="模型目录(留空=默认 ~/.dsh/models/bge-small-zh)" value="' + esc(lm.modelDir || '') + '">'`

const D1_NEW = `              + (function () {
                // 2026-08 改版: 模型从"只能手敲路径"变成**下拉可点选**(用户反复反馈"模型选不了")
                var _presets = [['bge-small-zh', 'bge-small-zh · 23MB 最快'], ['bge-base-zh', 'bge-base-zh · 98MB 更准'], ['bge-large-zh', 'bge-large-zh · 330MB 最准']]
                var _isPreset = false
                for (var _i = 0; _i < _presets.length; _i++) { if (_presets[_i][0] === lmName) _isPreset = true }
                if (!lmName) _isPreset = true
                var _curName = lmName || 'bge-small-zh'
                var _opt = ''
                for (var _j = 0; _j < _presets.length; _j++) {
                  _opt += '<option value="' + _presets[_j][0] + '"' + (_presets[_j][0] === _curName ? ' selected' : '') + '>' + _presets[_j][1] + '</option>'
                }
                _opt += '<option value="__custom"' + (_isPreset ? '' : ' selected') + '>自定义路径…</option>'
                return '<select class="qqs-inp" id="dk-lm-preset" style="min-width:170px" title="选一个现成的模型, 或选「自定义路径」手填">' + _opt + '</select>'
                  + '<input class="qqs-inp" id="dk-lm-dir" style="flex:1;min-width:200px" placeholder="模型目录/别名(留空=默认 bge-small-zh)" value="' + esc(lm.modelDir || '') + '">'
              })()`

/** D2: 下拉联动 */
const D2_OLD = `        var saveBtn = panel.querySelector('#dk-lm-save')
        if (saveBtn) saveBtn.onclick = function () { saveLocalModel() }`

const D2_NEW = `        var saveBtn = panel.querySelector('#dk-lm-save')
        if (saveBtn) saveBtn.onclick = function () { saveLocalModel() }
        // 模型下拉 ↔ 目录输入框联动: 选中即写进输入框(复用原有保存逻辑), 选「自定义」则聚焦手填
        var presetEl = panel.querySelector('#dk-lm-preset')
        if (presetEl) presetEl.onchange = function () {
          var dirB = panel.querySelector('#dk-lm-dir')
          if (!dirB) return
          if (presetEl.value === '__custom') { dirB.focus(); if (dirB.select) dirB.select(); return }
          dirB.value = presetEl.value
          var h2 = panel.querySelector('#dk-lm-hint')
          if (h2) h2.textContent = '已选 ' + presetEl.value + ' —— 点「💾 保存」生效(重载约 0.3 秒)'
        }`

/** D3a: 去掉整体 return */
const D3A_OLD = `        if (!ovKey) {
          if (hint) hint.textContent = '✗ 当前会话不是 QQ 会话 —— 单会话设置需先切到与 bot 的群/私聊(顶栏「当前会话」要命中)'
          return
        }`

const D3A_NEW = `        var _ovMissing = !ovKey`

/** D3b: 写覆盖项时跳过空 key */
const D3B_OLD = `          lm.overrides[ovKey] = ovNext                                    // 会话级`

const D3B_NEW = `          if (!_ovMissing) lm.overrides[ovKey] = ovNext                   // 会话级(未命中会话则不写)`

/** D3c: 本地回填也跳过空 key */
const D3C_OLD = `            lm2.overrides[ovKey] = ovNext`

const D3C_NEW = `            if (!_ovMissing) lm2.overrides[ovKey] = ovNext`

/** D3d: 成功提示区分账号级/会话级 */
const D3D_OLD = `            if (hint) hint.textContent = '已保存 ✓(仅对本会话生效, live)'`

const D3D_NEW = `            if (hint) hint.textContent = _ovMissing
              ? '已保存 ✓(账号级·全局生效; 本会话未绑定 QQ, 评分项未改)'
              : '已保存 ✓(仅对本会话生效, live)'`

/** D4: 未命中会话时，「本会话」不再只摆一句"不是 QQ 会话" —— 回落到面板选中的群并标注"手动指定" */
const D4_OLD = `      function curHitLabel() {
        var hit = state.detectedHit
        if (!hit || !hit.peerId) return '（当前会话不是 QQ 会话）'
        return (hit.scope === 'group' ? '群「' + (hit.name || '…') + '」' : '私聊「' + (hit.name || '…') + '」')
      }`

const D4_NEW = `      function curHitLabel() {
        var hit = state.detectedHit
        if (!hit || !hit.peerId) {
          // 2026-08 修(用户反馈"未命中 QQ 会话 ⇒ 基本没有一个能用"): 不再摆一句"不是 QQ 会话"了事,
          // 回落到「群管理」里选中的群并明确标注"手动指定" —— 下面的覆盖项就能正常读写。
          var g0 = state.gid || ''
          if (g0) {
            var nm0 = ''
            try { (state.groups || []).forEach(function (x) { if (x.gid === g0) nm0 = x.name || x.groupName || x.group_name || '' }) } catch (e) {}
            return '群「' + (nm0 || g0) + '」(手动指定)'
          }
          return '（未绑定 QQ 会话 · 到「群管理」选一个群即可）'
        }
        return (hit.scope === 'group' ? '群「' + (hit.name || '…') + '」' : '私聊「' + (hit.name || '…') + '」')
      }`

/** D5: curOvKey 也做同样的回落（原来只认 detectedHit） */
const D5_OLD = `      function curOvKey() {
        var hit = state.detectedHit
        return (hit && hit.peerId) ? (hit.scope + ':' + hit.peerId) : ''
      }`

const D5_NEW = `      function curOvKey() {
        var hit = state.detectedHit
        if (hit && hit.peerId) return hit.scope + ':' + hit.peerId
        // 2026-08: 未命中会话时回落到面板选中的群(与 ctxlessKey() 口径一致),
        // 否则"单会话设置"整块永远写不进去。
        var g1 = state.gid || ''
        return g1 ? ('group:' + g1) : ''
      }`

const PATCHES = [
  ['D1 模型改成下拉可选', D1_OLD, D1_NEW],
  ['D2 下拉↔输入框联动', D2_OLD, D2_NEW],
  ['D3a 未命中会话不再整体 return', D3A_OLD, D3A_NEW],
  ['D3b 覆盖项跳过空 key(写配置)', D3B_OLD, D3B_NEW],
  ['D3c 覆盖项跳过空 key(本地回填)', D3C_OLD, D3C_NEW],
  ['D3d 保存提示区分账号级/会话级', D3D_OLD, D3D_NEW],
  ['D4 未命中会话时显示手动指定的群', D4_OLD, D4_NEW],
  ['D5 curOvKey 回落到面板选中的群', D5_OLD, D5_NEW],
]

if (mode === 'revert') {
  if (!existsSync(BAK)) { console.error('没有备份可回滚: ' + BAK); process.exit(1) }
  copyFileSync(BAK, FILE)
  console.log('已回滚到 ' + BAK)
  process.exit(0)
}

let src = readFileSync(FILE, 'utf8')
let applied = 0, already = 0, missing = []

// 该 bundle 用 CRLF；跨行匹配必须按文件实际行尾归一化，否则只有单行补丁能命中
const EOL = src.includes('\r\n') ? '\r\n' : '\n'
const toEol = (s) => s.split('\n').join(EOL)

for (const [name, oldS0, newS0] of PATCHES) {
  const oldS = toEol(oldS0), newS = toEol(newS0)
  const hasOld = src.includes(oldS)
  const hasNew = src.includes(newS)
  if (hasNew) { console.log(`  = ${name}  [已应用]`); already++; continue }
  if (!hasOld) { console.log(`  ! ${name}  [未匹配 — 源码已变]`); missing.push(name); continue }
  if (mode === 'apply') { src = src.split(oldS).join(newS); applied++ }
  console.log(`  + ${name}  [${mode === 'apply' ? '已打' : '可打'}]`)
}

if (mode === 'apply') {
  // 备份放工作区：插件目录里新建文件会被沙箱拒（EPERM），改写已有文件则允许
  if (!existsSync(BAK)) {
    mkdirSync(dirname(BAK), { recursive: true })
    writeFileSync(BAK, readFileSync(FILE, 'utf8'), 'utf8')
    console.log('已备份原文件 → ' + BAK)
  }
  writeFileSync(FILE, src, 'utf8')
  console.log(`\n写入完成: 新打 ${applied} 处, 原本已应用 ${already} 处`)
} else {
  console.log(`\n检查完成: 可打 ${PATCHES.length - already - missing.length} 处, 已应用 ${already} 处, 未匹配 ${missing.length} 处`)
}
if (missing.length) console.log('⚠️ 未匹配项需要人工核对: ' + missing.join(', '))
