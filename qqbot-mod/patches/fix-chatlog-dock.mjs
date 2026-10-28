#!/usr/bin/env node
/**
 * fix-chatlog-dock.mjs —— 两个主人亲自提的问题，一次装好
 *
 * ① 浮窗「群聊」页补不全、拿不到最新几条
 *    原因：聊天页的数据源里，本地兜底只并了 `.qqbot/msg-content.jsonl`；那是
 *    dist/transport/msg-content-cache.js 的「被引用消息内容台账」，**只记被引用过的消息**
 *    （MAX_LINES=2000，最新几条常常还没进），所以永远缺最新。
 *    真正的完整台账是 `.qqbot/msg-history/<scope>_<peerId>/YYYY-MM-DD.jsonl`
 *    （dist/features/msg-history.js 写的，含机器人自己发的，真实时间戳+昵称）。
 *    本补丁：host 侧新增 chatLogItems()/mergeChatLog()，在
 *      · 会话记录没了（no-session）→ 直接用台账兜底（code: 'log-only'）
 *      · 正常路径 → 与快照 events 合并去重后按时间升序 slice(-limit)
 *
 * ② 切 tab 改窗口大小 / 想要可调大小
 *    client 侧补 DOCK_CSS6：面板 flex 纵向、.dk-b 吃满剩余高度并可滚动；
 *    聊天 tab 加 .dk-b-chat 类 → 聊天框 flex:1 自适应（不再被固定 300px 裁掉）；
 *    右下角加可见拖拽手柄 .dk-grip（拖动改宽高并写 localStorage qqs-dock-size-v1，
 *    双击恢复默认）；paintBody 末尾重新 layoutPanel()，切 tab 尺寸纹丝不动。
 *
 * ③ 记忆页导入提示补一句：QQ 的 .bak / nt_msg.db 是加密库，密钥在 QQ 进程内存里，
 *    本插件不解密也不该去拿 —— 请在 QQ「消息管理器 → 导出消息记录」导出 .txt 再导入。
 *
 * 用法：
 *   node qqbot-mod/patches/fix-chatlog-dock.mjs --check    # 只看要改什么
 *   node qqbot-mod/patches/fix-chatlog-dock.mjs --apply    # 真写盘（先备份 .orig-muu + node --check）
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLUGIN, GENERATION, announce } from './plugin-dir.mjs';

const APPLY = process.argv.includes('--apply');
const HOST = join(PLUGIN, 'settings-host.js');
const CLIENT = join(PLUGIN, 'client', 'qqbot-settings.js');

announce('fix-chatlog-dock');
console.log(`  目标: ${PLUGIN}${GENERATION ? ` · generation ${GENERATION}` : ''}`);

/** 一处替换：old 必须在文本里出现且唯一 */
function splice(src, old, neu, label) {
  const n = src.split(old).length - 1;
  if (n === 0) return { src, hit: false, label };
  if (n > 1) throw new Error(`锚点不唯一（${n} 处）：${label}`);
  return { src: src.replace(old, neu), hit: true, label };
}

const results = [];
function edit(target, mutator) {
  const want = target === HOST ? 'settings-host.js' : 'client/qqbot-settings.js';
  const raw = readFileSync(target, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';   // 上游文件是 CRLF，锚点统一按 LF 写
  let src = eol === '\r\n' ? raw.split('\r\n').join('\n') : raw;
  const before = src;
  src = mutator(src);
  const changed = src !== before;
  results.push({ want, target, changed });
  if (!APPLY) { console.log(`  ${changed ? '~' : '='} ${want}: ${changed ? '需要写入' : '已是最新'}`); return; }
  if (!changed) { console.log(`  = ${want}: 已是最新`); return; }
  const bak = target + '.orig-muu';
  if (!existsSync(bak)) { copyFileSync(target, bak); console.log(`    备份: ${bak.replace(PLUGIN, '<plugin>')}`); }
  writeFileSync(target, eol === '\r\n' ? src.split('\n').join('\r\n') : src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    console.log(`  ✔ ${want}: 已写入（语法检查通过）`);
  } catch (e) {
    copyFileSync(bak, target);
    const msg = String(e.stderr || e.message || e);
    console.error(`  ✘ ${want}: 语法检查失败，已回滚\n${msg.split('\n').slice(0, 6).join('\n')}`);
    process.exitCode = 1;
  }
}

// ───────────────────────── ① host：用 msg-history 台账补全聊天页 ─────────────────────────
const HOST_HELPERS = `  // [qqbot-mod] chat-log-source（2026-10-25 主人: 浮窗群聊拿不到最新几条）
  //   msg-content.jsonl 只记"被引用过的消息"，不是完整台账；
  //   完整台账在 .qqbot/msg-history/<scope>_<peerId>/YYYY-MM-DD.jsonl（含机器人自己发的）。
  const CHATLOG_JUNK = /^\\[(记忆|设定|印象|旧识|别重复)[^\\]]*\\]\\s*/g
  function chatLogDir(bot, scope, peerId) {
    try {
      const root = resolveMemoryRoot(bot)
      if (!root) return ''
      const sid = String(peerId || '').replace(/[^0-9A-Za-z_-]/g, '')
      if (!sid) return ''
      return join(root, '.qqbot', 'msg-history', String(scope) + '_' + sid)
    } catch { return '' }
  }
  function chatLogItems(bot, scope, peerId, limit) {
    const out = []
    try {
      const dir = chatLogDir(bot, scope, peerId)
      if (!dir || !existsSync(dir)) return out
      const want = Math.max(1, Math.min(400, Number(limit) || 80))
      const names = readdirSync(dir).filter(function (n) { return /^\\d{4}-\\d{2}-\\d{2}\\.jsonl$/.test(n) }).sort()
      const lines = []
      for (let i = names.length - 1; i >= 0 && lines.length < want * 3; i--) {
        try {
          const rows = readFileSync(join(dir, names[i]), 'utf8').split(String.fromCharCode(10))
          for (let j = rows.length - 1; j >= 0 && lines.length < want * 3; j--) {
            const ln = String(rows[j] || '').trim()
            if (ln) lines.push(ln)
          }
        } catch { /* 单个日期文件读不到就跳过 */ }
      }
      const seen = Object.create(null)
      for (const ln of lines) {
        let o = null
        try { o = JSON.parse(ln) } catch { continue }
        if (!o) continue
        const t = Number(o.t) || 0
        if (!t) continue
        let text = String(o.x == null ? '' : o.x)
        if (o.k === 'image') text = text || '[图片]'
        else if (o.k === 'video') text = text || '[视频]'
        else if (o.k === 'voice') text = text || '[语音]'
        else if (o.k === 'file') text = text || '[文件]'
        text = text.replace(CHATLOG_JUNK, '').trim()
        if (!text) continue
        const dir2 = o.me ? 'out' : 'in'
        const key = Math.floor(t / 1000) + '|' + dir2 + '|' + text.slice(0, 24)
        if (seen[key]) continue
        seen[key] = 1
        out.push({
          seq: 0,
          time: t,
          dir: dir2,
          sender: String(o.n || o.s || (dir2 === 'out' ? '' : '群友')),
          text: text,
          images: [],
          tag: '',
          by: 'log',
          ms: 0,
          model: '',
        })
        if (out.length >= want) break
      }
    } catch { /* 台账读不到就当没有 */ }
    out.sort(function (a, b) { return (Number(a.time) || 0) - (Number(b.time) || 0) })
    return out
  }
  function mergeChatLog(items, extra, limit) {
    const byKey = Object.create(null)
    const all = []
    const add = function (it) {
      if (!it) return
      const k = Math.floor((Number(it.time) || 0) / 1000) + '|' + String(it.dir || '') + '|' + String(it.text || '').slice(0, 24)
      if (byKey[k]) return
      byKey[k] = 1
      all.push(it)
    }
    for (const it of (extra || [])) add(it)
    for (const it of (items || [])) add(it)
    all.sort(function (a, b) { return (Number(a.time) || 0) - (Number(b.time) || 0) })
    const cap = Math.max(1, Math.min(400, Number(limit) || 80))
    return all.length > cap ? all.slice(all.length - cap) : all
  }
`;

edit(HOST, (src) => {
  if (src.includes('[qqbot-mod] chat-log-source')) { console.log('  = host: chat-log-source 已存在'); return src; }
  let s = src;
  // 1) 在聊天路由前插入 helper（锚点：路由注册行，纯 ASCII，唯一）
  const ROUTE = "  route(ctx, 'GET', '/api/qqbot-settings/chat/history', async (req, res) => {";
  let r = splice(s, ROUTE, HOST_HELPERS + ROUTE, 'host: 插入 helper');
  if (!r.hit) throw new Error('找不到 chat/history 路由注册行');
  s = r.src;

  // 2) 路由里准备一个惰性取台账的闭包（bot 之后可能被跨实例兜底改写）
  const BOTLINE = '      let bot = nsBot(ns);';
  r = splice(s, BOTLINE, BOTLINE + "\n      const _chatLogOf = function () { try { return chatLogItems(bot, scope, peerId, 200) } catch { return [] } }", 'host: 挂 _chatLogOf');
  if (!r.hit) throw new Error('找不到 `let bot = nsBot(ns);`');
  s = r.src;

  // 3) 两处 no-session 兜底：先用台账顶上
  const FALLBACK1 = '        const only = chatLocalOnlyItems(bot, scope, peerId, limit)';
  r = splice(s, FALLBACK1,
    "        const _lg1 = _chatLogOf()\n"
    + "        if (_lg1.length) return writeJson(res, 200, { ok: true, code: 'log-only', items: mergeChatLog([], _lg1, limit), hasMore: false, tailSeq: 0, msg: '会话记录已换/未就绪，已用本地消息台账补齐' })\n"
    + FALLBACK1, 'host: no-session 兜底 A');
  if (!r.hit) throw new Error('找不到 no-session 分支 A');
  s = r.src;

  const FALLBACK2 = '        const only2 = chatLocalOnlyItems(bot, scope, peerId, limit)';
  r = splice(s, FALLBACK2,
    "        const _lg2 = _chatLogOf()\n"
    + "        if (_lg2.length) return writeJson(res, 200, { ok: true, code: 'log-only', items: mergeChatLog([], _lg2, limit), hasMore: false, tailSeq: 0, msg: '会话未就绪，已用本地消息台账补齐' })\n"
    + FALLBACK2, 'host: no-session 兜底 B');
  if (!r.hit) throw new Error('找不到 no-session 分支 B');
  s = r.src;

  // 4) local-only 两条也把台账并进去
  r = splice(s, 'items: only, hasMore: false', 'items: mergeChatLog(only, _lg1 || [], limit), hasMore: false', 'host: local-only A');
  if (!r.hit) throw new Error('找不到 local-only A');
  s = r.src;
  r = splice(s, 'items: only2, hasMore: false', 'items: mergeChatLog(only2, _lg2 || [], limit), hasMore: false', 'host: local-only B');
  if (!r.hit) throw new Error('找不到 local-only B');
  s = r.src;

  // 5) 主路径：最终返回前合并（保证最新几条一定在）
  const FINAL = '      writeJson(res, 200, { ok: true, items, hasMore: !reachedEnd, tailSeq: sess.seq, debug: diag });';
  r = splice(s, FINAL,
    "      // [qqbot-mod] chat-log-source：补上 msg-history 里的最新消息（按 秒+方向+前24字 去重）\n"
    + "      try { items = mergeChatLog(items, _chatLogOf(), limit) } catch (eM) {}\n"
    + FINAL, 'host: 主路径合并');
  if (!r.hit) throw new Error('找不到主路径 writeJson');
  return r.src;
});

// ───────────────────────── ② client：CSS6 + 缩放手柄 + chat flex ─────────────────────────
const CSS6_RULES = [
  '#qqs-dock-panel{display:flex;flex-direction:column;box-sizing:border-box;overflow:hidden}',
  '#qqs-dock-panel .dk-h,#qqs-dock-panel .dk-detect{flex:none}',
  '#qqs-dock-panel .dk-b{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}',
  /* 聊天 tab：整条链路 flex 下来，聊天框吃满剩余高度（原来固定 min(36vh,300px) 会被裁） */
  '#qqs-dock-panel .dk-b.dk-b-chat{display:flex;flex-direction:column;overflow:hidden}',
  '#qqs-dock-panel .dk-b.dk-b-chat .dk-chat-wrap{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
  '#qqs-dock-panel .dk-b.dk-b-chat .dk-chat-head{flex:none}',
  '#qqs-dock-panel .dk-b.dk-b-chat .dk-chat-box{flex:1 1 auto !important;height:auto !important;min-height:120px;max-height:none !important;overflow-y:auto;overscroll-behavior:contain}',
  '#qqs-dock-panel .dk-b.dk-b-chat .dk-composer{flex:none;margin-top:8px}',
  /* 右下角可见缩放手柄（原生 resize:both 的角在圆角+overflow:hidden 下几乎摸不到） */
  '#qqs-dock-panel .dk-grip{position:absolute;right:3px;bottom:3px;width:18px;height:18px;z-index:31;cursor:nwse-resize;opacity:.5;border-radius:0 0 6px 0;background:repeating-linear-gradient(135deg,var(--q-dim,#9aa0a8) 0 1.5px,transparent 1.5px 4.5px)}',
  '#qqs-dock-panel .dk-grip:hover{opacity:.95}',
  '@media (max-width:560px){#qqs-dock-panel .dk-grip{display:none}}',
];
const CSS6_DECL = 'var DOCK_CSS6 = "' + CSS6_RULES.join('\\n') + '"\n';
const CSS6_FN = `function ensureDockCss6() {
  try {
    if (document.getElementById('qqs-dock-css6')) return
    var st = document.createElement('style')
    st.id = 'qqs-dock-css6'
    st.textContent = DOCK_CSS6
    document.head.appendChild(st)
  } catch (e) {}
};
`;

const GRIP_FN = `      // [qqbot-mod] dock-grip（2026-10-25 主人: 窗口大小最好能调）
      //   原生 resize:both 的角被 border-radius + overflow:hidden 遮住，几乎摸不到；
      //   这里给一个看得见的右下角手柄：拖动改宽高 → 写 localStorage qqs-dock-size-v1；
      //   双击恢复默认尺寸（并清掉记忆）。
      function ensureDockGrip() {
        try {
          if (!panel) return
          var grip = panel.querySelector('.dk-grip')
          if (!grip) {
            grip = document.createElement('div')
            grip.className = 'dk-grip'
            grip.title = '拖动调整窗口大小（双击恢复默认）'
            panel.appendChild(grip)
          }
          if (grip._qqsBound) return
          grip._qqsBound = true
          grip.addEventListener('pointerdown', function (e) {
            if (e.pointerType === 'mouse' && e.button !== 0) return
            e.preventDefault(); e.stopPropagation()
            var sx = e.clientX, sy = e.clientY
            var w0 = panel.offsetWidth, h0 = panel.offsetHeight
            try { grip.setPointerCapture(e.pointerId) } catch (eC) {}
            var mv = function (ev) {
              var w = Math.max(420, Math.min((window.innerWidth || 1200) - 20, w0 + (ev.clientX - sx)))
              var h = Math.max(360, Math.min((window.innerHeight || 800) - 20, h0 + (ev.clientY - sy)))
              panel.style.width = Math.round(w) + 'px'
              panel.style.height = Math.round(h) + 'px'
            }
            var up = function () {
              document.removeEventListener('pointermove', mv)
              document.removeEventListener('pointerup', up)
              document.removeEventListener('pointercancel', up)
              manualPanelSize = { w: Math.round(panel.offsetWidth), h: Math.round(panel.offsetHeight) }
              try { localStorage.setItem('qqs-dock-size-v1', JSON.stringify(manualPanelSize)) } catch (eS) {}
            }
            document.addEventListener('pointermove', mv)
            document.addEventListener('pointerup', up)
            document.addEventListener('pointercancel', up)
          })
          grip.addEventListener('dblclick', function (e) {
            e.preventDefault(); e.stopPropagation()
            manualPanelSize = null
            try { localStorage.removeItem('qqs-dock-size-v1') } catch (eR) {}
            layoutPanel()
          })
        } catch (e) {}
      }
`;

edit(CLIENT, (src) => {
  let s = src;
  // 1) CSS6 定义（放在 startQqDock 之前；ensureDockCss5 已被"深海配色"占用，所以用 6）
  if (!s.includes('var DOCK_CSS6')) {
    const ANCHOR = '    function startQqDock(sessionsSvc) {';
    const r = splice(s, ANCHOR, CSS6_DECL + CSS6_FN + ANCHOR, 'client: CSS6 定义');
    if (!r.hit) throw new Error('找不到 startQqDock');
    s = r.src;
  }
  // 2) 启动时注入
  if (!s.includes('try { ensureDockCss6() }')) {
    const A2 = "try { ensureDockCss5() } catch (e) {}";
    const r = splice(s, A2, A2 + '\ntry { ensureDockCss6() } catch (e) {}', 'client: 注入 CSS6');
    if (!r.hit) throw new Error('找不到 ensureDockCss5 调用点');
    s = r.src;
  }
  // 3) 手柄函数（放进 startQqDock 闭包里，能访问 panel/manualPanelSize/layoutPanel）
  if (!s.includes('function ensureDockGrip()')) {
    const A3 = '      function closePanel() {';
    const r = splice(s, A3, GRIP_FN + A3, 'client: ensureDockGrip');
    if (!r.hit) throw new Error('找不到 closePanel');
    s = r.src;
  }
  // 4) renderPanel：加手柄 + 重排一次尺寸
  if (!s.includes('ensureDockGrip() } catch (eG)')) {
    const A4 = "        panel.innerHTML = '<div class=\"dk-h\"></div><div class=\"dk-detect\"></div><div class=\"dk-b\"></div>'";
    const r = splice(s, A4, A4 + "\n        try { ensureDockGrip() } catch (eG) {}\n        try { layoutPanel() } catch (eL) {}", 'client: renderPanel 挂钩');
    if (!r.hit) throw new Error('找不到 renderPanel 的 innerHTML 行');
    s = r.src;
  }
  // 5) paintBody 末尾：切 chat 类 + 重排尺寸（切 tab 尺寸不变）
  if (!s.includes("classList.add('dk-b-chat')")) {
    const A5 = "        if (state.tab === 'chat') renderChatList()";
    const r = splice(s, A5, A5
      + "\n        try { if (state.tab === 'chat') b.classList.add('dk-b-chat'); else b.classList.remove('dk-b-chat') } catch (eC2) {}"
      + "\n        try { ensureDockGrip(); layoutPanel() } catch (eL2) {}", 'client: paintBody 挂钩');
    if (!r.hit) throw new Error('找不到 paintBody 的 chat 分支');
    s = r.src;
  }
  // 6) 记忆页导入提示：说清 .bak 拿不到密钥这件事
  if (!s.includes('nt_msg.db')) {
    const A6 = "          + '<button class=\"dk-btn\" id=\"dk-imp-go\">📥 导入历史</button>'\n          + '</div>'";
    const HINT = "          + '</div>'\n"
      + "          + '<div class=\"q-hint\" style=\"margin:0 0 6px\">📦 支持 QQ「消息管理器 → 导出消息记录」得到的 <b>.txt</b>，或任意 <b>.json</b>。'\n"
      + "          + '<b>不支持 nt_msg.db / .bak</b>：那是 QQ 的加密数据库，密钥只在 QQ 运行时进程内存里，本插件不解密也不该去拿 —— 请在 QQ 里导出文本后再导入。</div>'";
    const r = splice(s, A6, "          + '<button class=\"dk-btn\" id=\"dk-imp-go\">📥 导入历史</button>'\n" + HINT, 'client: 导入提示');
    if (!r.hit) throw new Error('找不到导入历史按钮行');
    s = r.src;
  }
  return s;
});

console.log('');
if (!APPLY) {
  const need = results.filter((r) => r.changed).length;
  console.log(`结果: ${need} 个文件需要写入（加 --apply 落盘）`);
  process.exit(need ? 1 : 0);
}
console.log('结果: 完成。生效需要重启宿主（/bot-restart 或重启 DSH Desktop）+ 页面 Ctrl+F5。');
