#!/usr/bin/env node
/**
 * add-memory-view.mjs — 给「三层记忆 + 分流」加一个只读观察出口
 *
 * 为什么：记忆和分流默认没有任何界面，写了也看不见。
 *   这里不动现有 UI，只在 settings-host.js 里加一条只读路由：
 *     GET /api/qqbot-settings/memory            → JSON
 *     GET /api/qqbot-settings/memory?format=html → 一页可读的表格（自动刷新）
 *
 * 安全性：纯读文件，不写任何东西；不注册到面板，不会影响现有按钮。
 *
 * 用法：node add-memory-view.mjs [--check|--revert]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { pluginPath } from './plugin-dir.mjs';
const F = pluginPath('settings-host.js');
const ORIG = F + '.orig-memview';
const MARK = '本机新增(2026-10-22): 记忆库 / 分流观察页';
const ANCHOR = "route(ctx, 'GET', '/api/qqbot-settings/affinity', async (req, res) => {";

const BLOCK = `  // ★ ${MARK}
  //   三层记忆与 router-log 默认没有界面，写了也看不见。这里只加一条【只读】路由：
  //     /api/qqbot-settings/memory              → JSON
  //     /api/qqbot-settings/memory?format=html  → 一页可读表格（5 秒自动刷新）
  //   不写任何文件、不注册到面板，碰不到现有 UI。
  function resolveMemoryRoot(bot) {
    const cands = [];
    const push = (p) => { const s = String(p || '').trim(); if (s && !cands.includes(s)) cands.push(s); };
    try { push(bot && bot.cfg && bot.cfg.dataRoot); } catch { /* ignore */ }
    try { push(process.env.QQBOT_MEMORY_DATA_ROOT); } catch { /* ignore */ }
    try {
      if (bot && bot.cwd) { push(join(bot.cwd, 'dshqqbot')); push(bot.cwd); }
    } catch { /* ignore */ }
    for (const p of cands) { try { if (existsSync(join(p, '.qqbot'))) return p; } catch { /* ignore */ } }
    return cands[0] || '';
  }

  function escMem(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderMemoryPage(p) {
    const fmt = (ts) => { try { return new Date(ts).toLocaleString('zh-CN'); } catch { return ''; } };
    const scopeBlocks = p.scopes.map((s) => {
      const kinds = Object.entries(s.byKind || {}).map(([k, v]) => k + ':' + v).join(' · ') || '—';
      const rows = s.recent.map((r) => '<tr><td class="k k-' + escMem(r.kind) + '">' + escMem(r.kind) + '</td><td>' + escMem(r.text) + '</td><td class="t">' + escMem(fmt(r.ts)) + '</td></tr>').join('');
      return '<h2>' + escMem(s.scope) + ' <span class="cnt">' + s.total + ' 条</span> <span class="kind">' + escMem(kinds) + '</span></h2>'
        + '<table><thead><tr><th>类型</th><th>内容</th><th>时间</th></tr></thead><tbody>' + (rows || '<tr><td colspan="3" class="empty">（还没有记忆）</td></tr>') + '</tbody></table>';
    }).join('');
    const tierRows = Object.entries(p.router.tiers || {}).map(([k, v]) => '<tr><td>' + escMem(k) + '</td><td>' + v + '</td></tr>').join('');
    const lastRows = (p.router.last || []).map((r) => '<tr><td>' + escMem(fmt(r.ts)) + '</td><td>' + escMem(r.tier) + '</td><td>' + escMem(r.score) + '</td><td>' + (r.mentioned ? '是' : '') + '</td><td>' + escMem(r.len) + '</td></tr>').join('');
    return '<!doctype html><meta charset="utf-8"><title>小蓝 · 记忆与分流</title>'
      + '<style>body{font:13px/1.6 -apple-system,"Segoe UI",sans-serif;background:#f6f7fb;color:#222;margin:0;padding:18px 22px}h1{font-size:17px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 6px}.cnt{color:#2f9e44;font-weight:400}.kind{color:#888;font-weight:400;font-size:12px}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e6ef;border-radius:6px;overflow:hidden}th,td{padding:6px 9px;text-align:left;border-bottom:1px solid #eef0f6;vertical-align:top}th{background:#eef0f8;font-weight:600;font-size:12px}.k{color:#7c6bd6;white-space:nowrap;font-size:12px}.t{color:#999;white-space:nowrap;font-size:12px}.empty{color:#aaa;text-align:center;padding:14px}.bar{color:#666;font-size:12px;margin-top:6px}.root{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#888;word-break:break-all}</style>'
      + '<h1>🧠 小蓝 · 记忆与分流（只读）</h1>'
      + '<div class="bar">数据根：<span class="root">' + escMem(p.root) + '</span> · 记忆目录：<span class="root">' + escMem(p.memDir) + '</span></div>'
      + '<div class="bar">分流样本 ' + p.router.lines + ' 条</div>'
      + (scopeBlocks || '<p class="empty">还没有任何记忆文件 —— 在群里说几句话再看。</p>')
      + '<h2>分流分档分布</h2><table><thead><tr><th>档位</th><th>条数</th></tr></thead><tbody>' + (tierRows || '<tr><td colspan="2" class="empty">（还没有记录）</td></tr>') + '</tbody></table>'
      + '<h2>最近分流判定</h2><table><thead><tr><th>时间</th><th>档</th><th>分值</th><th>@</th><th>字数</th></tr></thead><tbody>' + (lastRows || '<tr><td colspan="5" class="empty">（还没有记录）</td></tr>') + '</tbody></table>'
      + '<div class="bar">页面每 5 秒自动刷新</div>'
      + '<script>setTimeout(function(){location.reload()},5000)</script>';
  }

  route(ctx, 'GET', '/api/qqbot-settings/memory', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(NSQ(u));
      const root = resolveMemoryRoot(bot);
      const memDir = root ? join(root, '.qqbot', 'memory') : '';
      const scopes = [];
      if (memDir && existsSync(memDir)) {
        for (const f of readdirSync(memDir)) {
          if (!f.endsWith('.jsonl') || f.startsWith('_')) continue;
          const items = [];
          try {
            for (const line of readFileSync(join(memDir, f), 'utf8').split('\\n')) {
              if (!line.trim()) continue;
              try { items.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
            }
          } catch { /* 读不到就跳过这个 scope */ }
          const byKind = {};
          for (const it of items) byKind[it.kind || '?'] = (byKind[it.kind || '?'] || 0) + 1;
          scopes.push({
            scope: f.replace(/\\.jsonl$/, ''),
            total: items.length,
            byKind,
            recent: items.slice(-8).reverse().map((it) => ({ kind: it.kind || '', text: String(it.text || '').slice(0, 160), ts: it.ts || 0 })),
          });
        }
      }
      const router = { lines: 0, tiers: {}, last: [] };
      const rl = root ? join(root, '.qqbot', 'router-log.jsonl') : '';
      if (rl && existsSync(rl)) {
        const arr = readFileSync(rl, 'utf8').split('\\n').filter(Boolean).slice(-500);
        router.lines = arr.length;
        for (const l of arr) {
          try { const o = JSON.parse(l); router.tiers[o.tier] = (router.tiers[o.tier] || 0) + 1; } catch { /* ignore */ }
        }
        for (const l of arr.slice(-10).reverse()) {
          try { const o = JSON.parse(l); router.last.push({ tier: o.tier, score: o.score, mentioned: !!o.mentioned, len: (o.s || {}).len, ts: o.ts }); } catch { /* ignore */ }
        }
      }
      const payload = { ok: true, root, memDir, scopes: scopes.sort((a, b) => b.total - a.total), router };
      if (String(u.searchParams.get('format') || '') === 'html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderMemoryPage(payload));
        return;
      }
      return writeJson(res, 200, payload);
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
if (at < 0) { log('✗ 找不到锚点（affinity 路由），放弃'); process.exit(1); }
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
log('\n加好了。**需要重启一次 DSH**，然后打开：');
log('  /api/qqbot-settings/memory?format=html');
