#!/usr/bin/env node
/**
 * live-overlay/capture.mjs —— 把"现在正在跑的插件文件"抄进 ours/ 并刷新 manifest 哈希
 *
 * 什么时候用：在 live 上直接打完补丁、确认能跑之后，跑一次这个，
 * 把成果固化进 overlay（否则下次插件自动升级，install.mjs 会拿旧的 ours 覆盖，新补丁就丢了）。
 *
 * 用法：node qqbot-mod/patches/live-overlay/capture.mjs [--dry]
 */
import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN, GENERATION, announce } from '../plugin-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');
const MANIFEST_PATH = join(HERE, 'manifest.json');
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

announce('live-overlay capture');
console.log(`  overlay 版本: ${MANIFEST.version}${GENERATION ? ` · 目标 generation: ${GENERATION}` : ''}`);

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
let n = 0;
for (const rel of MANIFEST.files) {
  const live = join(PLUGIN, rel);
  const ours = join(HERE, 'ours', rel);
  const base = join(HERE, 'base', rel);
  if (!existsSync(live)) { console.log(`  ✘ ${rel}: live 不存在`); continue; }
  if (!existsSync(base)) { console.log(`  ✘ ${rel}: 缺 base/（先补官方原文件）`); continue; }
  if (DRY) { console.log(`  ~ ${rel}: 将抄入 ours/`); n += 1; continue; }
  mkdirSync(dirname(ours), { recursive: true });
  copyFileSync(live, ours);
  MANIFEST.sha256[rel] = { ours: sha(ours), base: sha(base) };
  console.log(`  ✔ ${rel}: ours 已更新（${readFileSync(ours, 'utf8').length} 字符）`);
  n += 1;
}
if (!DRY) {
  MANIFEST.note = 'base/ 是官方同版本原文件；ours/ 是本仓库定制后的结果；install.mjs 用三路合并把它们装回正在跑的插件。';
  writeFileSync(MANIFEST_PATH, JSON.stringify(MANIFEST, null, 2) + '\n', 'utf8');
  console.log(`\n结果: ${n} 个文件已固化进 overlay，manifest.json 已刷新。`);
}
