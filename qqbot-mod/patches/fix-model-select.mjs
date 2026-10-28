/**
 * fix-model-select.mjs —— 让「模型下拉」真的能选（点了就换，不用再按保存）
 *
 * 现场：面板上模型那一行是一个 <select id="dk-lm-preset">，但**没有任何 change 监听**
 *   （前一版 D2 联动补丁没落地，E5b 只绑了 .dk-lm-pick 按钮，而按钮那一版 markup 也没用上）。
 *   ⇒ 用户在下拉里选了 bge-base-zh，界面看着变了，配置却没写，重绘又跳回原值 ——
 *   这就是反复报"模型还是选择不了"的直接原因。
 *
 * 修法：给下拉加 onchange，选中非「自定义」项直接调 applyModelDir(value)
 *   （写配置 → 重绘 → 重新检测），选「自定义路径…」则聚焦输入框让用户手填。
 *
 * 用法：node fix-model-select.mjs --check|--apply|--revert（apply 需 danger-full-access）
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const EOL = CR + LF;
const Q = String.fromCharCode(39);   // 单引号，避免在模板里出现反斜杠转义

import { PLUGIN } from './plugin-dir.mjs';
const FILE = join(PLUGIN, 'client', 'qqbot-settings.js');
const BACKUP_DIR = 'F:/qqbot/qqbot-mod/backups';
const BACKUP = join(BACKUP_DIR, 'qqbot-settings.js.orig-modelsel');

const mode = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--revert') ? 'revert'
    : 'check';

if (!existsSync(FILE)) {
  console.error('找不到 ' + FILE);
  process.exit(1);
}

const raw = readFileSync(FILE, 'utf8');
const src = raw.split(CR).join('').split(LF).join(EOL);

const ANCHOR = [
  `        if (saveBtn) saveBtn.onclick = function () { saveLocalModel() }`,
].join(EOL);

const NEW = [
  `        if (saveBtn) saveBtn.onclick = function () { saveLocalModel() }`,
  `        // ★ 本机新增(2026-10-23)：下拉直接生效 —— 之前只有 markup 没有监听，选了等于没选。`,
  `        var presetSel = panel.querySelector('#dk-lm-preset')`,
  `        if (presetSel) presetSel.onchange = function () {`,
  `          var pv = String(presetSel.value || '')`,
  `          if (pv === '__custom') { var de = panel.querySelector('#dk-lm-dir'); if (de) { de.focus(); de.select() } return }`,
  `          if (pv) applyModelDir(pv)`,
  `        }`,
].join(EOL);

const MARK = '下拉直接生效';
const applied = src.indexOf(MARK) >= 0;

if (mode === 'check') {
  console.log('文件: ' + FILE + ' (' + raw.length + ' 字符)');
  console.log('MODEL-SELECT: ' + (applied ? '已应用' : (src.indexOf(ANCHOR) >= 0 ? '可打' : '未匹配')));
  process.exit(!applied && src.indexOf(ANCHOR) < 0 ? 2 : 0);
}

if (mode === 'revert') {
  if (!applied) { console.log('未应用，无需回滚'); process.exit(0); }
  const out = src.split(NEW).join(ANCHOR);
  writeFileSync(FILE, out, 'utf8');
  console.log('已回滚 (' + src.length + ' → ' + out.length + ')');
  process.exit(0);
}

if (applied) { console.log('已应用，跳过'); process.exit(0); }
if (src.indexOf(ANCHOR) < 0) { console.error('未匹配（源文件形状变了）'); process.exit(2); }

try {
  mkdirSync(BACKUP_DIR, { recursive: true });
  if (!existsSync(BACKUP)) { copyFileSync(FILE, BACKUP); console.log('备份 → ' + BACKUP); }
} catch (e) {
  console.error('备份失败（权限？需要 danger-full-access）: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

const out = src.split(ANCHOR).join(NEW);
writeFileSync(FILE, out, 'utf8');
console.log('已打补丁 (' + src.length + ' → ' + out.length + ' 字符)');
