#!/usr/bin/env node
/**
 * add-ext-config-api.mjs — 给「本地代答 / 语音」两份扩展配置加读写接口
 *
 * 为什么：`local-llm-config.json` / `voice-config.json` 现在只能手改文件，
 *   面板里既看不见也点不了（主人反馈"整个UI都是一个毛病"）。
 *   这里在 settings-host.js 里加一条通用读写路由，前端就能做成开关：
 *
 *     GET  /api/qqbot-settings/ext-config?which=local|voice
 *          → { ok, which, path, config, ollama:{up,models}, voices:[...] }
 *     POST /api/qqbot-settings/ext-config   { which, patch:{...} }
 *          → { ok, which, path, config }   （浅合并后整份写回）
 *
 * 安全性：
 *   · 只碰 `.qqbot-extensions/` 下那两个白名单文件，路径写死，不接受任意路径；
 *   · 写之前把原文件备份成 `<file>.bak-<时间戳>`；
 *   · 不注册到插件的 settings 存储，不受 host volatile 限制。
 *
 * 用法：node add-ext-config-api.mjs [--check|--revert]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { pluginPath } from './plugin-dir.mjs';
const F = pluginPath('settings-host.js');
const ORIG = F + '.orig-extcfg';
const MARK = '本机新增(2026-10-23): 扩展配置读写（本地代答 / 语音）';
const ANCHOR = "  route(ctx, 'GET', '/api/qqbot-settings/memory', async (req, res) => {";

const BLOCK = `  // ★ ${MARK}
  //   两份额外配置（本地小模型、语音）原来只能改文件。这里给前端一对读写接口，
  //   面板就能做成"开关 + 下拉"，不用记事本。
  const EXT_CFG_FILES = { local: 'local-llm-config.json', voice: 'voice-config.json' };

  const EXT_VOICES = [
    ['zh-CN-XiaoyiNeural', '小艺 · 女 · 活泼'],
    ['zh-CN-XiaoxiaoNeural', '晓晓 · 女 · 温柔'],
    ['zh-CN-XiaochenNeural', '晓辰 · 女 · 慵懒'],
    ['zh-CN-YunxiNeural', '云希 · 男 · 少年'],
    ['zh-CN-YunjianNeural', '云健 · 男 · 沉稳'],
    ['zh-CN-liaoning-XiaobeiNeural', '晓北 · 女 · 东北腔'],
  ];

  function extCfgPath(root, which) {
    const f = EXT_CFG_FILES[String(which || '')];
    if (!f || !root) return '';
    return join(root, '.qqbot-extensions', f);
  }

  function readExtCfg(p) {
    try {
      if (!p || !existsSync(p)) return {};
      const o = JSON.parse(readFileSync(p, 'utf8'));
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch { return {}; }
  }

  // 探一下 Ollama（1.5 秒超时，探不到不算错，只是前端显示"离线"）
  async function probeOllama(cfg) {
    const base = String((cfg && cfg.baseUrl) || 'http://127.0.0.1:11434').replace(/\\/+$/, '');
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, 1500);
    try {
      const r = await fetch(base + '/api/tags', { signal: ac.signal });
      const j = await r.json();
      const models = ((j && j.models) || []).map((m) => String((m && m.name) || '')).filter(Boolean);
      return { up: true, baseUrl: base, models };
    } catch (e) {
      return { up: false, baseUrl: base, models: [], error: String((e && e.message) || e) };
    } finally { clearTimeout(timer); }
  }

  route(ctx, 'GET', '/api/qqbot-settings/ext-config', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const which = String(u.searchParams.get('which') || 'local');
      if (!EXT_CFG_FILES[which]) return writeJson(res, 400, { ok: false, error: 'which 只能是 local 或 voice' });
      const bot = nsBot(NSQ(u));
      const root = resolveMemoryRoot(bot);
      const p = extCfgPath(root, which);
      const config = readExtCfg(p);
      const payload = { ok: true, which, root, path: p, exists: !!(p && existsSync(p)), config };
      if (which === 'local') payload.ollama = await probeOllama(config);
      if (which === 'voice') payload.voices = EXT_VOICES.map(([id, label]) => ({ id, label }));
      return writeJson(res, 200, payload);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  route(ctx, 'POST', '/api/qqbot-settings/ext-config', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const which = String((body && body.which) || 'local');
      if (!EXT_CFG_FILES[which]) return writeJson(res, 400, { ok: false, error: 'which 只能是 local 或 voice' });
      const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : null;
      if (!patch) return writeJson(res, 400, { ok: false, error: '缺 patch' });
      const bot = nsBot(String((body && body.ns) || ''));
      const root = resolveMemoryRoot(bot);
      const p = extCfgPath(root, which);
      if (!p) return writeJson(res, 400, { ok: false, error: '找不到数据目录' });
      const cur = readExtCfg(p);
      const next = Object.assign({}, cur, patch);
      // 这几个键永远不让空串覆盖成 ""：留空=用内置默认
      for (const k of ['systemPrompt', 'model', 'voice', 'baseUrl']) {
        if (next[k] === '') delete next[k];
      }
      try {
        if (existsSync(p)) writeFileSync(p + '.bak-' + Date.now(), readFileSync(p, 'utf8'), 'utf8');
      } catch { /* 备份失败不影响主流程 */ }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
      const out = { ok: true, which, path: p, config: readExtCfg(p) };
      if (which === 'local') out.ollama = await probeOllama(out.config);
      return writeJson(res, 200, out);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

`;

const argv = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);

if (!existsSync(F)) { log(`✗ 文件不存在: ${F}`); process.exit(1); }
if (argv.has('--revert')) {
  if (!existsSync(ORIG)) { log('✗ 没有备份'); process.exit(1); }
  copyFileSync(ORIG, F); log('已还原'); process.exit(0);
}

const src = readFileSync(F, 'utf8');
if (src.includes(MARK)) { log('= 已经加过了，跳过。'); process.exit(0); }
const at = src.indexOf(ANCHOR);
if (at < 0) { log('✗ 找不到锚点（memory 路由），放弃'); process.exit(1); }
log(`  ✓ 锚点在字符偏移 ${at}`);

if (argv.has('--check')) { log('\n(--check) 未写入'); process.exit(0); }
if (!existsSync(ORIG)) { copyFileSync(F, ORIG); log(`备份: ${ORIG}`); }

const out = src.slice(0, at) + BLOCK + src.slice(at);
writeFileSync(F, out, 'utf8');

log('写入完成，语法自检…');
try {
  execFileSync(process.execPath, ['--check', F], { stdio: 'inherit' });
  log('语法 OK');
} catch {
  copyFileSync(ORIG, F);
  log('✗ 语法失败 → 已回滚');
  process.exit(1);
}
log('\n加好了。**重启宿主后**可用：');
log('  GET  /api/qqbot-settings/ext-config?which=local');
log('  POST /api/qqbot-settings/ext-config  {"which":"voice","patch":{"mode":"off"}}');
