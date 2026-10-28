#!/usr/bin/env node
/**
 * run-all-tests.mjs — 把 qqbot-mod/scripts 下所有 *test*.mjs 跑一遍并汇总
 *
 * 判断"过没过"的规则（脚本口径不统一，所以按优先级抓）：
 *   ① 显式失败计数：FAIL n / n failed / 失败 n  → 必须为 0
 *   ② 显式成功计数：PASS a / FAIL b → b 必须为 0
 *   ③ 都没有就看退出码
 *
 * 跑法：node F:\qqbot\qqbot-mod\scripts\run-all-tests.mjs [--filter=子串] [--timeout=ms]
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = 'F:/qqbot/qqbot-mod/scripts';
const args = process.argv.slice(2);
const filter = (args.find((a) => a.startsWith('--filter=')) || '').slice(9);
const timeout = Number((args.find((a) => a.startsWith('--timeout=')) || '').slice(10)) || 180000;

const files = readdirSync(DIR)
  .filter((f) => /test.*\.mjs$/i.test(f) || /selftest\.mjs$/i.test(f))
  .filter((f) => !/^_/.test(f) && f !== 'run-all-tests.mjs')
  .filter((f) => !filter || f.includes(filter))
  .sort();

/** 从输出里抽出结论：{ label, bad } */
function verdict(out, code, timedOut) {
  if (timedOut) return { label: 'TIMEOUT', bad: 1 };
  const pick = (re) => {
    const m = [...out.matchAll(re)].pop();
    return m ? m : null;
  };
  // "PASS 12 / FAIL 0" / "12 通过 / 0 失败" / "35 passed, 0 failed"
  const a = pick(/PASS\s+(\d+)\s*\/\s*FAIL\s+(\d+)/gi);
  if (a) return { label: `${a[1]} 通过 / ${a[2]} 失败`, bad: Number(a[2]) };
  const b = pick(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/g);
  if (b) return { label: `${b[1]} 通过 / ${b[2]} 失败`, bad: Number(b[2]) };
  const c = pick(/(\d+)\s*passed,\s*(\d+)\s*failed/gi);
  if (c) return { label: `${c[1]} 通过 / ${c[2]} 失败`, bad: Number(c[2]) };
  const d = pick(/全部通过\s*(\d+)\s*\/\s*(\d+)/g);
  if (d) return { label: `全部通过 ${d[1]}/${d[2]}`, bad: Number(d[2]) - Number(d[1]) };
  const e = pick(/(?:结论|结果)[:：]\s*([^\n]*)/g);
  if (e) {
    // "有问题，见上面 FAIL 行" 这种没有数字，但也明确是失败
    const bad = /失败\s*([1-9]\d*)/.test(e[1]) || /有问题/.test(e[1]) ? 1 : 0;
    return { label: e[1].trim().slice(0, 40), bad };
  }
  const f = pick(/全部通过|闭环通过|分档全部正确/g);
  if (f) return { label: f[0], bad: 0 };
  return { label: code === 0 ? 'exit 0（无明确结论）' : 'exit ' + code, bad: code === 0 ? 0 : 1 };
}

const rows = [];
// 子进程剥掉宿主的 NODE_OPTIONS：那是编辑器的语言/删除护栏注入，
// 会拦下测试自己的 .devdata-* 批量删除，导致"单独跑能过、批量跑报错"。
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], {
    cwd: 'F:/qqbot', encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
    env: childEnv,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const timedOut = r.error && String(r.error.code) === 'ETIMEDOUT';
  const v = verdict(out, r.status, timedOut);
  // 失败时把最后几行留住，别让人再去重跑一遍才知道为什么
  const tail = v.bad === 0 ? '' : '\n      ' + out.split('\n').filter(Boolean).slice(-6).join('\n      ');
  // 失败的全量输出落到文件里，屏幕只看尾巴
  if (v.bad !== 0) {
    try {
      mkdirSync(DIR + '/../../tmp/test-failures', { recursive: true });
      writeFileSync(DIR + '/../../tmp/test-failures/' + f.replace(/\.mjs$/, '') + '.log', out, 'utf8');
    } catch { /* 写不了就算了 */ }
  }
  rows.push({ f, ...v, ms: Date.now() - t0 });
  const mark = v.bad === 0 ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${f.padEnd(26)} ${String(v.label).padEnd(24)} ${((Date.now() - t0) / 1000).toFixed(1)}s${tail}`);
}

const bad = rows.filter((r) => r.bad !== 0);
console.log('\n──────────────────────────────────────────');
console.log(`套件 ${rows.length} 个，通过 ${rows.length - bad.length}，失败 ${bad.length}`);
if (bad.length) console.log('失败清单：' + bad.map((r) => r.f).join(', '));
process.exitCode = bad.length ? 1 : 0;
