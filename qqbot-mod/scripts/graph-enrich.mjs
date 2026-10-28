#!/usr/bin/env node
/**
 * graph-enrich.mjs — 用本地模型给记忆图谱补"实体—关系"三元组
 *
 * 用法：
 *   # 先看这个 scope 里有多少条还没补过图
 *   node qqbot-mod/scripts/graph-enrich.mjs --scope person:qq12345 --dry-run
 *
 *   # 真补（模型离线会立刻退出，不会白等）
 *   node qqbot-mod/scripts/graph-enrich.mjs --scope person:qq12345 --limit 50
 *
 *   # 所有 scope 都补一遍
 *   node qqbot-mod/scripts/graph-enrich.mjs --all-scopes --limit 30
 *
 * 说明：
 *   · 只在**本机模型**上跑（local-llm 的 Ollama/OpenAI 兼容端点），聊天记录不出本机
 *   · 只往 mem_edge 加边，正文一个字都不改；冲突关系会走同一条失效逻辑
 *   · 模型没开就什么都不做，反复跑也不会产生重复边（主键去重）
 */

import { resolve } from 'node:path';
import { enrichScopeGraph } from '../../dshqqbot/.qqbot-extensions/lib/memory-graph-llm.mjs';
import { openDb } from '../../dshqqbot/.qqbot-extensions/lib/memory-db.mjs';

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const has = (n) => process.argv.includes('--' + n);

const dataRoot = resolve(arg('data-root', process.cwd()));
const scopeArg = arg('scope', '');
const allScopes = has('all-scopes');
const limit = Number(arg('limit', '20'));
const budgetMs = Number(arg('budget', '20000'));
const dryRun = has('dry-run');

if (!scopeArg && !allScopes) {
  console.log(`用法:
  node graph-enrich.mjs --scope <scope> [--limit 20] [--budget 20000] [--dry-run]
  node graph-enrich.mjs --all-scopes [--limit 20]

先 --dry-run 看有多少条待补，再真跑。模型不开也能跑（会直接退出）。`);
  process.exit(1);
}

let scopes = [];
if (allScopes) {
  const h = openDb(dataRoot);
  scopes = h.db.prepare('SELECT scope, COUNT(*) AS n FROM mem GROUP BY scope ORDER BY n DESC').all()
    .map((r) => r.scope);
} else {
  scopes = [scopeArg];
}
if (!scopes.length) {
  console.log('库里还没有任何 scope，先导入/写入记忆。');
  process.exit(0);
}

if (dryRun) {
  const h = openDb(dataRoot);
  console.log('待补图统计（dry-run，不写库）：');
  for (const sc of scopes) {
    const n = Number(h.db.prepare(
      `SELECT COUNT(*) AS n FROM mem m
        WHERE m.scope = ?
          AND NOT EXISTS (SELECT 1 FROM mem_edge e
                           WHERE e.scope = m.scope AND e.mem_id = m.id AND COALESCE(e.src_kind,'rule') = 'llm')`,
    ).get(sc)?.n) || 0;
    console.log(`  ${sc}  ${n} 条待补`);
  }
  console.log('\n去掉 --dry-run 才会真跑。');
  process.exit(0);
}

let totalAdded = 0;
let totalSuperseded = 0;
for (const sc of scopes) {
  const r = await enrichScopeGraph(dataRoot, sc, { limit, budgetMs });
  totalAdded += r.added;
  totalSuperseded += r.superseded;
  console.log(`${sc}`);
  console.log(`  扫描 ${r.scanned} / 待补 ${r.picked} / 新增边 ${r.added} / 失效旧边 ${r.superseded} / 失败 ${r.failed}  (${r.ms} ms)`);
  if (r.reason) console.log(`  结束原因：${r.reason}`);
  for (const s of r.samples) {
    console.log(`  例：${s.text}… → ${s.triples.map((t) => `${t.src}-${t.rel}-${t.dst}`).join('，')}`);
  }
}

console.log(`\n合计：新增 ${totalAdded} 条关系，失效 ${totalSuperseded} 条旧关系。`);
if (totalAdded === 0) {
  console.log('没有新增：要么已经补全，要么本地模型没开（local-llm 配置见 dshqqbot/.qqbot-extensions/local-llm-config.json）。');
}
