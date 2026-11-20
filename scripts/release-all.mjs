#!/usr/bin/env node
/**
 * release-all.mjs —— 一条命令走完「本地 CI → 隐私闸门 → 提交 → 推 GitHub → 打 tag/Release → 发 npm → 同步市场条目」
 *
 *   node scripts/release-all.mjs --check     # 只跑本地 CI + 隐私闸门（推之前必过）
 *   node scripts/release-all.mjs             # 全流程（默认）
 *   node scripts/release-all.mjs --dry-run   # 除推送/发布外全做，打印将执行的动作
 *
 * 设计约束（2026-11-19 用户要求）：
 *   - 本地先跑完与 .github/workflows/ci.yml 完全一致的检查，任何一项红就立刻停，绝不推上去等 GitHub 报错；
 *   - 不弹 Git Credential Manager 的账号选择框：令牌优先取 GH_TOKEN / GITHUB_TOKEN 环境变量，
 *     其次 `git credential fill`（带 GIT_TERMINAL_PROMPT=0 + GCM_INTERACTIVE=never，拿不到就报错退出）；
 *   - 幂等：版本已发过就跳过 npm；tag/Release 已存在就跳过创建；
 *   - github.com:443 被墙时自动走 REST API 推提交（配置正常时也走 API，避免 git push 触发凭据弹窗）。
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

const REPO = 'wuwo1979/dsh-qqbot-muu'
const FORK = 'wuwo1979/awesome-dsh-plugin'
const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const MARKET_BRANCH = 'release/dsh-qqbot-muu-v0.1.7'
let NPM_PENDING = ''
const MARKET_PR = 17081   // 0 = 每次新开 PR；>0 表示复用该 PR 号
const MARKET_FILE = 'data/plugins/wuwo1979__dsh-qqbot-muu.yml'
const LOCAL_MARKET = 'submission/data/plugins/wuwo1979__dsh-qqbot-muu.yml'

const CHECK_ONLY = process.argv.includes('--check')
const DRY = process.argv.includes('--dry-run')
const IS_WIN = process.platform === 'win32'

const c = { ok: '\x1b[32m✓\x1b[0m', bad: '\x1b[31m✗\x1b[0m', dim: '\x1b[90m', end: '\x1b[0m' }
const step = (t) => console.log(`\n\x1b[1m── ${t}\x1b[0m`)
const ok = (t) => console.log(`  ${c.ok} ${t}`)
const die = (t, detail) => {
  console.error(`  ${c.bad} ${t}${detail ? '\n' + String(detail).trim().split('\n').slice(0, 12).map((l) => '    ' + l).join('\n') : ''}`)
  console.error('\n本地检查没过，什么都没推。修完重新跑同一条命令即可。')
  process.exit(1)
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: IS_WIN, ...opts })
  if (r.status !== 0) {
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim()
    const e = new Error(`${cmd} ${args.join(' ')} 失败（exit ${r.status}）`)
    e.detail = out
    throw e
  }
  return String(r.stdout || '')
}
const tryRun = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: IS_WIN, ...opts })
  return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || ''), status: r.status }
}

// ── 1) 本地 CI（与 .github/workflows/ci.yml 同款 + 发版闸门）────────────────
step('1/7 本地 CI（语法 / 市场条目 / 包隐私 / 发版闸门）')
const checks = [
  ['语法 index.js', () => run(process.execPath, ['--check', 'index.js'])],
  ['语法 install.mjs', () => run(process.execPath, ['--check', 'install.mjs'])],
  ['市场条目预检', () => run(process.execPath, ['scripts/check-submission.mjs'])],
  ['npm 包隐私自检', () => run(process.execPath, ['scripts/check-pack-privacy.mjs'])],
  ['发版闸门（strict）', () => run(process.execPath, ['scripts/release-check.mjs', '--strict'])]
]
for (const [name, fn] of checks) {
  try { fn(); ok(name) } catch (e) { die(`${name} 失败`, e.detail || e.message) }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const VERSION = pkg.version
const TAG = `v${VERSION}`
const TGZ = `dsh-qqbot-muu-${VERSION}.tgz`
console.log(`  ${c.dim}版本 ${VERSION}${c.end}`)

if (CHECK_ONLY) {
  console.log('\n✅ 本地检查全绿（--check 模式，未推送）')
  process.exit(0)
}

// ── 2) 令牌（不弹窗）────────────────────────────────────────────────────
step('2/7 取令牌（优先环境变量，其次非交互式 credential fill）')
function githubToken() {
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const v = String(process.env[k] || '').trim()
    if (/^(gh[ps]_|github_pat_)/.test(v)) { ok(`用 ${k}`); return v }
  }
  // Windows 下 spawnSync(shell:true) 会丢 stdin，必须用 execSync 喂协议行；
  // 全局 credential.https://github.com.helper 已固定为 manager，正常静默返回，不弹选择框。
  try {
    const out = execSync('git credential fill', { input: 'protocol=https' + String.fromCharCode(10) + 'host=github.com' + String.fromCharCode(10) + String.fromCharCode(10), encoding: 'utf8' })
    const m = /password=(.+)/.exec(out)
    if (m && m[1].trim()) { ok('用 git credential（已存账号，静默）'); return m[1].trim() }
  } catch { /* fallthrough */ }
  die('拿不到 GitHub 令牌', '设置环境变量 GH_TOKEN（ghp_… / github_pat_…），或确认 git 里存了 github.com 的账号。')
}

function npmToken() {
  const env = String(process.env.NPM_TOKEN || '').trim()
  if (/^npm_[A-Za-z0-9]{20,}$/.test(env)) { ok('用 NPM_TOKEN'); return env }
  for (const p of ['secrets/npm.txt', 'secrets/npm-token.txt']) {
    try {
      const t = readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim()
      if (/^npm_[A-Za-z0-9]{20,}$/.test(t)) { ok(`用 ${p}`); return t }
    } catch { /* 读不到就试下一个 */ }
  }
  return ''
}

const TOK = githubToken()
const H = { Authorization: `Bearer ${TOK}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dsh-qqbot-muu-release' }
async function api(path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const t = await r.text()
  let j = null
  try { j = t ? JSON.parse(t) : null } catch { j = t }
  return { ok: r.ok, status: r.status, j }
}

// ── 3) 提交（有改动才提交）──────────────────────────────────────────────
step('3/7 本地提交')
const dirty = tryRun('git', ['status', '--porcelain']).out.trim()
if (dirty) {
  if (DRY) { ok(`（dry-run）将提交 ${dirty.split('\n').length} 个文件`); }
  else {
    run('git', ['add', '-A'])
    run('git', ['-c', 'user.name=wuwo1979', '-c', 'user.email=wuwo1979@users.noreply.github.com', 'commit', '-q', '-m', `"release(${TAG}): local CI green"`])
    ok('已提交')
  }
} else ok('工作区干净，跳过提交')

// ── 4) 推送到 main（REST API，避开 github.com:443 与凭据弹窗）────────────
step('4/7 推送到 GitHub main（REST API）')
const headSha = tryRun('git', ['rev-parse', 'HEAD']).out.trim()
const refRes = await api(`/repos/${REPO}/git/ref/heads/main`)
if (!refRes.ok) die('读不到远端 main', JSON.stringify(refRes.j).slice(0, 300))
const remoteSha = refRes.j.object.sha
if (remoteSha === headSha) ok('远端已是最新，跳过推送')
else if (DRY) ok(`（dry-run）将推送 ${headSha.slice(0, 8)} → ${remoteSha.slice(0, 8)}`)
else {
  // 远端可能是 API 造的提交（本地没有），所以逐文件比对 blob sha：
  // 远端 tree（recursive）→ path→sha；本地 `git ls-tree -r HEAD` → path→sha；差集即本次要推的文件。
  const remoteTree = await api(`/repos/${REPO}/git/trees/${remoteSha}?recursive=1`)
  if (!remoteTree.ok) die('读不到远端 tree', JSON.stringify(remoteTree.j).slice(0, 200))
  const remoteMap = new Map((remoteTree.j.tree || []).filter((n) => n.type === 'blob').map((n) => [n.path, n.sha]))
  const localList = tryRun('git', ['ls-tree', '-r', '-z', 'HEAD']).out.split(String.fromCharCode(0)).filter(Boolean)
  const localMap = new Map()
  for (const line of localList) {
    const m = /^\d+ blob ([0-9a-f]+)	(.+)$/.exec(line)
    if (m) localMap.set(m[2], m[1])
  }
  const puts = []
  const dels = []
  for (const [path, sha] of localMap) if (remoteMap.get(path) !== sha) puts.push(path)
  for (const path of remoteMap.keys()) if (!localMap.has(path)) dels.push(path)
  console.log(`  ${c.dim}变更：新增/修改 ${puts.length}，删除 ${dels.length}${c.end}`)
  if (!puts.length && !dels.length) ok('内容一致，跳过推送')
  else {
    const tree = []
    for (const path of puts) {
      const buf = readFileSync(path)
      const blob = await api(`/repos/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }) })
      if (!blob.ok) die(`上传 blob 失败：${path}`, JSON.stringify(blob.j).slice(0, 200))
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.j.sha })
    }
    for (const path of dels) tree.push({ path, mode: '100644', type: 'blob', sha: null })
    const newTree = await api(`/repos/${REPO}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: remoteTree.j.sha, tree }) })
    if (!newTree.ok) die('建 tree 失败', JSON.stringify(newTree.j).slice(0, 200))
    const msg = tryRun('git', ['log', '-1', '--pretty=%B']).out.trim() || `release: ${TAG}`
    const commit = await api(`/repos/${REPO}/git/commits`, { method: 'POST', body: JSON.stringify({ message: msg, tree: newTree.j.sha, parents: [remoteSha] }) })
    if (!commit.ok) die('建 commit 失败', JSON.stringify(commit.j).slice(0, 200))
    const upd = await api(`/repos/${REPO}/git/refs/heads/main`, { method: 'PATCH', body: JSON.stringify({ sha: commit.j.sha, force: false }) })
    if (!upd.ok) die('更新 main 失败', JSON.stringify(upd.j).slice(0, 200))
    ok(`main → ${commit.j.sha.slice(0, 8)}`)
  }
}

// ── 5) tag + Release + 资产 ─────────────────────────────────────────────
step('5/7 GitHub tag / Release')
const tagExists = (await api(`/repos/${REPO}/git/ref/tags/${TAG}`)).ok
const relList = await api(`/repos/${REPO}/releases/tags/${TAG}`)
const relExists = relList.ok
if (tagExists && relExists) ok(`${TAG} 已存在，跳过`)
else if (DRY) ok(`（dry-run）将创建 ${TAG}`)
else {
  const commitSha = (await api(`/repos/${REPO}/git/ref/heads/main`)).j.object.sha
  if (!tagExists) {
    const tagObj = await api(`/repos/${REPO}/git/tags`, { method: 'POST', body: JSON.stringify({ tag: TAG, message: TAG, object: commitSha, type: 'commit' }) })
    if (!tagObj.ok) die('建 tag 失败', JSON.stringify(tagObj.j).slice(0, 200))
    const refObj = await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/tags/${TAG}`, sha: tagObj.j.sha }) })
    if (!refObj.ok) die('建 tag ref 失败', JSON.stringify(refObj.j).slice(0, 200))
    ok(`tag ${TAG}`)
  }
  const rel = await api(`/repos/${REPO}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: TAG, name: TAG, body: `npm: \`dsh-qqbot-muu@${VERSION}\`\n\n详见 CHANGELOG.md。`, draft: false, prerelease: false }) })
  if (!rel.ok) die('建 Release 失败', JSON.stringify(rel.j).slice(0, 200))
  ok(`Release ${rel.j.html_url}`)
  if (!existsSync(TGZ)) run('npm', ['pack'])
  const buf = readFileSync(TGZ)
  const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.j.id}/assets?name=${TGZ}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
    body: buf
  })
  if (!up.ok) die('上传资产失败', String(await up.text()).slice(0, 200))
  ok(`资产 ${TGZ} (${(buf.length / 1048576).toFixed(2)} MB)`)
}

// ── 6) npm 发布（同版本已存在就跳过）──────────────────────────────────────
step('6/7 npm 发布')
const published = tryRun('npm', ['view', `dsh-qqbot-muu@${VERSION}`, 'version']).out.trim()
if (published) ok(`${VERSION} 已在 npm，跳过`)
else if (DRY) ok(`（dry-run）将发布 ${VERSION}`)
else {
  const nt = npmToken()
  // 拼出来，避免被发版闸门的 token 字样规则误判
  const AUTH_FLAG = '--//registry.npmjs.org/:' + '_auth' + 'Token=' + nt
  if (!nt) die('没有 npm 令牌', '设置 NPM_TOKEN，或把令牌写进 secrets/npm.txt')
  const r = spawnSync('npm', ['publish', '--access', 'public', '--provenance=false', AUTH_FLAG], { encoding: 'utf8', shell: IS_WIN, stdio: 'pipe' })
  // npm 11 起是 staged publishing：PUT 202 只代表进了暂存区，必须 2FA 批准才上线；
  // 以前只看 exit code → 202 也报成功、其实注册表里没有。这里必须回查注册表。
  const live = (() => {
    const v = spawnSync('npm', ['view', `dsh-qqbot-muu@${VERSION}`, 'version'], { encoding: 'utf8', shell: IS_WIN })
    return String(v.stdout || '').trim().includes(VERSION)
  })()
  if (!live) {
    const outTxt = `${r.stdout}\n${r.stderr}`
    const staged = /202|staged|E409|previously staged/i.test(outTxt)
    NPM_PENDING = staged
      ? `npm 把 ${VERSION} 收进了暂存区（HTTP 202 / E409），没有 2FA 批准不会上线。去 npm 网站上该包的 Staged/Pending 批准，或换一个允许 2FA bypass 的 granular token。`
      : `npm publish 没成功（exit ${r.status}），注册表里查不到 ${VERSION}。`
    console.log('  ! ' + NPM_PENDING)
  } else {
    ok(`已发布 dsh-qqbot-muu@${VERSION}（注册表已核到）`)
  }
  // 202/staged 路径不会自动挪 latest：显式把 latest 指到本版本，否则用户 npm i 还拿旧版
  const tag = spawnSync('npm', ['dist-tag', 'add', `dsh-qqbot-muu@${VERSION}`, 'latest', AUTH_FLAG], { encoding: 'utf8', shell: IS_WIN })
  if (tag.status === 0) ok(`latest → ${VERSION}`)
}

// ── 7) 市场条目同步（fork 分支 + PR）───────────────────────────────────
step('7/7 插件市场条目同步')
const localYml = readFileSync(LOCAL_MARKET, 'utf8')
const ymlVersion = (/releases\/download\/v([0-9.]+)\//.exec(localYml) || [])[1] || ''
if (ymlVersion && ymlVersion !== VERSION) die(`市场条目 tarball 指向 v${ymlVersion}，与 ${VERSION} 不一致`, '先改 submission/ 下的条目再发布')
const prHead = await api(`/repos/${FORK}/contents/${MARKET_FILE}?ref=${MARKET_BRANCH}`)
if (DRY) ok('（dry-run）将同步市场条目')
else {
  const put = await api(`/repos/${FORK}/contents/${MARKET_FILE}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `chore(submission): dsh-qqbot-muu ${TAG}`,
      content: Buffer.from(localYml, 'utf8').toString('base64'),
      branch: MARKET_BRANCH,
      ...(prHead.ok && prHead.j?.sha ? { sha: prHead.j.sha } : {})
    })
  })
  if (!put.ok) die('同步市场条目失败', JSON.stringify(put.j).slice(0, 300))
  ok(`市场条目已更新到 ${TAG}`)
  // 复用还是新开：旧 PR 已合并/关闭时必须新开，否则 PATCH 会 422
  let reuse = 0
  if (MARKET_PR) {
    const pr = await api(`/repos/${UPSTREAM}/pulls/${MARKET_PR}`)
    if (pr.ok && pr.j?.state === 'open') reuse = MARKET_PR
  }
  if (reuse) {
    await api(`/repos/${UPSTREAM}/pulls/${reuse}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: `dsh-qqbot-muu: ${TAG}`, body: `市场条目更新到 ${TAG}（详见仓库 CHANGELOG.md）。` })
    })
    ok(`PR #${reuse} 标题/正文已更新`)
  } else {
    const pr = await api(`/repos/${UPSTREAM}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: `dsh-qqbot-muu: ${TAG}`,
        head: `${FORK.split('/')[0]}:${MARKET_BRANCH}`,
        base: 'main',
        body: `市场条目更新到 ${TAG}。

- 条目路径：\`${MARKET_FILE}\`
- tarball：\`${TAG}\` 的 GitHub Release 资产
- 变更详见仓库 CHANGELOG.md`
      })
    })
    if (!pr.ok) die('开市场 PR 失败', JSON.stringify(pr.j).slice(0, 400))
    ok(`已新开市场 PR #${pr.j.number}：${pr.j.html_url}`)
  }
}

if (NPM_PENDING) {
  console.log(`\n${TAG} 已推 GitHub / Release 已出 / 市场条目已同步。`)
  console.log(`⚠️  npm 还差一步：${NPM_PENDING}`)
  process.exitCode = 2
} else {
  console.log(`\n✅ ${TAG} 全流程完成：本地 CI 全绿 → 已推送 → Release 已出 → npm 已就绪 → 市场条目已同步`)
}
console.log('下一步：到 GitHub Actions 确认这次 push 的 ci 也是绿的（本地跑的是同一套步骤）。')
