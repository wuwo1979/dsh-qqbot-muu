#!/usr/bin/env node
/**
 * install.mjs — 把 dsh-qqbot-muu 的扩展装进任意 bot 数据根
 *
 *   node install.mjs --data-root "D:\mybot"          # 复制扩展
 *   node install.mjs --data-root "D:\mybot" --force  # 覆盖已有文件
 *
 * 只复制扩展代码与默认配置；不复制 data/、inbound/.state/、*.bak* 这些运行时/隐私文件。
 * 复制过去后会把配置里的 dataRoot 换成目标目录（其它本机路径请自行确认）。
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync,
} from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(fileURLToPath(import.meta.url));
const SRC = join(REPO, 'dshqqbot', '.qqbot-extensions');
const LOCAL_ROOT = 'F:/qqbot/dshqqbot';

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : '';
}

const targetRaw = argValue('--data-root') || process.env.QQBOT_DATA_ROOT || process.cwd();
const TARGET = targetRaw.replace(/\\/g, '/').replace(/\/+$/, '');
const FORCE = process.argv.includes('--force');

if (!existsSync(SRC)) {
  console.error('找不到扩展目录：' + SRC + '\n请在仓库根目录运行本脚本。');
  process.exit(2);
}

const SKIP_DIRS = new Set(['data', '.state', 'node_modules']);
let copied = 0;
let skipped = 0;

function walk(dir, rel) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const relPath = rel ? rel + '/' + name : name;
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(abs, relPath);
      continue;
    }
    if (/\.bak($|-)/.test(name)) continue;
    const dst = join(TARGET, '.qqbot-extensions', relPath);
    if (existsSync(dst) && !FORCE) { skipped += 1; continue; }
    mkdirSync(dirname(dst), { recursive: true });
    if (extname(name).toLowerCase() === '.json') {
      let txt = readFileSync(abs, 'utf8');
      txt = txt.replaceAll(LOCAL_ROOT, TARGET);
      writeFileSync(dst, txt, 'utf8');
    } else {
      copyFileSync(abs, dst);
    }
    copied += 1;
  }
}

if (!existsSync(join(TARGET, '.qqbot'))) {
  console.log('提示：' + TARGET + ' 里还没有 .qqbot/，请确认这就是你的 bot 数据根。');
}
mkdirSync(join(TARGET, '.qqbot-extensions'), { recursive: true });
walk(SRC, '');

// bili-ops-config.json 含真实 ownerOpenid，不进 git/npm；干净模板随包发布，目标没有就铺一份
// （ownerOpenids 为空 = 所有写操作一律拒绝，装好后把你的 openid 填进去才放行）
{
  const cfgDst = join(TARGET, '.qqbot-extensions', 'bili-ops-config.json');
  const cfgSrc = join(SRC, 'bili-ops-config.example.json');
  if (!existsSync(cfgDst) && existsSync(cfgSrc)) {
    mkdirSync(dirname(cfgDst), { recursive: true });
    copyFileSync(cfgSrc, cfgDst);
    console.log('已从 bili-ops-config.example.json 铺出默认 B 站运营配置（ownerOpenids 为空 = 拒绝一切写操作，记得填你的 openid）');
  }
}

// 真实世界书/人格不进包（最高级保密）；干净模板铺底，用户自己填自己的性格
{
  const wbDst = join(TARGET, '.qqbot-extensions', 'worldbook.json');
  const wbSrc = join(SRC, 'worldbook.example.json');
  if (!existsSync(wbDst) && existsSync(wbSrc)) {
    copyFileSync(wbSrc, wbDst);
    console.log('已从 worldbook.example.json 铺出默认世界书（照着改成你自己的性格与关系即可）');
  }
}

console.log('✅ 扩展已安装到 ' + join(TARGET, '.qqbot-extensions'));
console.log('   新增/更新 ' + copied + ' 个文件，跳过 ' + skipped + ' 个已存在文件' + (FORCE ? '' : '（用 --force 覆盖）'));
console.log('下一步：');
console.log('  1) 检查 .qqbot-extensions/memory-config.json 与 local-llm-config.json 里的 dataRoot');
console.log('  2) ollama pull qwen2.5vl:3b（表情打标/识图）');
console.log('  3) 在 QQ 里发 /bot-restart，或重启 DSH 桌面端');
