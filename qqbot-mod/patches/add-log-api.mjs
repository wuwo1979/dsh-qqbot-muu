#!/usr/bin/env node
/**
 * add-log-api.mjs —— 给面板加一条「本地代答判定日志」只读接口
 *
 * 为什么需要：用户实测反馈"本地小模型似乎没有生效"，而界面上**什么都看不出来**。
 *   local-answer.mjs 现在把每次判定写进 `{数据根}/.qqbot/local-answer-log.jsonl`
 *   （by=local|gag|cloud、why=挡在哪道门、model、ms）。面板读这条接口显示"最近判定"。
 *
 * 用法：
 *   node qqbot-mod/patches/add-log-api.mjs --check     # 只看能不能打
 *   node qqbot-mod/patches/add-log-api.mjs --apply     # 打（需 danger-full-access）
 *   node qqbot-mod/patches/add-log-api.mjs --revert    # 回滚
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLUGIN } from './plugin-dir.mjs';

const EOL = '\r\n';
const FILE = join(PLUGIN, 'settings-host.js');
const BACKUP = join('F:/qqbot/qqbot-mod/backups', 'settings-host.js.orig-answerlog');

const ANCHOR = "  route(ctx, 'GET', '/api/qqbot-settings/memory', async (req, res) => {";

const BLOCK = [
  "  // ★ 本机新增(2026-10-23): 本地代答判定日志（面板「最近判定」用它）",
  "  //   每条消息一行：by=local|gag|cloud，why=被哪道门挡了，model / ms。",
  "  route(ctx, 'GET', '/api/qqbot-settings/ext-answer-log', async (req, res) => {",
  "    try {",
  "      const u = new URL(req.url ?? '/', 'http://x');",
  "      const limit = Math.max(1, Math.min(50, Number(u.searchParams.get('limit') || 8) || 8));",
  "      const bot = nsBot(NSQ(u));",
  "      const root = resolveMemoryRoot(bot);",
  "      const p = root ? join(root, '.qqbot', 'local-answer-log.jsonl') : '';",
  "      let rows = [];",
  "      if (p && existsSync(p)) {",
  "        const lines = readFileSync(p, 'utf8').split('\\n').filter(Boolean).slice(-limit);",
  "        rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);",
  "      }",
  "      const localCfg = readExtCfg(extCfgPath(root, 'local'));",
  "      return writeJson(res, 200, {",
  "        ok: true, root, path: p, count: rows.length, rows,",
  "        whoAnswers: String(localCfg.whoAnswers || 'simple'),",
  "        model: String(localCfg.model || ''),",
  "      });",
  "    } catch (e) {",
  "      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });",
  "    }",
  "  });",
  "",
  "",
].join(EOL);

const MARK = 'ext-answer-log';

function main() {
  const mode = process.argv.includes('--apply') ? 'apply'
    : process.argv.includes('--revert') ? 'revert' : 'check';

  if (!existsSync(FILE)) {
    console.error('找不到 settings-host.js: ' + FILE);
    process.exit(2);
  }

  if (mode === 'revert') {
    if (!existsSync(BACKUP)) {
      console.error('没有备份可回滚: ' + BACKUP);
      process.exit(2);
    }
    copyFileSync(BACKUP, FILE);
    console.log('已回滚 ' + FILE);
    return;
  }

  const src = readFileSync(FILE, 'utf8');
  const norm = src.split('\n').join(EOL);

  if (src.includes(MARK)) {
    console.log('[已应用] 判定日志接口已在文件里，无需重复打');
    return;
  }

  if (!norm.includes(ANCHOR)) {
    console.error('[未匹配] 找不到锚点：' + ANCHOR.trim().slice(0, 60));
    process.exit(3);
  }

  const out = norm.replace(ANCHOR, BLOCK + ANCHOR);

  if (mode === 'check') {
    console.log('[可打] 将在 memory 路由前插入 ext-answer-log 路由（约 ' + BLOCK.length + ' 字符）');
    return;
  }

  mkdirSync(dirname(BACKUP), { recursive: true });
  if (!existsSync(BACKUP)) writeFileSync(BACKUP, src, 'utf8');
  writeFileSync(FILE, out, 'utf8');
  console.log('[已应用] 写入 ' + FILE);
  console.log('  备份: ' + BACKUP);
  console.log('  下一步: node --check 该文件；然后重启 DSH 桌面端让路由注册');
}

main();
