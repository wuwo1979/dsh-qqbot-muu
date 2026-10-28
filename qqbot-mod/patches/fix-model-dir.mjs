#!/usr/bin/env node
/**
 * fix-model-dir.mjs — 修「面板里填了模型目录（别名）却显示模型缺失、选择被禁用」
 *
 * 根因（settings-host.js 的 localModelDirOf）：
 *     function localModelDirOf(bot) {
 *       const cfgDir = String(bot?.cfg?.localModel?.modelDir || '').trim();
 *       if (cfgDir) return cfgDir;          ← 原样返回，不解析别名、不补绝对路径
 *       return join(dshHome, 'models', 'bge-small-zh');
 *     }
 *   状态接口随后用这个返回值直接 join(...,'onnx/model_quantized.onnx') 去 existsSync。
 *   默认（空）时给的是绝对路径，没问题；一旦面板里填了别名（如 bge-base-zh），
 *   就变成相对进程 cwd 的相对路径 ⇒ 四个资产全"缺失"、available:false ⇒ 面板禁用选择。
 *   同一接口里的 embStatus 走的是 local-embed 的解析（P1 已支持别名），于是出现
 *   「embStatus 可用 / missing 全缺」这种自相矛盾的返回。
 *
 * 修法：整段替换这个函数 —— 绝对路径照旧；非绝对（别名/仅目录名）挂到 {DSH_HOME}/models 下。
 *       绝对路径判断用 charCode，避免反斜杠转义踩坑。
 *
 * 用法：node fix-model-dir.mjs [--check|--revert]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { pluginPath } from './plugin-dir.mjs';
const F = pluginPath('settings-host.js');
const ORIG = F + '.orig-modeldir';
const MARK = '本地修复(2026-10-22)：别名解析';

const NEW_FN = [
  '  function localModelDirOf(bot) {',
  '    const cfgDir = String((bot && bot.cfg && bot.cfg.localModel && bot.cfg.localModel.modelDir) || "").trim();',
  '    const dshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), ".dsh");',
  '    const modelsRoot = join(dshHome, "models");',
  '    if (cfgDir) {',
  '      // ★ ' + MARK + '：原来这里原样返回 cfgDir。',
  '      //   面板填预设别名（bge-base-zh / bge-small-zh / bge-large-zh）时，',
  '      //   下游 join(cfgDir, "onnx/model_quantized.onnx") 会相对【进程 cwd】去找，',
  '      //   于是四个资产全判缺失、available:false，面板就把"选择模型"禁用了。',
  '      const c0 = cfgDir.charCodeAt(0);',
  '      const absLike = (cfgDir.length > 1 && cfgDir[1] === ":") || c0 === 47 || c0 === 92;',
  '      return absLike ? cfgDir : join(modelsRoot, cfgDir);',
  '    }',
  '    return join(modelsRoot, "bge-small-zh");',
  '  }',
];

const argv = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);

if (!existsSync(F)) { log(`✗ 文件不存在: ${F}`); process.exit(1); }

if (argv.has('--revert')) {
  if (!existsSync(ORIG)) { log('✗ 没有备份'); process.exit(1); }
  copyFileSync(ORIG, F); log('已还原'); process.exit(0);
}

const src = readFileSync(F, 'utf8');
if (src.includes(MARK)) { log('= 已经修过了，跳过。'); process.exit(0); }

const lines = src.split('\n');
const start = lines.findIndex((l) => l.includes('function localModelDirOf(bot)'));
if (start < 0) { log('✗ 找不到 localModelDirOf，放弃'); process.exit(1); }

// 找到函数结束：从 start 起第一个 trim 后等于 '}' 的行
let end = -1;
for (let i = start + 1; i < Math.min(lines.length, start + 30); i++) {
  if (lines[i].trim() === '}') { end = i; break; }
}
if (end < 0) { log('✗ 找不到函数结束括号，放弃'); process.exit(1); }

log(`  ✓ 命中 ${start + 1}~${end + 1} 行（共 ${end - start + 1} 行）`);
log('  原函数：');
for (let i = start; i <= end; i++) log('    ' + lines[i]);
if (argv.has('--check')) { log('\n(--check) 未写入'); process.exit(0); }

if (!existsSync(ORIG)) { copyFileSync(F, ORIG); log(`备份: ${ORIG}`); }

lines.splice(start, end - start + 1, ...NEW_FN);
writeFileSync(F, lines.join('\n'), 'utf8');

log('写入完成，语法自检…');
try {
  execFileSync(process.execPath, ['--check', F], { stdio: 'inherit' });
  log('语法 OK');
} catch {
  copyFileSync(ORIG, F);
  log('✗ 语法失败 → 已回滚');
  process.exit(1);
}
log('\n修好了。状态接口 handler 是启动时注册的 —— **需要重启一次 DSH 才生效**。');
