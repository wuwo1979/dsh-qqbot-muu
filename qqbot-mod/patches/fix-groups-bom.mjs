// 群聊标题显示成私聊人名的 Bug（主人 2026-10-27）：两处根因一起修——
//   ① groups.json 被外部工具以 UTF-8 BOM 重写后，所有 JSON.parse 整段抛错且被静默吞掉，
//      群名表失效 → 浮窗聊天页群聊标题回退成 msg-history 里最后说话的**群成员昵称**（如「爸爸」）。
//      → 所有 groups.json 读取点统一容忍 BOM（String().replace(/^\uFEFF/,'')）。
//   ② msg-history 兜底合并时把群成员昵称当群名传出去 → 只有 c2c 才用昵称当对端名，group 一律不给。
//      群名以 groups.json 注册表 + 官方 getGroupInfo 回填为准；都没有就「群 xxxxxx」。
// 同时修宿主 settings-host.js（6 处）与扩展 group-tiers.mjs / memory-panel.mjs（4 处）。
// 数据侧：.qqbot/groups.json 如带 BOM 由本脚本 --fix-data 去除（代码修复后 BOM 也不再致命）。
// 用法：node fix-groups-bom.mjs --check | --apply | --revert | --fix-data
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const MARK = '[qqbot-mod] groups-bom-tolerant'
const FILE = join(PLUGIN, 'settings-host.js')
const BACKUP = 'F:/qqbot/qqbot-mod/backups/settings-host.js.orig-groupsbom'
const DATA_ROOT = process.env.QQBOT_DATA_ROOT || 'F:/qqbot/dshqqbot'

// [宿主 settings-host.js] 旧片段 → 新片段（幂等：出现 MARK 即认为已应用）
const R_HOST = [
  {
    old: "        const _gn = JSON.parse(readFileSync(_gnPath, 'utf8') || '{}');",
    neu: "        // " + MARK + " 2026-10-27：groups.json 若被外部工具以 UTF-8 BOM 重写，\n"
      + "        //   JSON.parse 会整段抛错 → 群名表失效 → 群聊标题回退成最后说话的成员名（浮窗聊天页 Bug）\n"
      + "        const _gn = JSON.parse(String(readFileSync(_gnPath, 'utf8')).replace(/^\\uFEFF/, '') || '{}');",
  },
  {
    old: "                _kcAdd(_mm[1], _mm[2], _nm || undefined, _ts);",
    neu: "                // [qqbot-mod] group-title-fix 2026-10-27：msg-history 里扫到的 n 是**群成员昵称**，\n"
      + "                //   不能当群名（否则群聊标题变成某个群友的名字）；只有私聊(c2c)才用它当对端名\n"
      + "                _kcAdd(_mm[1], _mm[2], (_mm[1] === 'c2c' ? _nm : '') || undefined, _ts);",
  },
  {
    old: "      try { gNames = JSON.parse(readFileSync(join(root, '.qqbot', 'groups.json'), 'utf8')) || {}; } catch { }",
    neu: "      // " + MARK + "：同上，容忍 BOM\n"
      + "      try { gNames = JSON.parse(String(readFileSync(join(root, '.qqbot', 'groups.json'), 'utf8')).replace(/^\\uFEFF/, '')) || {}; } catch { }",
  },
  {
    old: "    try { return JSON.parse(readFileSync(join(cwd, '.qqbot', 'groups.json'), 'utf8') || '{}'); } catch { return {}; }",
    neu: "    // " + MARK + "：容忍 UTF-8 BOM\n"
      + "    try { return JSON.parse(String(readFileSync(join(cwd, '.qqbot', 'groups.json'), 'utf8')).replace(/^\\uFEFF/, '') || '{}'); } catch { return {}; }",
  },
  {
    old: "      try { _old = JSON.parse(readFileSync(_f, 'utf8') || '{}') || {}; } catch (eOld) { _old = {}; }",
    neu: "      try { _old = JSON.parse(String(readFileSync(_f, 'utf8')).replace(/^\\uFEFF/, '') || '{}') || {}; } catch (eOld) { _old = {}; }",
  },
  {
    old: "            if (!_m2.name && _nm) _m2.name = _nm;\n"
      + "            if (!_m2.lastAt) _m2.lastAt = _lastAt;",
    neu: "            // [qqbot-mod] group-title-fix：不拿群成员昵称补群名（官方 getGroupInfo 回填更可靠）\n"
      + "            if (!_m2.lastAt) _m2.lastAt = _lastAt;",
  },
  {
    old: "            map.set(_gid, { gid: _gid, name: _nm ? ('群 ' + _nm) : '', from: 'msg-history', lastAt: _lastAt });",
    neu: "            map.set(_gid, { gid: _gid, name: '', from: 'msg-history', lastAt: _lastAt });",
  },
]

// [扩展] 同类读取点（路径默认 F:/qqbot/dshqqbot/.qqbot-extensions，可用 QQBOT_EXT_ROOT 覆盖）
const EXT_ROOT = process.env.QQBOT_EXT_ROOT || join(DATA_ROOT, '.qqbot-extensions')
const R_EXT = [
  {
    file: join(EXT_ROOT, 'lib', 'group-tiers.mjs'),
    pairs: [
      ["const j = JSON.parse(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8'));",
       "// " + MARK + "\n      const j = JSON.parse(String(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')).replace(/^\\uFEFF/, ''));"],
      ["try { j = JSON.parse(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')) || {}; } catch { return { id: '', ambiguous: [] }; }",
       "try { j = JSON.parse(String(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')).replace(/^\\uFEFF/, '')) || {}; } catch { return { id: '', ambiguous: [] }; }"],
      ["const groups = (() => { try { return JSON.parse(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')) || {}; } catch { return {}; } })();",
       "const groups = (() => { try { return JSON.parse(String(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')).replace(/^\\uFEFF/, '')) || {}; } catch { return {}; } })();"],
    ],
  },
  {
    file: join(EXT_ROOT, 'hooks', 'memory-panel.mjs'),
    pairs: [
      ["try { j = JSON.parse(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')) || {}; } catch { return []; }",
       "// " + MARK + "\n  try { j = JSON.parse(String(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')).replace(/^\\uFEFF/, '')) || {}; } catch { return []; }"],
    ],
  },
]

function applyReplacements(src, pairs) {
  let out = src; const done = []; const missed = []
  for (const [o, n] of pairs) {
    // 探测：新代码里含 groups.json 的那行（不含注释）就是“已应用”的判据
    const probe = n.split('\n').map((x) => x.trim()).find((x) => x.includes('groups.json')) || n;
    if (!out.includes(o)) {
      if (out.includes(probe)) { done.push('已应用'); continue }
      missed.push(o.slice(0, 60)); continue
    }
    out = out.split(o).join(n); done.push('替换 1 处')
  }
  return { out, done, missed }
}

const src = readFileSync(FILE, 'utf8')
const arg = process.argv[2] || '--check'

if (arg === '--fix-data') {
  const f = join(DATA_ROOT, '.qqbot', 'groups.json')
  if (!existsSync(f)) { console.log('没有 ' + f); process.exit(0) }
  const raw = readFileSync(f, 'utf8')
  if (!raw.startsWith('﻿')) { console.log('groups.json 无 BOM，无需处理'); process.exit(0) }
  const clean = raw.replace(/^﻿/, '')
  try { JSON.parse(clean) } catch (e) { console.log('去 BOM 后仍非法 JSON，不动：' + e.message); process.exit(1) }
  copyFileSync(f, f + '.bak-bom-' + new Date().toISOString().slice(0, 10).replaceAll('-', ''))
  writeFileSync(f, clean, 'utf8')
  console.log('已去 BOM 重写 ' + f + '（原文件已备份）')
  process.exit(0)
}

if (arg === '--revert') {
  if (!existsSync(BACKUP)) { console.log('没有备份：' + BACKUP); process.exit(2) }
  copyFileSync(BACKUP, FILE)
  console.log('已回滚 ' + FILE)
  process.exit(0)
}

announce('groups-bom')
const res = applyReplacements(src, R_HOST.map((r) => [r.old, r.neu]))
let extPending = 0
for (const spec of R_EXT) {
  if (!existsSync(spec.file)) { console.log('⚠️ 扩展文件不存在：' + spec.file); extPending += 1; continue }
  const s = readFileSync(spec.file, 'utf8')
  const r = applyReplacements(s, spec.pairs)
  console.log('  ' + spec.file + ' → ' + r.done.join(', ') + (r.missed.length ? ' | 未匹配 ' + r.missed.length + ' 处' : ''))
  if (arg === '--apply' && r.out !== s) { copyFileSync(spec.file, spec.file + '.bak-groupsbom'); writeFileSync(spec.file, r.out, 'utf8') }
  if (r.missed.length) extPending += r.missed.length
}

if (res.out === src) {
  console.log(src.includes(MARK) ? '已应用（groups.json BOM 容忍 + 群标题修复）' : '未匹配任何宿主片段（上游可能又变了，需人工核对）')
  process.exit(src.includes(MARK) ? 0 : 1)
}
if (arg !== '--apply') {
  console.log('可打：宿主 ' + res.done.filter((x) => x !== '已应用').length + ' 处，扩展待处理 ' + extPending + ' 处')
  process.exit(0)
}
copyFileSync(FILE, BACKUP)
console.log('备份 → ' + BACKUP)
writeFileSync(FILE, res.out, 'utf8')
console.log('已写入 settings-host.js（' + src.length + ' → ' + res.out.length + ' 字符）')
console.log('提醒：宿主需重启后生效；浮窗群名因 groups.json 已实时可读，不重启也应先恢复。')
