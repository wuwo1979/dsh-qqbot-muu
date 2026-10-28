// [qqbot-mod] accounts3 —— 平台账号路由改名，避开上游同名的 QQ 账号实例路由
//   上游 settings-host.js 自己已注册 GET /api/qqbot-settings/accounts（返回 QQ 机器人实例列表
//   {hasFile,instances:[…]}），我们那条同名平台路由被后注册的覆盖 ⇒ 账号卡永远空白、粘 Cookie 没反应。
//   判别方式：我们的三条都用 (req, res)，上游那条用 (_req, res)。
//   改成 /platforms、/platforms-detail、/platforms-cookie。
// 用法：node qqbot-mod/patches/fix-accounts3.mjs [--check|--apply]
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { pluginPath, announce } from './plugin-dir.mjs'

const HOST = pluginPath('settings-host.js')
const CLIENT = pluginPath('client/qqbot-settings.js')
const norm = (s) => s.replace(/\r\n/g, '\n')
const denorm = (s) => s.replace(/\n/g, '\r\n')

const HOST_OPS = [
  ["route(ctx, 'GET', '/api/qqbot-settings/accounts', async (req, res) => {", "route(ctx, 'GET', '/api/qqbot-settings/platforms', async (req, res) => {"],
  ["route(ctx, 'GET', '/api/qqbot-settings/accounts-detail', async (req, res) => {", "route(ctx, 'GET', '/api/qqbot-settings/platforms-detail', async (req, res) => {"],
  ["route(ctx, 'POST', '/api/qqbot-settings/accounts-cookie', async (req, res) => {", "route(ctx, 'POST', '/api/qqbot-settings/platforms-cookie', async (req, res) => {"],
]

const CLIENT_OPS = [
  ["await api('accounts', '')", "await api('platforms', '')"],
  ["apiPost('accounts-cookie', { id: 'douyin', cookie: val })", "apiPost('platforms-cookie', { id: 'douyin', cookie: val })"],
]

function applyTo(file, ops) {
  let s = norm(readFileSync(file, 'utf8'))
  let hits = 0
  for (const [a, b] of ops) {
    if (s.includes(b)) continue
    if (s.includes(a)) {
      s = s.replace(a, b)
      hits++
    }
  }
  return { s, hits }
}

function run(checkOnly) {
  announce('accounts3（平台账号路由改名，避开上游 /accounts）')
  let total = 0
  for (const [file, ops] of [
    [HOST, HOST_OPS],
    [CLIENT, CLIENT_OPS],
  ]) {
    const { s, hits } = applyTo(file, ops)
    total += hits
    console.log(`  ${hits === 0 ? '=' : '✎'} ${file.split(/[\\/]/).slice(-2).join('/')}: ${hits} 处`)
    if (checkOnly || hits === 0) continue
    copyFileSync(file, file + '.orig-muu-accounts3')
    writeFileSync(file, denorm(s), 'utf8')
  }
  if (checkOnly) console.log(total ? `需要写入 ${total} 处` : '= 已是最新')
}

run(process.argv.includes('--check'))
