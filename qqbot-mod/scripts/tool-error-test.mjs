// tool-error-test.mjs —— 工具失败：不上群、只记日志（面板可读）
//
// 被改的文件：插件 dist/transport/tool-presenter.js
//   formatToolResult(name, args, data, registry, agent)
//   出错时 → 写 {dataRoot}/.qqbot/tool-errors.jsonl，默认 return null（不发 QQ）
//   设 QQBOT_TOOL_ERRORS_ON_QQ=1 才回到旧行为（把 ❌ 文案发到群里）
//
// 用法：node scripts/tool-error-test.mjs [-v]

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-toolerr';
const LOG = join(ROOT, '.qqbot', 'tool-errors.jsonl');

process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;

const mod = await import(
  'file:///C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/.generations/live/zaofan+dsh-qqbot+1.10.22+7e82c7977ddc/node_modules/@zaofan/dsh-qqbot/dist/transport/tool-presenter.js'
);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log('PASS  ' + name);
  } else {
    fail += 1;
    console.log('FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
};

function reset() {
  try { rmSync(LOG, { force: true }); } catch {}
  mkdirSync(join(ROOT, '.qqbot'), { recursive: true });
}

const errData = (name, code) => ({
  error: { name, code },
  message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'boom' }] }] },
});

// 1) grep 搜索失败（用户截图里那个）
reset();
const r1 = mod.formatToolResult('grep', '{}', errData('SearchError', 'SEARCH_FAILED'), null, null);
ok('grep 失败 → 不返回任何文本（不上群）', r1 === null, String(r1));
ok('grep 失败 → 写进了日志', existsSync(LOG) && readFileSync(LOG, 'utf8').includes('SEARCH_FAILED'));

// 2) read_image 文件不存在
const r2 = mod.formatToolResult('read_image', '{}', errData('FsError', 'FS_NOT_FOUND'), null, null);
ok('read_image 失败 → 不上群', r2 === null, String(r2));
const logText = readFileSync(LOG, 'utf8');
ok('日志里两条都在', logText.trim().split('\n').length === 2, logText.trim().split('\n').length);
ok('日志字段齐全', /"tool":"read_image".*"code":"FS_NOT_FOUND"/.test(logText), logText.trim().split('\n').pop());

// 3) 强制模式（环境变量）→ 回到旧行为，文案还带工具名与错误码
process.env.QQBOT_TOOL_ERRORS_ON_QQ = '1';
const r3 = mod.formatToolResult('grep', '{}', errData('SearchError', 'SEARCH_FAILED'), null, null);
ok('强制模式下照旧发群', typeof r3 === 'string' && r3.includes('grep') && r3.includes('SEARCH_FAILED'), String(r3));
delete process.env.QQBOT_TOOL_ERRORS_ON_QQ;

// 4) 静默工具（reply_gate）即使强制模式也静默
process.env.QQBOT_TOOL_ERRORS_ON_QQ = '1';
const r4 = mod.formatToolResult('reply_gate', '{}', errData('GateError', 'SELF_CANCEL'), null, null);
ok('reply_gate 始终静默', r4 === null, String(r4));
delete process.env.QQBOT_TOOL_ERRORS_ON_QQ;

// 5) 成功结果不受影响（没有 presentResult 时走 raw text）
reset();
const okData = (text) => ({ message: { content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] } });
const r5 = mod.formatToolResult('memory', '{}', okData('记住啦：周五交报告'), null, null);
ok('成功结果照常返回', typeof r5 === 'string' && r5.includes('周五交报告'), String(r5));

// 6) 空结果的工具返回 null
const r6 = mod.formatToolResult('memory', '{}', okData(''), null, null);
ok('空结果 → null', r6 === null, String(r6));

// 7) 日志读回来（面板用）—— 先确保库里有一条（上面 test5 的 reset 清过）
reset();
mod.formatToolResult('grep', '{}', errData('SearchError', 'SEARCH_FAILED'), null, null);
const rows = mod.readToolErrors(10);
ok('readToolErrors 能读', Array.isArray(rows) && rows.length === 1, JSON.stringify(rows).slice(0, 120));
ok('readToolErrors 倒序/字段', rows[0] && rows[0].tool === 'grep' && rows[0].code === 'SEARCH_FAILED', JSON.stringify(rows[0]));

// 8) 日志膨胀会被裁剪（>200KB）
reset();
const big = JSON.stringify({ ts: Date.now(), tool: 'x', name: 'E', code: 'C', message: 'y'.repeat(200) });
const many = [];
for (let i = 0; i < 1200; i += 1) many.push(big);
writeFileSync(LOG, many.join('\n') + '\n', 'utf8');
mod.formatToolResult('grep', '{}', errData('SearchError', 'SEARCH_FAILED'), null, null);
const sizeAfter = readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length;
ok('日志超 200KB 被裁剪到 120 行以内', sizeAfter <= 121, 'lines=' + sizeAfter);

// 9) 坏行不影响读取
reset();
writeFileSync(LOG, 'not json\n' + JSON.stringify({ ts: 1, tool: 'grep', code: 'X' }) + '\n', 'utf8');
const rows2 = mod.readToolErrors(5);
ok('坏 JSON 行被跳过', rows2.length === 1 && rows2[0].tool === 'grep', JSON.stringify(rows2));

// 10) 数据根不存在也能落盘（自动建目录）
rmSync(ROOT, { recursive: true, force: true });
const r10 = mod.formatToolResult('grep', '{}', errData('SearchError', 'SEARCH_FAILED'), null, null);
ok('数据根不存在 → 自动建目录并写入', r10 === null && existsSync(LOG));

console.log('');
console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
