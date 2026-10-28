#!/usr/bin/env node
/**
 * live-overlay/install.mjs — 把本仓库对 @zaofan/dsh-qqbot 的定制**装回正在跑的那份插件**
 *
 * 为什么要有 overlay（2026-10-25 血的教训）：
 *   桌面端插件市场会自动升级 @zaofan/dsh-qqbot，并在
 *   `profiles/.generations/live/zaofan+dsh-qqbot+<版本>+<hash>/` 下生成一份**全新官方文件**。
 *   实测 16:57 从 1.10.22 自动升到 1.10.39，之前打在旧 generation 上的所有补丁当场作废，
 *   浮窗的「记忆」页、主题、聊天记录补全全部消失（主人原话：「刚刚还坏了」）。
 *
 *   单靠"锚点字符串替换"的补丁脚本扛不住升级：1.10.39 一改，二十来个锚点里能对上的一半不到。
 *   所以这里改成 **三路合并**：
 *     base/ = 制作 overlay 时那份官方原文件（带版本号记在 manifest.json）
 *     ours/ = 本仓库的定制结果
 *     live  = 现在磁盘上真正在跑的文件
 *   用 `git merge-file ours base live` 把上游的改动并进来 —— 上游改了多少都不怕，
 *   只有真正撞行的位置才会报冲突（冲突时不写盘，只报告）。
 *
 * 用法：
 *   node install.mjs --check     # 只报告：能不能直接装 / 需要合并 / 冲突
 *   node install.mjs --apply     # 落盘（原文件备份成 <file>.orig-muu，只备份一次）
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN, GENERATION, announce } from '../plugin-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const FORCE = args.has('--force');

announce('live-overlay');
console.log(`  overlay 版本: ${MANIFEST.version}${GENERATION ? ` · 目标 generation: ${GENERATION}` : ''}`);

const sha = (p) => {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return ''; }
};
const same = (a, b) => a && b && a === b;

/** 用 git merge-file 做三路合并；返回 {ok, conflicts, text} */
function merge3(oursText, baseText, theirsText, tmpDir) {
  mkdirSync(tmpDir, { recursive: true });
  const o = join(tmpDir, 'ours.js');
  const b = join(tmpDir, 'base.js');
  const t = join(tmpDir, 'theirs.js');
  writeFileSync(o, oursText, 'utf8');
  writeFileSync(b, baseText, 'utf8');
  writeFileSync(t, theirsText, 'utf8');
  let code = 0;
  try {
    execFileSync('git', ['merge-file', o, b, t], { stdio: 'pipe' });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
  }
  const text = readFileSync(o, 'utf8');
  const conflicts = (text.match(/^<<<<<<< /gm) || []).length;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { conflicts, text, code };
}

function syntaxOk(file) {
  if (!/\.(js|mjs)$/.test(file)) return true;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return true;
  } catch (e) {
    const msg = String((e.stderr || e.message || e));
    console.error('  ✗ 语法检查失败: ' + file + '\n' + msg.split('\n').slice(0, 6).join('\n'));
    return false;
  }
}

let failed = 0;
let changed = 0;
for (const rel of MANIFEST.files) {
  const livePath = join(PLUGIN, rel);
  const oursPath = join(HERE, 'ours', rel);
  const basePath = join(HERE, 'base', rel);
  const label = rel.replace(/\\/g, '/');
  if (!existsSync(livePath)) { console.log(`  ✗ ${label}: 目标不存在（插件结构变了？）`); failed += 1; continue; }
  if (!existsSync(oursPath)) { console.log(`  ✗ ${label}: overlay 缺 ours`); failed += 1; continue; }
  if (!existsSync(basePath)) { console.log(`  ✗ ${label}: overlay 缺 base`); failed += 1; continue; }

  const live = sha(livePath);
  const ours = sha(oursPath);
  const base = sha(basePath);
  const liveVer = (() => {
    try { return JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
  })();

  if (same(live, ours)) { console.log(`  = ${label}: 已是 overlay 版本`); continue; }

  let outText = null;
  if (same(live, base) || FORCE) {
    outText = readFileSync(oursPath, 'utf8');
    console.log(`  + ${label}: 与 ${MANIFEST.version} 原文件一致 → 直接覆盖${FORCE ? '（--force）' : ''}`);
  } else {
    const r = merge3(readFileSync(oursPath, 'utf8'), readFileSync(basePath, 'utf8'), readFileSync(livePath, 'utf8'), join(HERE, '.merge-tmp'));
    if (r.conflicts) {
      console.log(`  ✗ ${label}: 与插件 ${liveVer || '?'} 有 ${r.conflicts} 处冲突，未写入（先人工看 .merge-tmp 或更新 overlay）`);
      failed += 1;
      continue;
    }
    outText = r.text;
    console.log(`  ~ ${label}: 插件已是 ${liveVer || '?'}，三路合并成功（0 冲突）`);
  }

  if (!APPLY) { console.log(`      (--check) 未写入，预计 ${outText.length} 字符`); continue; }

  const bak = livePath + '.orig-muu';
  if (!existsSync(bak)) { copyFileSync(livePath, bak); console.log('      备份: ' + bak.replace(PLUGIN, '<plugin>')); }
  writeFileSync(livePath, outText, 'utf8');
  if (!syntaxOk(livePath)) {
    copyFileSync(bak, livePath);
    console.log('      ✗ 语法失败 → 已回滚');
    failed += 1;
    continue;
  }
  changed += 1;
}

console.log('');
if (!APPLY) {
  console.log(failed ? `结果: ${failed} 个文件需要人工处理` : '结果: 全部可以装（加 --apply 落盘）');
  process.exit(failed ? 1 : 0);
}
console.log(failed ? `结果: ${failed} 个文件失败，其余已更新` : `✅ 全部就绪（更新 ${changed} 个文件）`);
console.log('生效方式：QQ 里发 /bot-restart 或重启 DSH Desktop；前端页面 Ctrl+F5 刷新。');
process.exit(failed ? 1 : 0);
