/**
 * upgrade-memory-view.mjs — 把「记忆观察页」升级成读 SQLite + 显示人格库
 *
 * 背景：记忆库已经从 jsonl 换成真数据库（`{root}/.qqbot/memory.db`，见
 * `.qqbot-extensions/lib/memory-db.mjs`），但 `/api/qqbot-settings/memory` 这页还是照 jsonl 写的，
 * 一旦重启切到 sqlite，这页就会显示"还没有任何记忆"。所以这里让它 **db 优先、jsonl 回退**，
 * 并且把 `persona` 表（人设/关系，Neuro 式 char 档案）也一起列出来。
 *
 * 用法：node patches/upgrade-memory-view.mjs --check|--apply|--revert
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOD = join(HERE, '..');
const PATCHES = join(MOD, 'patches');
const { PLUGIN, IS_LIVE, announce } = await import('file://' + join(PATCHES, 'plugin-dir.mjs').replace(/\\/g, '/'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REVERT = args.includes('--revert');

const dir = PLUGIN;
announce('memory-view');
if (!IS_LIVE) { console.error('⚠️ 这不是桌面端正在跑的那套，中止。'); process.exit(2); }
const FILE = join(dir, 'settings-host.js');
if (!existsSync(FILE)) { console.error('找不到 settings-host.js: ' + FILE); process.exit(2); }

const BAK = join(MOD, 'backups', 'settings-host.js.orig-memview2');
mkdirSync(dirname(BAK), { recursive: true });

const raw = readFileSync(FILE, 'utf8');
const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
const src = raw.split('\n').join(EOL);

const START = "      const memDir = root ? join(root, '.qqbot', 'memory') : '';";
const END = "      const router = { lines: 0, tiers: {}, last: [] };";
const MARK = "const dbFile = root ? join(root, '.qqbot', 'memory.db') : '';";

if (REVERT) {
  if (!existsSync(BAK)) { console.error('没有备份可回滚: ' + BAK); process.exit(2); }
  copyFileSync(BAK, FILE);
  console.log('✓ 已回滚 ' + FILE);
  process.exit(0);
}

const already = src.includes(MARK);
if (args.includes('--check')) {
  console.log('插件目录  ' + dir);
  console.log('目标文件  ' + FILE);
  console.log(already ? '状态      已升级（检测到 dbFile 逻辑）' : '状态      需要升级');
  process.exit(0);
}

if (already && APPLY) { console.log('✓ 已经是升级后的版本，无需重复打补丁'); process.exit(0); }

const i = src.indexOf(START);
const j = src.indexOf(END);
if (i < 0 || j < 0 || j < i) {
  console.error('锚点未匹配：START=' + i + ' END=' + j);
  process.exit(3);
}
// 取出原来的 jsonl 循环（作为回退分支原样保留）
const oldBlock = src.slice(i, j);
const loopHead = 'if (memDir && existsSync(memDir)) {';
const ls = oldBlock.indexOf(loopHead);
const closeMarker = '      }' + EOL;
const le = oldBlock.lastIndexOf(closeMarker);
let innerOld = '';
if (ls >= 0 && le > ls) {
  const bodyStart = ls + loopHead.length + EOL.length;
  innerOld = oldBlock.slice(bodyStart, le);
}
if (!innerOld.trim()) { console.error('没能提取原 jsonl 循环，放弃'); process.exit(4); }

const newBlock = [
  "      const memDir = root ? join(root, '.qqbot', 'memory') : '';",
  MARK,
  "      const scopes = [];",
  "      const persona = { total: 0, rows: [] };",
  "      let backend = 'jsonl';",
  "      // ① 优先读 SQLite（记忆库已换成真数据库；jsonl 只是迁移源/旧后端）",
  "      if (dbFile && existsSync(dbFile)) {",
  "        try {",
  "          const { DatabaseSync } = await import('node:sqlite');",
  "          const db = new DatabaseSync(dbFile, { readOnly: true });",
  "          const byScope = new Map();",
  "          for (const r of db.prepare('SELECT scope, kind, COUNT(*) AS c FROM mem GROUP BY scope, kind').all()) {",
  "            const k = String(r.scope || '?');",
  "            if (!byScope.has(k)) byScope.set(k, { scope: k, total: 0, byKind: {}, recent: [] });",
  "            const s = byScope.get(k);",
  "            s.total += Number(r.c) || 0;",
  "            s.byKind[String(r.kind || '?')] = Number(r.c) || 0;",
  "          }",
  "          const recent = db.prepare('SELECT scope, kind, text, ts FROM mem ORDER BY ts DESC LIMIT 500').all();",
  "          for (const r of recent) {",
  "            const s = byScope.get(String(r.scope || '?'));",
  "            if (s && s.recent.length < 8) s.recent.push({ kind: r.kind || '', text: String(r.text || '').slice(0, 160), ts: r.ts || 0 });",
  "          }",
  "          for (const s of byScope.values()) scopes.push(s);",
  "          try {",
  "            const pr = db.prepare('SELECT scope, ckey, cvalue, weight, ts FROM persona ORDER BY ts DESC LIMIT 80').all();",
  "            persona.total = pr.length;",
  "            persona.rows = pr.map((r) => ({ scope: r.scope, key: r.ckey, value: String(r.cvalue || '').slice(0, 150), w: r.weight, ts: r.ts }));",
  "          } catch { /* 没有 persona 表也不影响 */ }",
  "          db.close();",
  "          backend = 'sqlite';",
  "        } catch (e) {",
  "          backend = 'jsonl(回退:' + String((e && e.message) || e).slice(0, 40) + ')';",
  "        }",
  "      }",
  "      // ② 没有 db / db 读不了，才回退旧的 jsonl",
  "      if (backend !== 'sqlite' && memDir && existsSync(memDir)) {",
].join(EOL) + EOL;

// 把原 jsonl 循环体接上（nested 索引体保持原缩进）
const rebuilt = newBlock + innerOld.replace(/\s*$/, '') + EOL + '      }' + EOL;

const out = src.slice(0, i) + rebuilt + src.slice(j);

// ③ payload 带上 backend / persona
let out2 = out.replace(
  "const payload = { ok: true, root, memDir, scopes: scopes.sort((a, b) => b.total - a.total), router };",
  "const payload = { ok: true, root, memDir, backend, persona, scopes: scopes.sort((a, b) => b.total - a.total), router };"
);
if (out2 === out) { console.error('payload 行未匹配'); process.exit(5); }

// ④ 页面顶部显示后端 + 人格库条数
const barAnchor = "+ '<div class=\"bar\">分流样本 ' + p.router.lines + ' 条</div>'";
if (!out2.includes(barAnchor)) { console.error('渲染锚点未匹配'); process.exit(6); }
out2 = out2.replace(
  barAnchor,
  "+ '<div class=\"bar\">后端：' + escMem(p.backend || '?') + ' · 人格库 ' + ((p.persona || {}).total || 0) + ' 条</div>'" + EOL +
  "      + '<div class=\"bar\">分流样本 ' + p.router.lines + ' 条</div>'"
);

// ⑤ persona 表格
const tierAnchor = "    const tierRows = Object.entries(p.router.tiers || {})";
if (!out2.includes(tierAnchor)) { console.error('persona 锚点未匹配'); process.exit(7); }
const personaCode = [
  "    const personaRows = ((p.persona || {}).rows || []).map((r) => '<tr><td class=\"k\">' + escMem(r.scope) + '</td><td>' + escMem(r.key) + '</td><td>' + escMem(r.value) + '</td></tr>').join('');",
  "    const personaBlock = '<h2>人格库 <span class=\"cnt\">' + ((p.persona || {}).total || 0) + ' 条</span></h2>'",
  "      + '<table><thead><tr><th>作用域</th><th>键</th><th>值</th></tr></thead><tbody>' + (personaRows || '<tr><td colspan=\"3\" class=\"empty\">（还没有写人设条目）</td></tr>') + '</tbody></table>';",
].join(EOL);
out2 = out2.replace(tierAnchor, personaCode + EOL + tierAnchor);

// ⑥ 页面里插入 personaBlock
const scopesAnchor = "+ (scopeBlocks || '<p class=\"empty\">还没有任何记忆文件 —— 在群里说几句话再看。</p>')";
if (!out2.includes(scopesAnchor)) { console.error('scopeBlocks 锚点未匹配'); process.exit(8); }
out2 = out2.replace(scopesAnchor, scopesAnchor + EOL + "      + personaBlock");

if (!APPLY) {
  console.log('（只检查。加 --apply 才会写入）');
  console.log('将替换 ' + (j - i) + ' 字符的区块，新增 persona 表与后端显示');
  process.exit(0);
}

if (!existsSync(BAK)) copyFileSync(FILE, BAK);
writeFileSync(FILE, out2, 'utf8');
console.log('✓ 已写入 ' + FILE);
console.log('  备份 ' + BAK);
