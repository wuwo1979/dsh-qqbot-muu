#!/usr/bin/env node
/**
 * fix-panel-crash.mjs —— 浮窗"点开一片白"的兜底
 *
 * 现象（主人 2026-10-26 反复报）：切到记忆页/某些 tab 后整个 dock 空白，没有任何提示。
 * 根因：paintBody() 里是一大串字符串拼接 + 直接读写 d.xxx，而后端返回体随记忆管线
 * 迭代经常增删字段（hippo/drift/bedrock/insights/底层目标…），任何一处 undefined
 * 都会在 paintBody 里抛异常 → b.innerHTML = body 永远执行不到 → 白。
 *
 * 修法不改业务逻辑：把 paintBody 改名 paintBodyInner，外面套一层 try/catch，
 * 出错时把错误原文画进 .dk-b（连同 stack 前几行），主人截图就能定位。
 *
 * 用法：
 *   node qqbot-mod/patches/fix-panel-crash.mjs --check
 *   node qqbot-mod/patches/fix-panel-crash.mjs --apply
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PLUGIN, announce } from './plugin-dir.mjs';

const REL = 'client/qqbot-settings.js';
const APPLY = process.argv.includes('--apply');
const TAG = '[qqbot-mod] panel-crash';

function read(p) { return readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }
function write(p, s) { writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8'); }

const TARGET = `${PLUGIN}/${REL}`;

const OLD = `      function paintBody() {`;
const NEW = `      // ${TAG} 渲染兜底：paintBody 里任何一处 undefined 都会让整个 dock 变空白
      function paintBody() {
        try {
          return paintBodyInner()
        } catch (ePB) {
          try {
            var _pb = panel.querySelector('.dk-b')
            var _pbMsg = String((ePB && (ePB.stack || ePB.message)) || ePB || '未知错误')
            if (_pb) {
              _pb.innerHTML = '<div class="dk-empty" style="white-space:pre-wrap;line-height:1.5">'
                + '这块渲染出错了（不是数据没了）：\\n' + esc(_pbMsg.slice(0, 600))
                + '\\n\\n把这段发给主人就能修。</div>'
            }
            try { console.error('${TAG}', ePB) } catch (e1) {}
          } catch (e2) {}
          return
        }
      }
      function paintBodyInner() {`;

announce('浮窗白屏兜底');
if (!existsSync(TARGET)) {
  console.log('  ✗ 目标不存在: ' + TARGET);
  process.exit(1);
}
let src = read(TARGET);
if (src.includes(TAG)) {
  console.log('  = 已是最新，无需写入');
  process.exit(0);
}
if (!src.includes(OLD)) {
  console.log('  ✗ 找不到锚点: ' + OLD.trim());
  process.exit(1);
}
if (src.split(OLD).length - 1 !== 1) {
  console.log('  ✗ 锚点不唯一');
  process.exit(1);
}
src = src.replace(OLD, NEW);
console.log('  ✓ paintBody → paintBodyInner + 兜底');

if (!APPLY) {
  console.log('  (--check) 未写入，预计 ' + src.length + ' 字符');
  process.exit(0);
}
const bak = TARGET + '.orig-muu';
if (!existsSync(bak)) { copyFileSync(TARGET, bak); console.log('  备份: ' + bak); }
write(TARGET, src);
try {
  execFileSync(process.execPath, ['--check', TARGET], { stdio: 'pipe' });
  console.log('  ✔ 已写入 ' + REL + '（' + src.length + ' 字符）语法通过');
} catch (e) {
  copyFileSync(bak, TARGET);
  console.log('  ✗ 语法失败 → 已回滚');
  process.exit(1);
}
