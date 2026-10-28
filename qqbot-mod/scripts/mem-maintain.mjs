#!/usr/bin/env node
/**
 * mem-maintain.mjs — 记忆库体检 / 维护 CLI
 *
 * 记忆库是长期资产，但它有几种"不会报错、只会悄悄变差"的坏法：
 *   · 索引表没建上 → 关键词/实体/图谱三路召回全哑，只剩向量，用户感觉"她记性变差"；
 *   · WAL 没 checkpoint → -wal 越来越大，cp 出来的备份可能是残的；
 *   · prune 删了一堆行 → 文件不缩小，白占几 MB；
 *   · 一直没备份 → 一次误操作就没了。
 * 这个脚本把四件事都摊开，并给一个能一键修的动作。
 *
 * 用法：
 *   node qqbot-mod/scripts/mem-maintain.mjs --data-root F:/qqbot/dshqqbot            # 只体检
 *   node qqbot-mod/scripts/mem-maintain.mjs --data-root F:/qqbot/dshqqbot --fix      # 检查点 + 备份 + 补索引
 *   node qqbot-mod/scripts/mem-maintain.mjs --data-root F:/qqbot/dshqqbot --fix --vacuum --keep 5
 */

const LIB = '../../dshqqbot/.qqbot-extensions/lib/';
const M = await import(LIB + 'memory-db.mjs');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const has = (n) => process.argv.includes('--' + n);

const dataRoot = arg('data-root', process.cwd());
const fix = has('fix');
const vacuum = has('vacuum');
const keep = Number(arg('keep', '5'));
const noBackup = has('no-backup');

const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB');

const h = M.dbHealth(dataRoot);
console.log('=== 记忆库体检 ===');
console.log(`文件        ${h.file}  (${kb(h.bytes)})`);
console.log(`schema      v${h.schemaVersion} / 期望 v${h.expectedSchema}${h.missing.length ? '  缺表: ' + h.missing.join(', ') : ''}`);
console.log(`完整性      ${h.integrity || '(未取到)'}`);
console.log(`日志模式    ${h.journal}   页 ${h.pageCount} × ${h.pageSize}B   空闲页 ${h.freePages}（${Math.round(h.freeRatio * 100)}%）`);
console.log(`表行数      ${Object.entries(h.tables).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`倒排覆盖    ${h.indexedMem} / ${h.tables.mem}`);
if (h.indexErrors) console.log(`索引写失败  ${h.indexErrors} 次，最后一次: ${h.lastIndexError}`);
console.log(`结论        ${h.verdict}`);

if (h.scopes.length) {
  console.log('\n最大的几个 scope：');
  for (const s of h.scopes.slice(0, 8)) console.log(`  ${String(s.n).padStart(6)}  ${s.scope}`);
}

if (!fix) {
  console.log('\n只体检，没改任何东西。要修：加 --fix（检查点 + 备份 + 补索引），必要时再加 --vacuum。');
  process.exit(h.healthy ? 0 : 2);
}

console.log('\n=== 维护 ===');
const r = M.maintainDb(dataRoot, {
  checkpoint: true,
  vacuum: vacuum ? true : false,
  backup: !noBackup,
  keep,
  reindex: !h.healthy,
});
console.log(`检查点      ${r.checkpoint ? JSON.stringify(r.checkpoint) : '(跳过)'}`);
console.log(`VACUUM      ${r.vacuum ? '完成，回收 ' + kb(r.reclaimed) : '(未做)'}`);
console.log(`备份        ${r.backup || '(未做)'}   保留 ${r.kept} 份`);
if (r.reindexed?.length) {
  console.log('重建索引    ' + r.reindexed.map((x) => `${x.scope.replace(/^.*:/, '')}:${x.memories}条/${x.tokens}词`).join('  '));
}
if (r.reason) console.log(`异常        ${r.reason}`);

const after = M.dbHealth(dataRoot);
console.log(`\n维护后      ${after.verdict}`);
process.exit(after.healthy ? 0 : 2);
