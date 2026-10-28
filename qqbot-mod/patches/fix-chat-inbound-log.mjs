// fix-chat-inbound-log.mjs —— 聊天页补一个来源：插件自己的入站台账 msg-content.jsonl
//
// 为什么：聊天页原来只读 session-registry（进程内）。旧会话 / 换过 id 的私聊在注册表里没有，
//         面板就一条都看不到。插件其实一直在写 {dataRoot}/.qqbot/msg-content.jsonl
//         （p=peer键 group:<gid>/c2c:<openid>、at=时间、s=发送者、n=昵称、t=正文、imgs=图片）。
//         这里把它并进 chat/history。
//
// 用法：
//   node patches/fix-chat-inbound-log.mjs --check
//   node patches/fix-chat-inbound-log.mjs --apply
//   node patches/fix-chat-inbound-log.mjs --revert

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN, IS_LIVE, announce } from './plugin-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const Q = String.fromCharCode(39);
const MARK = '[qqbot-mod] chat-inbound-log';

const TARGET = join(PLUGIN, 'settings-host.js');
const BACKUP = join(HERE, '..', 'backups', 'settings-host.js.orig-chatlog');

const args = new Set(process.argv.slice(2));
const MODE = args.has('--apply') ? 'apply' : args.has('--revert') ? 'revert' : 'check';

const ANCHOR =
  '      writeJson(res, 200, { ok: true, items, hasMore: !reachedEnd, tailSeq: sess.seq, debug: diag });';

function q(s) {
  return Q + s + Q;
}
function L(arr) {
  return arr.join(LF);
}

function buildBlock() {
  return L([
    '      // ' + MARK + '：并入插件自己的入站台账（跨会话、跨重启都在），补「聊天页看不到消息」的缺口',
    '      try {',
    '        const _mb = root ? join(root, ' + q('.qqbot') + ', ' + q('msg-content.jsonl') + ') : ' + q('') + ';',
    '        if (_mb && existsSync(_mb)) {',
    '          const _want = String(scope) + ' + q(':') + ' + String(peerId);',
    '          const _stripInj = (s) => {',
    '            let t = String(s || ' + q('') + ');',
    '            for (const tag of [' + q('记忆') + ', ' + q('设定') + ']) {',
    '              const open = ' + q('[') + ' + tag + ' + q(']') + ';',
    '              const close = ' + q('[/') + ' + tag + ' + q(']') + ';',
    '              let guard = 0;',
    '              while (t.indexOf(open) >= 0 && guard < 6) {',
    '                const a = t.indexOf(open);',
    '                const b = t.indexOf(close, a);',
    '                if (b < 0) { t = t.slice(0, a); break; }',
    '                t = t.slice(0, a) + t.slice(b + close.length);',
    '                guard += 1;',
    '              }',
    '            }',
    '            const cut = t.indexOf(' + q('[别重复]') + ');',
    '            if (cut >= 0) {',
    '              const nl = t.indexOf(String.fromCharCode(10), cut);',
    '              t = t.slice(0, cut) + (nl >= 0 ? t.slice(nl) : ' + q('') + ');',
    '            }',
    '            return t.trim();',
    '          };',
    '          const _rows = readFileSync(_mb, ' + q('utf8') + ').split(String.fromCharCode(10)).filter(Boolean).slice(-4000);',
    '          const _in = [];',
    '          for (const line of _rows) {',
    '            let o = null;',
    '            try { o = JSON.parse(line); } catch { continue; }',
    '            if (!o || String(o.p || ' + q('') + ') !== _want) continue;',
    '            const text = _stripInj(o.t);',
    '            const imgs = Array.isArray(o.imgs) ? o.imgs.filter(Boolean) : [];',
    '            if (!text && !imgs.length) continue;',
    '            _in.push({',
    '              seq: 0,',
    '              time: Number(o.at) || 0,',
    '              dir: ' + q('in') + ',',
    '              sender: String(o.n || o.s || ' + q('群友') + '),',
    '              text,',
    '              images: imgs.map((x) => ({ url: String(x), kind: ' + q('image') + ' })),',
    '              tag: ' + q('') + ',',
    '            });',
    '          }',
    '          if (_in.length) {',
    '            const _seen = new Set();',
    '            const _merged = [];',
    '            for (const it of [...items, ..._in]) {',
    '              const key = String(it.time) + ' + q('|') + ' + String(it.dir) + ' + q('|') + ' + String(it.text || ' + q('') + ').slice(0, 40);',
    '              if (_seen.has(key)) continue;',
    '              _seen.add(key);',
    '              _merged.push(it);',
    '            }',
    '            _merged.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));',
    '            items = _merged.slice(-limit);',
    '            if (diag && typeof diag === ' + q('object') + ') diag.inboundLog = _in.length;',
    '          }',
    '        }',
    '      } catch { /* 台账读失败不影响主路径 */ }',
    ANCHOR,
  ]);
}

function main() {
  if (!existsSync(TARGET)) {
    console.error('找不到 ' + TARGET);
    process.exit(1);
  }
  if (MODE === 'revert') {
    if (!existsSync(BACKUP)) {
      console.error('没有备份：' + BACKUP);
      process.exit(1);
    }
    copyFileSync(BACKUP, TARGET);
    console.log('已回滚 ' + TARGET);
    return;
  }

  const raw = readFileSync(TARGET, 'utf8');
  const eol = raw.indexOf(CR + LF) >= 0 ? CR + LF : LF;
  const src = raw.split(CR).join('').split(LF).join(eol);

  announce('settings-host.js', IS_LIVE);
  if (src.includes(MARK)) {
    console.log('  · 已应用（跳过）');
    return;
  }
  const count = src.split(ANCHOR).length - 1;
  if (count !== 1) {
    console.log('  ✗ 锚点不唯一（' + count + '）');
    process.exit(1);
  }
  if (MODE === 'check') {
    console.log('  ○ 可打：并入驻站台账来源');
    console.log('检查完成（加 --apply 落盘）');
    return;
  }
  const out = src.replace(ANCHOR, buildBlock());
  if (!existsSync(BACKUP)) {
    copyFileSync(TARGET, BACKUP);
    console.log('已备份 → ' + BACKUP);
  }
  writeFileSync(TARGET, out, 'utf8');
  console.log('  ✓ 并入驻站台账来源');
  console.log('已写入 ' + TARGET + '（' + out.length + ' 字符）');
}

main();
