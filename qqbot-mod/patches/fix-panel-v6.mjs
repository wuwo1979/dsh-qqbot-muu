#!/usr/bin/env node
/**
 * fix-panel-v6.mjs — 印象卡按角色档案归并（主人 2026-10-26）
 *
 * 问题：机器人是主人起的 MuU、我们这边叫小蓝，印象栏里却当成两个人；妈妈=妈妈已写在
 * 角色档案里，卡片里又冒出一条"妈妈"，没有归类。
 * 做法（纯 UI，不动数据结构）：
 *   1) 印象卡区块顶部加一行"我是谁 + 档案里认的人"（来自 host 新增的 d.persona）；
 *   2) 卡片/熟识度带 role 或 declared 时，在名字后显示「· 妈妈」这种关系标签，不再重复造名字；
 *   3) 合并数量（d.cardsMerged）用一句灰字说明，免得主人以为卡丢了。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { pluginPath, announce } from './plugin-dir.mjs';

const CLIENT = pluginPath('client/qqbot-settings.js');
const MARK = '[qqbot-mod] impression-v6';

function nl(s) { return s.replace(/\r\n/g, '\n'); }

const OPS = [
  {
    label: 'client 印象卡头部 + 关系标签',
    find: `        // 印象卡 + 心情
        var cards = d.cards || []`,
    make: () => `        // 印象卡 + 心情${' '.repeat(0)}
        // ${MARK}：我是谁、档案里认的人（host 端 collectMemoryPanel 已按档案归并）
        var per = d.persona || {}
        var perRel = (per.relations || []).filter(function (r) { return r && r.who && r.role && r.who !== '熟人' && r.who !== '陌生人' && r.who !== '饲养员' })
        var cards = d.cards || []`,
  },
  {
    label: 'client 卡片名字带关系 + 顶部身份行',
    find: `        if (cards.length) cInner += cards.slice(0, 6).map(function (c) {
          var isGlobal = String(c.scope || '') === '__global__'
          return '<div style="font-size:11px;line-height:1.5;border-bottom:1px dashed #f0ecff;padding:2px 0">'
            + '<b style="color:#e8590c">' + esc(c.name || '某人') + '</b>：' + esc(c.text)`,
    make: () => `        if (per.name || perRel.length) {
          cInner += '<div style="font-size:10.5px;color:#666;margin-bottom:3px">🫧 我是 ' + esc(per.display || per.name || '小蓝')
            + (perRel.length ? ' · 认的人：' + perRel.map(function (r) { return esc(r.who) + '=' + esc(String(r.role || '').split('·')[0]) }).join('、') : '')
            + (d.cardsMerged ? ' · 已合并 ' + d.cardsMerged + ' 条重复卡' : '')
            + '</div>'
        }
        if (cards.length) cInner += cards.slice(0, 6).map(function (c) {
          var isGlobal = String(c.scope || '') === '__global__'
          return '<div style="font-size:11px;line-height:1.5;border-bottom:1px dashed #f0ecff;padding:2px 0">'
            + '<b style="color:#e8590c">' + esc(c.name || '某人') + '</b>'
            + (c.role ? '<span style="color:#7048e8;font-size:10px"> · ' + esc(String(c.role).split('·')[0]) + '</span>' : '')
            + '：' + esc(c.text)`,
  },
  {
    label: 'client 熟识度也显示关系标签',
    find: `            + '<div style="font-size:12px;color:#333;font-weight:600">' + esc(b.name || '某人')`,
    make: () => `            + '<div style="font-size:12px;color:#333;font-weight:600">' + esc(b.name || '某人')
            + (b.role ? '<span style="font-weight:400;color:#7048e8;font-size:10px"> · ' + esc(String(b.role).split('·')[0]) + '</span>' : '')`,
  },
];

const mode = process.argv.includes('--apply') ? 'apply' : 'check';
announce(`fix-panel-v6 (${mode})`);

let src = nl(readFileSync(CLIENT, 'utf8'));
let changed = 0;
for (const op of OPS) {
  const at = src.indexOf(op.find);
  if (at < 0) { console.log(`  ✘ 找不到锚点：${op.label}`); continue; }
  // 幂等：锚点后面这段里已经有 impression 标记就算打过
  if (src.slice(at, at + op.find.length + 300).includes('impression')) { console.log(`  = 已是最新：${op.label}`); continue; }
  if (mode !== 'apply') { console.log(`  · 需要写入：${op.label}`); continue; }
  src = src.slice(0, at) + op.make() + src.slice(at + op.find.length);
  changed += 1;
  console.log(`  ✓ ${op.label}`);
}

if (mode === 'apply' && changed) {
  const bak = CLIENT + '.orig-muu';
  if (!existsSync(bak)) copyFileSync(CLIENT, bak);
  writeFileSync(CLIENT, src.replace(/\n/g, '\r\n'), 'utf8');
  console.log(`已写入 ${CLIENT}（${src.length} 字符）`);
} else if (mode === 'apply') {
  console.log('无需写入');
}
