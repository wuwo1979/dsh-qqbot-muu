#!/usr/bin/env node
/**
 * check-submission.mjs — 提交插件市场之前，在本地先过一遍人家的门
 *
 * 为什么要有这个：市场 CI 的失败原因全在远端，反馈一轮要等几分钟，
 * 而且 `pr-check` / `pr-gate` 两个 workflow 报错信息分散在不同页面。
 * 实测最容易踩的几类是：条目 YAML 里 description 少了 `en`、
 * 值里有 `": "` 却没加引号、仓库没有 `dsh.bundle`、
 * screenshots.json 指向的文件被 .gitignore 吃掉、icon 不在 GitHub 托管。
 *
 * 这个脚本把能离线判的全判了，只在 `--age` 时才打 GitHub API。
 *
 * 跑法：
 *   node scripts/check-submission.mjs            # 全量离线检查
 *   node scripts/check-submission.mjs --age      # 额外查仓库年龄（需要 gh 登录）
 *   node scripts/check-submission.mjs --json     # 机器可读输出
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const WANT_AGE = args.includes('--age');
const JSON_OUT = args.includes('--json');

// 与市场 scripts/lib/entries.mjs 保持同步（CAT_IDS）
const CAT_IDS = [
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools',
  'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify',
  'dev', 'security', 'remote', 'market', 'fun',
];
const MAX_SHOTS = 8;
const ICON_HOSTS = new Set(['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'github.com']);
const ICON_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const SHOT_HOSTS = ICON_HOSTS;
const MIN_AGE_DAYS = 1;

const problems = [];
const notes = [];
const bad = (m) => problems.push(m);
const ok = (m) => notes.push(m);

// ── 极简 YAML：只认 entry 文件的两层结构，够用且不引依赖 ────────────────
function parseEntryYaml(text) {
  const out = { description: {} };
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indented = /^\s+\S/.test(raw);
    const line = raw.trim();
    const i = line.indexOf(':');
    if (i < 0) { bad(`YAML 行没有冒号：${line}`); continue; }
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (!indented) {
      if (val === '') { section = key; out[key] = out[key] || {}; }
      else {
        section = null;
        if (!/^['"]/.test(val) && val.includes(': ')) bad(`YAML 值里有 ": " 必须整体加引号：${line}`);
        out[key] = unquote(val);
      }
    } else if (section) {
      if (!/^['"]/.test(val) && val.includes(': ')) bad(`YAML 值里有 ": " 必须整体加引号：${line}`);
      out[section][key] = unquote(val);
    } else {
      bad(`缩进行没有归属的父键：${line}`);
    }
  }
  return out;
}

function unquote(v) {
  const s = String(v);
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// ── 1) 条目文件 ─────────────────────────────────────────────────────────
const subDir = join(ROOT, 'submission');
const entries = existsSync(subDir)
  ? readdirSync(subDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  : [];
if (!entries.length) {
  bad('submission/ 下没有 .yml 条目');
} else {
  for (const f of entries) {
    if (f.endsWith('.yaml')) bad(`${f}: 市场只收 .yml，.yaml 会被直接跳过`);
    const rel = `submission/${f}`;
    const e = parseEntryYaml(readFileSync(join(subDir, f), 'utf8'));

    if (!e.url || !/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(e.url)) bad(`${rel}: url 必须是 https://github.com/<owner>/<repo>`);
    if (!e.name) bad(`${rel}: 缺 name`);
    if (!CAT_IDS.includes(e.category)) bad(`${rel}: category 必须是 ${CAT_IDS.join(' / ')}（当前 ${JSON.stringify(e.category)}）`);

    const en = (e.description || {}).en;
    const zh = (e.description || {}).zh;
    if (!en || !String(en).trim()) bad(`${rel}: description.en 必填（市场默认语言）`);
    for (const [loc, v] of Object.entries(e.description || {})) {
      if (typeof v === 'string' && v.includes('\n')) bad(`${rel}: description.${loc} 必须是单行`);
    }
    if (zh && !zh.trim()) bad(`${rel}: description.zh 存在但为空 —— 要么写内容，要么删掉这个键`);

    if (e.icon !== undefined) {
      try {
        const u = new URL(e.icon);
        if (u.protocol !== 'https:') bad(`${rel}: icon 必须 https`);
        if (!ICON_HOSTS.has(u.hostname)) bad(`${rel}: icon 必须托管在 GitHub（当前 ${u.hostname}）`);
        if (!ICON_EXTS.some((x) => u.pathname.toLowerCase().endsWith(x))) bad(`${rel}: icon 必须是位图（${ICON_EXTS.join(' / ')}）`);
      } catch {
        bad(`${rel}: icon 不是合法 URL`);
      }
    }

    // 仓库 slug 与文件名约定：owner__repo.yml
    const slug = String(e.url || '').replace('https://github.com/', '').split('/').slice(0, 2).join('__');
    if (slug && f !== slug + '.yml') bad(`${rel}: 文件名应为 ${slug}.yml`);
    if (e.name && slug && e.name !== slug.replace('__', '/')) bad(`${rel}: name 应为 ${slug.replace('__', '/')}`);
    else ok(`${rel}: 字段齐全`);
  }
}

// ── 2) 插件壳（市场硬门槛：必须声明 dsh.bundle）─────────────────────────
const pkg = readJson(join(ROOT, 'package.json'));
if (!pkg) {
  bad('package.json 读不出来');
} else {
  const patch = pkg.dsh?.bundle?.patch;
  if (!patch) bad('package.json 缺 dsh.bundle.patch —— 市场会判定"不是 DSH 插件"');
  else if (!existsSync(join(ROOT, String(patch).replace(/^\.\//, '')))) bad(`dsh.bundle.patch 指向的文件不存在：${patch}`);
  else ok(`dsh.bundle.patch → ${patch}`);

  if (!/^\d+\.\d+\.\d+/.test(String(pkg.version || ''))) bad(`version 不是 semver：${pkg.version}`);
  if (pkg.engines?.node && !/22/.test(String(pkg.engines.node))) bad(`engines.node=${pkg.engines.node}：本项目依赖 node:sqlite（需要 ≥22.5）`);
  for (const f of ['index.js', 'cordis.patch.yml', 'install.mjs']) {
    if (!existsSync(join(ROOT, f))) bad(`缺文件 ${f}`);
  }
  if (String(pkg.main || '') && !existsSync(join(ROOT, pkg.main))) bad(`main 指向的文件不存在：${pkg.main}`);
  const repo = String(pkg.repository?.url || '');
  if (repo && !/wuwo1979\/dsh-qqbot-muu/.test(repo)) bad(`repository 与提交条目不一致：${repo}`);
}

// ── 3) screenshots.json ────────────────────────────────────────────────
const shotsPath = join(ROOT, 'screenshots.json');
if (!existsSync(shotsPath)) {
  ok('没有 screenshots.json（可选；不写就不显示应用截图）');
} else {
  const doc = readJson(shotsPath);
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.screenshots) ? doc.screenshots
    : doc && Object.keys(doc).length === 1 && Array.isArray(Object.values(doc)[0]) ? Object.values(doc)[0] : null;
  if (!list) {
    bad('screenshots.json 必须是数组、{"screenshots":[...]} 或单键映射');
  } else if (!list.length) {
    bad('screenshots.json 里没有图片');
  } else if (list.length > MAX_SHOTS) {
    bad(`screenshots.json 有 ${list.length} 张，上限 ${MAX_SHOTS}`);
  } else {
    for (const raw of list) {
      const s = String(raw || '').trim();
      if (!s) { bad('screenshots.json 有空项'); continue; }
      if (/^https?:\/\//i.test(s)) {
        try {
          const u = new URL(s);
          if (u.protocol !== 'https:' || !SHOT_HOSTS.has(u.hostname)) bad(`绝对地址必须是 GitHub 托管的 https 图片：${s}`);
        } catch { bad(`截图 URL 不合法：${s}`); }
        continue;
      }
      if (s.startsWith('/') || s.split('/').includes('..')) { bad(`截图路径不能越出仓库根：${s}`); continue; }
      if (!existsSync(join(ROOT, s))) { bad(`截图文件不存在：${s}`); continue; }
      if (!/\.(png|jpe?g|webp)$/i.test(s)) { bad(`截图必须是 png/jpg/webp：${s}`); continue; }
      // 白名单式 .gitignore 最容易把 assets/ 挡在门外
      try {
        execFileSync('git', ['check-ignore', '-q', s], { cwd: ROOT, stdio: 'ignore' });
        bad(`截图被 .gitignore 忽略了（推上去会是 404）：${s}`);
      } catch { /* 未被忽略：check-ignore 用退出码 1 表示没忽略 */ }
    }
    ok(`screenshots.json 通过（${list.length} 张）`);
  }
}

// ── 4) 仓库年龄（可选，需要 gh）────────────────────────────────────────
if (WANT_AGE) {
  const repo = (pkg?.repository?.url || 'wuwo1979/dsh-qqbot-muu').replace(/^git\+/, '').replace(/\.git$/, '');
  const slug = repo.includes('github.com') ? repo.split('github.com/')[1] : repo;
  try {
    const out = execFileSync('gh', ['api', `repos/${slug}`, '--jq', '.created_at'], { encoding: 'utf8' }).trim();
    const days = (Date.now() - Date.parse(out)) / 86400000;
    const line = `仓库 ${slug} 创建于 ${out}（${days.toFixed(1)} 天）`;
    if (days < MIN_AGE_DAYS) bad(`${line} —— 市场要求 ≥${MIN_AGE_DAYS} 天，等约 ${Math.ceil(MIN_AGE_DAYS - days)} 天后 CI 会自己转绿，不用重推`);
    else ok(line);
  } catch (e) {
    notes.push('查不到仓库年龄（gh 未登录或没网），跳过');
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: problems.length === 0, problems, notes }, null, 2));
} else {
  for (const n of notes) console.log('  ✓ ' + n);
  for (const p of problems) console.log('  ✗ ' + p);
  console.log(problems.length ? `\n${problems.length} 个问题需要修` : '\n全部通过，可以提交');
}
process.exit(problems.length ? 1 : 0);
