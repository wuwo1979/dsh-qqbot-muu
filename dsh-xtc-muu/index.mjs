/**
 * dsh-xtc-muu/index.mjs —— 小天才通道插件（2026-11-13）
 *
 * 对标 dsh-wechat-muu，但服务「小天才」这个独立儿童聊天平台（无 wxid，用 xtcId）。
 * 本插件是 小蓝 大脑里的一条**儿童专用通道**：专门陪家里的小朋友聊天。
 *
 * 与微信侧完全隔离：消息来自 xtc-bridge（HTTP 拉取），不走微信桥接。
 * 复用：
 *   · 小蓝人设（muuPersona）/ agentPresets / 默认模型（与 dsh-wechat-muu 同一套大脑 API）；
 *   · qqbot-mod/kids-mode.mjs（儿童对话须知 + 风险扫描 + 监护人提醒，平台无关，微信/小天才共享）。
 *
 * 交互流程：桥轮询小天才设备 → 入站消息入队 → 本插件拉取 → 走小蓝 agent（儿童人格）→
 *   回复经桥发回小天才；机器人用 xtc_persona_note 把对小朋友的了解写进印象卡。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

/**
 * 仓库根（2026-11-14）：优先 QQBOT_REPO_ROOT，其次从本文件位置上溯，最后回落 F:/qqbot。
 *
 * 为什么必须兜底：DSH 用 pnpm 的 file: 依赖把本插件**复制**进
 * profiles/web/node_modules/.pnpm/dsh-xtc-muu@…/node_modules/dsh-xtc-muu/，
 * 复制后本文件的上一级是 node_modules 而不是仓库根，`../qqbot-mod/…` 这种相对 import
 * 会直接 ERR_MODULE_NOT_FOUND。xtc-muu 是 required 插件，一挂 DSH 就判定
 * 「1 required plugin did not activate」→ 掉进安全模式（2026-11-14 事故）。
 * 所以仓库内的共享模块一律走 REPO_ROOT 动态 import（与 dsh-wechat-muu 同一套写法）。
 */
function pickRepoRoot() {
  const cands = [
    String(process.env.QQBOT_REPO_ROOT || '').trim(),
    resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    'F:/qqbot',
  ].filter(Boolean)
  return cands.find((p) => { try { return existsSync(join(p, 'wechat-bridge', 'util.mjs')) } catch { return false } }) || cands[cands.length - 1]
}
const REPO_ROOT = pickRepoRoot()

// 统一记忆库（2026-11-13）：和 QQ / 微信共用同一份 memory.db，不再各自一套。
// 渠道之间只允许「近期上下文」不同（recentContext），长期记忆必须是同一个库。
const QQ_DATA_ROOT = String(process.env.QQBOT_MEMORY_DATA_ROOT || join(REPO_ROOT, 'dshqqbot'))
const MEM_LIB_URL = pathToFileURL(join(REPO_ROOT, 'dshqqbot', '.qqbot-extensions', 'lib', 'memory.mjs')).href
// 跨渠道台账 + 人物归一（2026-11-13）
const CHANNEL_LIB_URL = pathToFileURL(join(REPO_ROOT, 'dshqqbot', '.qqbot-extensions', 'lib', 'channel-store.mjs')).href
const PERSON_LIB_URL = pathToFileURL(join(REPO_ROOT, 'dshqqbot', '.qqbot-extensions', 'lib', 'person-link.mjs')).href
// 回合后记忆分身（提炼事实/印象卡/心情）——和 QQ 共用同一个实现，否则小天才这边永远没有印象卡
const AGENT_LIB_URL = pathToFileURL(join(REPO_ROOT, 'dshqqbot', '.qqbot-extensions', 'lib', 'memory-agent.mjs')).href
const LLM_LIB_URL = pathToFileURL(join(REPO_ROOT, 'dshqqbot', '.qqbot-extensions', 'lib', 'local-llm.mjs')).href
const VISION_LIB_URL = pathToFileURL(join(REPO_ROOT, 'dshqqbot', '.qqbot-extensions', 'lib', 'vision.mjs')).href
// 共享：微信 / 小天才 通道都从这里读小蓝人设/预设（单一来源，QQ 改了这边自动跟上）
const { loadMuuSettings } = await import(pathToFileURL(join(REPO_ROOT, 'qqbot-mod', 'muu-shared.mjs')).href)
const KIDS_MODE_URL = pathToFileURL(join(REPO_ROOT, 'qqbot-mod', 'kids-mode.mjs')).href

function makeUserMessage(input) {
  return { ...input, role: 'user', id: `msg-${randomUUID()}` }
}

/** dumpsys 里 `android.title=String (小朋友)` → `小朋友` */
function cleanNotifValue(v) {
  let s = String(v || '').trim()
  s = s.replace(/^(?:String|SpannableString|CharSequence)\s*\(/, '')
  if (s.endsWith(')')) s = s.slice(0, -1)
  return s.trim()
}

/**
 * 判断一段入站正文是不是「不可用」的假消息：
 * 星号遮蔽、半截 JSON（`{`、`}`、`{"`）、空串、null、通知条数前缀。
 * 命中就不回、不沉淀 —— 免得对着噪声说话。
 */
export function isJunkText(v) {
  const s = String(v ?? '').trim()
  if (!s) return true
  if (s === 'null' || s === 'undefined') return true
  if (/^\*+$/.test(s)) return true
  if (/^[{}[\],:"']+$/.test(s)) return true
  if (/^\[\d+条\]/.test(s)) return true
  return false
}

/**
 * 手表/系统的提示不是小朋友说的话：充电、电量、连接、守护、升级……
 * 命中就不回、不入聊天记录（否则会对着「手表充电完成」聊起来）。
 */
export function isSystemText(v) {
  const s = String(v ?? '').trim()
  if (!s) return true
  return /手表.{0,8}(充电|电量|充满|开机|关机|连接|离线|在线|升级|更新)|充电完成|正在充电|电量低|已充满|守护中|网络不可用|和你一起陪伴孩子成长/.test(s)
}

/**
 * 从 `dumpsys notification --noredact` 里抠出小天才 App 的消息通知。
 * 只读文本，不点屏、不注入 —— 手表 App 自己的通知就是最可靠的「收到消息」信号。
 * @returns {Array<{title:string,text:string,postTime:number}>}
 */
export function parseXtcNotifications(dump) {
  const out = []
  const blocks = String(dump || '').split(/NotificationRecord\(/).slice(1)
  for (const b of blocks) {
    if (!/pkg=com\.xtc\.watch/.test(b)) continue
    let title = '', text = '', big = '', ticker = '', postTime = 0
    for (const raw of b.split('\n')) {
      const line = raw.trim()
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq)
      const v = line.slice(eq + 1)
      if (k === 'android.title') title = cleanNotifValue(v)
      else if (k === 'android.text') text = cleanNotifValue(v)
      else if (k === 'android.bigText') big = cleanNotifValue(v)
      else if (k === 'tickerText') ticker = cleanNotifValue(v)
      else if (k === 'postTime') postTime = Number(cleanNotifValue(v)) || 0
      else if (k === 'when') postTime = postTime || (Number(cleanNotifValue(v)) || 0)
    }
    const body = text || big || ticker
    if (!body) continue
    // 服务通知（「小天才 守护中…」）不是聊天消息
    if (/守护中|已连接|正在守护/.test(title + body)) continue
    out.push({ title, text: body, postTime })
  }
  return out
}

export const name = 'xtc-muu'
export const inject = ['agents', 'tools', 'systemPrompt']

export const Config = Schema.object({
  settingsPath: Schema.string().default(''),
  bridgeUrl: Schema.string().default('http://127.0.0.1:4331'),
  bridgeDir: Schema.string().default('F:/qqbot/xtc-bridge'),
  pollIntervalMs: Schema.number().default(3000),
  replyTimeoutMs: Schema.number().default(120000),
  replyMode: Schema.union(['full', 'last']).default('full'),
  stateDir: Schema.string().default(''),
  botAliases: Schema.string().default('小蓝,小蓝姐姐,蓝蓝'),
  /** 通知监听兜底（2026-11-13）：frida 与手表 App 互斥，改为只读 dumpsys notification 取消息 */
  notifWatch: Schema.boolean().default(true),
  notifIntervalMs: Schema.number().default(5000),
  adbPath: Schema.string().default('F:/tools/pt/platform-tools/adb.exe'),
  deviceSerial: Schema.string().default('HA1TPTBF'),
})

export class XtcChannel {
  constructor(ctx, config) {
    this.ctx = ctx
    this.cfg = config
    this.log = ctx.logger ?? console
    this.stateDir = config.stateDir || join(process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || '.', '.dsh', 'dsh-xtc-muu')
    try { mkdirSync(this.stateDir, { recursive: true }) } catch { /* ignore */ }

    const muu = loadMuuSettings(config.settingsPath)
    const d = muu.data || {}
    this.muuPreset = (typeof d.preset === 'string' && d.preset.trim()) ? d.preset.trim() : 'standard'
    this.muuCwd = (typeof d.cwd === 'string' && d.cwd.trim()) ? d.cwd.trim() : REPO_ROOT
    this.muuPersona = (typeof d.groupPrompt === 'string' && d.groupPrompt.trim()) ? d.groupPrompt.trim() : ''
    this.pushLog(muu.file
      ? `人格源：${muu.file}（preset=${this.muuPreset}，人设 ${this.muuPersona.length} 字）`
      : '⚠️ 未找到 qqbot-muu 设置，人设将为空')

    this.sessionMap = Object.create(null)
    // 会话要落盘：重启后按同一个人 resume，别每条消息都新开一个会话（白烧 token）
    this._sessFile = join(QQ_DATA_ROOT, '.qqbot', 'xtc-sessions.json')
    try {
      if (existsSync(this._sessFile)) {
        const saved = JSON.parse(readFileSync(this._sessFile, 'utf8'))
        for (const [k, v] of Object.entries(saved || {})) if (v && v.sid) this.sessionMap[k] = { sid: v.sid, turns: Number(v.turns) || 0 }
      }
    } catch { /* 坏文件就重建 */ }
    this.collectors = new Map()
    this.pending = new Map()
    this.recentReplies = new Map()
    this.childBlock = ''              // 儿童对话须知（异步拉取小朋友人物卡后填充）
    this.KIDS = null
    this._polling = false
    this.status = {
      lastPollAt: null, lastEventAt: null, lastError: null, startedAt: Date.now(), replied: 0,
      bridgeOk: false, lastBridgeAt: null,
    }

    this._fetchChildBlock()           // 异步：加载儿童安全库 + 拉取小朋友人物卡，填充 childBlock

    this._registerSystemPrompt()
    this.ctx.on('session/event', (session, event) => this.handleSessionEvent(session, event))
    this.start()
  }

  async _ensureKids() {
    if (this.KIDS) return this.KIDS
    try {
      this.KIDS = await import(KIDS_MODE_URL)
    } catch (e) { this.pushLog(`儿童安全库加载失败：${e?.message || e}`) }
    return this.KIDS
  }

  async _fetchChildBlock() {
    const KIDS = await this._ensureKids()
    if (!KIDS) return
    try {
      const r = await this.http('/xtc/people', { timeoutMs: 6000 })
      const list = Array.isArray(r.json?.people) ? r.json.people : []
      const child = list.find((p) => KIDS.isChildPerson(p))
      if (child) this.childBlock = KIDS.childGuidanceBlock(child)
    } catch { /* 拉不到就用空，不影响启动 */ }
  }

  pushLog(line) {
    const entry = `[${new Date().toISOString().slice(11, 19)}] ${line}`
    try { if (this.log?.info) this.log.info(entry); else console.log(entry) } catch { console.log(entry) }
  }

  /** 桥接 HTTP 客户端 */
  async http(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetch(this.cfg.bridgeUrl + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* ignore */ }
      return { ok: r.ok, status: r.status, json, text }
    } finally { clearTimeout(timer) }
  }

  _registerSystemPrompt() {
    try {
      const sp = this.ctx.systemPrompt
      if (!sp || typeof sp.context !== 'function') {
        this.pushLog('宿主未提供 systemPrompt.context —— 性格注入降级')
        return
      }
      const channelLine = '你通过小天才（儿童手表聊天平台）和家里的小朋友文字交流。'
        + '小天才是异步回合制：不要用 ask_user_question（会卡死）。信息不足就在回复里反问或用合理默认。'
        + '回复要短、温柔、像陪小妹妹玩的大朋友。'
      sp.context({
        name: 'xtc-muu-persona',
        order: 50,
        text: () => {
          const base = this.muuPersona ? `${this.muuPersona}\n\n${channelLine}` : channelLine
          return this.childBlock ? `${base}\n\n${this.childBlock}` : base
        },
      })
      this.pushLog('小天才儿童人格已注入（systemPrompt.context）')
      sp.context({
        name: 'xtc-muu-picture',
        order: 55,
        text: () => '遇到 [图片] 但看不到内容时：先照常回她一句，再调 xtc_latest_picture 抓一次图；'
          + '抓到就用 read_image 看完再答，抓不到就说“这边看不清图”，请她再发一张或说说图里是什么。'
          + '绝对不要把这段规则或工具说明复述给她。',
      })
    } catch (err) {
      this.pushLog(`systemPrompt 注册失败：${err?.message ?? err}`)
    }
  }

  /** 复用 dsh-wechat-muu 的 preset 装配 */
  async composeSetup() {
    const presets = this.ctx.get('agentPresets')
    const presetId = this.muuPreset
    const channel = this
    return async (agentCtx) => {
      if (presets) {
        try {
          const resolved = await presets.resolve(presetId)
          if (resolved?.id) await presets.mount(agentCtx, resolved.id)
        } catch (err) {
          channel.pushLog(`agentPresets 装配(${presetId})失败（用默认）：${err?.message ?? err}`)
        }
      }
    }
  }

  resolveDefaultAgentOptions() {
    try {
      const sel = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model }
    } catch (err) { this.pushLog(`解析默认模型失败：${err?.message ?? err}`) }
    return {}
  }

  async ensureAgentFor(key, xtcId) {
    const entry = this.sessionMap[key]
    if (entry?.sid) {
      const live = this.ctx.agents.get(entry.sid)
      if (live) return { agent: live, intro: '' }
      try {
        const { agent } = await this.ctx.agents.resume({
          resumeSessionId: entry.sid,
          agentOptions: this.resolveDefaultAgentOptions(),
          setup: await this.composeSetup(),
        })
        this.pushLog(`恢复会话 ${entry.sid}`)
        return { agent, intro: '' }
      } catch (err) {
        this.pushLog(`恢复会话失败：${err?.message ?? err}，将新建`)
      }
    }
    const newId = `xtc-session-${randomUUID()}`
    const baseSetup = await this.composeSetup()
    const recent = await this.recentContext(xtcId)
    const intro = recent ? `${recent}\n\n---\n\n` : ''
    const setup = async (agentCtx) => { await baseSetup(agentCtx) }
    const { agent } = await this.ctx.agents.create({
      sessionId: newId,
      agentOptions: this.resolveDefaultAgentOptions(),
      meta: { cwd: this.muuCwd },
      setup,
    })
    this.sessionMap[key] = { sid: newId, turns: 0 }
    this._saveSessions()
    this.pushLog(`新建会话 ${newId}（${key}${recent ? '，已回灌近期历史' : ''}）`)
    return { agent, intro }
  }

  _saveSessions() {
    try { writeFileSync(this._sessFile, JSON.stringify(this.sessionMap, null, 1), 'utf8') } catch { /* 写不了下次再试 */ }
  }

  async recentContext(xtcId) {
    try {
      const r = await this.http(`/xtc/messages?convId=${encodeURIComponent(xtcId)}&limit=8`, { timeoutMs: 8000 })
      const list = Array.isArray(r.json?.messages) ? r.json.messages : []
      if (!list.length) return ''
      const lines = list.map((m) => {
        const who = m.dir === 'out' ? '我' : (m.sender || '小朋友')
        const t = String(m.text || '').replace(/\s+/g, ' ').slice(0, 60)
        return `${who}：${t}`
      })
      return '## 最近聊的（供接话）\n' + lines.join('\n')
    } catch { return '' }
  }

  /** 侧车端口自愈：以 xtc-bridge/.port 里的实际端口为准（没有就用配置） */
  _syncBridgePort() {
    try {
      const p = Number(readFileSync(join(REPO_ROOT, 'xtc-bridge', '.port'), 'utf8').trim())
      if (p > 0 && p < 65536) {
        const url = `http://127.0.0.1:${p}`
        if (url !== this.cfg.bridgeUrl) {
          this.pushLog(`小天才通道：侧车实际端口 ${p}，改用 ${url}`)
          this.cfg.bridgeUrl = url
        }
      }
    } catch { /* 没文件就用配置 */ }
  }

  start() {
    this._syncBridgePort()
    const tick = async () => {
      if (this._polling) return
      this._polling = true
      try {
        const r = await this.http('/xtc/inbound/pull', { timeoutMs: 8000 })
        this.status.lastPollAt = Date.now()
        this.status.lastError = null
        const msgs = Array.isArray(r.json?.messages) ? r.json.messages : []
        // 入站去重（2026-11-13 修订）：先去重会丢素材，用户口径是「只有时间戳+来源+用户
        // 都相同的重复收集才去重」。所以这里先落台账（appendChat 自带 msgId/指纹幂等），
        // 去重只决定「要不要回这条」，不决定「要不要记」。
        if (!this._seenXtc) this._seenXtc = new Map()
        for (const m of msgs) {
          const from = String(m.from)
          const body = String(m.text || '').slice(0, 60)
          const id = String(m.id ?? m.msgId ?? m.seq ?? '')
          const tsRaw = Number(m.ts ?? m.at ?? 0)
          const ts = tsRaw > 1e12 ? tsRaw : tsRaw > 1e9 ? tsRaw * 1000 : Date.now()
          try {
            const recKey = `rec:${from}|${String(m.text || '').trim()}`
            const recPrev = this._seenXtc.get(recKey) || 0
            const dupRow = Date.now() - recPrev < 120000
            if (!dupRow && !isJunkText(m.text) && !isSystemText(m.text)) {
              await this.recordInbound(from, String(m.text || ''), id, ts, String(m.kind || m.type || 'text'))
              this._seenXtc.set(recKey, Date.now())
            }
          } catch { /* 台账失败不影响回复 */ }
          const now = Date.now()
          const k1 = `${from}|${id || m.ts || ''}|${body}`
          const k2 = `t:${from}|${body}`
          const p1 = this._seenXtc.get(k1)
          const p2 = this._seenXtc.get(k2)
          if (isJunkText(m.text) || isSystemText(m.text)) {
            this.pushLog(`系统/噪声消息，不回：${String(m.text || '').slice(0, 24)}`)
            continue
          }
          if ((p1 && now - p1 < 30 * 60 * 1000) || (p2 && now - p2 < 120 * 1000)) {
            this.pushLog(`小天才入站去重：已入库、不重复回（${from}）`)
            continue
          }
          this._seenXtc.set(k1, now)
          this._seenXtc.set(k2, now)
          if (this._seenXtc.size > 2000) {
            for (const [k, v] of this._seenXtc) { if (now - v > 30 * 60 * 1000) this._seenXtc.delete(k) }
          }
          try { await this.processInbound(from, String(m.text || '')) } catch (e) { this.pushLog(`处理消息失败：${e?.message ?? e}`) }
        }
      } catch (e) {
        // 桥未起/网络问题：仅记日志，不刷屏
        this.status.lastError = e?.message ?? String(e)
        this.pushLog(`拉取小天才入站失败：${e?.message ?? e}`)
      } finally { this._polling = false }
    }
    this._timer = setInterval(tick, Math.max(1000, Number(this.cfg.pollIntervalMs || 3000)))
    this._startHeal()
    void this.chatLib()
    this._startNotifWatch()
    // 积压补回(2026-11-13): 重启期间小朋友发来的消息，20 秒后合成一条注入，让 agent 接着回
    setTimeout(() => { void this._catchup() }, 20000)
    if (this._catchupTimer) clearInterval(this._catchupTimer)
    this._catchupTimer = setInterval(() => { void this._catchup() }, 3 * 60 * 1000)
    this.pushLog(`小天才通道轮询已启动（间隔 ${this.cfg.pollIntervalMs}ms）`)
  }

  /** 桥接保活：/health 不通就拉起 xtc-bridge（5 分钟冷却，同微信桥 self-heal 思路）
   *  2026-11-14：启动 5 秒后先强探一次——以前要等两次 60s tick（约 2 分钟）才拉起，
   *  重启后那两分钟面板就是「连接异常」，人以为坏了。 */
  _startHeal() {
    this._healFails = 0
    this._lastHealAt = 0
    this._healTimer = setInterval(() => this._healTick(), 60000)
    setTimeout(() => { void this._healTick(true) }, 5000)
  }

  /** 跑 sidecar 用哪个 python：优先绝对路径（桌面端 PATH 里不一定有 python）。 */
  _pythonBin() {
    const cands = [
      String(process.env.XTC_PYTHON || '').trim(),
      'E:/Anaconda/python.exe',
      'C:/Python311/python.exe',
      'C:/Python312/python.exe',
      'C:/Python310/python.exe',
    ].filter(Boolean)
    for (const p of cands) { try { if (existsSync(p)) return p } catch { /* ignore */ } }
    return 'python'
  }

  /** 通知监听兜底：frida 与手表 App 互斥（frida-server 一挂 App 就被反调试），
   *  所以收消息改走「只读 dumpsys notification」——不碰 frida、不点屏、不注入。 */
  _startNotifWatch() {
    if (!this.cfg.notifWatch || this._notifTimer) return
    const ms = Math.max(3000, Number(this.cfg.notifIntervalMs || 5000))
    this._notifSeen = new Map()
    this._notifTimer = setInterval(() => { void this._notifTick() }, ms)
    setTimeout(() => { void this._notifTick() }, 8000)
    this.pushLog(`小天才通知监听已启动（只读，间隔 ${ms}ms）`)
  }

  async _notifTick() {
    if (this._notifBusy) return
    this._notifBusy = true
    try {
      const adb = this.cfg.adbPath || 'F:/tools/pt/platform-tools/adb.exe'
      const serial = this.cfg.deviceSerial || 'HA1TPTBF'
      if (!existsSync(adb)) return
      const dump = await this._exec(adb, ['-s', serial, 'shell', 'dumpsys', 'notification', '--noredact'], 20000)
      const list = parseXtcNotifications(dump)
      if (!list.length) return
      const peers = this._peers()
      const peerIds = Object.keys(peers)
      if (!peerIds.length) return
      const now = Date.now()
      for (const m of list) {
        let t = String(m.text || '').trim()
        if (!t || t.length > 500) continue
        if (m.postTime && now - m.postTime > 30 * 60 * 1000) continue
        let xtcId = ''
        // 通知正文常带「小朋友：…」，标题里有时也带
        for (const id of peerIds) {
          const nm = String(peers[id] || '')
          if (!nm) continue
          const re = new RegExp(`^${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`)
          if (re.test(t)) { xtcId = id; t = t.replace(re, ''); break }
        }
        if (!xtcId) xtcId = peerIds.find((id) => m.title && m.title.includes(String(peers[id] || ''))) || (peerIds.length === 1 ? peerIds[0] : '')
        if (!xtcId) continue
        // 应用自己的汇总通知（「[1条]:…」）不是正文；空串/null 也不入
        if (!t || t === 'null' || /^\[\d+条\]/.test(t)) continue
        // 自己刚发出去的回声不算入站
        if (this._sentXtc && this._sentXtc.has(`${xtcId}|${t}`)) continue
        // 先落台账：同一条通知的 postTime 不变 → msgId 不变 → 幂等合并；
        // 10 分钟去重只决定「这次还回不回」，不再决定「记不记」。
        await this.recordInbound(xtcId, t, `notif-${m.postTime || now}`, m.postTime || now, 'notif').catch(() => {})
        const k = `${xtcId}|${m.title}|${t}`
        const last = this._notifSeen.get(k)
        if (last && now - last < 3 * 60 * 1000) continue
        this._notifSeen.set(k, now)
        this.pushLog(`通知入站：${peers[xtcId] || xtcId} ${t.slice(0, 30)}`)
        await this.processInbound(xtcId, t)
      }
      if (this._notifSeen.size > 500) {
        for (const [k, v] of this._notifSeen) if (now - v > 30 * 60 * 1000) this._notifSeen.delete(k)
      }
    } catch (e) {
      if (!this._notifErrAt || Date.now() - this._notifErrAt > 60000) {
        this._notifErrAt = Date.now()
        this.pushLog(`通知监听失败：${e?.message ?? e}`)
      }
    } finally { this._notifBusy = false }
  }

  _peers() {
    try {
      const f = join(QQ_DATA_ROOT, '.qqbot', 'xtc-peers.json')
      if (!existsSync(f)) return {}
      return JSON.parse(readFileSync(f, 'utf8')) || {}
    } catch { return {} }
  }

  /** 跑一条外部命令，拿 stdout（超时杀进程） */
  _exec(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ch = spawn(cmd, args, { windowsHide: true })
      let out = ''
      let done = false
      const timer = setTimeout(() => { try { ch.kill() } catch { /* ignore */ } if (!done) { done = true; resolve(out) } }, timeoutMs)
      ch.stdout?.on('data', (d) => { if (out.length < 4_000_000) out += d.toString('utf8') })
      ch.stderr?.on('data', () => {})
      ch.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e) })
      ch.on('close', () => { if (done) return; done = true; clearTimeout(timer); resolve(out) })
    })
  }

  /** 手动抓一次图片：去找平板上最近落盘的聊天图片，拉回本地。
   *  有些图只在聊天页渲染时存在、不落盘；这时会明确返回 not_found，而不是让回复卡住。 */
  async grabLatestPicture(maxAgeMin = 30) {
    const adb = this.cfg.adbPath || 'F:/tools/pt/platform-tools/adb.exe'
    const serial = this.cfg.deviceSerial || 'HA1TPTBF'
    const dirs = [
      '/sdcard/Android/data/com.xtc.watch/cache/big_image/com.xtc.watch',
      '/data/data/com.xtc.watch/cache/libCachedImageData',
      '/data/data/com.xtc.watch/cache/image_manager_disk_cache',
    ]
    const findCmd = `find ${dirs.join(' ')} -type f -mmin -${maxAgeMin} -size +3k -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -3`
    let list = ''
    try { list = (await this._exec(adb, ['-s', serial, 'shell', `su -c "${findCmd.replace(/"/g, '\\"')}"`], 15000)).trim() } catch { list = '' }
    const remote = list.split(/\r?\n/).map((s) => s.trim().split(/\s+/).slice(1).join(' ')).filter(Boolean)[0]
    if (!remote) return { ok: false, reason: 'not_found', hint: '平板上没有最近落盘的图片（可能只在聊天页缓存里）' }
    const ext = (remote.match(/\.(jpg|jpeg|png|webp)$/i) || [])[1] || 'bin'
    const local = join(this.dataRoot, 'tmp', `xtc-latest-${Date.now()}.${ext}`)
    try { mkdirSync(join(this.dataRoot, 'tmp'), { recursive: true }) } catch { /* ignore */ }
    const buf = await new Promise((resolve, reject) => {
      const ch = spawn(adb, ['-s', serial, 'exec-out', `su -c "cat '${remote}'"`], { windowsHide: true })
      const chunks = []
      ch.stdout?.on('data', (d) => chunks.push(d))
      ch.on('error', reject)
      ch.on('close', () => resolve(Buffer.concat(chunks)))
    })
    if (!buf || buf.length < 1000) return { ok: false, reason: 'empty', remote }
    const jpg = buf[0] === 0xff && buf[1] === 0xd8
    const png = buf[0] === 0x89 && buf[1] === 0x50
    const realExt = jpg ? 'jpg' : png ? 'png' : 'bin'
    const file = local.replace(/\.(bin|jpg|png|webp|jpeg)$/i, `.${realExt}`)
    writeFileSync(file, buf)
    return { ok: true, path: file, remote, bytes: buf.length }
  }

  /** 起「改名 + 自定义端口」的 frida-server 并建 adb 转发。
   *  com.xtc.watch 会检测默认 /data/local/tmp/frida-server 与 27042 端口；
   *  实测改成 fsd2 + -l 0.0.0.0:5555 后 App 不再被反调试杀掉。 */
  async _ensureFrida() {
    const adb = this.cfg.adbPath || 'F:/tools/pt/platform-tools/adb.exe'
    const serial = this.cfg.deviceSerial || 'HA1TPTBF'
    const remote = this.cfg.fridaRemote || '127.0.0.1:5555'
    const port = String(remote).split(':').pop() || '5555'
    try {
      // [2026-11-16] 平板/手表重启后 adb 守护进程常「活着但设备列表为空」，
      // forward 建不起来 → frida 连 127.0.0.1:5555 永远失败，面板一直离线。
      // 先确认设备在不在，不在就重建 adb 守护（实测这一步能救回来）。
      const devs = String(await this._exec(adb, ['devices'], 8000))
      const online = devs.split(/\r?\n/).some((ln) => {
        const s = ln.trim()
        if (!s || /^List of devices/.test(s)) return false
        const parts = s.split(/\s+/)
        return parts[0] === serial && parts[1] === 'device'
      })
      if (!online) {
        this.pushLog('adb 看不到设备，重建 adb 守护后再连')
        await this._exec(adb, ['kill-server'], 8000)
        await new Promise((r) => setTimeout(r, 1200))
        await this._exec(adb, ['start-server'], 8000)
        await new Promise((r) => setTimeout(r, 3000))
      }
      // 默认名/默认端口会被 App 反调试检测（一挂就自杀、反复重启、每轮弹 adb 窗口）；
      // 一旦发现残留的默认 frida-server 就清掉，只留改名+改端口的 fsd2。
      const bad = String(await this._exec(adb, ['-s', serial, 'shell', "su -c 'pidof frida-server'"], 8000)).trim()
      if (bad) {
        await this._exec(adb, ['-s', serial, 'shell', `su -c 'kill -9 ${bad.split(/\s+/).join(' ')}'`], 8000)
        this.pushLog(`清掉默认 frida-server（${bad}），避免小天才被反调试反复重启`)
      }
      const pid = String(await this._exec(adb, ['-s', serial, 'shell', "su -c 'pidof fsd2'"], 8000)).trim()
      if (!pid) {
        await this._exec(adb, ['-s', serial, 'shell', `su -c 'nohup /data/local/tmp/fsd2 -l 0.0.0.0:${port} >/dev/null 2>&1 &'`], 12000)
        await new Promise((r) => setTimeout(r, 1500))
      }
      await this._exec(adb, ['-s', serial, 'forward', `tcp:${port}`, `tcp:${port}`], 8000)
    } catch (e) { this.pushLog(`frida 远端准备失败：${e?.message ?? e}`) }
  }

  async _healTick(force = false) {
    try {
      const r = await this.http('/health', { timeoutMs: 4000 })
      if (r.ok) { this._healFails = 0; return }
    } catch { /* 不可达，走下面计数 */ }
    this._healFails += 1
    // 设备重启/断连后要尽快自己爬起来：90 秒一次退避重试（以前 5 分钟，面板会长时间显示连不上）
    if (Date.now() - this._lastHealAt < 90000) return
    if (!force && this._healFails < 2) return
    this._lastHealAt = Date.now()
    this._healFails = 0
    try {
      const { spawn } = await import('node:child_process')
      const dir = this.cfg.bridgeDir || 'F:/qqbot/xtc-bridge'
      const out = openSync(join(dir, 'bridge.log'), 'a')
      // 2026-11-14: 端口可能因 Windows 保留端口而自愈顺延（4711/4740/…），
      // 所以不再按固定端口判断——只有旧 node 桥(4331/4332)才走 server.mjs。
      const url = String(this.cfg.bridgeUrl || '')
      const isSidecar = !/:(4331|4332)\b/.test(url)
      const port = Number((url.match(/:(\d+)/) || [])[1]) || 4740
      if (isSidecar) await this._ensureFrida()
      const args = isSidecar ? ['-u', 'xtc-frida-bridge.py', '--port', String(port)] : ['server.mjs']
      const env = isSidecar
        ? { ...process.env, XTC_ADB: this.cfg.adbPath || 'F:/tools/pt/platform-tools/adb.exe', XTC_SERIAL: this.cfg.deviceSerial || 'HA1TPTBF', XTC_REMOTE: this.cfg.fridaRemote || '127.0.0.1:5555', PYTHONPATH: this.cfg.pythonPath || 'F:/qqbot/tmp/pylibs' }
        : process.env
      const bin = isSidecar ? this._pythonBin() : process.execPath
      const child = spawn(bin, args, {
        cwd: dir, detached: true, windowsHide: true, stdio: ['ignore', out, out], env,
      })
      // spawn 找不到可执行文件是异步 error 事件，不接会变成进程级未捕获异常
      child.on('error', (e) => this.pushLog(`拉起失败（${bin}）：${e?.message ?? e}`))
      child.unref()
      this.pushLog(isSidecar
        ? `协议层 sidecar 不可达，已拉起 frida-bridge（pid=${child.pid}，bin=${bin}）`
        : `桥接不可达，已拉起 xtc-bridge（pid=${child.pid}）`)
    } catch (e) { this.pushLog(`拉起失败：${e?.message ?? e}`) }
  }

  /** 统一记忆库模块（懒加载，失败只降级不抛） */
  async memLib() {
    if (this._memLib !== undefined) return this._memLib
    try { this._memLib = await import(MEM_LIB_URL) } catch (e) { this.pushLog(`统一记忆库加载失败：${e?.message ?? e}`); this._memLib = null }
    return this._memLib
  }

  /** 跨渠道台账（person-link + channel-store），失败返回 null */
  async chatLib() {
    if (this._chatLib !== undefined) return this._chatLib
    try {
      const cs = await import(CHANNEL_LIB_URL)
      const pl = await import(PERSON_LIB_URL)
      this._chatLib = { cs, pl }
    } catch (e) {
      this.pushLog(`台账模块加载失败：${e?.message ?? e}`)
      this._chatLib = null
    }
    return this._chatLib
  }

  /** 入站落原始台账（补回/事件任务/检索的素材；失败静默）。
   *  ts 用消息自身的原始时间，msgId 有就带上 —— appendChat 的幂等键是 msgId，
   *  只有「同一条消息被重复收集」才会合并，不同时间的同样文字是两条记录。 */
  async recordInbound(xtcId, text, msgId, ts, kind) {
    try {
      const lib = await this.chatLib()
      const mem = await this.memLib()
      if (!lib || !mem) return
      await lib.cs.recordChat(mem, QQ_DATA_ROOT, {
        platform: 'xtc',
        convId: String(xtcId),
        dir: 'in',
        text,
        ts: Number(ts) > 1e12 ? Number(ts) : Date.now(),
        senderId: String(xtcId),
        sender: this.peerName(xtcId),
        kind: kind || 'text',
        msgId: msgId || '',
        src: 'xtc',
      })
    } catch { /* 台账不能影响回复 */ }
  }

  /** 出站落同一本台账 */
  async recordOutbound(xtcId, text) {
    try {
      const lib = await this.chatLib()
      const mem = await this.memLib()
      if (!lib || !mem) return
      await lib.cs.recordChat(mem, QQ_DATA_ROOT, {
        platform: 'xtc', convId: String(xtcId), dir: 'out', text, ts: Date.now(),
        senderId: 'bot', sender: '小蓝', kind: 'text', src: 'xtc',
      })
    } catch { /* 同上 */ }
  }

  /** 腕表 id → 昵称（xtc-peers.json） */
  peerName(xtcId) {
    try {
      const f = join(QQ_DATA_ROOT, '.qqbot', 'xtc-peers.json')
      if (!existsSync(f)) return String(xtcId)
      const j = JSON.parse(readFileSync(f, 'utf8')) || {}
      return String(j[String(xtcId)] || xtcId)
    } catch { return String(xtcId) }
  }

  /** 记忆 scope：优先按人归一（微信/QQ/腕表同一人 → 同一 scope） */
  memScopeOf(xtcId) {
    try {
      const reg = this._chatLib?.pl || null
      if (reg?.scopeFor) return reg.scopeFor(QQ_DATA_ROOT, 'xtc', String(xtcId))
    } catch { /* ignore */ }
    return `c2c:${String(xtcId)}`
  }

  /**
   * 积压补回：只处理 xtc-peers.json 里登记过的腕表 id，用 memory.db 判断「最后一条入站晚于出站」，
   * 把积压合成一条 [补回] 交给 processInbound，让它走正常 agent 流程回出去。
   */
  async _catchup(opts = {}) {
    if (this._catchupRunning) return
    // ★ 2026-11-18 修: 桥没连上时不要注入补回 —— 发不出去只会在 3 分钟后重来，表现成“频繁发消息”
    if (!this.linkFresh()) { this.pushLog('小天才链路不可用，跳过积压补回'); return }
    this._catchupRunning = true
    try {
      const peersFile = join(QQ_DATA_ROOT, '.qqbot', 'xtc-peers.json')
      // peers 文件丢了也别整个停摆：下面会用库里的 src='xtc' 兜底推断是谁。
      const peers = existsSync(peersFile) ? (JSON.parse(readFileSync(peersFile, 'utf8')) || {}) : {}
      let ids = Object.keys(peers)
      const dbFile = join(QQ_DATA_ROOT, '.qqbot', 'memory.db')
      if (!existsSync(dbFile)) return
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbFile, { readOnly: true })
      if (!ids.length) {
        ids = db.prepare("select distinct scope from chat where src = 'xtc' and scope like 'c2c:%'").all()
          .map((r) => String(r.scope || '').slice(4)).filter(Boolean)
      }
      if (!ids.length) { try { db.close() } catch { /* ignore */ } return }
      const since = Date.now() - Math.max(3600000, Number(opts.lookbackMs || this.cfg.catchupLookbackMs || 24 * 3600 * 1000))
      for (const id of ids) {
        const scope = `c2c:${id}`
        const lastIn = Number(db.prepare("select max(ts) t from chat where scope = ? and dir = 'in' and coalesce(src,'') like 'xtc%'").get(scope)?.t || 0)
        const lastOut = Number(db.prepare("select max(ts) t from chat where scope = ? and dir = 'out'").get(scope)?.t || 0)
        if (!lastIn || lastIn <= lastOut || lastIn < since) continue
        const rows = db.prepare("select text, ts from chat where scope = ? and dir = 'in' and coalesce(src,'') like 'xtc%' and ts > ? order by ts asc").all(scope, Math.max(lastOut, since))
          .filter((r) => !isJunkText(r.text) && !isSystemText(r.text))
        if (!rows.length) continue
        // ★ 2026-11-18: 同一段积压只补一次（发不出去也不能每 3 分钟刷一轮）
        const marks = this._catchupMarks()
        if (Number(marks[scope] || 0) >= lastIn) continue
        const lines = rows.slice(-6).map((r) => '- ' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 120)).join('\n')
        const note = `[补回] 你刚才不在，${peers[id] || '对方'} 发了这些：\n${lines}

接着回一句就好：别解释自己刚才在忙、别说“刚看到”，也别复述上面的话。`
        this.pushLog(`小天才积压补回：${id} 共 ${rows.length} 条`)
        await this.processInbound(id, note)
        this._catchupMarks(lastIn, scope)
      }
      try { db.close() } catch { /* ignore */ }
    } catch (e) { this.pushLog(`小天才积压补回失败：${e?.message ?? e}`) }
    finally { this._catchupRunning = false }
  }

  async processInbound(xtcId, text) {
    const body = String(text ?? '').trim()
    if (!body || body === 'null') return
    text = body
    // 星号遮蔽 / 半截 JSON / 通知前缀 这类「不是真话」的正文，不入脑、不回。
    if (isJunkText(body)) {
      this.pushLog(`入站正文不可用，跳过回复：${body.slice(0, 20)}`)
      return
    }
    const key = `u:${xtcId}`
    const { agent, intro } = await this.ensureAgentFor(key, xtcId)
    // 统一记忆库（2026-11-13）：和 QQ/微信同一个 memory.db，scope 用 c2c:<id>，
    // 这样「记得」是全局一份，不按渠道分裂；渠道差异只体现在近期上下文（recentContext）。
    const mem = await this.memLib()
    const scope = this.memScopeOf(xtcId)
    // 台账由各自的入口先写（轮询 tick / 通知监听），这里不再补写：
    // 否则同一句话会被记两遍（ts 不同、指纹不同，去重挡不住）。
    let recallBlock = ''
    try {
      const hits = await mem.recall(QQ_DATA_ROOT, scope, String(text).slice(0, 200))
      if (Array.isArray(hits) && hits.length) {
        const lines = hits.slice(0, 4).map((h) => `- ${String(h.text || h.content || '').replace(/\s+/g, ' ').slice(0, 120)}`)
        recallBlock = `[记忆]\n${lines.join('\n')}\n[/记忆]\n\n`
      }
    } catch (e) { this.pushLog(`记忆召回失败：${e?.message ?? e}`) }
    const fullText = `${recallBlock}${intro ? `${intro}${text}` : text}`
    // 图：先抓最近落盘的缓存图（Coil 大图缓存里是可直接打开的 JPEG），
    // 让视觉模型先描述出来，再拼进给大脑的正文——这样她看到的是内容，不用靠猜。
    let visionNote = ''
    if (/\[图片\]/.test(String(text))) {
      try {
        const pic = await this.grabLatestPicture(90)
        if (pic.ok) {
          const vision = await import(VISION_LIB_URL).catch(() => null)
          const v = vision ? await vision.describeImage(QQ_DATA_ROOT, pic.path, {}) : null
          if (v?.ok) {
            visionNote = `\n\n（她刚发的图片，画面内容：${String(v.text || '').replace(/\s+/g, ' ').slice(0, 260)}）`
            this.pushLog(`图片已识别：${String(v.text || '').slice(0, 60)}`)
          } else {
            visionNote = '\n\n（她刚发了一张图，这边只抓到很模糊的缩略图，看不清细节。）'
          }
        }
      } catch (e) { this.pushLog(`抓图/识图失败：${e?.message ?? e}`) }
    }
    const promptText = fullText + visionNote
    if (!String(text).startsWith('[补回]')) {
      try { await mem.remember(QQ_DATA_ROOT, scope, { role: 'user', text: String(text) }) } catch { /* 记忆写失败不影响回复 */ }
    }
    const userMessage = makeUserMessage({ content: [{ type: 'text', text: promptText }], source: { kind: 'user' } })
    await new Promise((resolve) => {
      const pend = { convId: xtcId, sessionId: agent.id, resolve, timer: null, key, timedOut: false }
      const fail = (err) => {
        if (pend.timer) clearTimeout(pend.timer)
        this.pending.delete(userMessage.id)
        this.collectors.delete(agent.id)
        this.pushLog(`followup 失败：${err?.message ?? err}`)
        this.sendTo(xtcId, `😵 处理失败：${err?.message ?? err}`).finally(resolve)
      }
      pend.timer = setTimeout(() => {
        pend.timedOut = true
        this.sendTo(xtcId, '⏳ 这条要算久一点，我还在想，想好就发给你').finally(resolve)
      }, Number(this.cfg.replyTimeoutMs || 120000))
      this.pending.set(userMessage.id, pend)
      this.collectors.set(agent.id, { sessionId: agent.id, msgId: userMessage.id, parts: [], pending: pend })
      try {
        const p = agent.followup(userMessage)
        if (p && typeof p.then === 'function') p.catch(fail)
      } catch (err) { fail(err) }
    })
  }

  handleSessionEvent(session, event) {
    const c = this.collectors.get(session.id)
    if (!c) return
    switch (event.type) {
      case 'assistant/message': {
        const blocks = event.data?.message?.content ?? []
        const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
        if (texts.length) {
          this.status.lastEventAt = Date.now()
          if (this.cfg.replyMode === 'last') c.parts.length = 0
          c.parts.push(texts.join('\n'))
        }
        break
      }
      case 'turn/end': {
        this.collectors.delete(session.id)
        this.status.lastEventAt = Date.now()
        const { pending, parts, msgId } = c
        this.pending.delete(msgId)
        if (pending.timer) clearTimeout(pending.timer)
        const reply = parts.join('\n').trim()
        if (pending.silent) { pending.resolve(reply); break }
        if (pending.timedOut) this.pushLog(`超时后补发：${reply.length} 字`)
        let outText = reply
        if (!outText && event.data?.reason?.kind === 'error') {
          outText = `😵 处理失败：${event.data.reason.error?.message ?? '未知错误'}`
        }
        const send = outText ? this.sendTo(pending.convId, outText) : Promise.resolve()
        // 回复也要进统一记忆库，否则下次只记得「对方说过什么」，忘了「我怎么回的」
        if (outText) {
          this.memLib().then((m) => m && m.remember(QQ_DATA_ROOT, this.memScopeOf(pending.convId), { role: 'assistant', text: String(outText) })).catch(() => {})
        }
        send.finally(() => {
          pending.resolve()
          this.afterTurn(pending.key, pending.convId, outText).catch(() => {})
        })
        break
      }
      default:
        break
    }
  }

  async afterTurn(key, xtcId, replyText) {
    const entry = this.sessionMap[key]
    if (entry) { entry.turns = Number(entry.turns || 0) + 1 }
    if (replyText) {
      this.status.replied = Number(this.status.replied || 0) + 1
      const rs = this.recentReplies.get(xtcId) || []
      rs.push(String(replyText).slice(0, 120))
      this.recentReplies.set(xtcId, rs.slice(-3))
      // 回合后整理（和 QQ 同一条链路）：不 await，整理慢不能拖回复
      void this.reflectTurn(xtcId, replyText)
    }
  }

  async reflectTurn(xtcId, replyText) {
    const scope = this.memScopeOf(xtcId)
    if (!this._reflecting) this._reflecting = new Set()
    if (this._reflecting.has(scope)) return
    this._reflecting.add(scope)
    try {
      const lib = await this.memLib()
      const cfg = lib && typeof lib.loadConfig === 'function' ? lib.loadConfig(QQ_DATA_ROOT) : {}
      const [agent, llm] = await Promise.all([import(AGENT_LIB_URL), import(LLM_LIB_URL).catch(() => null)])
      let llmCfg = null
      try { llmCfg = llm && llm.loadConfig ? llm.loadConfig(QQ_DATA_ROOT) : null } catch { llmCfg = null }
      const r = await agent.runTurnAgent({ dataRoot: QQ_DATA_ROOT, scope, cfg, llmCfg, reply: String(replyText || '') })
      if (r && r.ok) this.pushLog(`小天才记忆整理：${scope} 新消息 ${r.newMessages} 条，印象 ${(r.cards || []).length} 张`)
    } catch (e) {
      this.pushLog(`小天才记忆整理失败：${e?.message ?? e}`)
    } finally {
      this._reflecting.delete(scope)
    }
  }

  /** 补回水位（scope → 已补到的 lastIn），落盘，重启后不重复注入 */
  _catchupMarks(lastIn, scope) {
    try {
      const f = join(QQ_DATA_ROOT, '.qqbot', 'xtc-catchup.json')
      let o = {}
      try { o = JSON.parse(readFileSync(f, 'utf8')) || {} } catch { o = {} }
      if (lastIn && scope) { o[scope] = Number(lastIn); writeFileSync(f, JSON.stringify(o)); return o }
      return o
    } catch { return {} }
  }

  async sendTo(xtcId, text) {
    // 出站闸门（2026-11-13）：同一个人 90 秒内重复同一段正文只发一次，防止重试/重放刷屏
    {
      const t = String(text ?? '').trim()
      const now = Date.now()
      if (!this._sentXtc) this._sentXtc = new Map()
      const k = `${xtcId}|${t}`
      const last = this._sentXtc.get(k)
      if (t && last && now - last < 90000) { this.pushLog(`小天才出站去重：90 秒内重复同一段正文，已跳过`); return true }
      if (t) this._sentXtc.set(k, now)
      if (this._sentXtc.size > 300) {
        for (const [kk, vv] of this._sentXtc) { if (now - vv > 300000) this._sentXtc.delete(kk) }
      }
    }
    try {
      const r = await this.http('/xtc/send', { method: 'POST', body: { to: xtcId, text: String(text) }, timeoutMs: 30000 })
      this.pushLog(`→小天才 ${xtcId}：${String(text).slice(0, 30)}（${(r.ok) ? 'OK' : '失败'}）`)
      if (r.ok) this.recordOutbound(xtcId, text).catch(() => {})
      return Boolean(r.ok)
    } catch (e) { this.pushLog(`发小天才消息失败：${e?.message ?? e}`); return false }
  }

  /** 小天才链路是否可用：桥可达 + 近期还在正常轮询 + 无错误 */
  linkFresh() {
    const now = Date.now()
    const fresh = this.status.lastPollAt && (now - this.status.lastPollAt) < (Number(this.cfg.pollIntervalMs || 3000) * 4)
    return Boolean(this.status.bridgeOk) && Boolean(fresh) && !this.status.lastError
  }

  /** 从统一台账取最近几条（sidecar 没有 /xtc/messages 时，面板靠这个也能看到聊了什么） */
  async recentFromDb(limit = 8) {
    try {
      const lib = await this.memLib()
      const cl = await this.chatLib()
      const id = Object.keys(this._peers())[0] || ''
      if (!id) return []
      const scope = this.memScopeOf(id)
      let scopes = [scope]
      try { if (cl?.pl?.aliasesFor) scopes = cl.pl.aliasesFor(QQ_DATA_ROOT, scope) || scopes } catch { /* ignore */ }
      const out = []
      for (const sc of scopes) {
        const rows = lib && lib.queryChat ? lib.queryChat(QQ_DATA_ROOT, sc, { limit }) : []
        for (const r of rows) out.push(r)
      }
      out.sort((a, b) => Number(a.ts) - Number(b.ts))
      const clean = out.filter((r) => !/^\*+$/.test(String(r.text || '').trim()))
      return clean.slice(-limit).map((r) => ({
        at: Number(r.ts), dir: r.dir, sender: r.dir === 'out' ? '我' : (r.sender || '小朋友'),
        text: String(r.text || '').slice(0, 200), src: r.src, kind: r.kind,
        who: r.dir === 'out' ? '我' : (r.sender || '小朋友'),
      }))
    } catch { return [] }
  }

  statusView() {
    return {
      bridgeUrl: this.cfg.bridgeUrl,
      personaChars: this.muuPersona.length,
      preset: this.muuPreset,
      cwd: this.muuCwd,
      sessionCount: Object.keys(this.sessionMap).length,
      replied: this.status.replied,
      lastPollAt: this.status.lastPollAt,
      lastEventAt: this.status.lastEventAt,
      lastError: this.status.lastError,
      startedAt: this.status.startedAt,
      bridgeOk: this.status.bridgeOk,
      link: this.linkFresh(),   // 小天才链路是否可用（面板据此显示 正常/不可用）
      childMode: true,
    }
  }

  /** 安全拉取小朋友人物卡（失败返回空数组，不影响面板） */
  async fetchPeopleSafe() {
    try {
      const r = await this.http('/xtc/people', { timeoutMs: 6000 })
      return Array.isArray(r.json?.people) ? r.json.people : []
    } catch { return [] }
  }

  /** 当前 agent 所属的儿童 xtcId（用于印象卡写入工具） */
  xtcIdOfAgent(agentId) {
    for (const k of Object.keys(this.sessionMap)) {
      if (this.sessionMap[k].sid === agentId) return k.startsWith('u:') ? k.slice(2) : k
    }
    return null
  }
}

/* ---------------------- 宿主同源路由（给 DSH 设置页/工作台卡片读状态） ---------------------- */
function writeJson(res, code, obj) {
  const s = JSON.stringify(obj)
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) })
    res.end(s)
  } catch { /* ignore */ }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
  })
}

function registerRoutes(ctx, channel, attempt = 0) {
  const web = (() => { try { return ctx.get('webServer') } catch { return null } })()
  if (!web?.register) {
    if (attempt < 20) {
      // webServer 可能晚于本插件就绪：退避重试，别直接放弃面板
      setTimeout(() => { try { registerRoutes(ctx, channel, attempt + 1) } catch { /* ignore */ } }, 1000 + attempt * 500)
    } else {
      channel.pushLog('webServer 始终不可用，跳过 /api/xtc-muu/* 路由')
    }
    return
  }
  const reg = (path, handler) => {
    try {
      ctx.effect(() => web.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try { await handler(req, res) } catch (e) { writeJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        },
      }))
    } catch (e) { channel.pushLog(`路由注册失败 ${path}：${e?.message ?? e}`) }
  }

  // 小天才链路状态（DSH 桌面面板据此显示 正常/不可用）
  reg('/api/xtc-muu/status', async (req, res) => {
    let bridge = { ok: false }
    let recent = []
    let today = { in: 0, out: 0 }
    try {
      const h = await channel.http('/health', { timeoutMs: 5000 })
      bridge = {
        ok: Boolean(h.ok && h.json?.transportOk !== false),
        transport: h.json?.transport || 'pending',
        transportOk: Boolean(h.json?.transportOk),
        queued: h.json?.queued || 0,
      }
      channel.status.bridgeOk = bridge.ok
      channel.status.lastBridgeAt = Date.now()
      const m = await channel.http('/xtc/messages?limit=60', { timeoutMs: 8000 })
      const list = Array.isArray(m.json?.messages) ? m.json.messages : []
      recent = list.slice(-8).reverse().map((x) => ({
        ...x,
        who: x.dir === 'out' ? '我' : (x.sender || '小朋友'),
      }))
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
      for (const x of list) {
        if ((x.at || 0) < dayStart.getTime()) continue
        if (x.dir === 'in') today.in += 1; else today.out += 1
      }
    } catch (e) {
      bridge = { ok: false, error: String(e?.message ?? e) }
      channel.status.bridgeOk = false
    }
    // sidecar 的 /xtc/messages 一直是空的；面板要能看到「她说了什么」，直接读统一台账
    if (!recent.length) {
      recent = await channel.recentFromDb(8)
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
      for (const x of recent) {
        if ((x.at || 0) < dayStart.getTime()) continue
        if (x.dir === 'in') today.in += 1; else today.out += 1
      }
    }
    const st = channel.statusView()
    return writeJson(res, 200, {
      ok: true,
      status: st,                 // 含 link 布尔：小天才链路是否可用
      bridge,
      today,
      recent,
      // 2026-11-13：contacts 带上 facts（印象卡），面板直接展示「小朋友的印象卡」
      contacts: (await channel.fetchPeopleSafe()).map((p) => ({
        xtcId: p.xtcId, name: p.name, relation: p.relation, isChild: Boolean(p.isChild),
        facts: (Array.isArray(p.facts) ? p.facts : []).slice(-8),
      })),
    })
  })

  // 手动触发积压补回（2026-11-13）：运维/面板想立刻补一次时用
  reg('/api/xtc-muu/catchup', async (req, res) => {
    if (String(req.method).toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const b = await readBody(req).catch(() => ({}))
    channel._catchup({ lookbackMs: b?.lookbackMs }).catch(() => {})
    return writeJson(res, 202, { ok: true, started: true })
  })

  // 手动发一条（调试/代聊用）
  reg('/api/xtc-muu/send', async (req, res) => {
    if (String(req.method).toUpperCase() !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const b = await readBody(req)
    if (!b.to || !b.text) return writeJson(res, 400, { ok: false, error: 'to/text required' })
    const ok = await channel.sendTo(b.to, String(b.text))
    return writeJson(res, ok ? 200 : 502, { ok })
  })
}

export function apply(ctx, config) {
  let channel
  try {
    channel = new XtcChannel(ctx, config)
  } catch (e) {
    try { console.error('[xtc-muu] 初始化失败，插件已跳过：', e?.message ?? e) } catch { /* ignore */ }
    return
  }
  const safe = (label, fn) => { try { fn() } catch (e) { channel.pushLog(`${label} 注册失败：${e?.message ?? e}`) } }

  safe('xtcMuu 服务', () => ctx.provide('xtcMuu', {
    status: () => channel.statusView(),
    send: (xtcId, text) => channel.sendTo(xtcId, text),
  }))

  safe('xtc_persona_note 工具', () => ctx.tools.register({
    name: 'xtc_persona_note',
    description: '把关于小朋友的稳定认知记进印象卡（喜好、习惯、害怕的东西）。一次一条，短句。下次对话会自动带上。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '一句话，例如「她最喜欢粉色和艾莎公主」' } },
      required: ['text'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      render: (_a, v) => [{ type: 'text', text: v.ok ? '已记住小朋友的这件事' : '没记住' }],
    },
    async execute(args, exec) {
      const xtcId = channel.xtcIdOfAgent(exec?.agent?.id) || ''
      const text = String(args?.text ?? '').trim()
      if (!xtcId || !text) return { ok: false }
      const r = await channel.http('/xtc/people', { method: 'POST', body: { xtcId, fact: text }, timeoutMs: 8000 })
      return { ok: Boolean(r.ok) }
    },
  }))

  safe('xtc_latest_picture 工具', () => ctx.tools.register({
    name: 'xtc_latest_picture',
    description: '小朋友发来图片、聊天里只有 [图片] 占位时，用这个把平板上最近落盘的图片拉到本地，拿到路径后用 read_image 看。找不到就明说，不要因此不回复。',
    parameters: {
      type: 'object',
      properties: { maxAgeMin: { type: 'number', description: '只看最近多少分钟内的图，默认 30' } },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, path: { type: 'string' }, reason: { type: 'string' } }, required: ['ok'] },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `图拿到了：${v.path}` : `没抓到图（${v.reason || 'not_found'}）` }],
    },
    async execute(args) {
      return channel.grabLatestPicture(Math.max(1, Number(args?.maxAgeMin) || 30))
    },
  }))

  safe('状态路由', () => registerRoutes(ctx, channel))
}
