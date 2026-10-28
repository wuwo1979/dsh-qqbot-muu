#!/usr/bin/env node
/**
 * fix-ext-ui2.mjs —— 本地代答那一块：加「谁来答」下拉 + 「最近判定」列表
 *
 * 用户反馈（2026-10-23）：
 *   · "本地小模型似乎也没有生效" —— 面板上完全看不出来谁答的、被哪道门挡了
 *   · "可以在浮窗界面加一个，回答由哪个模型输出这种"
 *
 * 于是：
 *   1. 模型下拉旁边加「谁来答」：关闭 / 简单消息 / 简单+闲聊 / 尽量本地
 *      （写进 local-llm-config.json 的 whoAnswers，由 inbound/local-answer.mjs 读）
 *   2. 卡片底部加「📋 最近判定」：读 /api/qqbot-settings/ext-answer-log，
 *      一行一条：本地/云端 + 原因 + 模型 + 耗时 + 原文
 *   3. 说明文字改成四档说法
 *
 * ⚠️ 本文件刻意**不含反斜杠**：EOL 用 String.fromCharCode 拼，
 *    客户端里要的换行也用 String.fromCharCode(10)，避免写文件时被转义成字面量。
 *
 * 用法：--check / --apply / --revert
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLUGIN } from './plugin-dir.mjs';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;

const FILE = join(PLUGIN, 'client', 'qqbot-settings.js');
const BACKUP = join('F:/qqbot/qqbot-mod/backups', 'qqbot-settings.js.orig-extui2');

const OPS = [
  // ── 1. 谁来答 下拉 ───────────────────────────────────────────────
  {
    marker: 'dk-llm-who',
    old: [
      "          + '<label style=\"display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer\"><input type=\"checkbox\" id=\"dk-llm-on\"' + (c.enabled === false ? '' : ' checked') + '> 启用</label>'",
      "          + '<span style=\"font-size:12px;color:#666\">模型</span>'",
    ].join(EOL),
    new: [
      "          + '<label style=\"display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer\"><input type=\"checkbox\" id=\"dk-llm-on\"' + (c.enabled === false ? '' : ' checked') + '> 启用</label>'",
      "          + '<span style=\"font-size:12px;color:#666\">谁来答</span>'",
      "          + '<select class=\"qqs-inp\" id=\"dk-llm-who\" style=\"min-width:140px\">'",
      "          + [['off', '关闭（全走云端）'], ['simple', '简单消息（推荐）'], ['chat', '简单+闲聊'], ['all', '尽量本地']].map(function (p) { return '<option value=\"' + p[0] + '\"' + (String(c.who || 'simple') === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>' }).join('')",
      "          + '</select>'",
      "          + '<span style=\"font-size:12px;color:#666\">模型</span>'",
    ].join(EOL),
  },

  // ── 2. 说明文字 + 最近判定列表 ──────────────────────────────────
  {
    marker: 'dk-llm-recent',
    old: "        html += '<div class=\"dk-msg\" style=\"font-size:11px;color:#888;line-height:1.6\">只接管\"群里 @她 且很简单\"的消息（在吗 / 哈哈哈 / 2+3），本地约 0.1 秒答完，<b>不花云端 token</b>；主人说的话、任务型提问永远走云端。服务是 Ollama。</div>'",
    new: [
      "        html += '<div class=\"dk-msg\" style=\"font-size:11px;color:#888;line-height:1.6\">谁来答：<b>简单消息</b>=碎句/打招呼/2+3 这类才走本地；<b>简单+闲聊</b>=废话也本地答（更省 token）；<b>尽量本地</b>=除任务型全本地。本地约 0.1 秒、<b>不花云端 token</b>；主人说的话和任务型提问永远走云端。任务型（找资源/写代码/查东西）不会交给小模型。</div>'",
      "        html += '<div class=\"dk-row\" style=\"gap:8px;align-items:center;margin:8px 0 0;font-size:12px;color:#666\">'",
      "          + '<span>📋 最近判定</span>'",
      "          + '<button class=\"dk-btn\" id=\"dk-llm-reflog\" style=\"font-size:11px;padding:0 8px\">🔄 刷新</button>'",
      "          + '<span class=\"dk-msg\" id=\"dk-llm-recent-note\" style=\"font-size:11px;color:#999\"></span>'",
      "          + '</div>'",
      "        html += '<div class=\"dk-msg\" id=\"dk-llm-recent\" style=\"font-size:11px;color:#555;line-height:1.75;white-space:pre-wrap;max-height:150px;overflow:auto\">（点刷新读最近 8 条）</div>'",
    ].join(EOL),
  },

  // ── 3. extFillLocal 回填 who ────────────────────────────────────
  {
    marker: 'whSel.value = String',
    old: [
      "      function extFillLocal() {",
      "        var c = state.extLocal || {}",
    ].join(EOL),
    new: [
      "      function extFillLocal() {",
      "        var c = state.extLocal || {}",
      "        var whSel = panel ? panel.querySelector('#dk-llm-who') : null",
      "        if (whSel) whSel.value = String(c.who || 'simple')",
    ].join(EOL),
  },

  // ── 4. loadExtCfg：带回 whoAnswers + 顺手拉判定日志 ─────────────
  {
    marker: 'who: (d.config || {}).whoAnswers',
    old: [
      "            c = { loaded: true, enabled: (d.config || {}).enabled !== false, model: (d.config || {}).model || 'qwen2.5:0.5b', serverUp: !!(d.ollama && d.ollama.up), models: (d.ollama && d.ollama.models) || [] }",
      "          } else { c.loaded = true; c.serverUp = false }",
      "          state.extLocal = c",
      "          extFillLocal()",
    ].join(EOL),
    new: [
      "            c = { loaded: true, enabled: (d.config || {}).enabled !== false, model: (d.config || {}).model || 'qwen2.5:0.5b', who: (d.config || {}).whoAnswers || 'simple', serverUp: !!(d.ollama && d.ollama.up), models: (d.ollama && d.ollama.models) || [] }",
      "          } else { c.loaded = true; c.serverUp = false }",
      "          state.extLocal = c",
      "          extFillLocal()",
      "          loadAnswerLog()",
    ].join(EOL),
  },

  // ── 5. loadAnswerLog / renderAnswerLog ─────────────────────────
  {
    marker: 'function loadAnswerLog(',
    old: [
      "      function extFillLocal() {",
    ].join(EOL),
    new: [
      "      /** 读最近判定（本地/云端 + 原因），面板「📋 最近判定」用 */",
      "      function loadAnswerLog() {",
      "        api('ext-answer-log', 'limit=8').then(function (d) {",
      "          var box = panel ? panel.querySelector('#dk-llm-recent') : null",
      "          var note = panel ? panel.querySelector('#dk-llm-recent-note') : null",
      "          if (!box) return",
      "          if (!d || !d.ok) { box.textContent = '（读不到判定日志）'; return }",
      "          var rows = d.rows || []",
      "          if (note) note.textContent = '当前：' + (d.whoAnswers === 'off' ? '全走云端' : ('谁来答=' + d.whoAnswers)) + (d.model ? (' · ' + d.model) : '')",
      "          if (!rows.length) { box.textContent = '还没有记录 —— 群里发一条 @她 的短消息试试（重启后才会写日志）'; return }",
      "          box.textContent = rows.map(function (r) {",
      "            var t = new Date(Number(r.ts) || Date.now())",
      "            var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2)",
      "            var who = r.by === 'local' ? '⚡本地' : (r.by === 'gag' ? '🎯梗' : '☁️云端')",
      "            var extra = ''",
      "            if (r.by === 'local' || r.by === 'gag') extra = (r.ms ? (' ' + r.ms + 'ms') : '') + (r.reply ? (' → ' + String(r.reply).slice(0, 24)) : '')",
      "            else extra = ' · ' + (r.why || '')",
      "            return hh + ' ' + who + extra + '  「' + String(r.text || '').slice(0, 16) + '」'",
      "          }).join(String.fromCharCode(10))",
      "        })",
      "      }",
      "",
      "      function extFillLocal() {",
    ].join(EOL),
  },

  // ── 6. saveExtLocal：带上 whoAnswers ──────────────────────────
  {
    marker: 'whoAnswers: whEl',
    old: [
      "      function saveExtLocal() {",
      "        var h = panel ? panel.querySelector('#dk-llm-hint2') : null",
      "        var onEl = panel ? panel.querySelector('#dk-llm-on') : null",
      "        var mdEl = panel ? panel.querySelector('#dk-llm-model') : null",
      "        if (h) h.textContent = '保存中…'",
      "        apiPost('ext-config', { ns: state.ns || undefined, which: 'local', patch: { enabled: !!(onEl && onEl.checked), model: mdEl ? mdEl.value : '' } }).then(function (d) {",
    ].join(EOL),
    new: [
      "      function saveExtLocal() {",
      "        var h = panel ? panel.querySelector('#dk-llm-hint2') : null",
      "        var onEl = panel ? panel.querySelector('#dk-llm-on') : null",
      "        var mdEl = panel ? panel.querySelector('#dk-llm-model') : null",
      "        var whEl = panel ? panel.querySelector('#dk-llm-who') : null",
      "        if (h) h.textContent = '保存中…'",
      "        apiPost('ext-config', { ns: state.ns || undefined, which: 'local', patch: { enabled: !!(onEl && onEl.checked), model: mdEl ? mdEl.value : '', whoAnswers: whEl ? whEl.value : 'simple' } }).then(function (d) {",
    ].join(EOL),
  },

  // ── 7. save 成功后写回 state.who ─────────────────────────────
  {
    marker: 'c.who = (d.config',
    old: [
      "            c.model = (d.config || {}).model || 'qwen2.5:0.5b'",
    ].join(EOL),
    new: [
      "            c.model = (d.config || {}).model || 'qwen2.5:0.5b'",
      "            c.who = (d.config || {}).whoAnswers || 'simple'",
    ].join(EOL),
  },

  // ── 8. bindExtCard：刷新按钮 ─────────────────────────────────
  {
    marker: 'dk-llm-reflog',
    old: [
      "        var vBtn = panel.querySelector('#dk-vc-save')",
      "        if (vBtn) vBtn.onclick = function () { saveExtVoice() }",
    ].join(EOL),
    new: [
      "        var vBtn = panel.querySelector('#dk-vc-save')",
      "        if (vBtn) vBtn.onclick = function () { saveExtVoice() }",
      "        var rBtn = panel.querySelector('#dk-llm-reflog')",
      "        if (rBtn) rBtn.onclick = function () { loadAnswerLog() }",
    ].join(EOL),
  },
];

function main() {
  const mode = process.argv.includes('--apply') ? 'apply'
    : process.argv.includes('--revert') ? 'revert' : 'check';

  if (!existsSync(FILE)) {
    console.error('找不到客户端 bundle: ' + FILE);
    process.exit(2);
  }

  if (mode === 'revert') {
    if (!existsSync(BACKUP)) {
      console.error('没有备份可回滚: ' + BACKUP);
      process.exit(2);
    }
    copyFileSync(BACKUP, FILE);
    console.log('已回滚 ' + FILE);
    return;
  }

  const src = readFileSync(FILE, 'utf8');
  // ★ 归一化必须先把所有 CR 去掉再按 LF 切：直接 split(LF) 会留下行尾的 CR，
  //   拼回去就变成 CRCRLF，多行锚点永远匹配不上（踩过）。
  const norm = src.split(CR).join('').split(LF).join(EOL);

  const plan = [];
  for (const op of OPS) {
    if (norm.includes(op.marker)) { plan.push({ op, state: 'done' }); continue; }
    if (!norm.includes(op.old)) { plan.push({ op, state: 'nomatch' }); continue; }
    plan.push({ op, state: 'todo' });
  }

  let out = norm;
  for (const p of plan) {
    if (p.state !== 'todo') continue;
    out = out.replace(p.op.old, p.op.new);
  }

  const todo = plan.filter((p) => p.state === 'todo').length;
  const done = plan.filter((p) => p.state === 'done').length;
  const bad = plan.filter((p) => p.state === 'nomatch');

  for (const p of bad) {
    console.error('[未匹配] ' + p.op.marker + ' —— 锚点不存在，可能已被改过');
    if (process.argv.includes('--dump')) {
      console.error('   FULL=' + JSON.stringify(p.op.old).slice(0, 400));
      for (const ln of p.op.old.split(EOL)) {
        console.error('   ' + JSON.stringify(ln.slice(0, 90)) + ' → 单行命中=' + norm.includes(ln));
      }
    }
  }

  if (mode === 'check') {
    console.log(`[检查] 待打 ${todo} 处 / 已应用 ${done} 处 / 未匹配 ${bad.length} 处`);
    for (const p of plan) console.log(`  ${p.state === 'done' ? '已应用' : p.state === 'todo' ? '可打  ' : '未匹配'} ${p.op.marker}`);
    return;
  }

  if (bad.length) {
    console.error('有锚点未匹配，拒绝写入（先修脚本再打）');
    process.exit(3);
  }

  mkdirSync(dirname(BACKUP), { recursive: true });
  if (!existsSync(BACKUP)) writeFileSync(BACKUP, src, 'utf8');
  writeFileSync(FILE, out, 'utf8');
  console.log(`[已应用] 写入 ${FILE}（本次打 ${todo} 处，原本已应用 ${done} 处）`);
  console.log('  备份: ' + BACKUP);
  console.log('  下一步: node --check 该文件；用户端 Ctrl+R 即可生效');
}

main();
