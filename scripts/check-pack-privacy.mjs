#!/usr/bin/env node
/**
 * check-pack-privacy.mjs — npm 包与仓库的隐私闸门（CI 与发布前都跑）
 *
 * 规则（2026-10-28 收紧）：
 *   1. 包里不得有运行时数据：data/、.state/、.qqbot/、msg-history/、*.jsonl、*.db、*.log；
 *   2. 包里不得有媒体与成片：*.mp4/*.webm/*.mp3/*.wav/*.srt/cover.jpg；
 *   3. 包里不得有本机密钥：*cookie*.json、bili-ops-config.json、secrets/；
 *   4. 包里不得有人格真身：worldbook.json / character.json / persona/（只允许 *.example.json）；
 *   5. 文本里不得出现 32 位十六进制 openid 形态串（上游官方文件自带的白名单除外）；
 *   6. 文本里不得出现 Cookie / 令牌形态：SESSDATA=、bili_jct=、sessionid_ss=、ghp_、sk- 等；
 *   7. 真实身份名黑名单来自 secrets/privacy-blocklist.json（不进仓库，CI 里没有就自动跳过）。
 *
 * 用法：node scripts/check-pack-privacy.mjs
 * 退出码：0 = 干净；1 = 泄漏（打印文件与上下文）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 上游 @zaofan/dsh-qqbot 官方文件自带的示例 openid（live-overlay/base 必须与官方字节一致）
const UPSTREAM_ALLOW = new Set(['07B470BDA5052489D2D0532C2CC2A2EB']);
const PLACEHOLDER_ALLOW = new Set(['AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD', '0123456789ABCDEF0123456789ABCDEF']);
const HEX32 = /[0-9A-F]{32}/g;

const TEXT_EXT = /\.(json|jsonl|mjs|js|md|yml|yaml|txt|ps1|sh|py|srt|html|css)$/i;
const BIN_EXT = /\.(png|jpe?g|gif|webp|ico|gz|tar|zip|mp3|mp4|webm|wav|db|woff2?|ttf)$/i;

const PATH_BAD = [
  [/\/(data|\.state|\.qqbot|msg-history|tts|uploads)\//i, '运行时数据目录'],
  [/\.jsonl$/i, '聊天/审计台账'],
  [/\.(db|sqlite3?)$/i, '数据库'],
  [/\.log$/i, '日志'],
  [/\.(mp4|webm|mov|mkv|wav|mp3|m4a|srt|vtt)$/i, '媒体/成片'],
  [/cover\.(jpg|png)$/i, '成片封面'],
  [/cookie.*\.json$/i, 'Cookie 文件'],
  [/bili-ops-config\.json$/i, '本机配置（含 ownerOpenid）'],
  [/worldbook\.json$/i, '世界书真身（只允许 *.example.json）'],
  [/character\.json$/i, '人格真身（只允许 *.example.json）'],
  [/\/persona\/(?!.*\.example\.json$)/i, '人格目录（只允许 *.example.json）'],
  [/\.(zip|tgz|tar|tar\.gz|7z)$/i, '历史打包'],
  [/\.bak($|-)/i, '快照文件'],
  [/^secrets\//, 'secrets 目录'],
];

const TOKEN_PATTERNS = [
  [/SESSDATA=[A-Za-z0-9%*]{10,}/, 'B 站 SESSDATA'],
  [/bili_jct=[0-9a-f]{20,}/, 'B 站 bili_jct'],
  [/sessionid_ss?=[0-9a-f]{20,}/, '抖音 sessionid'],
  [/ghp_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/sk-[A-Za-z0-9]{24,}/, 'API key'],
];

const BLOCKLIST_FILE = 'secrets/privacy-blocklist.json';

function fail(msg, extra) {
  console.error('❌ ' + msg);
  for (const line of extra || []) console.error('   ' + line);
  process.exit(1);
}

const isPlaceholder = (s) => PLACEHOLDER_ALLOW.has(s) || /(.)\1{8,}/.test(s);
const isText = (f) => TEXT_EXT.test(f) && !BIN_EXT.test(f) && !f.includes('/vendor/') && !f.includes('node_modules/');

function readBlocklist() {
  if (!existsSync(BLOCKLIST_FILE)) return [];
  try {
    const j = JSON.parse(readFileSync(BLOCKLIST_FILE, 'utf8'));
    return [...(j.names || []), ...(j.accounts || []), ...(j.extra || [])].filter((s) => typeof s === 'string' && s.length >= 2);
  } catch (e) {
    console.warn(`⚠️  ${BLOCKLIST_FILE} 读不出来（${e.message}），跳过真名扫描`);
    return [];
  }
}

function scanText(files, label) {
  const hits = { path: [], openid: [], token: [], name: [] };
  for (const f of files) {
    for (const [re, why] of PATH_BAD) if (re.test(f)) hits.path.push(`${f}（${why}）`);
    if (!isText(f)) continue;
    let txt = '';
    try { txt = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of txt.matchAll(HEX32)) {
      if (UPSTREAM_ALLOW.has(m[0]) || isPlaceholder(m[0])) continue;
      const at = m.index;
      hits.openid.push(`${f} @${at}: …${txt.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, ' ')}…`);
    }
    for (const [re, why] of TOKEN_PATTERNS) {
      const m = txt.match(re);
      if (m) hits.token.push(`${f}: ${why} → ${m[0].slice(0, 12)}…`);
    }
  }
  const names = readBlocklist();
  if (names.length) {
    for (const f of files) {
      if (!isText(f)) continue;
      let txt = '';
      try { txt = readFileSync(f, 'utf8'); } catch { continue; }
      for (const n of names) if (txt.includes(n)) hits.name.push(`${f}: 含真名/账号（${n.slice(0, 1)}…）`);
    }
  }
  if (hits.path.length) fail(`${label}里混入了运行时/隐私文件：`, hits.path.slice(0, 12));
  if (hits.openid.length) fail(`${label}里有 ${hits.openid.length} 处疑似真实 openid：`, hits.openid.slice(0, 10));
  if (hits.token.length) fail(`${label}里出现了 Cookie/令牌：`, hits.token.slice(0, 10));
  if (hits.name.length) fail(`${label}里出现了真名/账号：`, hits.name.slice(0, 10));
  return names.length;
}

// ── 阶段 1：npm 包（tarball 文件清单）────────────────────────────────────
let files = [];
try {
  const out = execFileSync('npm', ['pack', '--json'], { encoding: 'utf8', cwd: process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out);
  rmSync(join(process.cwd(), j[0].filename), { force: true });
  files = j[0].files.map((f) => f.path);
} catch (e) {
  fail(`npm pack 失败（${String(e.message).split('\n')[0]}）`);
}
console.log(`npm 包共 ${files.length} 个文件，开始隐私扫描…`);
const withNames = scanText(files, 'npm 包');

// ── 阶段 2：仓库跟踪的源码 ───────────────────────────────────────────────
let repoFiles = [];
try {
  repoFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: process.cwd(), shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
    .split(/\r?\n/).filter(Boolean);
} catch { /* 不在 git 仓库里就跳过 */ }
if (repoFiles.length) {
  console.log(`仓库跟踪 ${repoFiles.length} 个文件，开始隐私扫描…`);
  scanText(repoFiles, '仓库源码');
}

console.log(`✅ 隐私自检通过（真名黑名单：${withNames ? '已启用' : '未配置，跳过'}）。`);
