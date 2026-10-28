#!/usr/bin/env node
/**
 * fix-groups-trust.mjs —— 群列表：台账里有近期活动的群，不能被「getGroupInfo 查不到」抹掉
 *
 * 现状（2026-10-27 排查）：group/accounts 会用 gc.client.getGroupInfo(gid) 逐个验活，
 * 查不到就把 gid 记进 DEAD_GROUP_CACHE 并从结果里删掉。可是台账（known-chats / msg-history）
 * 里明明有群、主人也还在群里说话 —— 于是面板上「群凭空消失」，只剩私聊。
 *
 * 本补丁：
 *   1. 验活失败时，若这条来自台账（ledger / msg-history / registry+pending），仍然放进结果，
 *      标 unverified:true，而不是当成死群抹掉；
 *   2. 回写注册表统一用 _qaRoot（原来写 bot.cwd，和读的根不一致，导致 groups.json 写到别处）；
 *   3. 「补回列表」那道保险也认 ledger 来源。
 *
 * 用法：node qqbot-mod/patches/fix-groups-trust.mjs [--check|--apply]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, announce } from './plugin-dir.mjs'

const APPLY = process.argv.includes('--apply')
const HOST = join(PLUGIN, 'settings-host.js')
announce('groups-trust')

let src = readFileSync(HOST, 'utf8')
const crlf = src.includes('\r\n')
if (crlf) src = src.replace(/\r\n/g, '\n')

const ops = []

// 1) 死群分支：来自台账的，保留并标 unverified
{
  const anchor = `            } else {\n              // 11255 \u7b49 = \u7fa4\u5df2\u6ce8\u9500/\u4e0d\u5b58\u5728 \u2192 \u4e0d\u8fd4\u56de\u7ed9 UI`
  const marker = 'groups-trust-ledger-keep'
  if (src.includes(marker)) {
    ops.push(['\u7fa4\u53f0\u8d26\u4fdd\u7559', true])
  } else {
    const i = src.indexOf(anchor)
    if (i < 0) ops.push(['\u7fa4\u53f0\u8d26\u4fdd\u7559', false])
    else {
      const neu =
        `            } else {\n` +
        `              // [qqbot-mod] ${marker}\uff1a\u53f0\u8d26\u91cc\u6709\u8fd1\u671f\u8bb0\u5f55\u7684\u7fa4\u5c31\u662f\u6d3b\u7684\uff0c\n` +
        `              //   getGroupInfo \u67e5\u4e0d\u5230\u5927\u6982\u7387\u662f\u6743\u9650/\u63a5\u53e3\u95ee\u9898\uff0c\u4e0d\u80fd\u628a\u7fa4\u4ece\u5217\u8868\u91cc\u62b9\u6389\u3002\n` +
        `              if (g.from === 'ledger' || g.from === 'msg-history' || g.from === 'registry+pending') {\n` +
        `                out.push({ ...g, unverified: true });\n` +
        `                continue;\n` +
        `              }\n` +
        `              // 11255 \u7b49 = \u7fa4\u5df2\u6ce8\u9500/\u4e0d\u5b58\u5728 \u2192 \u4e0d\u8fd4\u56de\u7ed9 UI`
      src = src.slice(0, i) + neu + src.slice(i + anchor.length)
      ops.push(['\u7fa4\u53f0\u8d26\u4fdd\u7559', true])
    }
  }
}

// 2) 回写注册表用 _qaRoot
{
  const old = `        if (Object.keys(aliveReg).length >= 0) writeGroupsJson(bot.cwd, aliveReg);`
  const neu = `        // [qqbot-mod] groups-trust-writeroot\uff1a\u8bfb\u7684\u662f _qaRoot\uff0c\u5199\u4e5f\u8981\u5199\u540c\u4e00\u4e2a\u6839\n        if (Object.keys(aliveReg).length >= 0) writeGroupsJson(_qaRoot || bot.cwd, aliveReg);`
  if (src.includes('groups-trust-writeroot')) ops.push(['\u56de\u5199\u6839\u4fee\u6b63', true])
  else if (!src.includes(old)) ops.push(['\u56de\u5199\u6839\u4fee\u6b63', false])
  else {
    src = src.replace(old, neu)
    ops.push(['\u56de\u5199\u6839\u4fee\u6b63', true])
  }
}

// 3) 「补回列表」保险也认 ledger
{
  const old = `          if (_g.from !== 'msg-history' && _g.from !== 'registry') continue;`
  const neu = `          if (_g.from !== 'msg-history' && _g.from !== 'registry' && _g.from !== 'ledger' && _g.from !== 'registry+pending') continue;`
  if (src.includes(`_g.from !== 'ledger'`)) ops.push(['\u4fdd\u9669\u8ba4 ledger', true])
  else if (!src.includes(old)) ops.push(['\u4fdd\u9669\u8ba4 ledger', false])
  else {
    src = src.replace(old, neu)
    ops.push(['\u4fdd\u9669\u8ba4 ledger', true])
  }
}

for (const [k, ok] of ops) console.log(`  ${ok ? '\u2714' : '\u2717'} ${k}`)
if (ops.some(([, ok]) => !ok)) {
  console.log('\n\u2717 \u6709\u951a\u70b9\u6ca1\u547d\u4e2d\uff0c\u672a\u5199\u5165')
  process.exit(1)
}
if (!APPLY) {
  console.log('\n  dry run\uff08\u52a0 --apply \u624d\u5199\u76d8\uff09')
  process.exit(0)
}
if (!existsSync(HOST + '.orig-muu')) copyFileSync(HOST, HOST + '.orig-muu')
writeFileSync(HOST, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8')
console.log('\n  \u2714 \u5df2\u5199\u5165 settings-host.js')
console.log('\n\u88c5\u5b8c\u8bb0\u5f97\uff1a/bot-restart\uff08\u6216\u91cd\u542f DSH \u684c\u9762\u7aef\uff09+ \u9875\u9762 Ctrl+F5')
