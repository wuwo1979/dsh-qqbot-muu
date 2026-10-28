#!/usr/bin/env node
/**
 * add-ext-ui.mjs — 悬浮窗面板里加「⚡ 本地代答」「🎤 语音」两块，并按三档模型重写顶部说明
 *
 * 主人反馈（m01460）：要改的文字"2、3 都有一点" ——
 *   ② 顶部那句「让机器人在本机跑一个 23MB 的中文小模型…」还停在只有 23MB 模型的年代；
 *   ③ 面板里根本没有本地代答 / 语音的开关（只能记事本改 json）。
 *
 * 本补丁 4 处：
 *   U1 顶部说明重写（三档模型 + 本地代答 + 语音一句话说清）
 *   U2 在智能回复卡片末尾插入两张小卡片（本地代答 / 语音）的 HTML 生成函数
 *   U3 插入 extCardHtml() 调用（body += …）
 *   U4 插入绑定逻辑（读配置填控件 / 保存 / 显示服务状态）
 *
 * 依赖后端：patches/add-ext-config-api.mjs（GET/POST /api/qqbot-settings/ext-config）
 * 用法：node add-ext-ui.mjs [--check|--revert]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { pluginPath } from './plugin-dir.mjs';
const F = pluginPath('client/qqbot-settings.js');
const BK = 'F:/qqbot/qqbot-mod/backups/qqbot-settings.js.orig-extui';
const MARK = '本机新增(2026-10-23): 本地代答 / 语音 面板卡片';

// ── U1 顶部说明（整行替换）──────────────────────────────────────────────
const OLD_INTRO = `          body += '<div class="dk-msg" style="line-height:1.6">让机器人在本机跑一个 23MB 的中文小模型(<b>零 token</b>): 价值评分(她该不该开口) + 表情包语义搜索 —— <b>模型缺失时自动关闭, 不影响任何现有功能</b>。</div>'`;
const NEW_INTRO = `          // ★ ${MARK} —— U1 顶部说明按三档模型 + 本地代答/语音重写
          body += '<div class="dk-msg" style="line-height:1.6">本机跑一个中文小模型(<b>零 token</b>)，干三件事: 判断她该不该开口(价值评分)、表情包语义搜索、<b>简单消息直接代答</b>。'
            + '三档任选: <b>小 23MB 最快</b> / <b>中 98MB 更准</b> / <b>大 330MB 最准</b> —— <b>模型缺失时自动关闭, 不影响任何现有功能</b>。</div>'`;

// ── U2 函数定义 ────────────────────────────────────────────────────────
const FN_ANCHOR = `      function applyModelDir(dir) {`;
const FN_BLOCK = `      // ★ ${MARK} —— U2 两张卡片: 本地代答(零 token) / 语音(TTS)
      //   配置存在 .qqbot-extensions 下的两个 json 里, 通过 add-ext-config-api.mjs 的
      //   /api/qqbot-settings/ext-config 读写 —— 不碰插件自己的 settings 存储。
      function extCardHtml() {
        var c = state.extLocal || {}
        var v = state.extVoice || {}
        var models = (c.models && c.models.length) ? c.models.slice() : ['qwen2.5:0.5b']
        var curM = String(c.model || 'qwen2.5:0.5b')
        if (models.indexOf(curM) < 0) models.unshift(curM)
        var voices = (v.voices && v.voices.length) ? v.voices : [{ id: 'zh-CN-XiaoyiNeural', label: '小艺 · 女 · 活泼' }]
        var curV = String(v.voice || 'zh-CN-XiaoyiNeural')
        if (!voices.some(function (x) { return x.id === curV })) voices = [{ id: curV, label: curV }].concat(voices)
        var prob = (v.prob === 0 || v.prob) ? v.prob : 0.35
        var up = c.serverUp === true
        var stTxt = c.loaded ? (up ? ('● 服务在线 · ' + ((c.models || []).length) + ' 个模型') : '○ 服务离线（本地不接管, 全部走云端）') : '（读取中…）'
        var html = ''
        html += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:14px 0 2px;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<span>⚡ 本地代答（零 token）</span>'
          + '<span class="dk-msg" id="dk-llm-state" style="font-size:11px;color:' + (up ? '#2f9e44' : '#e8590c') + '">' + esc(stTxt) + '</span>'
          + '</div>'
        html += '<div class="dk-row" style="gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 2px">'
          + '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"><input type="checkbox" id="dk-llm-on"' + (c.enabled === false ? '' : ' checked') + '> 启用</label>'
          + '<span style="font-size:12px;color:#666">模型</span>'
          + '<select class="qqs-inp" id="dk-llm-model" style="min-width:170px">'
          + models.map(function (m) { return '<option value="' + esc(m) + '"' + (m === curM ? ' selected' : '') + '>' + esc(m) + '</option>' }).join('')
          + '</select>'
          + '<button class="dk-btn ok" id="dk-llm-save" style="font-size:12px;padding:1px 10px">💾 保存</button>'
          + '<span class="dk-msg" id="dk-llm-hint2" style="color:#2f9e44"></span>'
          + '</div>'
        html += '<div class="dk-msg" style="font-size:11px;color:#888;line-height:1.6">只接管"群里 @她 且很简单"的消息（在吗 / 哈哈哈 / 2+3），本地约 0.1 秒答完，<b>不花云端 token</b>；主人说的话、任务型提问永远走云端。服务是 Ollama。</div>'

        html += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:14px 0 2px;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<span>🎤 语音（偶尔发语音条）</span>'
          + '<span class="dk-msg" style="font-size:11px;color:#999">edge-tts 本地合成 · 也是零 token</span>'
          + '</div>'
        html += '<div class="dk-row" style="gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 2px">'
          + '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"><input type="checkbox" id="dk-vc-on"' + (v.mode === 'off' ? '' : ' checked') + '> 启用</label>'
          + '<span style="font-size:12px;color:#666">概率</span>'
          + '<input class="qqs-inp" id="dk-vc-prob" type="number" step="0.05" min="0" max="1" style="width:72px" value="' + esc(prob) + '">'
          + '<span style="font-size:12px;color:#666">音色</span>'
          + '<select class="qqs-inp" id="dk-vc-voice" style="min-width:170px">'
          + voices.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === curV ? ' selected' : '') + '>' + esc(x.label || x.id) + '</option>' }).join('')
          + '</select>'
          + '<button class="dk-btn ok" id="dk-vc-save" style="font-size:12px;padding:1px 10px">💾 保存</button>'
          + '<span class="dk-msg" id="dk-vc-hint2" style="color:#2f9e44"></span>'
          + '</div>'
        html += '<div class="dk-msg" style="font-size:11px;color:#888;line-height:1.6">按概率把她的文字回复改发语音条，同一会话 45 秒内不会再发。概率 0.35 = 大约三条里有一条；嫌吵就调到 0.1 或直接取消勾选。</div>'
        return html
      }

      function extFillLocal() {
        var c = state.extLocal || {}
        var onEl = panel ? panel.querySelector('#dk-llm-on') : null
        var mdEl = panel ? panel.querySelector('#dk-llm-model') : null
        var stEl = panel ? panel.querySelector('#dk-llm-state') : null
        if (onEl) onEl.checked = c.enabled !== false
        if (mdEl) {
          var cur = String(c.model || 'qwen2.5:0.5b')
          var list = (c.models && c.models.length) ? c.models.slice() : []
          if (list.indexOf(cur) < 0) list.unshift(cur)
          mdEl.innerHTML = list.map(function (m) { return '<option value="' + esc(m) + '"' + (m === cur ? ' selected' : '') + '>' + esc(m) + '</option>' }).join('')
        }
        if (stEl) {
          var s = c.loaded ? (c.serverUp ? ('● 服务在线 · ' + ((c.models || []).length) + ' 个模型') : '○ 服务离线（本地不接管, 全部走云端）') : '（读取中…）'
          stEl.textContent = s
          stEl.style.color = c.serverUp ? '#2f9e44' : '#e8590c'
        }
      }

      function extFillVoice() {
        var v = state.extVoice || {}
        var onEl = panel ? panel.querySelector('#dk-vc-on') : null
        var prEl = panel ? panel.querySelector('#dk-vc-prob') : null
        var vcEl = panel ? panel.querySelector('#dk-vc-voice') : null
        if (onEl) onEl.checked = v.mode !== 'off'
        if (prEl) prEl.value = (v.prob === 0 || v.prob) ? v.prob : 0.35
        if (vcEl) {
          var cur = String(v.voice || 'zh-CN-XiaoyiNeural')
          var list = (v.voices && v.voices.length) ? v.voices : [{ id: cur, label: cur }]
          if (!list.some(function (x) { return x.id === cur })) list = [{ id: cur, label: cur }].concat(list)
          vcEl.innerHTML = list.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === cur ? ' selected' : '') + '>' + esc(x.label || x.id) + '</option>' }).join('')
        }
      }

      function loadExtCfg() {
        api('ext-config', 'which=local').then(function (d) {
          var c = (state.extLocal || {})
          if (d && d.ok) {
            c = { loaded: true, enabled: (d.config || {}).enabled !== false, model: (d.config || {}).model || 'qwen2.5:0.5b', serverUp: !!(d.ollama && d.ollama.up), models: (d.ollama && d.ollama.models) || [] }
          } else { c.loaded = true; c.serverUp = false }
          state.extLocal = c
          extFillLocal()
        })
        api('ext-config', 'which=voice').then(function (d) {
          var v = (state.extVoice || {})
          if (d && d.ok) {
            v = { loaded: true, mode: (d.config || {}).mode || 'sometimes', prob: (d.config || {}).prob, voice: (d.config || {}).voice || 'zh-CN-XiaoyiNeural', voices: d.voices || [] }
          } else { v.loaded = true }
          state.extVoice = v
          extFillVoice()
        })
      }

      function saveExtLocal() {
        var h = panel ? panel.querySelector('#dk-llm-hint2') : null
        var onEl = panel ? panel.querySelector('#dk-llm-on') : null
        var mdEl = panel ? panel.querySelector('#dk-llm-model') : null
        if (h) h.textContent = '保存中…'
        apiPost('ext-config', { ns: state.ns || undefined, which: 'local', patch: { enabled: !!(onEl && onEl.checked), model: mdEl ? mdEl.value : '' } }).then(function (d) {
          if (d && d.ok) {
            var c = state.extLocal || {}
            c.enabled = (d.config || {}).enabled !== false
            c.model = (d.config || {}).model || 'qwen2.5:0.5b'
            c.serverUp = !!(d.ollama && d.ollama.up)
            c.models = (d.ollama && d.ollama.models) || c.models || []
            c.loaded = true
            state.extLocal = c
            extFillLocal()
            if (h) h.textContent = '已保存 ✓ 下一条消息生效'
          } else if (h) h.textContent = '保存失败: ' + ((d && d.error) || '未知响应')
        })
      }

      function saveExtVoice() {
        var h = panel ? panel.querySelector('#dk-vc-hint2') : null
        var onEl = panel ? panel.querySelector('#dk-vc-on') : null
        var prEl = panel ? panel.querySelector('#dk-vc-prob') : null
        var vcEl = panel ? panel.querySelector('#dk-vc-voice') : null
        if (h) h.textContent = '保存中…'
        apiPost('ext-config', { ns: state.ns || undefined, which: 'voice', patch: { mode: (onEl && onEl.checked) ? 'sometimes' : 'off', prob: prEl ? (parseFloat(prEl.value) || 0) : 0.35, voice: vcEl ? vcEl.value : '' } }).then(function (d) {
          if (d && d.ok) {
            var v = state.extVoice || {}
            v.mode = (d.config || {}).mode || 'sometimes'
            v.prob = (d.config || {}).prob
            v.voice = (d.config || {}).voice || 'zh-CN-XiaoyiNeural'
            v.loaded = true
            state.extVoice = v
            extFillVoice()
            if (h) h.textContent = '已保存 ✓ 下一条回复生效'
          } else if (h) h.textContent = '保存失败: ' + ((d && d.error) || '未知响应')
        })
      }

      function bindExtCard() {
        if (!panel) return
        var lBtn = panel.querySelector('#dk-llm-save')
        if (lBtn) lBtn.onclick = function () { saveExtLocal() }
        var vBtn = panel.querySelector('#dk-vc-save')
        if (vBtn) vBtn.onclick = function () { saveExtVoice() }
        if (panel.querySelector('#dk-llm-model') || panel.querySelector('#dk-vc-voice')) loadExtCfg()
      }

`;

// ── U3 调用点：插在 #dk-lm-hint 那行之后 ────────────────────────────────
const HTML_ANCHOR = `            body += '<span class="dk-msg" id="dk-lm-hint" style="color:#2f9e44;margin:2px 0"></span>'`;
const HTML_ADD = `            body += '<span class="dk-msg" id="dk-lm-hint" style="color:#2f9e44;margin:2px 0"></span>'
            body += extCardHtml()   // ★ ${MARK} —— U3 本地代答 / 语音两张卡片`;

// ── U4 绑定点：插在 .dk-lm-pick 绑定之后 ───────────────────────────────
const BIND_ANCHOR = `        panel.querySelectorAll('.dk-lm-pick').forEach(function (b) {
          b.onclick = function () { applyModelDir(b.getAttribute('data-dir')) }
        })`;
const BIND_ADD = `        panel.querySelectorAll('.dk-lm-pick').forEach(function (b) {
          b.onclick = function () { applyModelDir(b.getAttribute('data-dir')) }
        })
        bindExtCard()   // ★ ${MARK} —— U4 读配置 / 保存 / 显示服务状态`;

const argv = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);

if (!existsSync(F)) { log(`✗ 文件不存在: ${F}`); process.exit(1); }
if (argv.has('--revert')) {
  if (!existsSync(BK)) { log('✗ 没有备份'); process.exit(1); }
  copyFileSync(BK, F); log('已还原'); process.exit(0);
}

let src = readFileSync(F, 'utf8');
if (src.includes(MARK)) { log('= 已经打过了，跳过。'); process.exit(0); }

const EOL = src.includes('\r\n') ? '\r\n' : '\n';
const norm = (s) => s.split('\n').join(EOL);
const tnorm = (s) => s.split('\r\n').join('\n');

const jobs = [
  ['U1 顶部说明', norm(OLD_INTRO), norm(NEW_INTRO)],
  ['U2 卡片函数', norm(FN_ANCHOR), norm(FN_BLOCK) + EOL + norm(FN_ANCHOR)],
  ['U3 调用卡片', norm(HTML_ANCHOR), norm(HTML_ADD)],
  ['U4 绑定', norm(BIND_ANCHOR), norm(BIND_ADD)],
];

let out = src;
const plan = [];
for (const [name, oldS, newS] of jobs) {
  if (!out.includes(norm(tnorm(oldS)))) { log(`✗ ${name}: 找不到锚点`); process.exit(1); }
  plan.push([name, oldS, newS]);
}
if (argv.has('--check')) { log(`(--check) 4 处都能打，未写入`); process.exit(0); }

mkdirSync('F:/qqbot/qqbot-mod/backups', { recursive: true });
if (!existsSync(BK)) { copyFileSync(F, BK); log(`备份: ${BK}`); }

for (const [name, oldS, newS] of plan) {
  const at = out.indexOf(norm(tnorm(oldS)));
  out = out.slice(0, at) + newS + out.slice(at + norm(tnorm(oldS)).length);
  log(`  ✓ ${name}`);
}

writeFileSync(F, out, 'utf8');
log('写入完成，语法自检…');
try {
  execFileSync(process.execPath, ['--check', F], { stdio: 'inherit' });
  log('语法 OK');
} catch {
  copyFileSync(BK, F);
  log('✗ 语法失败 → 已回滚');
  process.exit(1);
}
log('\n浏览器 Ctrl+R 刷新就能看到「⚡ 本地代答」「🎤 语音」两块。');
