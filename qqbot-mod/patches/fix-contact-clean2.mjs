#!/usr/bin/env node
/**
 * fix-contact-clean2.mjs —— 群列表第二道保险（2026-10-27）
 *
 * 第一道（fix-contact-clean.mjs）把 .qqbot/msg-history/group_<id>/ 扫进 map，
 * 但后面「逐个校验」那段会用 groupClientOf 逐群探活：群查不到 / 判死 / 报错时
 * 可能直接 continue，结果 out 里还是没有群（主人看到的就是「群没了」）。
 * 这里在校验循环之后、writeJson 之前补一段：台账里确凿存在的群，即使探活没通过，
 * 也以 unverified 标记补回列表——面板能看见、能选，只是标一下「未验证」。
 *
 * 用法：node qqbot-mod/patches/fix-contact-clean2.mjs [--check|--apply]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const APPLY = process.argv.includes('--apply')
const HOST = join(PLUGIN, 'settings-host.js')
announce('contact-clean2')

const anchor = '      writeJson(res, 200, { groups: out });\n'
const neu = `      // [qqbot-mod] groups-unverified-keep：探活阶段可能把群判死/跳过（群里机器人被踢过、
      //   或者当前拿不到群客户端），但台账（msg-history）里确凿存在过这个群 —— 补回列表，标 unverified，
      //   否则主人看到的就是「群凭空消失」。
      try {
        const _have = new Set(out.map((x) => x && x.gid));
        for (const _g of map.values()) {
          if (!_g || !_g.gid || _have.has(_g.gid)) continue;
          if (_g.from !== 'msg-history' && _g.from !== 'registry') continue;
          out.push({
            gid: _g.gid,
            name: _g.name || ('群 ' + String(_g.gid).slice(-6)),
            from: _g.from,
            lastAt: _g.lastAt || 0,
            unverified: true,
          });
        }
      } catch { /* ignore */ }
${anchor}`

const src = readFileSync(HOST, 'utf8').replace(/\r\n/g, '\n')
if (src.includes('groups-unverified-keep')) {
  console.log('  = 已是最新')
  process.exit(0)
}
const idx = src.indexOf(anchor)
if (idx < 0) { console.log('  ✗ 找不到 writeJson(res, 200, { groups: out }) 锚点'); process.exit(1) }
const out = src.slice(0, idx) + neu + src.slice(idx + anchor.length)
if (!APPLY) { console.log('  ✔ 可写入（dry run）'); process.exit(0) }
if (!existsSync(HOST + '.orig-muu')) copyFileSync(HOST, HOST + '.orig-muu')
writeFileSync(HOST, out.replace(/\n/g, '\r\n'), 'utf8')
console.log('  ✔ 已写入 settings-host.js')
console.log('\n装完记得：/bot-restart（或重启 DSH 桌面端）+ 页面 Ctrl+F5')
