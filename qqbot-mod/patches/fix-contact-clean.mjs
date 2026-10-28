#!/usr/bin/env node
/**
 * fix-contact-clean.mjs —— 2026-10-27（主人第八轮）
 *
 * 1) 群列表又空了：根本原因是 groups.json 被上游写成 {}，而 group/accounts 只认
 *    「注册表 + pending + known-chats」三处；三处同时空 ⇒ 群列表消失。
 *    这里补第四处兜底：直接扫 .qqbot/msg-history/group_<id>/（有历史就一定有群）。
 * 2) writeGroupsJson 再保险一次：合并结果为空时**不写盘**，避免把好表覆盖成 {}。
 * 3) 浮窗「联系方式」页：去掉整块「📇 QQ 联系方式」以及「群 N · 人 N」计数，
 *    只留 B 站学习记录 + 学习心得（主人要求）。
 *
 * 用法：node qqbot-mod/patches/fix-contact-clean.mjs [--check|--apply]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const APPLY = process.argv.includes('--apply')
const HOST = join(PLUGIN, 'settings-host.js')
const CLIENT = join(PLUGIN, 'client', 'qqbot-settings.js')
announce('contact-clean')

function load(p) { return readFileSync(p, 'utf8').replace(/\r\n/g, '\n') }
function save(p, s, orig) {
  if (!APPLY) return
  if (!existsSync(p + '.orig-muu')) copyFileSync(p, p + '.orig-muu')
  writeFileSync(p, s.replace(/\n/g, '\r\n'), 'utf8')
  void orig
}

const ops = []

/* ── 1. host: group/accounts 扫 msg-history 兜底 ── */
{
  const anchor = '      const gc = await groupClientOf(NSQ(u));\n'
  const neu = `      // [qqbot-mod] groups-msghistory：注册表被清空时（groups.json 变成 {}）兜底——
      //   只要有过群聊，.qqbot/msg-history/group_<id>/ 里一定有当天的台账，群就不会凭空消失。
      try {
        const _mhRoot = join(_qaRoot, '.qqbot', 'msg-history');
        for (const _d of readdirSync(_mhRoot)) {
          const _mm = /^group_(.+)$/.exec(_d);
          if (!_mm) continue;
          const _gid = _mm[1];
          let _lastAt = 0;
          let _nm = '';
          try {
            const _files = readdirSync(join(_mhRoot, _d)).filter((f) => /^\\d{4}-\\d{2}-\\d{2}\\.jsonl$/.test(f)).sort();
            const _last = _files[_files.length - 1];
            if (_last) {
              const _p = join(_mhRoot, _d, _last);
              try { _lastAt = statSync(_p).mtimeMs } catch { _lastAt = 0 }
              try {
                const _lines = readFileSync(_p, 'utf8').split('\\n').filter(Boolean).slice(-80);
                for (let _i = _lines.length - 1; _i >= 0; _i--) {
                  try {
                    const _o = JSON.parse(_lines[_i]);
                    const _n = String((_o && _o.n) || '').trim();
                    if (_n && _n !== 'self' && !/^[0-9A-Fa-f]{32}$/.test(_n)) { _nm = _n; break }
                  } catch { /* 坏行跳过 */ }
                }
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
          if (map.has(_gid)) {
            const _m2 = map.get(_gid);
            if (!_m2.name && _nm) _m2.name = _nm;
            if (!_m2.lastAt) _m2.lastAt = _lastAt;
          } else {
            map.set(_gid, { gid: _gid, name: _nm ? ('群 ' + _nm) : '', from: 'msg-history', lastAt: _lastAt });
          }
        }
      } catch (eMH) { /* 没有台账目录就算了 */ }
${anchor}`
  ops.push({ file: HOST, label: 'host-groups-msghistory', from: anchor, to: neu, kind: 'replace' })
}

/* ── 2. host: writeGroupsJson 空表不落盘 ── */
{
  const anchor = "      writeFileSync(_f, JSON.stringify(_merged, null, 1), 'utf8');\n"
  const neu = `      // [qqbot-mod] groups-keep：合并后仍是空表就别写，宁可不更新也不要把好表清空
      if (!Object.keys(_merged).length) return;
${anchor}`
  ops.push({ file: HOST, label: 'host-groups-keep', from: anchor, to: neu, kind: 'replace' })
}

/* ── 3. client: 联系方式页开头说明改写（去掉 QQ 口径） ── */
{
  const marker = "        var h = '<div class=\"dk-msg\" style=\"font-size:11px;color:#888;line-height:1.6\">"
  const neu = `        var h = '<div class="dk-msg" style="font-size:11px;color:#888;line-height:1.6">这里是她对外留下的痕迹：B 站侧的出片 / 发布 / 评论记录，以及她自己攒下的学习心得。群和人的联络清单已经挪到聊天页的「⭐ 特别关心」。<\/div>'\n`
  ops.push({ file: CLIENT, label: 'client-contact-intro', from: marker, to: neu, kind: 'replace-line-starting-with' })
}

/* ── 4. client: 删掉 QQ 整块（gi/pi 构造 + 标题 + 计数） ── */
{
  const startMark = "        var gi = ''\n"
  const endMark = "        h += gi + '<div style=\"height:6px\"></div>' + pi\n"
  ops.push({ file: CLIENT, label: 'client-contact-remove-qq', from: startMark, endMark, kind: 'cut' })
}

let ok = 0
let bad = 0
const cache = new Map()
for (const op of ops) {
  if (!cache.has(op.file)) cache.set(op.file, load(op.file))
  const src = cache.get(op.file)
  if (op.kind === 'cut') {
    const i = src.indexOf(op.from)
    const j = src.indexOf(op.endMark, i)
    if (i < 0 || j < 0) { console.log(`  ✗ ${op.label}: 找不到端点`); bad++; continue }
    const cut = src.slice(i, j + op.endMark.length)
    if (cut.includes('groups-msghistory')) { console.log(`  = ${op.label}: 已处理`); ok++; continue }
    cache.set(op.file, src.slice(0, i) + src.slice(j + op.endMark.length))
    console.log(`  ✔ ${op.label}: 删掉 ${cut.length} 字符（QQ 联系方式整块）`)
    ok++
    continue
  }
  if (op.kind === 'replace') {
    if (!src.includes(op.from)) { console.log(`  ✗ ${op.label}: 锚点不匹配`); bad++; continue }
    if (src.includes(op.to)) { console.log(`  = ${op.label}: 已是最新`); ok++; continue }
    cache.set(op.file, src.replace(op.from, op.to))
    console.log(`  ✔ ${op.label}: 已写入`)
    ok++
    continue
  }
  // replace-line-starting-with：整行替换
  const lines = src.split('\n')
  const idx = lines.findIndex((l) => l.startsWith(op.from))
  if (idx < 0) { console.log(`  ✗ ${op.label}: 找不到该行`); bad++; continue }
  if (lines[idx].includes('她对外留下的痕迹')) { console.log(`  = ${op.label}: 已是最新`); ok++; continue }
  lines[idx] = op.to.replace(/\n$/, '')
  cache.set(op.file, lines.join('\n'))
  console.log(`  ✔ ${op.label}: 已替换第 ${idx + 1} 行`)
  ok++
}

if (bad) { console.log(`\n✗ ${bad} 处失败，未写入`); process.exit(1) }
if (!APPLY) { console.log(`\n(dry run) ${ok} 处可写入；加 --apply 落盘`); process.exit(0) }
for (const [file, src] of cache) {
  const orig = load(file)
  if (orig === src) continue
  save(file, src, orig)
  console.log(`  ✔ 写入 ${file.replace(PLUGIN, '<plugin>')}`)
}
console.log('\n装完记得：/bot-restart（或重启 DSH 桌面端）+ 页面 Ctrl+F5')
