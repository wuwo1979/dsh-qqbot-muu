/**
 * personal-ids.mjs —— 本机身份表（2026-11-10 v0.1.6：把硬编码的 openid 从代码里摘出去）
 *
 * 为什么会有这个文件：
 *   重启闸门（inbound/a1-restart-guard.mjs）和家庭关系种子（lib/memory-agent.mjs）
 *   原来把爸爸妈妈妹妹的 openid 直接写在代码里 —— 一发布就等于把家里人的 openid
 *   印在 npm 包的源码上。openid 是账号级标识，不该跟着代码走。
 *
 * 读的顺序（先到先得，全部缺省时返回空表 → 依赖它的功能自动关闭，不会瞎猜）：
 *   ① 环境变量 QQBOT_PERSONAL_IDS（JSON：{"dad":"...","mom":"...","stelle":"..."}）
 *   ② 环境变量 QQBOT_OWNER_IDS（逗号/空格分隔，等价于 owners 列表）
 *   ③ 本机文件 {dataRoot}/.qqbot-extensions/data/ids.json
 *      （data/ 在 .gitignore 与 .npmignore 里都排除，只留在你自己的机器上）
 *
 * 文件格式：
 *   { "dad": "xxx", "mom": "xxx", "stelle": "xxx", "owners": ["xxx","yyy"] }
 *   owners 省略时 = dad + mom（爸爸妈妈都能重启，和代码里的原规则一致）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件在 {dataRoot}/.qqbot-extensions/lib/ ⇒ 上两级就是数据根 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(HERE, '..', '..');

function splitIds(v) {
  return String(v || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readJsonIds() {
  const paths = [
    join(DATA_ROOT, '.qqbot-extensions', 'data', 'ids.json'),
    // 老位置兜底（早期把身份表塞在 data 根下）
    join(DATA_ROOT, 'ids.json'),
  ];
  for (const p of paths) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j && typeof j === 'object') return { ids: j, from: p };
    } catch { /* 没这个文件很正常 */ }
  }
  return { ids: {}, from: '' };
}

/**
 * 取本机身份表。返回 { dad, mom, stelle, owners: string[], source }
 * 全部缺省时各字段为空串/空数组 —— 调用方据此关掉对应功能，绝不用猜的 id。
 */
export function personalIds() {
  let dad = '';
  let mom = '';
  let stelle = '';
  let owners = [];
  let source = '';
  // 称呼：代码里只留「爸爸/妈妈/妹妹」这种角色名，真人昵称也从本机读
  let names = { dad: '爸爸', mom: '妈妈', stelle: '妹妹' };

  const file = readJsonIds();
  if (file.ids && Object.keys(file.ids).length) {
    dad = String(file.ids.dad || '').trim();
    mom = String(file.ids.mom || '').trim();
    stelle = String(file.ids.stelle || '').trim();
    owners = Array.isArray(file.ids.owners) ? file.ids.owners.map((x) => String(x).trim()).filter(Boolean) : [];
    if (file.ids.names && typeof file.ids.names === 'object') {
      for (const k of ['dad', 'mom', 'stelle']) {
        const v = String(file.ids.names[k] || '').trim();
        if (v) names[k] = v;
      }
    }
    source = file.from;
  }

  // 环境变量覆盖文件：部署时注入，换机器不用改文件
  const envJson = String(process.env.QQBOT_PERSONAL_IDS || '').trim();
  if (envJson) {
    try {
      const j = JSON.parse(envJson);
      if (j && typeof j === 'object') {
        dad = String(j.dad || dad).trim();
        mom = String(j.mom || mom).trim();
        stelle = String(j.stelle || stelle).trim();
        if (Array.isArray(j.owners)) owners = j.owners.map((x) => String(x).trim()).filter(Boolean);
        if (j.names && typeof j.names === 'object') {
          for (const k of ['dad', 'mom', 'stelle']) {
            const v = String(j.names[k] || '').trim();
            if (v) names[k] = v;
          }
        }
        source = 'env:QQBOT_PERSONAL_IDS';
      }
    } catch { /* 坏 JSON 就当没设 */ }
  }
  const envOwners = splitIds(process.env.QQBOT_OWNER_IDS);
  if (envOwners.length) {
    owners = [...new Set([...owners, ...envOwners])];
    source = 'env:QQBOT_OWNER_IDS';
  }

  if (!owners.length) owners = [dad, mom].filter(Boolean);

  return { dad, mom, stelle, names, owners: [...new Set(owners)], source };
}

/** 只有这些人能重启机器人（爸爸 + 妈妈） */
export function ownerIds() {
  return personalIds().owners;
}
