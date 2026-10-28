// fix-tool-errors.mjs —— 工具失败不再发到群里，改成只记本地日志（面板里看）
//
// 背景：群里会冒出「❌ 工具 grep 执行失败 / SearchError: SEARCH_FAILED」这种消息，
//       用户希望：这类东西不要发出来，改成在浮窗面板里显示。
//
// 做法：改 dist/transport/tool-presenter.js 的 formatToolResult()
//   1) 出错时先写一行到 {dataRoot}/.qqbot/tool-errors.jsonl（供面板读取）
//   2) 默认返回 null（不上群）；想恢复旧行为就设 QQBOT_TOOL_ERRORS_ON_QQ=1
//
// 用法：
//   node patches/fix-tool-errors.mjs --check
//   node patches/fix-tool-errors.mjs --apply
//   node patches/fix-tool-errors.mjs --revert

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN, IS_LIVE, announce } from './plugin-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const Q = String.fromCharCode(39);
const BT = String.fromCharCode(96);

const args = new Set(process.argv.slice(2));
const MODE = args.has('--apply') ? 'apply' : args.has('--revert') ? 'revert' : 'check';

const TARGET = join(PLUGIN, 'dist', 'transport', 'tool-presenter.js');
const BACKUP = join(HERE, '..', 'backups', 'tool-presenter.js.orig-toolerr');
const MARK = '[qqbot-mod] tool-errors';

function eolOf(src) {
  return src.indexOf(CR + LF) >= 0 ? CR + LF : LF;
}
function norm(src) {
  const CR_ = String.fromCharCode(13);
  const LF_ = String.fromCharCode(10);
  return src.split(CR_).join('').split(LF_).join(LF_);
}
function lines(arr, eol) {
  return arr.join(eol);
}

function buildImportLine() {
  return "import { appendFileSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';";
}

function buildHelpers() {
  const L = [
    '/** ' + MARK + ' —— 工具失败：不上群，只记日志（面板展示） */',
    "const __QQ_TOOL_ERR_ENV = 'QQBOT_TOOL_ERRORS_ON_QQ';",
    'const __qqToolErrorsOnQq = () => {',
    '    const v = String(process.env[__QQ_TOOL_ERR_ENV] || "").toLowerCase();',
    '    return v === ' + Q + '1' + Q + ' || v === ' + Q + 'true' + Q + ' || v === ' + Q + 'yes' + Q + ';',
    '};',
    'export function toolErrorLogPath() {',
    '    const root = String(process.env.QQBOT_MEMORY_DATA_ROOT || ' + Q + 'F:/qqbot/dshqqbot' + Q + ').replace(/[/]+$/, "");',
    "    return root + '/.qqbot/tool-errors.jsonl';",
    '}',
    'function __qqWriteToolError(name, err) {',
    '    const file = toolErrorLogPath();',
    '    const payload = {',
    '        ts: Date.now(),',
    '        tool: String(name || ""),',
    '        name: String((err && err.name) || ""),',
    '        code: String((err && err.code) || ""),',
    '        message: String((err && err.message) || "").slice(0, 300),',
    '    };',
    '    try {',
    '        const dir = file.slice(0, file.lastIndexOf("/"));',
    '        if (dir) mkdirSync(dir, { recursive: true });',
    '        appendFileSync(file, JSON.stringify(payload) + String.fromCharCode(10), ' + Q + 'utf8' + Q + ');',
    '        if (existsSync(file) && statSync(file).size > 200000) {',
    '            const rows = readFileSync(file, ' + Q + 'utf8' + Q + ').split(String.fromCharCode(10)).filter(Boolean).slice(-120);',
    '            writeFileSync(file, rows.join(String.fromCharCode(10)) + String.fromCharCode(10), ' + Q + 'utf8' + Q + ');',
    '        }',
    '    } catch { /* 记日志失败不影响主流程 */ }',
    '}',
    "export function readToolErrors(limit = 10) {",
    '    try {',
    '        const file = toolErrorLogPath();',
    '        if (!existsSync(file)) return [];',
    '        const rows = readFileSync(file, ' + Q + 'utf8' + Q + ').split(String.fromCharCode(10)).filter(Boolean);',
    '        const out = [];',
    '        for (const line of rows.slice(-Math.max(1, Number(limit) || 10))) {',
    '            try { out.push(JSON.parse(line)); } catch { /* skip */ }',
    '        }',
    '        return out.reverse();',
    '    } catch { return []; }',
    '}',
  ];
  return lines(L, LF);
}

function main() {
  if (!existsSync(TARGET)) {
    console.error('找不到 ' + TARGET);
    process.exit(1);
  }
  const raw = readFileSync(TARGET, 'utf8');
  const eol = eolOf(raw);
  const src = norm(raw);

  if (MODE === 'revert') {
    if (!existsSync(BACKUP)) {
      console.error('没有备份，无法回滚：' + BACKUP);
      process.exit(1);
    }
    copyFileSync(BACKUP, TARGET);
    console.log('已回滚 ' + TARGET);
    return;
  }

  const already = src.includes(MARK);
  // 只在 `if (data.error) {` 之后插两句：先记日志；非静默工具、非强制模式 → 直接 return null（不上群）
  const oldBranch = lines(['    if (data.error) {'], LF);
  const newBranch = lines([
    '    if (data.error) {',
    '        // ' + MARK + '：失败不上群，只记日志（面板可看）；要旧行为就设 QQBOT_TOOL_ERRORS_ON_QQ=1',
    '        __qqWriteToolError(name, data.error);',
    '        if (!__qqToolErrorsOnQq() && !SILENT_TOOLS.has(name))',
    '            return null;',
  ], LF);

  const pl = [];
  if (src.includes('__qqWriteToolError(name, data.error)')) pl.push(['错误分支已改（跳过）']);
  else if (src.split(oldBranch).length - 1 === 1) pl.push([oldBranch, newBranch, '错误分支 → 记日志 + 默认不发群']);
  else pl.push(['!! 错误分支未匹配']);
  if (src.includes(buildImportLine())) pl.push(['import 已存在（跳过）']);
  else {
    const anchor = '/**' + LF + ' * 工具调用结果 → Markdown 格式化';
    if (src.includes(anchor)) pl.push([anchor, buildImportLine() + LF + anchor, '加 node:fs import']);
    else pl.push(['!! import 锚点未匹配']);
  }
  if (src.includes(MARK)) pl.push(['helpers 已存在（跳过）']);
  else pl.push([lines(['const RESULT_PREVIEW_LIMIT = 1500;'], LF), lines(['const RESULT_PREVIEW_LIMIT = 1500;'], LF) + LF + buildHelpers(), '加日志 helper']);

  announce('tool-presenter.js', IS_LIVE);
  let out = src;
  let bad = 0;
  for (const p of pl) {
    if (p.length === 1) { console.log('  · ' + p[0]); continue; }
    const [o, n, label] = p;
    if (o.startsWith('!!')) { console.log('  ✗ ' + o); bad += 1; continue; }
    if (MODE === 'apply') {
      out = out.replace(o, n);
      console.log('  ✓ ' + label);
    } else {
      console.log('  ○ 可打：' + label);
    }
  }

  if (MODE === 'check') {
    console.log(bad ? '存在未匹配锚点' : '检查完成（加 --apply 落盘）');
    return;
  }
  if (MODE === 'apply') {
    if (bad) { console.error('有锚点没匹配，放弃写入'); process.exit(1); }
    if (!existsSync(BACKUP)) {
      copyFileSync(TARGET, BACKUP);
      console.log('已备份 → ' + BACKUP);
    }
    writeFileSync(TARGET, out, 'utf8');
    console.log('已写入 ' + TARGET + '（' + out.length + ' 字符）');
  }
}

main();
