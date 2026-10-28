#!/usr/bin/env node
/**
 * digest-run.mjs — 手动跑「历史消息 → 切片 → 印象卡」
 *
 * 浮窗里的「重建」按钮走的是同一条链路（hooks/memory-panel.mjs → profile-digest），
 * 但这个脚本方便在没有开浮窗 / 想先看结果时直接跑：
 *
 *   node qqbot-mod/scripts/digest-run.mjs                 # 只整理主人（最活跃私聊）
 *   node qqbot-mod/scripts/digest-run.mjs --all --limit 3 # 主人 + 活跃的人
 *   node qqbot-mod/scripts/digest-run.mjs --sender=<id> --force
 *
 * 依赖本机 Ollama（memory-config.json 里 memoryAgent.model；缺省用 local-llm 默认模型）。
 */
import { digestPerson, digestAll, listTargets, pickOwner } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/profile-digest.mjs';
import { loadConfig } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/memory.mjs';

const ROOT = process.env.QQBOT_MEMORY_DATA_ROOT || 'F:/qqbot/dshqqbot';
const args = process.argv.slice(2);
const val = (name) => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : '';
};

const cfg = loadConfig(ROOT) || {};
const force = args.includes('--force');
const limit = Number(val('--limit')) || 3;
const sender = String(val('--sender') || '').trim();

if (sender) {
  const r = await digestPerson({ dataRoot: ROOT, senderId: sender, cfg, force });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (args.includes('--all')) {
  const r = await digestAll({ dataRoot: ROOT, cfg, limit, force });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

const owner = pickOwner(ROOT);
const targets = listTargets(ROOT, { limit: 5 });
console.log('数据根：', ROOT);
console.log('可整理：', targets.map((t) => `${t.name}${t.isOwner ? '(主人)' : ''} ${t.msgs}条`).join(' / ') || '(无)');
if (!owner) { console.error('找不到主人（没有私聊记录）'); process.exit(1); }
const r = await digestPerson({ dataRoot: ROOT, senderId: owner, cfg, force });
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
