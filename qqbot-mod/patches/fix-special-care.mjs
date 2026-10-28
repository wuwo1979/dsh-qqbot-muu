// 特别关心（群/人）优先：先放行，再谈价值评分。
// 用法：node qqbot-mod/patches/fix-special-care.mjs --check|--apply|--revert
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN } from './plugin-dir.mjs';
const FILE = join(PLUGIN, 'dist/transport/inbound.js');
const BAK = 'F:/qqbot/qqbot-mod/backups/inbound.js.orig-specialcare';
const arg = process.argv[2] || '--check';

const OLD = `                    if (gate === 'block' && !mentioned && !aggMentioned && !forced && !worth) {`;
const NEW = `                    const _scCfg = (lmCfg && lmCfg.specialCare && typeof lmCfg.specialCare === 'object') ? lmCfg.specialCare : {};
                    const _scGroups = Array.isArray(_scCfg.groups) ? _scCfg.groups.map(String) : [];
                    const _scPeople = Array.isArray(_scCfg.people) ? _scCfg.people.map(String) : [];
                    const specialCare = _scGroups.includes(String(peerId)) || _scGroups.includes(String(ovKey))
                        || _scPeople.includes(String(msg.senderId)) || _scPeople.includes(String(srcSenderId));
                    if (specialCare) {
                        try { traceContextless('[gate] special-care=true sender=' + String(srcSenderId) + ' group=' + String(peerId)); } catch { }
                    }
                    if (gate === 'block' && scope === 'group' && !mentioned && !aggMentioned && !forced && !specialCare && !worth) {`;

const src = readFileSync(FILE, 'utf8');
const has = src.includes('const specialCare = _scGroups.includes');
if (arg === '--revert') {
  if (!existsSync(BAK)) { console.error('没有备份:', BAK); process.exit(1); }
  writeFileSync(FILE, readFileSync(BAK, 'utf8'), 'utf8');
  console.log('已还原', FILE);
  process.exit(0);
}
if (arg === '--check') {
  console.log(has ? '已应用' : (src.includes(OLD) ? '可打' : '锚点未匹配'));
  process.exit(has || src.includes(OLD) ? 0 : 1);
}
if (has) { console.log('已经应用过，跳过'); process.exit(0); }
if (!src.includes(OLD)) { console.error('锚点未匹配:', OLD); process.exit(1); }
copyFileSync(FILE, BAK);
writeFileSync(FILE, src.replace(OLD, NEW), 'utf8');
console.log('已应用。备份:', BAK);
