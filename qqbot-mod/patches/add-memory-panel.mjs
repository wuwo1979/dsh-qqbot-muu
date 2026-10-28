/**
 * add-memory-panel.mjs — 给浮窗加「🧠 记忆」页（客户端 UI 补丁）
 *
 * 只改 AppData 里正在跑的 client/qqbot-settings.js，不动 dist。
 * 数据来自 hooks/memory-panel.mjs 挂的 /api/qqbot-settings/memory-panel。
 *
 * 用法：
 *   node patches/add-memory-panel.mjs --check
 *   node patches/add-memory-panel.mjs --apply
 *   node patches/add-memory-panel.mjs --update     # 已应用后只重写这段，不动其他补丁
 *   node patches/add-memory-panel.mjs --revert
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pluginPath, announce } from './plugin-dir.mjs';

const FILE = pluginPath('client/qqbot-settings.js');
const BACKUP = FILE + '.orig-mempanel';
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const APPLY = args.includes('--apply');
const UPDATE = args.includes('--update');
const REVERT = args.includes('--revert');

const TAB_ANCHOR =
  "          + '<button data-t=\"chat\" class=\"' + (state.tab === 'chat' ? 'on' : '') + '\">💬 聊天</button>'\n";
const TAB_NEW =
  "          + '<button data-t=\"chat\" class=\"' + (state.tab === 'chat' ? 'on' : '') + '\">💬 聊天</button>'\n" +
  "          + '<button data-t=\"memory\" class=\"' + (state.tab === 'memory' ? 'on' : '') + '\">🧠 记忆</button>'\n";

const BODY_ANCHOR = "        } else if (state.tab === 'join') {";
const BODY_NEW =
  "        } else if (state.tab === 'memory') {\n" +
  "          // 🧠 记忆页：数据来自 hooks/memory-panel.mjs（只读接口）\n" +
  "          body += renderMemoryPanel()\n" +
  BODY_ANCHOR;

const FN_ANCHOR = '      function paintBody() {';
const FN_NEW = `      // ── 🧠 记忆页（补丁 add-memory-panel）：台账/提炼/印象/关系/分身日志/召回轨迹 ──
      function fmtMemAgo(ts) {
        try {
          if (!ts) return '未知'
          var n = Date.now() - Number(ts)
          if (n < 0) n = 0
          if (n < 60000) return '刚刚'
          if (n < 3600000) return Math.floor(n / 60000) + ' 分钟前'
          if (n < 86400000) return Math.floor(n / 3600000) + ' 小时前'
          var d = new Date(Number(ts))
          return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
        } catch (e) { return '' }
      }
      function memScopeLabel(s) {
        s = String(s || '')
        if (s.indexOf('c2c:') === 0) return '私聊'
        if (s.indexOf('group:') === 0) return '群聊'
        return '会话'
      }
      function bondPhase(a, t) {
        var v = (Number(a) || 0) * 0.6 + (Number(t) || 0) * 0.4
        if (v >= 80) return '很亲近'
        if (v >= 60) return '亲近'
        if (v >= 40) return '熟悉'
        if (v >= 20) return '认识'
        return '刚认识'
      }
      function memChip(label, n, color) {
        return '<div class="q-card">'
          + '<b class="q-num" style="color:' + color + '">' + (Number(n) || 0) + '</b>'
          + '<i class="q-cap">' + label + '</i></div>'
      }
      function memBar(label, v, color) {
        var n = Math.max(0, Math.min(100, Number(v) || 0))
        return '<div style="display:flex;align-items:center;gap:6px;margin:2px 0;font-size:11px;color:var(--q-text-2)">'
          + '<span style="width:30px;flex:none">' + label + '</span>'
          + '<span class="q-track" style="flex:1"><i style="width:' + n + '%;background:' + color + '"></i></span>'
          + '<b style="width:26px;text-align:right;color:var(--q-text);font-variant-numeric:tabular-nums">' + n + '</b></div>'
      }
      function memSection(title, inner, note, open) {
        return '<details class="q-sec"' + (open ? ' open' : '') + '>'
          + '<summary>' + title
          + (note ? '<span class="q-note">' + note + '</span>' : '') + '</summary>'
          + '<div style="margin-top:7px">' + inner + '</div></details>'
      }
      function renderMemoryPanel() {
        if (state.memBusy && !state.memPanel) return '<div class="dk-empty">正在读取数据库记忆…</div>'
        if (state.memErr && !state.memPanel) return '<div class="dk-empty">' + esc(state.memErr) + '</div>'
        var d = state.memPanel
        if (!d) return '<div class="dk-empty">还没有读取 · 点「刷新」</div>'
        if (!d.ok) return '<div class="dk-empty">读取失败：' + esc(((d.errors || []).join('; ')) || '未知') + '</div>'
        var h = '<div class="dk-row" style="justify-content:space-between;align-items:center">'
          + '<span class="dk-msg">🗄 数据库记忆 · ' + esc(fmtMemAgo(d.ts)) + '更新</span>'
          + '<button class="dk-btn" id="dk-mem-refresh">🔄 刷新</button></div>'
        h += '<div style="display:flex;gap:6px;margin:6px 0 2px">'
          + memChip('台账条数', d.stats.chatTotal, '#7c5cff')
          + memChip('提炼记忆', d.stats.memTotal, '#2f9e44')
          + memChip('印象卡', (d.cards || []).length, '#e8590c')
          + memChip('熟识度', (d.familiarity || []).length, '#e64980')
          + memChip('历史切片', (d.digest || []).length, '#1c7ed6')
          + '</div>'
        h += '<div class="q-hint" style="margin:0 0 6px">共 ' + ((d.stats.scopes || []).length) + ' 个会话；点标题可展开/收起；这里看的是数据库里真实存下的内容，不是模型临时编的。</div>'

        // 分身状态
        var ag = d.agent || {}
        var log = (ag.log || [])[0]
        var agTxt = ''
        if (log) {
          agTxt = (log.ok ? '✅ 跑了' : '⚠️ 没跑成')
            + ' · ' + (log.newMessages || 0) + ' 条新消息'
            + ' · 事实 ' + (log.facts || 0) + ' / 印象 ' + (log.cards || 0)
            + (log.relation && (log.relation.delta || log.relation.note) ? ' · 关系 ' + (log.relation.delta > 0 ? '+' : '') + log.relation.delta + (log.relation.note ? '（' + log.relation.note + '）' : '') : '')
            + ' · ' + (log.ms || 0) + 'ms · ' + fmtMemAgo(log.ts)
        } else if (ag.enabled === false) {
          agTxt = '已关闭（memory-config.json → memoryAgent.enabled=false）'
        } else {
          agTxt = '还没有运行记录；攒够 ' + (ag.minNewMessages || 3) + ' 条新消息、间隔 ' + Math.round((ag.intervalMs || 45000) / 1000) + 's 后自动跑'
        }
        var agInner = '<div style="font-size:11px;color:#555;line-height:1.6">'
          + '<div>模型：<b>' + esc(ag.model || '未配置') + '</b>' + (ag.provider ? ' · ' + esc(ag.provider) : '') + '</div>'
          + '<div>最近一次：' + esc(agTxt) + '</div>'
          + ((ag.states || []).length ? '<div style="color:#999">上次尝试：' + esc(fmtMemAgo(ag.states[0].lastAttempt)) + ' · 上次成功：' + esc(ag.states[0].lastRun ? fmtMemAgo(ag.states[0].lastRun) : '还没成功过') + '</div>' : '')
          + '</div>'
        // 🧬 归纳与认知稳定度（类海马体：回放巩固 + 人格漂移护栏）
        // 数据来自 lib/memory-hippo.mjs：gists=归纳片段数，beliefs=信念条目数，
        // stability=100*(1-加权漂移)，越接近 100 说明"对她的认知"没被少数几次对话带跑。
        var hpS = d.hippo || {}
        var drS = d.drift || {}
        var hpRows = (drS.rows || hpS.drift || [])
        var stab = Number(drS.stability != null ? drS.stability : hpS.stability)
        if (!isFinite(stab)) stab = 100
        var alarmN = Number(drS.alarm != null ? drS.alarm : hpS.alarm) || 0
        var lvCls = alarmN > 0 ? 'bad' : (stab >= 82 ? 'ok' : 'warn')
        var lvTxt = alarmN > 0 ? '偏离偏大' : (stab >= 82 ? '稳定' : '需要留意')
        var hpInner = '<div class="q-cards">'
          + '<div class="q-card"><b class="q-num">' + (Number(hpS.gists) || 0) + '</b><i class="q-cap">归纳片段</i></div>'
          + '<div class="q-card"><b class="q-num">' + (Number(hpS.links) || 0) + '</b><i class="q-cap">记忆链接</i></div>'
          + '<div class="q-card"><b class="q-num">' + (Number(hpS.beliefs) || 0) + '</b><i class="q-cap">信念条目</i></div>'
          + '</div>'
          + '<div class="q-meter"><div class="q-meter-t"><span>认知稳定度</span>'
          + '<b class="q-pill ' + lvCls + '">' + Math.round(stab) + ' · ' + lvTxt + '</b></div>'
          + '<div class="q-track"><i class="' + lvCls + '" style="width:' + Math.max(0, Math.min(100, stab)) + '%"></i></div></div>'
        if (hpRows.length) {
          hpInner += '<div class="q-list">'
          for (var hi = 0; hi < Math.min(6, hpRows.length); hi += 1) {
            var hr = hpRows[hi] || {}
            var hv = Number(hr.drift) || 0
            var hc = Math.abs(hv) >= 0.45 ? 'bad' : (Math.abs(hv) >= 0.25 ? 'warn' : 'ok')
            hpInner += '<div class="q-row"><span class="q-k">' + esc(String(hr.key || '')) + '</span>'
              + '<span class="q-v">' + (Number(hr.value) || 0).toFixed(2) + '</span>'
              + '<b class="q-d ' + hc + '">' + (hv > 0 ? '+' : '') + hv.toFixed(2) + '</b></div>'
          }
          hpInner += '</div>'
        } else {
          hpInner += '<div class="q-hint">还没有信念条目 · 多聊几轮（每 12 轮会回放巩固一次）后才会沉淀出来</div>'
        }
        hpInner += '<div class="q-hint">'
          + (Number(hpS.lastReplay) ? '上次回放：' + esc(fmtMemAgo(hpS.lastReplay)) + (hpS.lastReplayDetail ? ' · ' + esc(hpS.lastReplayDetail) : '')
            : '还没有回放过（每 12 轮对话自动跑，或在记忆页手动触发）')
          + '</div>'
        h += memSection('🧬 归纳与认知稳定度', hpInner)
        h += memSection('🧠 记忆分身（本地模型整理）', agInner)

        // 召回轨迹
        var recall = d.recall || []
        var rInner = ''
        if (!recall.length) rInner = '<div style="font-size:11px;color:#999">还没有召回记录（重启后每条消息会记一条）</div>'
        else {
          rInner = recall.slice(0, 6).map(function (r) {
            var st = r.ok ? (r.hits > 0 ? '✅ 命中 ' + r.hits + ' / ' + r.raw : '✅ 查库了，但没命中') : '⚠️ 失败'
            var q = r.query ? ' · "' + esc(r.query) + '"' : ''
            return '<div style="font-size:11px;color:#555;line-height:1.55;border-bottom:1px dashed #f0ecff;padding:3px 0">'
              + st + (r.rewritten ? ' · 本地改写' : '') + ' · ' + (r.ms || 0) + 'ms · ' + esc(fmtMemAgo(r.ts))
              + '<div style="color:#999">' + memScopeLabel(r.scope) + q + '</div></div>'
          }).join('')
        }
        h += memSection('🔎 最近召回（是否真的查了库）', rInner)

        // 提炼记忆
        var mems = d.memories || []
        var mInner = mems.length ? mems.slice(0, 10).map(function (m) {
          return '<div style="font-size:11px;line-height:1.5;border-bottom:1px dashed #f0ecff;padding:3px 0">'
            + '<span style="display:inline-block;background:#eef7ee;color:#2f9e44;border-radius:5px;padding:0 5px;margin-right:4px">' + esc(m.kind) + '</span>'
            + esc(m.text)
            + '<span style="color:#aaa"> · ' + esc(m.subj || memScopeLabel(m.scope)) + ' · ' + esc(fmtMemAgo(m.ts)) + '</span></div>'
        }).join('') : '<div style="font-size:11px;color:#999">还没有提炼出记忆</div>'
        h += memSection('🗂 数据库里的提炼记忆', mInner, '近 ' + mems.length + ' 条')

        // 熟识度（与印象卡同源：persona.fam 是唯一事实源）
        var fams = d.familiarity || []
        var bInner = fams.length ? fams.slice(0, 8).map(function (b) {
          return '<div style="margin:5px 0;padding-bottom:5px;border-bottom:1px dashed #f0ecff">'
            + '<div style="font-size:12px;color:#333;font-weight:600">' + esc(b.name || '某人')
            + '<span style="font-weight:400;color:#e64980;margin-left:6px">' + esc(b.levelLabel || bondPhase(b.a, b.t)) + ' · ' + (b.s || 0) + '/100</span>'
            + '<span style="float:right;font-size:10px;color:#bbb">' + esc(b.source === 'fam' ? '统一记录' : '旧bond迁移') + '</span></div>'
            + memBar('亲近', b.a, 'linear-gradient(90deg,#ff9ec4,#e64980)')
            + memBar('信任', b.t, 'linear-gradient(90deg,#a5d8ff,#4dabf7)')
            + (b.note ? '<div style="font-size:11px;color:#888;margin-top:2px">最近：' + esc(b.note) + '</div>' : '')
            + '</div>'
        }).join('') : '<div style="font-size:11px;color:#999">还没有熟识度记录（聊几轮后由分身更新）</div>'
        h += memSection('💞 熟识度（与印象卡统一存储）', bInner, 'persona.fam，原生 affinity/attitude 只做导入')

        // 历史印象（全库切片）
        var dig = d.digestStates || []
        var dgInner = dig.length ? dig.map(function (x) {
          return '<div style="margin:4px 0;padding-bottom:4px;border-bottom:1px dashed #f0ecff;font-size:11px;color:#555">'
            + '<b style="color:#1c7ed6">' + esc(x.name || x.senderId) + '</b>'
            + (x.scope ? '<span style="color:#aaa;margin-left:4px">' + memScopeLabel(x.scope) + '</span>' : '')
            + ' · ' + (x.sliceCount || x.slices || 0) + ' 片 / 覆盖 ' + (x.covered || 0) + ' 条'
            + ' · 上次 ' + esc(fmtMemAgo(x.lastOk))
            + (x.lastError ? '<span style="color:#c92a2a"> · ' + esc(x.lastError) + '</span>' : '')
            + '<button class="dk-btn" style="float:right;padding:0 6px;height:20px;font-size:10px" data-digest="' + esc(x.senderId) + '" data-scope="' + esc(x.scope || '') + '">重建</button></div>'
        }).join('') : '<div style="font-size:11px;color:#999">还没有历史切片；点下面按钮，用本地模型把全部聊天切片归纳</div>'
        dgInner += '<div class="dk-row" style="margin-top:6px"><button class="dk-btn" id="dk-mem-digest-all">🧩 重建历史印象（主人优先）</button>'
          + '<span style="font-size:10px;color:#aaa;margin-left:6px">' + ((d.jobs && d.jobs.digest && d.jobs.digest.running) ? '正在整理…' : '全库切片，本地模型') + '</span></div>'
        h += memSection('🧩 历史印象（全库高维抽象）', dgInner, '每 60 条一片，可切片保存')

        // 检索模型
        var models = d.models || {}
        var ret = models.retrieval || {}
        var hlt = d.health || {}
        var oms = (hlt.ollamaModels || [])
        function memOpts(cur) {
          var arr = ['local'].concat(oms.map(function (m) { return 'ollama:' + m }))
          if (cur && arr.indexOf(cur) < 0) arr.push(cur)
          return arr.map(function (v) {
            return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>'
          }).join('')
        }
        var em = d.embedder || {}
        var mdInner = '<div style="font-size:11px;color:#555;line-height:1.7">'
          + '<div>记忆检索：<select id="dk-mem-emb" style="font-size:11px;max-width:230px">' + memOpts(ret.embeddingModel || 'local') + '</select></div>'
          + '<div>表情检索：<select id="dk-mem-sticker-emb" style="font-size:11px;max-width:230px">' + memOpts(ret.stickerEmbeddingModel || ret.embeddingModel || 'local') + '</select></div>'
          + '<div>记忆分身：<select id="dk-mem-agent-model" style="font-size:11px;max-width:230px">' + memOpts(models.agentModel || (models.llm && models.llm.model) || '') + '</select></div>'
          + '<div style="color:#888">当前向量：<b>' + esc(em.model || '未知') + '</b> · ' + esc(em.mode || '') + ' · ' + (em.dim || 0) + ' 维'
          + (models.indexed ? ' · 库内：' + esc(models.indexed.model || '') : '') + '</div>'
          + '<div class="dk-row" style="margin-top:4px"><button class="dk-btn" id="dk-mem-save-models">保存模型</button>'
          + '<button class="dk-btn" id="dk-mem-rebuild">重建向量</button>'
          + '<span style="font-size:10px;color:#aaa;margin-left:6px">' + ((d.jobs && d.jobs.rebuild && d.jobs.rebuild.running) ? '正在重嵌…' : '换模型后需重建') + '</span></div>'
          + '<div style="font-size:10px;color:#aaa">本地 = 插件 ONNX bge-small-zh；ollama:* = 本机 Ollama（nomic-embed-text / bge-m3 等）</div>'
          + '</div>'
        h += memSection('⚙️ 检索与整理模型', mdInner)

        // 印象卡 + 心情
        var cards = d.cards || []
        var moods = d.moods || []
        var cInner = ''
        if (cards.length) cInner += cards.slice(0, 6).map(function (c) {
          var isGlobal = String(c.scope || '') === '__global__'
          return '<div style="font-size:11px;line-height:1.5;border-bottom:1px dashed #f0ecff;padding:2px 0">'
            + '<b style="color:#e8590c">' + esc(c.name || '某人') + '</b>：' + esc(c.text)
            + '<span style="color:#aaa"> · ' + (isGlobal ? '个人（跨群统一）' : esc(memScopeLabel(c.scope))) + ' · ' + esc(fmtMemAgo(c.ts)) + '</span></div>'
        }).join('')
        if (moods.length) cInner += '<div style="font-size:11px;color:#666;margin-top:4px">🌤 当前状态：' + esc(moods[0].text) + ' <span style="color:#aaa">· ' + esc(fmtMemAgo(moods[0].ts)) + '</span></div>'
        if (!cInner) cInner = '<div style="font-size:11px;color:#999">还没有印象卡</div>'
        h += memSection('🪪 印象卡 / 当下状态', cInner, '', true)

        // B站分享档（主人 2026-10-24：分享要一张卡片；发不出去的也在这里留档）
        var bs = d.biliShares || []
        var bsInner = bs.length ? bs.slice(0, 10).map(function (s) {
          return '<div style="font-size:11px;line-height:1.55;border-bottom:1px dashed #f0ecff;padding:3px 0">'
            + '<b style="color:#1c7ed6">' + esc(s.title || s.bvid || '(视频)') + '</b>'
            + (s.sent ? '<span style="color:#2f9e44;margin-left:6px">已发</span>' : '<span style="color:#e8590c;margin-left:6px">未发（已留档）</span>')
            + '<span style="float:right;color:#bbb">' + esc(fmtMemAgo(s.ts)) + '</span>'
            + '<div style="color:#888">' + (s.owner ? 'UP：' + esc(s.owner) : '') + (s.afterComment ? ' · 评论后分享' : '') + (s.via ? ' · ' + esc(s.via) : '') + '</div>'
            + '<div style="color:#5c7cfa;word-break:break-all">' + esc(s.url || ('https://www.bilibili.com/video/' + (s.bvid || ''))) + '</div>'
            + '</div>'
        }).join('') : '<div style="font-size:11px;color:#999">还没有分享记录；用 bili 工具 action=share 分享一条就会出现在这里</div>'
        h += memSection('📺 B站分享档', bsInner, '每次分享一行；发失败的也留着，方便补发')

        // 最近台账
        var chat = d.chat || []
        var chInner = chat.length ? chat.slice(0, 8).map(function (c) {
          return '<div style="font-size:11px;line-height:1.5;border-bottom:1px dashed #f0ecff;padding:2px 0">'
            + '<b style="color:' + (c.dir === 'out' ? '#2f9e44' : '#555') + '">' + esc(c.sender) + '</b>：' + esc(c.text)
            + '<span style="color:#aaa"> · ' + esc(memScopeLabel(c.scope)) + ' · ' + esc(fmtMemAgo(c.ts)) + '</span></div>'
        }).join('') : '<div style="font-size:11px;color:#999">台账里还没有消息</div>'
        h += memSection('💬 最近聊天台账', chInner, '近 ' + chat.length + ' 条')

        // 🏷 群等级（主人 2026-10-24）：特别关心群才区分群成员 / 注入个人印象卡
        var tiers = d.tiers || {}
        var pri = tiers.priority || []
        var groups = (d.stats.scopes || []).filter(function (x) { return x.kind === '群聊' })
        var tInner = groups.length ? groups.map(function (g) {
          var id = String(g.scope || '').replace(/^group:/, '')
          var isPri = pri.indexOf(id) >= 0 || pri.indexOf(g.scope) >= 0
          var nm = id.length > 14 ? id.slice(0, 10) + '…' : id
          return '<div style="display:flex;align-items:center;gap:6px;font-size:11px;padding:3px 0;border-bottom:1px dashed #f0ecff">'
            + '<span style="flex:1;color:#555">' + esc(nm) + ' <span style="color:#aaa">· ' + (g.n || 0) + ' 条</span></span>'
            + '<span style="color:' + (isPri ? '#e8590c' : '#999') + '">' + (isPri ? '⭐ 特别关心' : '普通群') + '</span>'
            + '<button class="dk-btn" style="padding:0 6px;height:20px;font-size:10px" data-tier="' + esc(id) + '" data-to="' + (isPri ? 'normal' : 'priority') + '">' + (isPri ? '降为普通' : '设为关心') + '</button>'
            + '</div>'
        }).join('') : '<div style="font-size:11px;color:#999">还没有群聊记录</div>'
        tInner += '<div style="font-size:10px;color:#aaa;margin-top:4px">个人印象卡/熟识度跨群统一（同一个 QQ 在哪都认识）；群级聊天、记忆、心情各自隔离（A 群的恶言恶语不带坏 B 群）。普通群只看信息本身：不召回、不沉淀、不画像，只留一行「名字 · 等级」认人。</div>'
        h += memSection('🏷 群等级（特别关心 / 普通）', tInner, '即时生效', true)

        // 🎚 批量回复门槛（主人 2026-10-24）：一次给多个会话写覆盖项
        var scopesAll = d.stats.scopes || []
        var btInner = '<div style="font-size:11px;color:#555;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
          + '模式 <select id="dk-bt-gate" style="font-size:11px"><option value="log">log 只记录</option><option value="block">block 低分不唤醒</option><option value="off">off 关闭评分</option></select>'
          + '门槛 <input id="dk-bt-min" type="number" step="0.05" min="0" max="1" value="0.5" style="width:56px;font-size:11px">'
          + '<button class="dk-btn" id="dk-bt-apply" style="font-size:10px;padding:0 8px;height:22px">应用到选中</button>'
          + '<button class="dk-btn" id="dk-bt-clear" style="font-size:10px;padding:0 8px;height:22px">清除选中覆盖</button>'
          + '<button class="dk-btn" id="dk-bt-all" style="font-size:10px;padding:0 8px;height:22px">全选</button>'
          + '<button class="dk-btn" id="dk-bt-none" style="font-size:10px;padding:0 8px;height:22px">清空</button>'
          + '<span id="dk-bt-hint" style="font-size:10px;color:#888"></span>'
          + '</div><div style="max-height:150px;overflow:auto;margin-top:4px">'
          + (scopesAll.length ? scopesAll.map(function (s) {
            return '<label style="display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;border-bottom:1px dashed #f0ecff">'
              + '<input type="checkbox" class="dk-bt-key" value="' + esc(s.scope) + '">'
              + '<span style="flex:1;color:#555">' + memScopeLabel(s.scope) + ' · ' + esc(String(s.scope).replace(/^(group:|c2c:)/, '').slice(0, 12)) + '</span>'
              + '<span style="color:#aaa">' + (s.n || 0) + ' 条</span></label>'
          }).join('') : '<div style="font-size:11px;color:#999">还没有会话记录</div>')
          + '</div><div style="font-size:10px;color:#aaa;margin-top:4px">勾选会话 → 一次写入各自的会话级覆盖（不影响其他会话）。</div>'
        h += memSection('🎚 批量回复门槛（按会话）', btInner, '低分不唤醒，省 token')
        return h
      }
      function memPost(body) {
        return fetch('/api/qqbot-settings/memory-panel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {})
        }).then(function (r) { return r.json() }).catch(function () { return null })
      }
      function saveBatchThresholds(clear) {
        var hint = panel ? panel.querySelector('#dk-bt-hint') : null
        var gateEl = panel ? panel.querySelector('#dk-bt-gate') : null
        var minEl = panel ? panel.querySelector('#dk-bt-min') : null
        var keys = []
        Array.prototype.forEach.call(panel ? panel.querySelectorAll('.dk-bt-key:checked') : [], function (el) {
          var v = String(el.value || '').trim()
          if (v) keys.push(v)
        })
        if (!keys.length) { if (hint) hint.textContent = '先勾选会话'; return }
        if (hint) hint.textContent = '保存中…'
        fetch(READ + (state.ns ? '?' + outNsQ() : '')).then(function (r) { return r.json() }).then(function (d) {
          var cur = (d && d.value) || {}
          var lm = Object.assign({}, cur.localModel || {})
          lm.overrides = Object.assign({}, (lm.overrides || {}))
          for (var i = 0; i < keys.length; i += 1) {
            if (clear) delete lm.overrides[keys[i]]
            else lm.overrides[keys[i]] = {
              enabled: true,
              valueGate: gateEl ? gateEl.value : 'log',
              valueMinScore: minEl ? (parseFloat(minEl.value) || 0.5) : 0.5,
            }
          }
          var patch = Object.assign({}, cur, { localModel: lm })
          return fetch(UPDATE, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ns: state.ns || undefined, patch: patch, expectedRevision: d && d.revision }),
          }).then(function (r2) { return r2.json() })
        }).then(function (res) {
          if (res && !res.error) {
            if (hint) hint.textContent = (clear ? '已清除 ' : '已应用 ') + keys.length + ' 个会话 ✓'
          } else if (hint) hint.textContent = '保存失败：' + ((res && res.error) || '未知响应')
        }).catch(function (e) { if (hint) hint.textContent = '保存异常：' + (e && e.message ? e.message : e) })
      }
      function bindMemoryPanel() {
        if (!panel) return
        var btn = panel.querySelector('#dk-mem-refresh')
        if (btn) btn.onclick = function () { loadMemoryPanel(true) }
        var all = panel.querySelector('#dk-mem-digest-all')
        if (all) all.onclick = function () {
          all.disabled = true
          all.textContent = '正在切片整理…'
          memPost({ action: 'digest' }).then(function (r) {
            if (!r || !r.ok) { state.memErr = '启动失败：' + ((r && r.error) || '接口没有返回，扩展需 /bot-restart'); paintBody(); return }
            setTimeout(function () { loadMemoryPanel(true) }, 1500)
          })
        }
        Array.prototype.forEach.call(panel.querySelectorAll('[data-digest]'), function (b) {
          b.onclick = function () {
            b.disabled = true
            b.textContent = '…'
            memPost({ action: 'digest', senderId: b.getAttribute('data-digest'), scope: b.getAttribute('data-scope') || '' }).then(function (r) {
              if (!r || !r.ok) { state.memErr = '启动失败：' + ((r && r.error) || '接口没有返回'); paintBody(); return }
              setTimeout(function () { loadMemoryPanel(true) }, 1200)
            })
          }
        })
        var save = panel.querySelector('#dk-mem-save-models')
        if (save) save.onclick = function () {
          var emb = panel.querySelector('#dk-mem-emb')
          var stk = panel.querySelector('#dk-mem-sticker-emb')
          var agt = panel.querySelector('#dk-mem-agent-model')
          memPost({
            action: 'set-models',
            retrieval: {
              embeddingModel: emb ? emb.value : undefined,
              stickerEmbeddingModel: stk ? stk.value : undefined
            },
            agentModel: agt ? agt.value : undefined
          }).then(function (r) {
            if (!r || !r.ok) { state.memErr = '保存失败：' + ((r && r.error) || '接口没有返回'); paintBody(); return }
            loadMemoryPanel(true)
          })
        }
        var reb = panel.querySelector('#dk-mem-rebuild')
        if (reb) reb.onclick = function () {
          reb.disabled = true
          reb.textContent = '重嵌中…'
          memPost({ action: 'rebuild' }).then(function (r) {
            if (!r || !r.ok) { state.memErr = '重建失败：' + ((r && r.error) || '接口没有返回'); paintBody(); return }
            setTimeout(function () { loadMemoryPanel(true) }, 2000)
          })
        }
        // 🏷 群等级：一键在「特别关心 / 普通」之间切换
        Array.prototype.forEach.call(panel.querySelectorAll('[data-tier]'), function (b) {
          b.onclick = function () {
            var id = b.getAttribute('data-tier')
            var to = b.getAttribute('data-to') || 'priority'
            b.disabled = true
            memPost({ action: 'set-tier', ids: [id], tier: to }).then(function (r) {
              if (!r || !r.ok) { state.memErr = '设置失败：' + ((r && r.error) || '接口没有返回'); paintBody(); return }
              loadMemoryPanel(true)
            })
          }
        })
        // 🎚 批量回复门槛
        var btApply = panel.querySelector('#dk-bt-apply')
        if (btApply) btApply.onclick = function () { saveBatchThresholds(false) }
        var btClear = panel.querySelector('#dk-bt-clear')
        if (btClear) btClear.onclick = function () { saveBatchThresholds(true) }
        var btAll = panel.querySelector('#dk-bt-all')
        if (btAll) btAll.onclick = function () {
          Array.prototype.forEach.call(panel.querySelectorAll('.dk-bt-key'), function (el) { el.checked = true })
        }
        var btNone = panel.querySelector('#dk-bt-none')
        if (btNone) btNone.onclick = function () {
          Array.prototype.forEach.call(panel.querySelectorAll('.dk-bt-key'), function (el) { el.checked = false })
        }
      }
      function loadMemoryPanel(force) {
        if (state.memBusy) return
        state.memBusy = true
        state.memErr = ''
        if (state.tab === 'memory') paintBody()
        api('memory-panel', 'limit=30').then(function (d) {
          state.memBusy = false
          if (!d) {
            state.memErr = '接口没有返回：扩展还没重载，请 /bot-restart 后再刷新'
          } else if (!d.ok) {
            state.memPanel = d
            state.memErr = '读取失败：' + (((d.errors || []).join('; ')) || '未知')
          } else {
            state.memPanel = d
          }
          if (state.tab === 'memory') paintBody()
        })
      }
${FN_ANCHOR}`;

const BIND_ANCHOR = "        if (state.tab === 'session') bindLocalModel()   // ⚠️ 只绑定: 加载由切 tab 时触发(防重绘循环)";
const BIND_NEW = BIND_ANCHOR + "\n        if (state.tab === 'memory') bindMemoryPanel()";

const CLICK_ANCHOR = "            else if (state.tab === 'chat') { state.chatItems = []; state.chatErr = ''; }\n            paintBody()";
const CLICK_NEW = "            else if (state.tab === 'chat') { state.chatItems = []; state.chatErr = ''; }\n            else if (state.tab === 'memory') loadMemoryPanel()\n            paintBody()";

function read() {
  if (!existsSync(FILE)) {
    console.error('找不到客户端文件: ' + FILE);
    process.exit(2);
  }
  return readFileSync(FILE, 'utf8');
}

function strip(src) {
  return src
    .replace(/\n          \+ '<button data-t="memory"[\s\S]*?<\/button>'(?=\n)/, '')
    .replace(/\n        \} else if \(state\.tab === 'memory'\) \{[\s\S]*?\n          body \+= renderMemoryPanel\(\)\n(?=        \} else if \()/, '\n')
    .replace(/\n      \/\/ ── 🧠 记忆页（补丁 add-memory-panel）[\s\S]*?(?=\n      \/\/ ── |\n      function paintBody)/, '\n')
    .replace(/\n        if \(state\.tab === 'memory'\) bindMemoryPanel\(\)/, '')
    .replace(/\n            else if \(state\.tab === 'memory'\) loadMemoryPanel\(\)/, '');
}

function hasMarkers(src) {
  return src.includes('data-t="memory"') && src.includes('function renderMemoryPanel()');
}

function rx(s) {
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n');
  return new RegExp(esc);
}

function patch(src) {
  let s = src;
  for (const [label, a] of [['聊天 tab 按钮', TAB_ANCHOR], ['join 分支', BODY_ANCHOR], ['paintBody', FN_ANCHOR], ['session 绑定行', BIND_ANCHOR], ['tab 点击聊天分支', CLICK_ANCHOR]]) {
    if (!rx(a).test(s)) throw new Error('锚点丢失：' + label);
  }
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  const put = (anchor, text) => { s = s.replace(rx(anchor), () => text.replace(/\n/g, nl)); };
  put(TAB_ANCHOR, TAB_NEW);
  put(BODY_ANCHOR, BODY_NEW);
  put(FN_ANCHOR, FN_NEW);
  put(BIND_ANCHOR, BIND_NEW);
  put(CLICK_ANCHOR, CLICK_NEW);
  return s;
}

function syntaxCheck() {
  try {
    execFileSync(process.execPath, ['--check', FILE], { stdio: 'pipe' });
    console.log('  ✅ node --check 通过');
    return true;
  } catch (e) {
    console.error('  ❌ node --check 失败:');
    console.error(String(e.stderr || e.message || e).slice(0, 1200));
    return false;
  }
}

announce('memory-panel');
console.log('客户端文件: ' + FILE);

if (REVERT) {
  if (!existsSync(BACKUP)) { console.error('没有备份 ' + BACKUP); process.exit(2); }
  copyFileSync(BACKUP, FILE);
  console.log('已回滚到补丁前版本。');
  process.exit(0);
}

const cur = read();
const applied = hasMarkers(cur);

if (CHECK) {
  console.log(applied ? '✅ 已应用' : '⬜ 未应用');
  process.exit(applied ? 0 : 1);
}

if (!APPLY && !UPDATE) {
  console.log('用法：--check | --apply | --update | --revert');
  process.exit(2);
}

if (applied && !UPDATE) {
  console.log('已经应用过；要重写这段请用 --update。');
  process.exit(0);
}

if (!existsSync(BACKUP)) copyFileSync(FILE, BACKUP);

let src = cur;
const hadCrlf = cur.includes('\r\n');
if (hadCrlf) src = cur.replace(/\r\n/g, '\n');   // 补丁脚本内部统一用 LF 匹配，写完再还原
if (applied) {
  src = strip(src);
  if (hasMarkers(src)) {
    console.error('旧补丁清理不干净，已中止（未改文件）。');
    process.exit(3);
  }
}
const out = patch(src);
writeFileSync(FILE, hadCrlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
if (!syntaxCheck()) {
  if (existsSync(BACKUP)) copyFileSync(BACKUP, FILE);
  console.error('语法检查失败，已自动还原。');
  process.exit(4);
}
console.log((applied ? '✅ 已更新' : '✅ 已应用') + '「🧠 记忆」页（备份: ' + BACKUP + '）');
