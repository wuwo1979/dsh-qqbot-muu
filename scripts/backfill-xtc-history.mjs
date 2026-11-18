#!/usr/bin/env node
// 把从手表 App 内存里抓到的会话历史（tmp/xtc-history.json）补进 chat 台账。
// 用法: node scripts/backfill-xtc-history.mjs [--file tmp/xtc-history.json] [--dry-run]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');
const DATA_ROOT = process.env.QQBOT_MEMORY_DATA_ROOT || join(REPO, 'dshqqbot');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.indexOf('--file');
const file = resolve(REPO, fileArg >= 0 ? args[fileArg + 1] : 'tmp/xtc-history.json');

const { appendChat } = await import(pathToFileURL(join(REPO, 'dshqqbot', '.qqbot-extensions', 'lib', 'chatlog-db.mjs')).href);
const personLink = await import(pathToFileURL(join(REPO, 'dshqqbot', '.qqbot-extensions', 'lib', 'person-link.mjs')).href);

const payload = JSON.parse(readFileSync(file, 'utf8'));
const items = payload.filter((x) => x.t === 'item' && x.d).map((x) => x.d);
items.sort((a, b) => Number(a.createTime) - Number(b.createTime));

const kindOf = (msgType) => {
  const n = Number(msgType);
  if (n === 1) return 'text';
  if (n === 3) return 'voice';
  if (n === 6) return 'image';
  if (n === 2) return 'image';
  return 'other';
};

let wrote = 0;
let skipped = 0;
for (const it of items) {
  const peer = String(it.dialogId || '').trim();
  if (!peer) { skipped += 1; continue }
  const scope = personLink.scopeFor(DATA_ROOT, 'xtc', peer);
  const out = Number(it.state) === 2;
  const kind = kindOf(it.msgType);
  const text = String(it.content || '').trim() || (kind === 'image' ? '[图片]' : kind === 'voice' ? '[语音]' : '');
  if (!text) { skipped += 1; continue; }
  const row = {
    scope,
    ts: Number(it.createTime) || Date.now(),
    dir: out ? 'out' : 'in',
    senderId: out ? 'self' : String(it.dialogId || ''),
    sender: out ? '小蓝' : '小朋友',
    kind,
    text,
    media: (kind === 'image' || kind === 'voice') ? 'watch' : '',
    msgId: String(it.msgId || `xtc-${it.id}`),
    src: 'xtc-history',
  };
  if (dryRun) { console.log('[dry]', row.ts, row.dir, kind, text.slice(0, 50)); wrote += 1; continue; }
  const ok = appendChat(DATA_ROOT, row);
  if (ok) wrote += 1; else skipped += 1;
}

console.log(`${dryRun ? '[dry-run] ' : ''}历史 ${items.length} 条：写入 ${wrote}，跳过 ${skipped}`);
