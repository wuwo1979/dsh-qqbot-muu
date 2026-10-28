#!/usr/bin/env node
/**
 * chatlog-maintain.mjs — 聊天台账 / 记忆分身 的运维入口（手动跑，不进聊天链路）
 *
 * 用法：
 *   node scripts/chatlog-maintain.mjs stats
 *   node scripts/chatlog-maintain.mjs ingest
 *   node scripts/chatlog-maintain.mjs search group:xxxx 年糕
 *   node scripts/chatlog-maintain.mjs prune            # 只看会删多少（不删）
 *   node scripts/chatlog-maintain.mjs prune --apply    # 真删（按 chatlog.retentionDays / capPerScope）
 *   node scripts/chatlog-maintain.mjs agent group:xxxx # 手动跑一次本地记忆分身（会调 Ollama）
 *
 * 根目录：默认 F:/qqbot/dshqqbot，可用 --root 指定。
 */

const args = process.argv.slice(2);
let root = 'F:/qqbot/dshqqbot';
const ri = args.indexOf('--root');
if (ri >= 0 && args[ri + 1]) { root = args[ri + 1]; args.splice(ri, 2); }
let outFile = 'F:/qqbot/两段会话消息.md';
const oi = args.indexOf('--out');
if (oi >= 0 && args[oi + 1]) { outFile = args[oi + 1]; args.splice(oi, 2); }
const apply = args.includes('--apply');
const cmd = (args.find((a) => !a.startsWith('-')) || 'help').toLowerCase();
const rest = args.filter((a) => !a.startsWith('-') && a !== cmd);

const url = await import('node:url');
const FACADE_URL = url.pathToFileURL('F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory.mjs').href;
const AGENT_URL = url.pathToFileURL('F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory-agent.mjs').href;

const M = await import(FACADE_URL);

function help() {
  console.log(`聊天台账 / 记忆分身运维

  node scripts/chatlog-maintain.mjs stats
  node scripts/chatlog-maintain.mjs ingest
  node scripts/chatlog-maintain.mjs search <scope> <关键词>
  node scripts/chatlog-maintain.mjs prune [--apply]
  node scripts/chatlog-maintain.mjs agent <scope>
  node scripts/chatlog-maintain.mjs export [scope] [--out 文件]

  可选：--root <数据根>   （默认 ${root}）
  后端：${M.backendName}（${M.backendNote}）`);
}

if (cmd === 'stats' || cmd === 'help') {
  if (cmd === 'help') help();
  const s = M.chatStats(root);
  console.log('后端:', s.backend, s.file);
  console.log('总条数:', s.total);
  for (const x of s.scopes || []) {
    console.log(`  ${x.scope}  ${x.total} 条  ${new Date(x.first).toLocaleString()} → ${new Date(x.last).toLocaleString()}`);
  }
} else if (cmd === 'ingest') {
  const r = M.ingestChatHistory(root, {});
  console.log('导入结果:', JSON.stringify(r));
  const s = M.chatStats(root);
  console.log('当前总数:', s.total);
} else if (cmd === 'search') {
  const [scope, ...q] = rest;
  if (!scope || !q.length) { console.error('用法: search <scope> <关键词>'); process.exit(1); }
  const rows = M.searchChat(root, scope, q.join(' '), 20);
  for (const r of rows) {
    const who = r.dir === 'out' ? '小蓝' : (r.sender || '群友');
    console.log(`[${new Date(r.ts).toLocaleString()}] ${who}: ${r.text || '[' + r.kind + ']'}`);
  }
  console.log(`命中 ${rows.length} 条`);
} else if (cmd === 'prune') {
  const cfg = M.loadConfig(root);
  const c = { ...(cfg.chatlog || {}) };
  if (!apply) {
    const s = M.chatStats(root);
    console.log('当前总数:', s.total);
    console.log(`将按 retentionDays=${c.retentionDays || 60} / capPerScope=${c.capPerScope || 8000} 清理；加 --apply 才会真删。`);
  } else {
    const r = M.pruneChat(root, c);
    console.log('清理结果:', JSON.stringify(r));
    console.log('清理后总数:', M.chatStats(root).total);
  }
} else if (cmd === 'export') {
  const only = rest[0] || '';
  const fs = await import('node:fs');
  let rows = [];
  try {
    // 先增量同步一遍：顺带触发历史行的清洗与昵称回填迁移
    try { M.ingestChatHistory(root, {}); } catch (e) { console.warn('增量同步失败(继续导出):', e.message); }
    const h = M.openDb(root);
    rows = h.db.prepare(
      'SELECT scope, ts, dir, sender_id, sender, kind, text FROM chat WHERE (? = \'\' OR scope = ?) ORDER BY scope ASC, ts ASC, rowid ASC',
    ).all(only, only);
  } catch (e) { console.error('读库失败:', e.message); process.exit(1); }

  const looksLikeId = (s) => {
    const t = String(s || '').trim();
    return t.length >= 16 && !/[\u4e00-\u9fa5]/.test(t) && /^[A-Za-z0-9_-]+$/.test(t);
  };
  const generic = new Set(['对方', '群友', '小蓝']);
  // 私聊没有昵称：从群聊里同一 openid 反查一个名字出来
  const nameMap = new Map();
  for (const r of rows) {
    const id = String(r.sender_id || '').trim();
    const name = String(r.sender || '').trim();
    if (!id || !name || generic.has(name) || looksLikeId(name)) continue;
    if (!nameMap.has(id)) nameMap.set(id, name);
  }

  const noise = (text) =>
    text.startsWith('❌ 工具') || text.startsWith('🔧 ') || text.startsWith('（已中断') || text.startsWith('❌ 绘图失败');
  const kindLabel = (k) => ({ image: '图片', voice: '语音', video: '视频', file: '文件', face: '表情' })[String(k || '')] || '非文本';

  const byScope = new Map();
  let noiseCount = 0;
  let dupCount = 0;
  let emptyCount = 0;
  for (const r of rows) {
    const text = M.cleanChatText(r.text);
    if (noise(text)) { noiseCount += 1; continue; }
    if (!text && String(r.kind || 'text') === 'text') { emptyCount += 1; continue; }
    if (!byScope.has(r.scope)) byScope.set(r.scope, []);
    byScope.get(r.scope).push({ ...r, cleaned: text });
  }

  const p2 = (n) => String(n).padStart(2, '0');
  const dstr = (ts) => {
    const d = new Date(Number(ts) || 0);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  const fmt = (ts) => {
    const d = new Date(Number(ts) || 0);
    return `${dstr(ts)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };

  const shown = [...byScope.values()].reduce((n, l) => n + l.length, 0);
  const lines = [
    '# QQ 聊天会话导出',
    '',
    `- 导出时间：${new Date().toLocaleString()}`,
    `- 数据根：${root}`,
    `- 会话数：${byScope.size}`,
    `- 消息数：${shown}（已过滤工具播报 ${noiseCount} 条、空正文 ${emptyCount} 条）`,
    '',
    '> 由 memory.db 的 `chat` 表导出；`小蓝` 为机器人自己，其余为群友/私聊对象。',
    '',
    '> 注入块（记忆/设定/印象/状态/别重复）已在入库和导出时各清洗一次。',
    '',
  ];
  for (const [scope, list] of byScope) {
    const title = scope.startsWith('group:') ? '群聊' : scope.startsWith('c2c:') ? '私聊' : '会话';
    lines.push(`## ${title} · ${scope}（${list.length} 条）`, '');
    let lastDay = '';
    let lastKey = '';
    for (const r of list) {
      const day = dstr(r.ts);
      if (day !== lastDay) {
        lines.push(`### ${day}`, '');
        lastDay = day;
      }
      const key = `${r.ts}|${r.dir}|${r.cleaned}`;
      if (key === lastKey) { dupCount += 1; continue; }
      lastKey = key;
      let who = r.dir === 'out' ? '小蓝' : String(r.sender || '').trim();
      if (!who || (who !== '小蓝' && generic.has(who)) || looksLikeId(who)) {
        who = nameMap.get(String(r.sender_id || '').trim()) || (scope.startsWith('c2c:') ? '对方' : '群友');
      }
      const text = r.cleaned || `[${kindLabel(r.kind)}]`;
      lines.push(`**${fmt(r.ts)} · ${who}**：${text}`, '');
    }
  }
  if (dupCount) lines.push('', `> 已跳过完全重复的消息 ${dupCount} 条。`);
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  console.log(`已导出 ${shown} 条 / ${byScope.size} 个会话 → ${outFile}`);
  console.log(`过滤：工具播报 ${noiseCount} 条、空正文 ${emptyCount} 条、完全重复 ${dupCount} 条`);
  const leftover = lines.join('\n').match(/\[(记忆|设定|印象|状态|别重复)\]/g);
  if (leftover) console.warn(`⚠ 导出文件里仍有 ${leftover.length} 处注入标签，请检查清洗规则`);
} else if (cmd === 'agent') {
  const scope = rest[0];
  if (!scope) { console.error('用法: agent <scope>'); process.exit(1); }
  const { runTurnAgent } = await import(AGENT_URL);
  const r = await runTurnAgent({ dataRoot: root, scope, cfg: M.loadConfig(root) });
  console.log('整理结果:', JSON.stringify(r, null, 2));
} else {
  help();
  process.exit(1);
}
