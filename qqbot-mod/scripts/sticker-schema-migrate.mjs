/**
 * sticker-schema-migrate.mjs — 把 index.json 升级到标签 v2（五面 schema）
 *
 * 做什么：
 *   为每张图补 {facets:{emotion,scene,action,intensity,platform}, tagSchema:2, facetSource}
 *   tags 仍是拍平数组（插件侧老代码照常能读），只是额外补上词表规范后的标签。
 *   原有 tags/desc/来源信息一个不动；写入前先留一份 .bak-schema2-<时间戳>。
 *
 * 用法：
 *   node qqbot-mod/scripts/sticker-schema-migrate.mjs --dry
 *   node qqbot-mod/scripts/sticker-schema-migrate.mjs
 *   node qqbot-mod/scripts/sticker-schema-migrate.mjs --root F:/qqbot/dshqqbot
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION, applyTagSchema, auditItems, facetsOf,
} from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/sticker-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ROOT = valOf('--root', process.env.QQBOT_MEMORY_DATA_ROOT || join(REPO, 'dshqqbot'));
const INDEX = join(ROOT, '表情包', 'index.json');

function main() {
  if (!existsSync(INDEX)) {
    console.error('找不到索引：' + INDEX);
    process.exit(2);
  }
  const raw = readFileSync(INDEX, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);
  const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
  if (!items.length) {
    console.error('索引里没有条目：' + INDEX);
    process.exit(2);
  }

  let changed = 0;
  for (const it of items) {
    const before = JSON.stringify(facetsOf(it));
    applyTagSchema(it, { merge: true });
    if (JSON.stringify(facetsOf(it)) !== before) changed += 1;
  }

  const out = Array.isArray(data) ? items : { ...data, version: data.version || 1, items };
  const audit = auditItems(items);
  console.log(`schema v${SCHEMA_VERSION} · 条目 ${items.length} · 语义有变化 ${changed}`);
  console.log('覆盖：情绪 %d%% / 场景 %d%% / 动作 %d%% · 缺 schema %d · 疑似重复 %d',
    audit.emotionCoverage, audit.sceneCoverage, audit.actionCoverage, audit.missingSchema, audit.dupes);
  console.log('强度：', JSON.stringify(audit.intensity), '平台：', JSON.stringify(audit.platform));
  console.log('高频情绪：', audit.topEmotion.map((x) => x.join(':')).join(' '));
  console.log('高频场景：', audit.topScene.map((x) => x.join(':')).join(' '));

  if (has('--dry')) {
    console.log('（dry-run：没有写盘）');
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = INDEX + `.bak-schema2-${stamp}`;
  copyFileSync(INDEX, bak);
  writeFileSync(INDEX, JSON.stringify(out, null, 2), 'utf8');
  console.log('已写入：' + INDEX);
  console.log('备份：' + bak);
}

main();
