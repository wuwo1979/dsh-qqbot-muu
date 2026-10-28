// overlay-check.mjs — 启动时自检「补丁是否还活着」（主人 2026-10-27 需求）
//
// 背景：所有定制都打在 profiles/.generations/live/…/@zaofan/dsh-qqbot 的文件上，
// 上游自动升级会换新的 generation（干净文件），补丁全部作废——10/25 记忆页消失、
// 10/27 群标题 Bug 都属于这一类「上游行为变了/文件被换、我们的补丁没跟上」。
//
// 做法：宿主启动时（本钩子被 ext-hooks 自动执行）逐一检查 live 宿主文件里的
// 「标志性代码片段」。缺失的补丁列出清单并打 warning 日志，同时写
// hooks/data/overlay-check.json 供浮窗/人工查看。**只读不写宿主文件**，
// 是否自动重放由 install.mjs / 各 fix-*.mjs 补丁脚本负责（--apply 可重放）。
//
// 自检方式：不依赖哈希基线（升级后行号/内容会漂），而是按「功能标记」检查——
// 每个定制在代码里都有唯一注释标记或特征串，标记在 = 补丁在。
import { readFileSync, existsSync, mkdirSync, writeFileSync, openSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 追加模式句柄（后台重放日志用） */
function fsOpenAppend(p) { try { return openSync(p, 'a') } catch { return 'ignore' } }

export async function run(env) {
  const logger = env.logger || console
  const out = { at: Date.now(), ok: true, missing: [], checks: [] }
  try {
    let hostDir = ''
    // 按 plugin-dir.mjs 同款规则解析 live 宿主目录（generation 最新 → profiles/web）
    const HOME = process.env.USERPROFILE || process.env.HOME || ''
    const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming')
    const GENROOT = join(APPDATA, 'dsh-desktop', 'harness', 'profiles', '.generations', 'live')
    const REL = 'node_modules/@zaofan/dsh-qqbot'
    let best = null
    try {
      const fsmod = await import('node:fs')
      for (const name of fsmod.readdirSync(GENROOT)) {
        const m = /^zaofan\+dsh-qqbot\+([^+]+)\+/.exec(name)
        if (!m) continue
        const dir = join(GENROOT, name, REL)
        if (!existsSync(join(dir, 'settings-host.js'))) continue
        const mt = fsmod.statSync(dir).mtimeMs
        const v = m[1].split('.').map(Number)
        const bv = best ? best.v : [-1]
        const newer = v[0] !== bv[0] ? v[0] > bv[0] : v[1] !== bv[1] ? v[1] > bv[1] : v[2] >= (bv[2] || 0)
        if (!best || newer) best = { dir, v, mt, name }
      }
    } catch { }
    if (!best) { logger.warn?.('[overlay-check] 找不到 live 宿主目录，跳过自检'); return 'no-host' }
    hostDir = best.dir

    // 每个定制一个探针：{ 文件, 标记, 说明, 补丁脚本 }
    const PROBES = [
      { file: 'settings-host.js', mark: 'known-chats-merge', desc: '聊天页目标下拉合并记忆库/判定日志', fix: 'fix-known-chats.mjs' },
      { file: 'settings-host.js', mark: 'groups-bom-tolerant', desc: 'groups.json BOM 容忍（群标题 Bug 修复 10/27）', fix: 'fix-groups-bom.mjs' },
      { file: 'settings-host.js', mark: 'group-title-fix', desc: '群聊标题不用群成员昵称兜底（10/27）', fix: 'fix-groups-bom.mjs' },
      { file: 'settings-host.js', mark: 'groups-trust-ledger-keep', desc: '群列表台账兜底不判死', fix: 'fix-groups-trust.mjs' },
      { file: 'settings-host.js', mark: '群名优先用群注册表', desc: '群名优先读 groups.json 注册表', fix: 'live-overlay/ours 重放' },
      { file: 'client/qqbot-settings.js', mark: '记忆', desc: '浮窗「记忆」页入口存在（抽查）', fix: 'install.mjs --apply' },
      { file: 'client/qqbot-settings.js', mark: 'llm-noloop', desc: '本地模型页原地刷新（取数死循环修复 10/27）', fix: 'install.mjs --apply' },
      { file: 'client/qqbot-settings.js', mark: 'api-timeout', desc: '浮窗 api 12s 超时（读取中不再无限转 10/27）', fix: 'install.mjs --apply' },
      { file: 'client/qqbot-settings.js', mark: 'bili-qr-login', desc: 'B站浮窗扫码登录（10/27）', fix: 'install.mjs --apply' },
      { file: 'client/qqbot-settings.js', mark: 'arm-confirm', desc: '两段式确认替代 window.confirm（10/27）', fix: 'install.mjs --apply' },
      { file: 'settings-host.js', mark: 'login-qr-start', desc: 'B站扫码登录服务端动作（10/27）', fix: 'install.mjs --apply' },
      { file: 'settings-host.js', mark: 'douyin-comments', desc: '浮窗抖音评论/日志/待审队列路由（10/27）', fix: 'install.mjs --apply' },
      { file: 'settings-host.js', mark: 'overview-cache 2026-10-27', desc: '总览 30s TTL+单飞缓存（10/27）', fix: 'install.mjs --apply' },
      { file: 'client/qqbot-settings.js', mark: 'acct-tabs 2026-10-27', desc: 'B站/抖音分页签（群聊/私聊式，10/27）', fix: 'install.mjs --apply' },
      { file: 'client/qqbot-settings.js', mark: 'creator.douyin.com', desc: '抖音 creator 新域名直达链接（10/27）', fix: 'install.mjs --apply' },
      { file: 'settings-host.js', mark: 'video-radar', desc: '视频雷达路由（10/27）', fix: 'install.mjs --apply' },
      { file: 'client/qqbot-settings.js', mark: 'video-radar', desc: '视频雷达页签（10/27）', fix: 'install.mjs --apply' },
      { file: 'client/qqbot-settings.js', mark: 'llm-tab-extbind 2026-10-27', desc: '本地模型页绑定本地代答/语音/工具报错卡（10/27）', fix: 'install.mjs --apply' },
      { file: 'settings-host.js', mark: 'lm-bases-permodel 2026-10-27', desc: '判定模型下载源按所选模型走（10/27）', fix: 'install.mjs --apply' },
    ]
    for (const p of PROBES) {
      const f = join(hostDir, p.file)
      let ok = false
      try { ok = existsSync(f) && readFileSync(f, 'utf8').includes(p.mark) } catch { }
      out.checks.push({ file: p.file, mark: p.mark, ok, desc: p.desc })
      if (!ok) { out.ok = false; out.missing.push({ ...p, file: f }) }
    }

    // 写自检结果（供浮窗/人工查看）
    try {
      const d = join(env.dataRoot || '', '.qqbot-extensions', 'hooks', 'data')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'overlay-check.json'), JSON.stringify(out, null, 1), 'utf8')
    } catch { }

    if (out.ok) {
      logger.info?.(`[overlay-check] 补丁自检通过：${out.checks.length}/${out.checks.length}（宿主 ${best.name}）`)
    } else {
      logger.warn?.(`[overlay-check] ⚠️ 检测到 ${out.missing.length} 个定制缺失（多半是上游升级换了 generation）——`)
      for (const m of out.missing) logger.warn?.(`[overlay-check]   ✗ ${m.desc}（标记 ${m.mark} 不在 ${m.file}；重放：qqbot-mod/patches/${m.fix}${String(m.fix).endsWith('.mjs') ? ' --apply' : ''}）`)
      logger.warn?.('[overlay-check]   修复方式：node F:/qqbot/qqbot-mod/patches/<对应脚本> --apply，或 live-overlay/install.mjs --apply 三路合并整体重放')
      // ── 自动重放（主人 2026-10-27：上游升级不能影响我们）──
      // 走三路合并（base=官方基线 / ours=定制 / live=新 generation），只撞行才冲突，冲突不写盘。
      // 护栏：① 环境变量 QQBOT_AUTO_REPLAY=0 关闭；② 同一 generation 最多自动试 2 次；
      //      ③ 5 分钟内不重复触发；④ 后台 detached 执行，绝不阻塞启动；dry=1 只打印命令。
      try {
        const AUTO = String(process.env.QQBOT_AUTO_REPLAY ?? '1') !== '0'
        const DRY = String(process.env.QQBOT_REPLAY_DRY ?? '') === '1'
        const REPO = 'F:/qqbot'
        const INSTALLER = REPO + '/qqbot-mod/patches/live-overlay/install.mjs'
        const stateDir = join(env.dataRoot || '', '.qqbot-extensions', 'hooks', 'data')
        const statePath = join(stateDir, 'overlay-replay-state.json')
        let st = {}
        try { st = JSON.parse(readFileSync(statePath, 'utf8')) || {} } catch { }
        if (!AUTO) {
          logger.info?.('[overlay-check] 自动重放已关闭（QQBOT_AUTO_REPLAY=0），只告警')
        } else if (st.generation === best.name && (st.attempts || 0) >= 2) {
          logger.warn?.('[overlay-check] 同一 generation 已自动重放 2 次仍有缺失，停止自动重放（请人工跑 install.mjs --apply 看冲突报告）')
        } else if ((st.lastAt || 0) > Date.now() - 5 * 60_000) {
          logger.info?.('[overlay-check] 5 分钟内刚触发过自动重放，跳过本轮')
        } else if (DRY) {
          logger.info?.(`[overlay-check] [dry] 将执行：node "${INSTALLER}" --apply`)
          out.replay = 'dry'
        } else {
          const { spawn } = await import('node:child_process')
          const logPath = join(stateDir, 'overlay-replay.log')
          mkdirSync(stateDir, { recursive: true })
          const child = spawn(process.execPath, [INSTALLER, '--apply'], {
            cwd: REPO, detached: true, stdio: ['ignore', fsOpenAppend(logPath), fsOpenAppend(logPath)],
          })
          child.unref()
          st = { generation: best.name, attempts: (st.generation === best.name ? (st.attempts || 0) : 0) + 1, lastAt: Date.now(), pid: child.pid }
          try { mkdirSync(stateDir, { recursive: true }); writeFileSync(statePath, JSON.stringify(st, null, 1), 'utf8') } catch { }
          logger.info?.(`[overlay-check] 已后台触发补丁自动重放（pid ${child.pid}，日志 ${logPath}，第 ${st.attempts} 次尝试）`)
          out.replay = { pid: child.pid, attempts: st.attempts }
        }
      } catch (eReplay) {
        logger.warn?.('[overlay-check] 自动重放触发失败（不影响启动）：' + String((eReplay && eReplay.message) || eReplay))
      }
    }
    return out.ok ? 'ok' : `missing:${out.missing.length}`
  } catch (e) {
    try { logger.warn?.('[overlay-check] 自检异常（不影响启动）：' + String((e && e.message) || e)) } catch { }
    return 'error'
  }
}

export async function dispose() { /* 只读自检，无需清理 */ }
