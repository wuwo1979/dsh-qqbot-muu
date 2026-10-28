/**
 * fix-ext-ui3.mjs —— 把「本地 / 云端」在面板里做得显眼（用户："这个不够明显"）
 *
 * 原来的「📋 最近判定」是 11px 纯文本灰字，本地/云端只差一个 emoji，扫一眼看不出来。
 * 现在：
 *   ① 标题上方加一行大字统计：⚡ 本地 5 ｜ 🎯 梗 1 ｜ ☁️ 云端 2（绿/橙/蓝三色）+ 一句解释；
 *   ② 每条记录改成卡片式：时间 + 带色的「谁在答」 + 本地模型名 + 耗时/回复，
 *      云端那条给出放行原因；
 *   ③ 字号 11px → 12px，不再用 pre-wrap（改 innerHTML）。
 *
 * 用法：
 *   node fix-ext-ui3.mjs --check    只报可打/已应用/未匹配
 *   node fix-ext-ui3.mjs --apply    打补丁（需 danger-full-access）
 *   node fix-ext-ui3.mjs --revert   回滚
 *
 * ⚠️ 该 bundle 是纯 CRLF；本脚本刻意不写任何反斜杠（write 工具会双写反斜杠），
 *    换行一律 String.fromCharCode。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;

import { PLUGIN } from './plugin-dir.mjs';
const FILE = join(PLUGIN, 'client', 'qqbot-settings.js');
const BACKUP_DIR = 'F:/qqbot/qqbot-mod/backups';
const BACKUP = join(BACKUP_DIR, 'qqbot-settings.js.orig-extui3');

const mode = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--revert') ? 'revert'
    : 'check';

if (!existsSync(FILE)) {
  console.error('找不到客户端 bundle: ' + FILE);
  process.exit(1);
}

const raw = readFileSync(FILE, 'utf8');
const src = raw.split(CR).join('').split(LF).join(EOL);

// ── 补丁 1：最近判定那块 markup（加统计行 + 放大字号）────────────
const OLD1 = [
  `        html += '<div class="dk-row" style="gap:8px;align-items:center;margin:8px 0 0;font-size:12px;color:#666">'`,
  `          + '<span>📋 最近判定</span>'`,
  `          + '<button class="dk-btn" id="dk-llm-reflog" style="font-size:11px;padding:0 8px">🔄 刷新</button>'`,
  `          + '<span class="dk-msg" id="dk-llm-recent-note" style="font-size:11px;color:#999"></span>'`,
  `          + '</div>'`,
  `        html += '<div class="dk-msg" id="dk-llm-recent" style="font-size:11px;color:#555;line-height:1.75;white-space:pre-wrap;max-height:150px;overflow:auto">（点刷新读最近 8 条）</div>'`,
].join(EOL);

const NEW1 = [
  `        html += '<div class="dk-row" style="gap:8px;align-items:center;margin:12px 0 2px;font-size:13px;font-weight:700">'`,
  `          + '<span>📋 最近判定（谁在答）</span>'`,
  `          + '<button class="dk-btn" id="dk-llm-reflog" style="font-size:11px;padding:0 8px">🔄 刷新</button>'`,
  `          + '<span class="dk-msg" id="dk-llm-recent-note" style="font-size:11px;color:#999;font-weight:400"></span>'`,
  `          + '</div>'`,
  `        html += '<div id="dk-llm-mix" style="font-size:13px;font-weight:700;margin:2px 0 6px;padding:5px 9px;background:#f8f9fa;border-radius:6px">（暂无记录）</div>'`,
  `        html += '<div class="dk-msg" id="dk-llm-recent" style="font-size:12px;color:#555;line-height:1.6;max-height:190px;overflow:auto">（点刷新读最近 8 条）</div>'`,
].join(EOL);

// ── 补丁 2：loadAnswerLog 的渲染（彩色卡片 + 三段统计）────────────
const OLD2 = [
  `          if (note) note.textContent = '当前：' + (d.whoAnswers === 'off' ? '全走云端' : ('谁来答=' + d.whoAnswers)) + (d.model ? (' · ' + d.model) : '')`,
  `          if (!rows.length) { box.textContent = '还没有记录 —— 群里发一条 @她 的短消息试试（重启后才会写日志）'; return }`,
  `          box.textContent = rows.map(function (r) {`,
  `            var t = new Date(Number(r.ts) || Date.now())`,
  `            var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2)`,
  `            var who = r.by === 'local' ? '⚡本地' : (r.by === 'gag' ? '🎯梗' : '☁️云端')`,
  `            var extra = ''`,
  `            if (r.by === 'local' || r.by === 'gag') extra = (r.ms ? (' ' + r.ms + 'ms') : '') + (r.reply ? (' → ' + String(r.reply).slice(0, 24)) : '')`,
  `            else extra = ' · ' + (r.why || '')`,
  `            return hh + ' ' + who + extra + '  「' + String(r.text || '').slice(0, 16) + '」'`,
  `          }).join(String.fromCharCode(10))`,
].join(EOL);

const NEW2 = [
  `          var mixEl = panel ? panel.querySelector('#dk-llm-mix') : null`,
  `          var cnt = { local: 0, gag: 0, cloud: 0 }`,
  `          rows.forEach(function (r) { if (r.by === 'local') cnt.local += 1; else if (r.by === 'gag') cnt.gag += 1; else cnt.cloud += 1 })`,
  `          if (mixEl) {`,
  `            mixEl.innerHTML = '<span style="color:#2f9e44">⚡ 本地模型 ' + cnt.local + '</span>'`,
  `              + '<span style="color:#ced4da;margin:0 8px">|</span><span style="color:#f08c00">🎯 死梗直答 ' + cnt.gag + '</span>'`,
  `              + '<span style="color:#ced4da;margin:0 8px">|</span><span style="color:#1c7ed6">☁️ 云端大模型 ' + cnt.cloud + '</span>'`,
  `              + '<div style="font-weight:400;font-size:11px;color:#868e96;margin-top:3px">最近 ' + rows.length + ' 条 —— 本地/死梗 不花 token，云端 花 token</div>'`,
  `          }`,
  `          if (note) note.textContent = '当前：' + (d.whoAnswers === 'off' ? '全走云端' : ('谁来答=' + d.whoAnswers)) + (d.model ? (' · ' + d.model) : '')`,
  `          if (!rows.length) { box.innerHTML = '<span style="color:#999">还没有记录 —— 群里发一条 @她 的短消息试试（重启后才会写日志）</span>'; return }`,
  `          box.innerHTML = rows.map(function (r) {`,
  `            var t = new Date(Number(r.ts) || Date.now())`,
  `            var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2)`,
  `            var isLocal = r.by === 'local'`,
  `            var isGag = r.by === 'gag'`,
  `            var col = isLocal ? '#2f9e44' : (isGag ? '#f08c00' : '#1c7ed6')`,
  `            var who = isLocal ? '⚡ 本地模型' : (isGag ? '🎯 死梗直答' : '☁️ 云端大模型')`,
  `            var mdl = (isLocal && d.model) ? ('<span style="color:#adb5bd;font-size:11px"> ' + esc(String(d.model)) + '</span>') : ''`,
  `            var tail = ''`,
  `            if (isLocal || isGag) tail = (r.ms ? ('<span style="color:#adb5bd">' + r.ms + 'ms</span> ') : '') + '<b style="color:#212529">' + esc(String(r.reply || '').slice(0, 26)) + '</b>'`,
  `            else tail = '<span style="color:#868e96">' + esc(String(r.why || '')) + '</span>'`,
  `            return '<div style="padding:4px 0;border-bottom:1px dashed #eee">'`,
  `              + '<span style="color:#adb5bd">' + hh + '</span> '`,
  `              + '<b style="color:' + col + '">' + who + '</b>'`,
  `              + mdl + ' ' + tail`,
  `              + '<div style="color:#495057">「' + esc(String(r.text || '').slice(0, 20)) + '」</div></div>'`,
  `          }).join('')`,
].join(EOL);

const MARK1 = 'dk-llm-mix';
const MARK1B = '最近判定（谁在答）';
const MARK2 = 'var isLocal = r.by ===';

const has1 = src.indexOf(MARK1) >= 0 && src.indexOf(MARK1B) >= 0;
const has2 = src.indexOf(MARK2) >= 0;

if (mode === 'check') {
  console.log('文件: ' + FILE + ' (' + raw.length + ' 字符)');
  console.log('UI3-1 统计行 + 放大字号: ' + (has1 ? '已应用' : (src.indexOf(OLD1) >= 0 ? '可打' : '未匹配')));
  console.log('UI3-2 彩色判定卡片: ' + (has2 ? '已应用' : (src.indexOf(OLD2) >= 0 ? '可打' : '未匹配')));
  const bad = (!has1 && src.indexOf(OLD1) < 0) || (!has2 && src.indexOf(OLD2) < 0);
  process.exit(bad ? 2 : 0);
}

if (mode === 'apply' && !existsSync(BACKUP)) {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    copyFileSync(FILE, BACKUP);
    console.log('备份 → ' + BACKUP);
  } catch (e) {
    console.error('备份失败（权限？需要 danger-full-access）: ' + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  }
}

let out = src;
let changed = 0;
let missed = 0;

const applyOne = (tag, oldS, newS, mark, markB) => {
  const applied = () => (markB ? (out.indexOf(mark) >= 0 && out.indexOf(markB) >= 0) : out.indexOf(mark) >= 0);
  if (mode === 'revert') {
    if (!applied()) { console.log(tag + ' 未应用，跳过'); return; }
    out = out.split(newS).join(oldS);
    changed += 1;
    console.log(tag + ' 已回滚');
    return;
  }
  if (applied()) { console.log(tag + ' 已应用，跳过'); return; }
  if (out.indexOf(oldS) < 0) { console.log(tag + ' 未匹配（源文件形状变了？）'); missed += 1; return; }
  out = out.split(oldS).join(newS);
  changed += 1;
  console.log(tag + ' 已打补丁');
};

if (mode === 'revert') {
  applyOne('UI3-2', OLD2, NEW2, MARK2);
  applyOne('UI3-1', OLD1, NEW1, MARK1, MARK1B);
} else {
  applyOne('UI3-1', OLD1, NEW1, MARK1, MARK1B);
  applyOne('UI3-2', OLD2, NEW2, MARK2);
}

if (!changed) {
  console.log('没有需要写的改动');
  process.exit(missed ? 2 : 0);
}

writeFileSync(FILE, out, 'utf8');
console.log('已写入 (' + src.length + ' → ' + out.length + ' 字符)');
