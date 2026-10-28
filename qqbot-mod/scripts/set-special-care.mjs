#!/usr/bin/env node
/**
 * set-special-care.mjs — 把特别关心名单写进宿主 im-qqbot.json（一次性运维脚本）
 *
 * ⚠️ 真实 openid 一律不进仓库（2026-10-28 审查发现本脚本曾硬编码真实 id，已改为参数传入）。
 * 用法：
 *   node set-special-care.mjs --group <群openid> --people <用户openid1,用户openid2>
 *   node set-special-care.mjs --show          # 只看当前配置
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : '';
}

const p = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/qqbot-settings/web/im-qqbot.json';
const j = JSON.parse(readFileSync(p, 'utf8'));

const SHOW = process.argv.includes('--show');
const groups = (argValue('--group') || '').split(',').map((s) => s.trim()).filter(Boolean);
const people = (argValue('--people') || '').split(',').map((s) => s.trim()).filter(Boolean);
const HEX32 = /^[0-9A-F]{32}$/;

if (SHOW) {
  console.log(JSON.stringify({ specialCare: j.localModel?.specialCare || null, gate: j.localModel?.valueGate, min: j.localModel?.valueMinScore }, null, 2));
  process.exit(0);
}

for (const id of [...groups, ...people]) {
  if (!HEX32.test(id)) {
    console.error(`openid 形态不对（应为 32 位大写十六进制）：${id}`);
    process.exit(2);
  }
}
if (!groups.length && !people.length) {
  console.error('用法：node set-special-care.mjs --group <群openid> --people <用户openid1,用户openid2>（或 --show）');
  process.exit(2);
}

const bak = p + '.bak-specialcare-' + Date.now();
copyFileSync(p, bak);
j.localModel = j.localModel || {};
if (groups.length) j.localModel.specialCare = j.localModel.specialCare || {};
if (groups.length) j.localModel.specialCare.groups = groups;
if (people.length) j.localModel.specialCare.people = people;
j.localModel.valueGate = 'block';
j.localModel.valueMinScore = 0.35;
for (const g of groups) {
  const key = 'group:' + g;
  j.localModel.overrides = j.localModel.overrides || {};
  j.localModel.overrides[key] = { ...(j.localModel.overrides[key] || {}), enabled: true, valueGate: 'block', valueMinScore: 0.35 };
}
writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
console.log('OK', bak);
console.log(JSON.stringify({ specialCare: j.localModel.specialCare, gate: j.localModel.valueGate, min: j.localModel.valueMinScore }, null, 2));
