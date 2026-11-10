/**
 * 微信侧 smoke（对应 docs/微信侧问题定位与改动说明 §6 六项实机验证）。
 *
 * 离线部分（默认，不依赖真机、不打扰任何人）：
 *   1. 红包 XML 分类 + 人类可读化（不统一拒收，也不声称已领取）
 *   2. 群 @ 识别（含机器人群显示名「来自木星的小鲸鱼」、全角 ＠、正文中间）
 *   3. 去重键（同文本 10 秒桶内去重，跨桶不误杀）
 *   4. 出站媒体白名单（outbox 内图片放行，secrets/config/穿越拒绝）
 *   5. 端口配置冲突校验（reverse 误配 3001 必须报错）
 *
 * 实机部分（--live）：
 *   6. 读桥接 /wx/health：tablet 可达、WCX 未命中坏版本
 *   7. --conv <会话> 时，用 /wx/send-image 发 outbox 测试图
 *   8. 读插件 /api/wechat-muu/status：contextChars 不超过预算
 *
 * 用法：
 *   node scripts/smoke-wechat.mjs
 *   node scripts/smoke-wechat.mjs --live
 *   node scripts/smoke-wechat.mjs --live --conv <wxid或群id>   # 会真的发一张 1x1 测试图
 */
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { classifyWechat, humanizeWechatText } from '../wechat-bridge/event-classify.mjs'
import { dedupeKey, safeMediaPath } from '../wechat-bridge/util.mjs'
import { DEFAULT_BOT_ALIASES, splitNames, parseMention } from '../wechat-bridge/mention.mjs'
import { PATHS, PORTS, validateConfig } from '../wechat-bridge/constants.mjs'

const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const conv = (() => {
  const i = args.indexOf('--conv')
  return i >= 0 ? args[i + 1] : ''
})()

const results = []
const ok = (name, pass, detail = '') => results.push({ name, pass, detail })
const cfg = existsSync(join(PATHS.bridge, 'config.json'))
  ? JSON.parse(readFileSync(join(PATHS.bridge, 'config.json'), 'utf8'))
  : {}

/* --------------------------- 1. 红包 XML --------------------------- */
const rpXml = `<msg><appmsg appid="" sdkver="0"><title>恭喜发财，大吉大利</title><type>2001</type><wcpayinfo><sendertitle>木囧</sendertitle><paymsgid>100003</paymsgid></wcpayinfo></appmsg></msg>`
{
  const cls = classifyWechat(rpXml, {})
  const text = humanizeWechatText(rpXml, {})
  ok('红包分类', cls.kind === 'red_packet', cls.kind)
  ok('红包可读化', /^\[微信红包\]/.test(text) && !/不可以收|已领取|已到账/.test(text), text)
}

/* --------------------------- 2. 群 @ 识别 --------------------------- */
{
  const aliases = splitNames(DEFAULT_BOT_ALIASES)
  const a = parseMention(aliases, '@来自木星的小鲸鱼 在吗')
  ok('默认别名含机器人群显示名', aliases.includes('来自木星的小鲸鱼'))
  ok('群 @ 命中（机器人显示名）', a.hit && a.name === '来自木星的小鲸鱼', a.stripped.slice(0, 20))
  const b = parseMention(aliases, '＠小蓝 帮我看看这个')
  ok('群 @ 命中（全角 ＠）', b.hit && b.name === '小蓝', b.stripped.slice(0, 20))
  const c = parseMention(aliases, '今天好热 @muu 你说呢')
  ok('群 @ 命中（正文中间兜底）', c.hit, c.stripped.slice(0, 20))
  const d = parseMention(aliases, '今天好热')
  ok('无关消息不命中', !d.hit)
}

/* --------------------------- 3. 去重键 --------------------------- */
{
  const t0 = 1_700_000_000_000
  const k1 = dedupeKey('u:1', 'wxid_a', 'text', '好的', null, t0)
  const k2 = dedupeKey('u:1', 'wxid_a', 'text', '好的', null, t0 + 3000)
  const k3 = dedupeKey('u:1', 'wxid_a', 'text', '好的', null, t0 + 12_000)
  const k4 = dedupeKey('u:1', 'wxid_a', 'text', '好的', '123456789', t0)
  ok('同桶去重', k1 === k2, k1)
  ok('跨桶不误杀', k1 !== k3)
  ok('有 svrid 优先', k4 === 's:123456789', k4)
}

/* --------------------------- 4. 媒体白名单 --------------------------- */
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  try { mkdirSync(PATHS.outbox, { recursive: true }) } catch { /* ignore */ }
  const testImg = join(PATHS.outbox, 'smoke-wechat.png')
  try { writeFileSync(testImg, png) } catch { /* ignore */ }
  const good = safeMediaPath(testImg, PATHS.outbox, 8 * 1024 * 1024, 'image')
  ok('outbox 图片放行', good.ok, good.ok ? good.name : good.reason)
  const bad1 = safeMediaPath(join(PATHS.root, 'secrets', 'wcx-token.txt'), PATHS.outbox)
  ok('secrets 拒绝', !bad1.ok, bad1.reason)
  const bad2 = safeMediaPath(join(PATHS.outbox, '..', 'config.json'), PATHS.outbox)
  ok('路径穿越/配置拒绝', !bad2.ok, bad2.reason)
  const bad3 = safeMediaPath(join(PATHS.outbox, 'note.txt'), PATHS.outbox, 8 * 1024 * 1024, 'image')
  ok('非图片扩展名拒绝', !bad3.ok, bad3.reason)
}

/* --------------------------- 5. 配置冲突校验 --------------------------- */
{
  const real = validateConfig(cfg)
  ok('当前 config 无致命冲突', real.ok, real.errors.join('；') || 'ok')
  // 历史事故的真实形态：reverse 在平板侧误开 3001，撞上平板 WCX 自己的端口
  const broken = validateConfig({ ...cfg, adb: { ...(cfg.adb || {}), remotePort: 3001, reversePort: 3001 } })
  ok('reverse 误配 3001 被拦下', !broken.ok, broken.errors[0] || '')
  // reverse 必须回到 bridge 端口，写成 6000 也要拦
  const mismatch = validateConfig({ ...cfg, adb: { ...(cfg.adb || {}), reversePort: 6000 } })
  ok('reverse 未回指桥接被拦下', !mismatch.ok, mismatch.errors[0] || '')
}

const BRIDGE_TOKEN = (() => {
  try { return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'secrets', 'runtime', 'bridge-token.txt'), 'utf8').trim() } catch { return '' }
})()

/* --------------------------- 6-8. 实机 --------------------------- */
if (LIVE) {
  const health = await fetch(`http://127.0.0.1:${PORTS.bridge}/wx/health`).then((r) => r.json()).catch(() => null)
  ok('桥接 /wx/health 可达', Boolean(health?.ok), health ? JSON.stringify(health.warnings || []) : '不可达')
  ok('平板 WCX 可达', Boolean(health?.tablet?.reachable), `tunnel=${health?.tunnel || '?'}`)
  ok('WCX 坏版本已降级只读（而非静默失败）', !health?.wcx?.knownBad || Boolean(health?.wcx?.readOnly),
    health?.wcx?.version ? `v${health.wcx.version}${health.wcx.knownBad ? ' 已知坏版本 → readOnly' : ''}` : '版本未知（不影响收）')

  if (conv) {
    const img = join(PATHS.outbox, 'smoke-wechat.png')
    const r = await fetch(`http://127.0.0.1:${PORTS.bridge}/wx/send-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(BRIDGE_TOKEN ? { 'X-Bridge-Token': BRIDGE_TOKEN } : {}) },
      body: JSON.stringify({ convId: conv, path: img }),
    }).then((x) => x.json()).catch(() => null)
    ok('outbox 测试图发送', Boolean(r?.ok), r ? `status=${r.status}${r.error ? ' ' + r.error : ''}` : '请求失败')
  } else {
    ok('测试图发送（跳过）', true, '未传 --conv，未真的发图')
  }

  const stRaw = await fetch(`http://127.0.0.1:${PORTS.harness}/api/wechat-muu/status`).then((r) => r.json()).catch(() => null)
  // 接口形如 { ok, status: {...}, bridge: {...} }；顶层也可能是旧版的扁平结构，两种都兼容
  const st = stRaw?.status ?? stRaw
  if (st) {
    // 旧插件没有这两个字段：不能把 undefined 当 0 蒙混过关，否则会误报「预算内」
    const hasFields = st.contextChars != null && st.contextBudgetChars != null
    const budget = Number(st.contextBudgetChars)
    const chars = Number(st.contextChars)
    ok('contextChars 在预算内', hasFields && chars <= budget,
      hasFields ? `${chars}/${budget}` : 'status 缺 contextChars/contextBudgetChars（宿主加载的是旧插件，需重装并重启）')
  } else {
    ok('插件 status 可达（跳过断言）', true, '宿主未启动或路由未注册')
  }
}

/* --------------------------- 发布前脱敏扫描（必跑） --------------------------- */
{
  const here = dirname(fileURLToPath(import.meta.url))
  const r = spawnSync(process.execPath, [join(here, 'logscan.mjs')], { encoding: 'utf8' })
  const pass = r.status === 0
  ok('发布前脱敏扫描（logscan）', pass, pass ? '日志无密钥/wxid 命中' : '命中敏感字面量，运行 node scripts/logscan.mjs 查看定位')
}

/* --------------------------- 报告 --------------------------- */
console.log(`\n微信侧 smoke（${LIVE ? '离线 + 实机' : '离线'}）`)
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
const failed = results.filter((r) => !r.pass)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('\n人工复核项（真机）：')
  console.log('  1) 红包：指定角色发红包 → 应正常对话；非白名单只按普通消息，不统一拒收')
  console.log('  2) 群 @：在群里 @机器人显示名 → 应回复；未 @ 的群消息不回复但入库')
  console.log('  3) 图片：微信侧发送图片 → 对方应收到；失败看 bridge.log 的 /wx/send-image')
  console.log('  4) 隧道：adb reverse tcp:4311 存在 → /wx/health 的 pushTotal 随消息增长')
}
process.exit(failed.length ? 1 : 0)
