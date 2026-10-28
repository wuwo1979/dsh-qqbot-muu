/**
 * tool-schema-test.mjs — 扩展工具 schema 形状回归
 *
 * 背景（2026-10-24 真机）：
 *   `bili_ops` 曾把 inputSchema 写成 JSON-Schema
 *   （`{type:'object', properties:{...}, required:[...]}`），宿主报
 *   `[channel-tools] 扩展工具注册失败 bili_ops: unsupported JSON schema:
 *    parameters.type must be a value schema object`
 *   —— 工具根本没注册，于是她只能自己写 `F:\qqbot\tmp\build_video.py` 做视频。
 *
 * 宿主要的是**扁平**形状：每个键直接是一个 value schema，必填写在字段的 required 上。
 * 这个测试把三个自研工具都钉住，避免以后又写回 JSON-Schema。
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const TOOLS = 'F:/qqbot/dshqqbot/.qqbot-extensions/tools';
const CASES = [
  { file: 'bili_ops.mjs', required: ['action'] },
  { file: 'draw.mjs', required: ['prompt'] },
  { file: 'storyboard.mjs', required: ['panels'] },
];

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

for (const c of CASES) {
  const mod = await import(pathToFileURL(join(TOOLS, c.file)).href);
  const def = mod.default || mod;
  const s = def.inputSchema;
  ok(c.file + ' 有 inputSchema', s && typeof s === 'object');
  if (!s) continue;
  ok(c.file + ' 顶层没有 type', !('type' in s));
  ok(c.file + ' 顶层没有 properties', !('properties' in s));
  ok(c.file + ' 顶层没有 required 数组', !Array.isArray(s.required));
  const keys = Object.keys(s);
  ok(c.file + ' 字段数 > 0', keys.length > 0, keys.length);
  for (const k of keys) {
    const v = s[k];
    ok(c.file + '.' + k + ' 是 object', v && typeof v === 'object' && !Array.isArray(v));
    ok(c.file + '.' + k + ' 有 type 字符串', v && typeof v.type === 'string', v && v.type);
    if (v && v.type === 'array') ok(c.file + '.' + k + ' array 有 items', v.items && typeof v.items === 'object');
  }
  for (const r of c.required) {
    ok(c.file + ' 必填 ' + r + ' 标了 required', s[r] && s[r].required === true);
  }
}

console.log('─'.repeat(40));
if (fail) { console.log(`FAIL ${pass} PASS / ${fail} FAIL`); process.exit(1); }
console.log(`PASS ${pass} / FAIL 0`);
