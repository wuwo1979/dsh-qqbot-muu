#!/usr/bin/env node
/**
 * fix-panel-blank.mjs —— 记忆页「一片白」的兜底。
 *
 * 症状：浮窗打开后记忆页什么都不显示（白块）。根因是 renderMemoryPanel 直接读
 * `d.stats.chatTotal` / `d.stats.scopes` 等字段，只要后端返回体少了一层（读库超时、
 * 刚重启还没建表、某段数据被别的补丁改坏），就会抛 TypeError，整个 panel 渲染中断，
 * 只剩底层空白。
 *
 * 做法（两处，纯防御，不改任何现有内容）：
 *   1. `if (!d.ok)` 之后插入 stats 归一化（缺字段补 0 / 补空数组）；
 *   2. 原函数改名 renderMemoryPanelInner，外面包一层 renderMemoryPanel 做 try/catch，
 *      出错时把错误文本画在面板上（再也不白屏，方便直接反映问题）。
 *
 * 用法：
 *   node qqbot-mod/patches/fix-panel-blank.mjs --check
 *   node qqbot-mod/patches/fix-panel-blank.mjs --apply
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const REL = 'client/qqbot-settings.js';

const OPS = [
  {
    label: 'stats 归一化',
    old: `        if (!d.ok) return '<div class="dk-empty">读取失败：' + esc(((d.errors || []).join('; ')) || '未知') + '</div>'
        var h = '<div class="dk-row" style="justify-content:space-between;align-items:center">'`,
    neu: `        if (!d.ok) return '<div class="dk-empty">读取失败：' + esc(((d.errors || []).join('; ')) || '未知') + '</div>'
        // [qqbot-mod] panel-blank：后端返回体可能缺字段（读库超时/刚重启），先补齐再用，避免整页抛错变白
        if (!d.stats || typeof d.stats !== 'object') d.stats = { chatTotal: 0, memTotal: 0, scopes: [] }
        if (!Array.isArray(d.stats.scopes)) d.stats.scopes = []
        if (typeof d.stats.chatTotal !== 'number') d.stats.chatTotal = 0
        if (typeof d.stats.memTotal !== 'number') d.stats.memTotal = 0
        if (d.agent && typeof d.agent !== 'object') d.agent = {}
        if (d.bedrock && !Array.isArray(d.bedrock)) d.bedrock = []
        if (d.insights && !Array.isArray(d.insights)) d.insights = []
        var h = '<div class="dk-row" style="justify-content:space-between;align-items:center">'`,
  },
  {
    label: '渲染异常兜底',
    old: `      function renderMemoryPanel() {
        if (state.memBusy && !state.memPanel) return '<div class="dk-empty">正在读取数据库记忆…</div>'`,
    neu: `      function renderMemoryPanel() {
        try {
          return renderMemoryPanelInner()
        } catch (eMB) {
          return '<div class="dk-empty">记忆页渲染出错：' + esc(String((eMB && eMB.message) || eMB)) + '（把这句话发给主人就能定位）</div>'
        }
      }
      function renderMemoryPanelInner() {
        if (state.memBusy && !state.memPanel) return '<div class="dk-empty">正在读取数据库记忆…</div>'`,
  },
];

function main() {
  const apply = process.argv.includes('--apply');
  const file = pluginPath(REL);
  announce('fix-panel-blank');
  if (!existsSync(file)) { console.error(`✗ 找不到 ${file}`); process.exit(1); }

  let src = readFileSync(file, 'utf8');
  const crlf = src.includes('\r\n');
  if (crlf) src = src.replace(/\r\n/g, '\n');

  if (src.includes('renderMemoryPanelInner')) {
    console.log('= 已是最新，无需写入');
    return;
  }

  let out = src;
  let hit = 0;
  for (const op of OPS) {
    if (!out.includes(op.old)) { console.log(`! 未命中：${op.label}`); continue; }
    out = out.replace(op.old, op.neu);
    hit += 1;
    console.log(`✓ ${op.label}`);
  }
  if (hit !== OPS.length) { console.error(`✗ 只命中 ${hit}/${OPS.length}，放弃写入（上游可能改过这段）`); process.exit(2); }

  if (!apply) { console.log('\n（--check 模式，未写入；加 --apply 落地）'); return; }

  copyFileSync(file, `${file}.orig-muu`);
  writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`\n✔ 已写入 ${REL}（备份 .orig-muu）`);
  } catch (e) {
    writeFileSync(file, src, 'utf8');
    console.error(`✗ 语法检查失败，已回滚：${e.message}`);
    process.exit(1);
  }
}

main();
