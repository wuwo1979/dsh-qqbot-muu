#!/usr/bin/env node
/**
 * qq-import.mjs — 历史 QQ 聊天记录导入 CLI
 *
 * 两种用法，差别很大，先想清楚要哪种：
 *
 *   A. 只提炼记忆（默认）
 *      把记录里"像事实/态度/承诺"的句子筛出来，按人写进 person:<id> 的记忆库。
 *      寒暄会被丢掉，原话不留——省空间，也省隐私。
 *
 *   B. 完整归档（--archive）
 *      把**整段对话原样**写进聊天台账（chat 表），不筛信息量、不砍长消息。
 *      记忆分身、历史印象归纳（digest）、"那晚到底聊了什么"都要靠这份。
 *      加上 --digest 会顺带用本地模型重建一次高维印象卡。
 *
 * 只想导入和某一个人的对话：
 *   --peer 123456789        按 QQ 号（精确，不会和同昵称的人串号）
 *   --self-uin 987654321    自己的号；不给的话，1v1 导出靠发言人数量猜，
 *                           群导出会提示 needSelfUin（只留对方的话）
 *
 * 用法：
 *   node qqbot-mod/scripts/qq-import.mjs --file 聊天记录.txt --peer 123456789 --self-uin 987654321 --dry-run
 *   node qqbot-mod/scripts/qq-import.mjs --file 聊天记录.txt --peer 123456789 --self-uin 987654321 --archive --digest
 *   node qqbot-mod/scripts/qq-import.mjs --file 聊天记录.txt --data-root "D:/qqbot-data" --limit 400
 */

import { resolve } from 'node:path';
import { openSync, readSync, closeSync } from 'node:fs';

const LIB = '../../dshqqbot/.qqbot-extensions/lib/';
const { importHistory, archiveScopeOf } = await import(LIB + 'qq-history-import.mjs');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const has = (n) => process.argv.includes('--' + n);
const multi = (n) => process.argv.reduce((acc, x, i) => (x === '--' + n && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? [...acc, process.argv[i + 1]] : acc), []);

const file = arg('file');
const raw = arg('raw');
const dataRoot = resolve(arg('data-root', process.cwd()));
const groupId = arg('group-id', '');
const peer = arg('peer', '');
const peerOpenid = arg('peer-openid', '');
const selfUin = arg('self-uin', '');
const selfLabel = arg('self-label', '我');
const limit = Number(arg('limit', '400'));
const minScore = Number(arg('min-score', '0.55'));
const scopeMode = arg('scope-mode', 'person');
const scope = arg('scope', '');
const archiveMaxChars = Number(arg('archive-max-chars', '2000'));
const dryRun = has('dry-run');
const noMask = has('no-mask');
const archive = has('archive');
const wantDigest = has('digest');

if (!file && !raw) {
  console.log(`用法:
  node qq-import.mjs --file <聊天记录.txt|.json> [--dry-run]
     [--data-root DIR] [--group-id 群号] [--limit 400] [--min-score 0.55]
     [--peer QQ号|昵称] [--peer-openid 对方openid] [--self-uin 自己的QQ号] [--self-label 我]
     [--archive] [--scope 会话scope] [--archive-max-chars 2000] [--digest]
     [--scope-mode person|group] [--no-mask]

先 --dry-run 看报告，确认筛得对 / 裁得对再真写。

  --peer       只导入与这个人的对话（QQ 号最准；昵称可能撞名）
  --self-uin   自己的 QQ 号，用来把"我"和"对方"分开；群导出建议一定给
  --archive    把完整对话原样写进聊天台账（记忆分身/历史印象要用）
  --digest     归档后用本地模型重建一次这个人/这段关系的高维印象卡`);
  process.exit(1);
}

// QQ 手机/PC 的「聊天记录备份」.bak 其实是 ZIP：里面 db/* 是加密 SQLite（头 16 字节后是 MSG0），
// 没有 QQ 的密钥就无法解成消息；直接交给 txt 解析器只会报“没有可解析的消息”。
// 这里提前拦住并给出去路，避免用户以为导入成功。
if (file && /\.bak$/i.test(file)) {
  let magic = Buffer.alloc(4);
  try {
    const fd = openSync(file, 'r');
    readSync(fd, magic, 0, 4, 0);
    closeSync(fd);
  } catch {}
  const isZip = magic[0] === 0x50 && magic[1] === 0x4b;
  console.error(isZip
    ? '.bak 是 QQ 的加密备份（ZIP 包，内部 db/* 是 MSG0 私有格式），不是 txt/json。\n'
      + '现有导入器不能解密它。请任选一种：\n'
      + '  1) QQ 里「消息管理器 → 导出消息记录」导出 .txt，再 --file 导入；\n'
      + '  2) 用 QQ 备份解密工具解出 db 后，导出成 txt/json 再导入；\n'
      + '  3) 如果确定 .bak 没有加密（极少见），先解压，把里面的 txt/json 指给 --file。'
    : '.bak 文件头不是 ZIP，读不出格式；请确认文件完整，或改用 QQ 导出的 txt/json。');
  process.exit(2);
}

if (noMask) {
  console.log('⚠️  已关闭脱敏：手机号/身份证等会原样入库，仅在你完全确定数据只在本地时使用。');
}

let digest = null;
if (wantDigest && !dryRun) {
  const { loadConfig } = await import(LIB + 'memory.mjs');
  const { digestPerson } = await import(LIB + 'profile-digest.mjs');
  const cfg = loadConfig(dataRoot);
  digest = async ({ senderId, scope: sc, force }) => {
    const r = await digestPerson({ dataRoot, senderId, scope: '', cfg, force });
    return { ok: !!r.ok, card: r.card ? String(r.card).slice(0, 120) : '', reason: r.reason || '', msgs: r.msgs || 0, scope: sc };
  };
}

const r = await importHistory({
  file: file || '',
  raw: raw || '',
  dataRoot,
  groupId,
  peer,
  personScope: peerOpenid ? 'qq:' + peerOpenid.replace(/^qq:/, '') : '',
  selfUin,
  selfLabel,
  selfNames: multi('self-name'),
  archive,
  scope,
  archiveMaxChars,
  digest,
  limit,
  minScore,
  scopeMode,
  dryRun,
  mask: !noMask,
});

if (!r.ok) {
  const hint = {
    'peer-not-found': '文件里找不到这个人。QQ 号对不对？导出的是不是这个人的会话？',
    'archive-needs-scope': '--archive 需要能确定会话：给 --peer（QQ号）或 --scope c2c:<openid>。',
  }[String(r.error || '').split(':')[0]];
  console.error('导入失败：', r.error || '(未知)');
  if (hint) console.error('提示：', hint);
  process.exit(1);
}

console.log(`格式       ${r.format}`);
console.log(`解析消息   ${r.parsed} 条`);
if (r.peer) {
  console.log(`指定对话   ${r.peer}  → 相关 ${r.filtered} 条（其中"我" ${r.selfSkipped} 条）`);
  if (r.needSelfUin) console.log('⚠️  没能认出"我"，且文件里有多个发言人：只保留了对方的发言。补 --self-uin 可保留完整对话。');
}
console.log(`留下有效   ${r.kept} 条  （筛掉 ${Math.max(0, r.filtered - r.kept)} 条寒暄/占位）`);
console.log(`涉及人物   ${r.people} 人`);
if (r.masked) console.log(`脱敏改写   ${r.masked} 条`);
if (archive) {
  console.log(`完整归档   ${r.archived} 条 → ${r.archiveScope}${r.archiveDup ? `（重复跳过 ${r.archiveDup}）` : ''}`);
  if (r.archiveError) console.log(`归档异常   ${r.archiveError}`);
}
if (!r.dryRun) {
  console.log(`新增记忆   ${r.added} 条，命中已有 ${r.deduped} 条，失败 ${r.failed} 条`);
  if (r.profile) console.log(`生成画像   ${r.profile} 条`);
}
if (r.pair) {
  console.log(`\n双方画像（写入 ${r.peer || ''} 的 person 记忆，kind=relation）：\n  ${r.pair}`);
}
if (r.digest) {
  console.log(`\n历史印象   ${r.digest.ok ? '已重建' : '未重建（' + (r.digest.reason || '原因未知') + '）'}${r.digest.card ? '\n  ' + r.digest.card : ''}`);
}
if (r.samples?.length) {
  console.log('\n样例（确认一下筛得对不对）：');
  for (const s of r.samples) {
    console.log(`  ${s.personId}  （${s.n} 条）`);
    for (const e of s.examples) console.log(`    · ${e}`);
  }
}
if (r.dryRun) console.log('\n这是 dry-run，没有写库。去掉 --dry-run 才会真正入库。');
console.log(`\n耗时 ${r.ms} ms`);
