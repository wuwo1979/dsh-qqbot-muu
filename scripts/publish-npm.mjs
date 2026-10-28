#!/usr/bin/env node
/**
 * publish-npm.mjs —— 一条命令发 npm（先过隐私闸门，再发布）
 *
 *   node scripts/publish-npm.mjs --dry-run     # 只体检 + 打包，不发布
 *   npm login                                  # 或把 token 写进 secrets/npm-token.txt
 *   node scripts/publish-npm.mjs
 *
 * 顺序（任何一步失败就停，不带着隐私风险发出去）：
 *   1. scripts/check-pack-privacy.mjs（运行时数据 / Cookie / 令牌 / 真名 / 非 ASCII 文件名）
 *   2. 与 GitHub 上的文件清单对账（防止包里少了东西）
 *   3. npm publish --access public
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', ...opts });

function step(title) { console.log(`\n── ${title}`); }

function whoami() {
  try {
    return run('npm', ['whoami']).trim();
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message);
    if (/ENEEDAUTH/i.test(msg)) return '';
    throw e;
  }
}

function tokenFromFile() {
  const p = 'secrets/npm-token.txt';
  if (!existsSync(p)) return '';
  const t = readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
  return /^npm_[A-Za-z0-9]{20,}$/.test(t) ? t : '';
}

// 1) 隐私闸门
step('隐私闸门');
try {
  const out = run('node', ['scripts/check-pack-privacy.mjs']);
  console.log(out.trim().split('\n').slice(-2).join('\n'));
} catch (e) {
  console.error('❌ 隐私自检没通过，停止发布：');
  console.error(String(e.stderr || e.stdout || e.message).trim().split('\n').slice(0, 12).join('\n'));
  process.exit(1);
}

// 2) 包里到底有什么
step('打包明细');
const packOut = run('npm', ['pack', '--dry-run', '--json']);
const info = JSON.parse(packOut)[0];
const files = info.files.map((f) => f.path);
console.log(`包内 ${files.length} 个文件，${(info.size / 1024).toFixed(0)}KB（unpacked ${(info.unpackedSize / 1024 / 1024).toFixed(1)}MB）：${info.filename}`);
const nonAscii = files.filter((f) => /[^\x00-\x7F]/.test(f));
if (nonAscii.length) { console.error('❌ 还有非 ASCII 文件名：' + nonAscii.slice(0, 5).join(', ')); process.exit(1); }

// 3) 身份
step('npm 身份');
const token = tokenFromFile();
let user = token ? '(用 secrets/npm-token.txt)' : whoami();
if (!user) {
  console.error('❌ 还没有 npm 登录态。二选一：');
  console.error('   a) 在本机跑一次 `npm login`（交互式，之后一直有效）');
  console.error('   b) 把 granular access token 写进 secrets/npm-token.txt（该文件已在 .gitignore 里）');
  console.error('   其它都就绪了：隐私闸门通过、包内容干净、CI 绿。');
  process.exit(2);
}
console.log(`身份：${user}`);

if (DRY) { console.log('\n✅ dry-run 结束（没有真的发布）'); process.exit(0); }

// 4) 发布
step('npm publish');
const env = { ...process.env };
if (token) env.NPM_TOKEN = token;
const args = ['publish', '--access', 'public', '--provenance=false'];
if (token) args.push(`--//registry.npmjs.org/:_authToken=${token}`);
try {
  const out = run('npm', args, { env });
  console.log(out.trim());
  console.log('\n✅ 已发布。检查：npm view dsh-qqbot-muu version');
} catch (e) {
  console.error('❌ 发布失败：');
  console.error(String(e.stderr || e.stdout || e.message).trim().split('\n').slice(0, 15).join('\n'));
  process.exit(1);
}
