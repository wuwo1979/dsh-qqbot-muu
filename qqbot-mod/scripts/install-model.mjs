#!/usr/bin/env node
/**
 * install-model.mjs — 给小蓝装本地评分模型（可选择，不是强制单一）
 *
 * 用法：
 *   node install-model.mjs                      # 列出可选模型 + 当前状态
 *   node install-model.mjs --check              # 只探测镜像/文件大小，不下载
 *   node install-model.mjs bge-base-zh          # 下载 bge-base-zh（约 100MB）
 *   node install-model.mjs bge-small-zh         # 下载/重装 bge-small-zh（24MB）
 *   node install-model.mjs bge-base-zh --force  # 已存在也覆盖
 *
 * 装完后：面板「⚙ 单会话设置 → 🧠 智能回复 → 模型目录」填别名（如 bge-base-zh），
 *         点「💾 保存」再点「🔄 重新检测」即可切换，无需重启。
 *
 * 依赖：只用 Node 内置 https/fs（不装任何包）。
 */

import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { get } from 'node:https';
import { createInterface } from 'node:readline';

// ── 预设表（与插件 dist/features/local-embed.js 的 MODEL_PRESETS 保持一致）──
const PRESETS = {
  'bge-small-zh': {
    repo: 'Xenova/bge-small-zh-v1.5',
    minOnnxMB: 20,
    note: '24MB，最快；现在就在用它',
  },
  'bge-base-zh': {
    repo: 'Xenova/bge-base-zh-v1.5',
    minOnnxMB: 80,
    note: '约 100MB，中文明显更准；推荐升级档',
  },
  'bge-large-zh': {
    repo: 'Xenova/bge-large-zh-v1.5',
    minOnnxMB: 250,
    note: '约 330MB，最准但 CPU 慢；没 GPU 不建议',
  },
};

/** 必须齐的三个 + 建议带的 tokenizer_config.json */
const FILES = [
  { rel: 'onnx/model_quantized.onnx', min: (p) => PRESETS[p].minOnnxMB * 1024 * 1024 },
  { rel: 'tokenizer.json', min: () => 300 * 1024 },
  { rel: 'config.json', min: () => 200 },
  { rel: 'tokenizer_config.json', min: () => 100, optional: true },
];

const MIRRORS = [
  'https://hf-mirror.com',   // 国内优先
  'https://huggingface.co',  // 官方兜底
];

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const FORCE = argv.includes('--force');
const alias = argv.find((a) => !a.startsWith('-'));

const DSH_HOME = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh');
const MODELS_ROOT = join(DSH_HOME, 'models');

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const ok = (s) => console.log('  ✅ ' + s);
const bad = (s) => { console.log('  ❌ ' + s); process.exitCode = 1; };
const info = (s) => console.log('     ' + s);

/** HEAD 请求拿 Content-Length（跟随重定向） */
function head(url, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 5) return resolve(null);
    let req;
    try {
      req = get(url, { method: 'HEAD', timeout: 20000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(head(new URL(res.headers.location, url).href, depth + 1));
        }
        const len = Number(res.headers['content-length'] || 0);
        res.resume();
        resolve(res.statusCode === 200 ? { len } : null);
      });
    } catch {
      return resolve(null);
    }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 流式下载到 .part，完成后校验大小再改名 */
function download(url, dest, minBytes, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向过多'));
    const req = get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, dest, minBytes, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const total = Number(res.headers['content-length'] || 0);
      const tmp = dest + '.part';
      const ws = createWriteStream(tmp);
      let got = 0;
      let lastPct = -10;
      res.on('data', (c) => {
        got += c.length;
        if (total > 0) {
          const pct = Math.floor((got / total) * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            process.stdout.write(`\r     下载中 ${pct}%  (${mb(got)} / ${mb(total)})      `);
          }
        }
      });
      res.pipe(ws);
      ws.on('finish', () => {
        ws.close(() => {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          try {
            const size = statSync(tmp).size;
            if (size < minBytes) {
              rmSync(tmp, { force: true });
              return reject(new Error(`文件过小 (${mb(size)} < ${mb(minBytes)})，可能是镜像返回了错误页`));
            }
            renameSync(tmp, dest);
            resolve(size);
          } catch (e) { reject(e); }
        });
      });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('连接超时')); });
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────
console.log('模型根目录: ' + MODELS_ROOT + '\n');

if (!alias) {
  console.log('可选模型:');
  for (const [k, v] of Object.entries(PRESETS)) {
    const dir = join(MODELS_ROOT, k);
    const f = join(dir, 'onnx', 'model_quantized.onnx');
    const st = existsSync(f) ? `已安装 (${mb(statSync(f).size)})` : '未安装';
    info(`${k.padEnd(14)} ${v.note.padEnd(38)} ${st}`);
  }
  console.log('\n安装: node install-model.mjs <别名>');
  console.log('探测: node install-model.mjs <别名> --check');
  process.exit(process.exitCode || 0);
}

if (!PRESETS[alias]) {
  bad(`未知模型别名: ${alias}（可选: ${Object.keys(PRESETS).join(' / ')}）`);
  process.exit(1);
}

const preset = PRESETS[alias];
const dir = join(MODELS_ROOT, alias);
console.log(`目标: ${alias} → ${dir}`);
console.log(`来源: ${preset.repo}（${preset.note}）\n`);

if (!CHECK_ONLY) mkdirSync(join(dir, 'onnx'), { recursive: true });

// 选镜像：第一个能 HEAD 到 onnx 的
let base = null;
for (const m of MIRRORS) {
  const probe = `${m}/${preset.repo}/resolve/main/onnx/model_quantized.onnx`;
  process.stdout.write(`  探测镜像 ${m} … `);
  const r = await head(probe);
  if (r && r.len > preset.minOnnxMB * 1024 * 1024) {
    console.log(`可用 (${mb(r.len)})`);
    base = m;
    break;
  }
  console.log('不可用');
}
if (!base) {
  bad('所有镜像都不可用（网络或镜像故障）。若在公司/校园网，可能需要代理。');
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log('\n各文件可下载性:');
  for (const f of FILES) {
    const url = `${base}/${preset.repo}/resolve/main/${f.rel}`;
    const r = await head(url);
    if (r) ok(`${f.rel} (${mb(r.len)})`);
    else if (f.optional) info(`optional 缺失: ${f.rel}`);
    else bad(`缺失: ${f.rel}`);
  }
  console.log('\n结论: 可安装。去掉 --check 即开始下载。');
  process.exit(process.exitCode || 0);
}

console.log('');
for (const f of FILES) {
  const dest = join(dir, f.rel);
  const url = `${base}/${preset.repo}/resolve/main/${f.rel}`;
  if (existsSync(dest) && !FORCE) {
    ok(`已存在，跳过 ${f.rel}`);
    continue;
  }
  info(`下载 ${f.rel} …`);
  try {
    const size = await download(url, dest, f.min(alias));
    ok(`${f.rel} (${mb(size)})`);
  } catch (e) {
    if (f.optional) { info(`optional 跳过: ${f.rel} (${e.message})`); continue; }
    bad(`${f.rel} 下载失败: ${e.message}`);
    process.exit(1);
  }
}

// 收尾校验
console.log('\n校验:');
const need = FILES.filter((f) => !f.optional);
let allOk = true;
for (const f of need) {
  const dest = join(dir, f.rel);
  if (!existsSync(dest) || statSync(dest).size < f.min(alias)) { bad(`不合格: ${f.rel}`); allOk = false; }
}
if (!allOk) process.exit(1);
ok('三个必需文件齐全');
const onnxMb = mb(statSync(join(dir, 'onnx', 'model_quantized.onnx')).size);

console.log(`
装好了。切换方式：
  ① 打开小蓝的设置面板 → 「⚙ 单会话设置」→ 「🧠 智能回复」
  ② 「模型目录」填: ${alias}
  ③ 点「💾 保存」→ 点「🔄 重新检测」
  ④ 看到状态变成 model 且维度正确即生效（无需重启宿主）

当前 onnx: ${onnxMb}
回滚到原来的模型: 把「模型目录」改成 bge-small-zh 或清空即可。
`);
