/**
 * fix-panel-v7.mjs —— 浮窗第七轮改版（主人 2026-10-27 五条）
 *
 *  1) 记忆页「🏷 群等级（特别关心 / 普通）」整块删掉（特别关心已在「💬 聊天」页一键设）
 *  2) 记忆页「📖 学习心得」整块删掉
 *  3) 单会话页「✍️ 样例库」删掉；单会话页里重复的「本地代答 / 语音」两张卡删掉
 *     （那两张卡本来就在「🖥 本地模型」页，是同一个 extCardHtml）
 *  4) 标签「⚙️ 出站」改名「💠 联系方式」，里面补：QQ 联系方式清单 + B 站学习记录 + 学习心得
 *  5) 修「进了本地模型页就切不到别的页」：bindBiliCard/bindGamesCard/bindLlmCard 任一抛错
 *     会让后面的 bindBodyEvents 根本不执行 → 标签按钮拿不到 onclick。改成 each try/catch。
 *  6) 语音：新增「🎧 音色试听」（四个主力音色，真合成真播放）+ 修 saveExtVoice 把
 *     model 硬编码回 gpt-sovits（这就是"界面上选了新引擎，实际还是走 9880"的真因）
 *
 * 用法：
 *   node qqbot-mod/patches/fix-panel-v7.mjs --check
 *   node qqbot-mod/patches/fix-panel-v7.mjs --apply
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN, IS_LIVE, GENERATION } from './plugin-dir.mjs';

const TARGETS = [
  join(PLUGIN, 'client', 'qqbot-settings.js'),
  join(PLUGIN, 'settings-host.js'),
];

const crlf = (s) => s.replace(/\r\n/g, '\n');
const toCrlf = (s, hadCrlf) => (hadCrlf ? s.replace(/\n/g, '\r\n') : s);

/* ────────────────────────── 小工具 ────────────────────────── */

function cut(src, startMark, endMark, repl = '') {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error('找不到起点锚点：' + startMark.slice(0, 60));
  const j = src.indexOf(endMark, i);
  if (j < 0) throw new Error('找不到终点锚点：' + endMark.slice(0, 60));
  return src.slice(0, i) + repl + src.slice(j + endMark.length);
}

function once(src, marker, fn) {
  if (src.includes(marker)) return { src, hit: false };
  const out = fn(src);
  return { src: out, hit: true };
}

/* ────────────────────────── client ────────────────────────── */

function patchClient(src) {
  const log = [];

  // 1) 标签改名：出站 → 联系方式
  {
    const neu = `>💠 联系方式</button>`;
    const old = `>⚙️ 出站</button>`;
    if (src.includes(neu)) {
      log.push('= 标签已是「联系方式」');
    } else {
      const i = src.indexOf(old);
      if (i < 0) throw new Error('找不到「⚙️ 出站」标签');
      src = src.slice(0, i) + neu + src.slice(i + old.length);
      log.push('✓ 标签「⚙️ 出站」→「💠 联系方式」');
    }
  }

  // 2) 记忆页：删「群等级（特别关心 / 普通）」整块，只保留后面要用到的 tiers/pri 两个变量
  {
    const startMark = `        // 🏷 群等级（主人 2026-10-24）：特别关心群才区分群成员 / 注入个人印象卡`;
    const endMark = `        h += memSection('🏷 群等级（特别关心 / 普通）', tInner, '即时生效', true)`;
    if (src.includes(startMark) && src.includes(endMark)) {
      src = cut(src, startMark, endMark,
        `        // [qqbot-mod] contact-move（主人 2026-10-27）：群等级列表从记忆页删掉——\n` +
        `        //   特别关心在「💬 聊天」页一键设，清单和 B 站学习记录一起挪到「💠 联系方式」。\n` +
        `        var tiers = d.tiers || {}\n` +
        `        var pri = tiers.priority || []`);
      log.push('✓ 记忆页删掉「群等级」整块');
    } else {
      log.push('= 记忆页没有「群等级」块（已删过）');
    }
  }

  // 3) 记忆页：删「学习心得」整块
  {
    const startMark = `        // ── 📖 学习心得（自我学习线）：insight/growth 心得，人可审查 ──`;
    const endMark = `        } catch (eIN) {}`;
    if (src.includes(startMark) && src.includes(endMark)) {
      src = cut(src, startMark, endMark,
        `        // [qqbot-mod] contact-move：学习心得挪到「💠 联系方式」页（和 B 站学习记录放一起）`);
      log.push('✓ 记忆页删掉「学习心得」整块');
    } else {
      log.push('= 记忆页没有「学习心得」块（已删过）');
    }
  }

  // 4) 单会话页：删「样例库」整块（保留后面的模型说明那段）
  {
    const startMark = `            // ✍️ 样例库编辑(2026-09-13 主人问"哪里写样本"): 直接改 jsonl, 保存后下一条消息生效`;
    const endMark = `            body += '<div class="dk-msg" style="font-size:12px;color:#888;line-height:1.6">'`;
    if (src.includes(startMark)) {
      const i = src.indexOf(startMark);
      const j = src.indexOf(endMark, i);
      if (j < 0) throw new Error('样例库块找不到终点');
      src = src.slice(0, i) + src.slice(j);
      log.push('✓ 单会话页删掉「样例库」');
    } else {
      log.push('= 单会话页没有样例库块（已删过）');
    }
  }

  // 5) 单会话页：删掉重复的 extCardHtml（本地代答 / 语音已在「本地模型」页）
  {
    const oldLine = `            body += extCardHtml()   // ★ 本机新增(2026-10-23): 本地代答 / 语音 面板卡片 —— U3 本地代答 / 语音两张卡片`;
    if (src.includes(oldLine)) {
      src = src.replace(oldLine,
        `            // [qqbot-mod] contact-move：本地代答 / 语音两张卡只在「🖥 本地模型」页出现，这里不再重复`);
      log.push('✓ 单会话页去掉重复的本地代答/语音卡');
    } else {
      log.push('= 单会话页已无重复卡');
    }
  }

  // 6) 修「进本地模型页就切不了页」：三个 bind 各自 try/catch
  {
    const oldBind =
      `        if (state.tab === 'bili') bindBiliCard()\n` +
      `        if (state.tab === 'games') bindGamesCard()\n` +
      `        if (state.tab === 'llm') bindLlmCard()`;
    if (src.includes(oldBind)) {
      src = src.replace(oldBind,
        `        // [qqbot-mod] tab-lock（主人 2026-10-27）：这三个 bind 任一抛错，后面的 bindBodyEvents 就不执行，\n` +
        `        //   标签按钮就再也点不动（"进了本地模型页切不到别的页"）。逐个兜住，出错只记一笔。\n` +
        `        if (state.tab === 'bili') { try { bindBiliCard() } catch (eB) { console.warn('[qqbot] bindBiliCard', eB && eB.message) } }\n` +
        `        if (state.tab === 'games') { try { bindGamesCard() } catch (eG) { console.warn('[qqbot] bindGamesCard', eG && eG.message) } }\n` +
        `        if (state.tab === 'llm') { try { bindLlmCard() } catch (eL) { console.warn('[qqbot] bindLlmCard', eL && eL.message) } try { loadVoices() } catch (eV) { } try { bindAudition() } catch (eA) { console.warn('[qqbot] bindAudition', eA && eA.message) } }`);
      log.push('✓ 三个 tab bind 各自 try/catch（修「切不到别的页」）');
    } else {
      log.push('= tab bind 已加固');
    }
  }

  // 7) 「联系方式」页内容：插在 out 分支结尾（} else if (state.tab === 'bili') 之前）
  {
    const anchor = `        } else if (state.tab === 'bili') {`;
    if (src.includes(`contactHtml()`)) {
      log.push('= 联系方式内容已存在');
    } else {
      const i = src.indexOf(anchor);
      if (i < 0) throw new Error('找不到 bili 分支起点');
      src = src.slice(0, i) +
        `          // [qqbot-mod] contact-move：联系方式 = QQ 侧清单 + B 站学习记录 + 学习心得\n` +
        `          body += contactHtml()\n` +
        src.slice(i);
      log.push('✓ 出站页挂上 contactHtml()');
    }
  }

  // 8) 联系方式的两个函数 + 绑定（插在 bindExtCard 定义之前）
  {
    const anchor = `      function bindExtCard() {`;
    if (src.includes(`function contactHtml()`)) {
      log.push('= contactHtml 已定义');
    } else {
      const i = src.indexOf(anchor);
      if (i < 0) throw new Error('找不到 bindExtCard 定义');
      src = src.slice(0, i) + CONTACT_JS + '\n\n' + src.slice(i);
      log.push('✓ 加 contactHtml()/loadContact()/bindContact()');
    }
  }

  // 9) 切到「联系方式」页时拉数据
  {
    const oldClick = `            else if (state.tab === 'out') loadOutMode()`;
    if (src.includes(`loadOutMode(); loadContact()`)) {
      log.push('= 联系方式已自动加载');
    } else if (src.includes(oldClick)) {
      src = src.replace(oldClick, `            else if (state.tab === 'out') { loadOutMode(); loadContact() }`);
      log.push('✓ 切页时 loadContact()');
    } else {
      log.push('! 没找到 out 的点击分支（跳过，下次靠 bindBodyEvents 兜）');
    }
  }

  // 10) 渲染联系方式页时绑定它的事件
  {
    const oldTail = `        if (state.tab === 'chat') renderChatList()`;
    if (src.includes(`if (state.tab === 'out') bindContact()`)) {
      log.push('= 联系方式事件已绑');
    } else if (src.includes(oldTail)) {
      src = src.replace(oldTail,
        `        if (state.tab === 'out') { try { bindContact() } catch (eC3) { console.warn('[qqbot] bindContact', eC3 && eC3.message) } }\n` +
        oldTail);
      log.push('✓ 渲染时 bindContact()');
    } else {
      log.push('! 没找到 renderChatList 尾锚点（跳过）');
    }
  }

  // 11) 语音：saveExtVoice 不再把 model 硬编码回 gpt-sovits
  {
    const oldBlk =
      `        if (provider === 'http') {\n` +
      `          patch.model = 'gpt-sovits'\n` +
      `          patch.endpoint = 'http://127.0.0.1:9881/v1/audio/speech'\n` +
      `        }`;
    if (src.includes(oldBlk)) {
      src = src.replace(oldBlk,
        `        if (provider === 'http') {\n` +
        `          // [qqbot-mod] engine-keep（主人 2026-10-27）：这里原来写死 model='gpt-sovits'，\n` +
        `          //   于是在「本地模型」页选了 index/breeze 也被这一保存动作打回 gsv（后端 9880）——\n` +
        `          //   表现就是"我设了新的也没用，永远是 9880"。现在只在没设过 model 时才给默认值。\n` +
        `          var _curM = (state.extVoice && state.extVoice.model) || (state.contact && state.contact.engine) || 'gsv'\n` +
        `          patch.model = _curM\n` +
        `          patch.endpoint = (state.extVoice && state.extVoice.endpoint) || 'http://127.0.0.1:9881/v1/audio/speech'\n` +
        `        }`);
      log.push('✓ 修「选了引擎还是 9880」的 model 硬编码');
    } else {
      log.push('= saveExtVoice 已修');
    }
  }

  // 12) 本地模型页：音色试听块（插在引擎表之后）
  {
    const anchor = `          body += (typeof extCardHtml === 'function' ? extCardHtml() : '')`;
    if (src.includes(`body += (typeof auditionHtml === 'function'`)) {
      log.push('= 音色试听已挂上');
    } else if (src.includes(anchor)) {
      src = src.replace(anchor,
        `          body += (typeof auditionHtml === 'function' ? auditionHtml() : '')\n` + anchor);
      log.push('✓ 本地模型页加「🎧 音色试听」');
    } else {
      log.push('! 没找到本地模型页的 extCardHtml 锚点（跳过）');
    }
  }

  return { src, log };
}

const CONTACT_JS = `
      // [qqbot-mod] contact-move（主人 2026-10-27）
      //   「💠 联系方式」= 她和这个世界的联系：QQ 侧认了谁、B 站侧学过什么、以及她的学习心得。
      //   数据来自 GET /api/qqbot-settings/contact（host 侧读 group-tiers.json / groups.json /
      //   bili-ops records / memory.db 的 insight+growth）。
      function contactHtml() {
        var c = state.contact || {}
        var q = c.qq || {}
        var h = '<div class="dk-msg" style="font-size:11px;color:#888;line-height:1.6">她认的人、她学过的东西，都在这一页。QQ 侧是「群 / 人」的联系清单（特别关心的在前），B 站侧是本机台账里的出片 / 发布 / 评论记录，最下面是她自己的学习心得。</div>'

        // ── QQ ──
        var gi = ''
        var gl = q.groups || []
        gi += '<div style="font-size:11px;line-height:1.7">' + (gl.length ? gl.map(function (g) {
          return '<div style="display:flex;gap:6px;align-items:center;border-bottom:1px dashed #f0ecff;padding:2px 0">'
            + '<span style="flex:1">' + (g.priority ? '⭐ ' : '· ') + esc(g.name || g.id)
            + '<span style="color:#aaa;font-size:10px"> · ' + (g.msgs || 0) + ' 条</span></span>'
            + (g.priority ? '<span style="color:#e8590c;font-size:10px">特别关心</span>' : '')
            + '</div>'
        }).join('') : '<div style="color:#999">还没有群记录</div>') + '</div>'
        var pi = ''
        var pl = q.people || []
        pi += '<div style="font-size:11px;line-height:1.7">' + (pl.length ? pl.map(function (p) {
          return '<div style="display:flex;gap:6px;align-items:center;border-bottom:1px dashed #f0ecff;padding:2px 0">'
            + '<span style="flex:1">' + (p.priority ? '⭐ ' : '· ') + esc(p.name || '（未命名）')
            + (p.role ? '<span style="color:#7c5cff;font-size:10px"> · ' + esc(p.role) + '</span>' : '')
            + (p.note ? '<span style="color:#aaa;font-size:10px"> · ' + esc(String(p.note).slice(0, 24)) + '</span>' : '')
            + '</span>'
            + (p.priority ? '<span style="color:#e8590c;font-size:10px">特别关心</span>' : '')
            + '</div>'
        }).join('') : '<div style="color:#999">还没有私聊记录</div>') + '</div>'
        h += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:10px 0 2px">📇 QQ 联系方式</div>'
        h += '<div style="font-size:10px;color:#999;margin:0 0 4px">' + (q.counts ? ('群 ' + (q.counts.groups || 0) + ' · 人 ' + (q.counts.people || 0)) : '') + '</div>'
        h += gi + '<div style="height:6px"></div>' + pi

        // ── B 站 ──
        var bl = c.bili || []
        h += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:12px 0 2px;gap:8px;align-items:center">'
          + '<span>📺 B 站学习记录</span>'
          + '<button class="dk-btn" id="dk-contact-reload" style="font-size:11px;padding:1px 8px">🔄 刷新</button>'
          + '<span class="dk-msg" style="font-size:10px;color:#999">' + (c.contactErr ? esc(c.contactErr) : '本机台账，不联网') + '</span></div>'
        h += '<div style="font-size:11px;line-height:1.6">' + (bl.length ? bl.slice(0, 20).map(function (r) {
          var icon = r.type === 'publish' ? '🚀' : r.type === 'render' ? '🎬' : r.type === 'plan' ? '📝'
            : r.type === 'comment' ? '💬' : r.type === 'dynamic' ? '📰' : '·'
          var t = new Date(Number(r.at) || 0)
          var ds = isNaN(t.getTime()) ? '' : (t.getMonth() + 1) + '/' + t.getDate() + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
          return '<div style="display:flex;gap:6px;align-items:flex-start;border-bottom:1px dashed #f0ecff;padding:2px 0">'
            + '<span style="color:#aaa;font-size:10px;flex:none;width:76px">' + ds + '</span>'
            + '<span style="flex:1">' + icon + ' ' + esc(String(r.text || r.type || '').slice(0, 46))
            + (r.url ? ' <a href="' + esc(r.url) + '" target="_blank" style="color:#1971c2">↗</a>' : '')
            + (r.ok === false ? ' <span style="color:#c92a2a;font-size:10px">失败</span>' : '')
            + '</span></div>'
        }).join('') : '<div style="color:#999">还没有 B 站记录 —— 让她建个片单或发条动态，这里就会长出来</div>') + '</div>'

        // ── 学习心得 ──
        var ins = c.insights || []
        var srcName = { family: '👨‍👩‍👧 家人', bili: '📺 B站', chat: '💬 聊天', self: '🌿 自省' }
        h += '<div class="dk-row" style="font-weight:700;font-size:13px;margin:12px 0 2px;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<span>📖 学习心得（从记忆页挪过来）</span>'
          + '<button class="dk-btn" id="dk-insight-reflect" style="padding:0 8px;height:20px;font-size:10px">🌿 自我反思</button>'
          + '<span class="dk-msg" style="font-size:10px;color:#999">每天自动一次 · 人可审查</span></div>'
        h += ins.length ? ins.slice(0, 15).map(function (m) {
          var src = srcName[m.source] || ('💬 ' + esc(String(m.source || 'chat')))
          var kindIcon = m.kind === 'growth' ? '🌿' : '📖'
          var when = ''
          try { var t = new Date(Number(m.ts) || 0); when = isNaN(t.getTime()) ? '' : ((t.getMonth() + 1) + '/' + t.getDate()) } catch (e) {}
          return '<div style="font-size:11px;line-height:1.6;border-bottom:1px dashed #f0ecff;padding:3px 0;display:flex;gap:6px;align-items:flex-start">'
            + '<span style="flex:1">' + kindIcon + ' <span style="color:#888">' + src + '</span> ' + esc(m.text)
            + ' <span style="color:#aaa;font-size:10px">' + when + '</span></span>'
            + '<span style="flex:none;display:flex;gap:6px">'
            + '<a data-insight-to-bedrock="' + esc(m.id) + '" data-text="' + esc(m.text) + '" style="color:#e8590c;cursor:pointer" title="人工确认后刻为信条">🪨刻</a>'
            + '<a data-insight-del="' + esc(m.id) + '" style="color:#c92a2a;cursor:pointer" title="删除这条心得">×</a></span></div>'
        }).join('') : '<div style="font-size:11px;color:#999">还没有心得 —— 也可以点「自我反思」让她先写一篇</div>'
        return h
      }

      function loadContact() {
        api('contact', { ns: state.ns || undefined }).then(function (d) {
          state.contact = (d && d.ok) ? d : (state.contact || {})
          state.contact.contactErr = (d && d.ok) ? '' : ((d && (d.error || d.reason)) || '联系方式读取失败')
          if (state.tab === 'out') paintBody()
        }).catch(function (e) {
          state.contact = state.contact || {}
          state.contact.contactErr = '联系方式读取失败: ' + (e && e.message ? e.message : '?')
          if (state.tab === 'out') paintBody()
        })
      }

      function bindContact() {
        var rb = panel.querySelector('#dk-contact-reload')
        if (rb) rb.onclick = function () { loadContact() }
        var rf = panel.querySelector('#dk-insight-reflect')
        if (rf) rf.onclick = function () {
          rf.disabled = true; rf.textContent = '反思中…'
          memPost({ action: 'self-reflect' }).then(function (r) {
            rf.disabled = false; rf.textContent = '🌿 自我反思'
            if (!r || !r.ok) { state.contact = state.contact || {}; state.contact.contactErr = '反思失败: ' + ((r && (r.reason || r.error)) || '?'); paintBody(); return }
            loadContact()
          }).catch(function () { rf.disabled = false; rf.textContent = '🌿 自我反思' })
        }
        Array.prototype.forEach.call(panel.querySelectorAll('[data-insight-del]'), function (a) {
          a.onclick = function () {
            if (!confirm('删除这条学习心得？')) return
            memPost({ action: 'insight-del', id: a.getAttribute('data-insight-del'), scope: '__global__' }).then(function (r) {
              if (!r || !r.ok) return
              loadContact()
            })
          }
        })
        Array.prototype.forEach.call(panel.querySelectorAll('[data-insight-to-bedrock]'), function (a) {
          a.onclick = function () {
            var txt = a.getAttribute('data-text') || ''
            if (!confirm('把这条心得刻为信条？\\n「' + txt + '」\\n\\n刻入后进入她底层（LLM 不可改），确定是你要的吗？')) return
            memPost({ action: 'bedrock-add', text: txt, confirm: 'human' }).then(function (r) {
              if (!r || !r.ok) return
              loadContact()
            })
          }
        })
      }

      // 🎧 音色试听：四个主力音色，点一下真合成并播放（不是占位图）
      function auditionHtml() {
        var vs = (state.voices && state.voices.curated) || []
        var cur = (state.extVoice && state.extVoice.voice) || ''
        var eng = (state.extVoice && state.extVoice.model) || ''
        var h = '<div class="dk-row" style="font-weight:700;font-size:13px;margin:12px 0 2px;gap:8px;align-items:center">'
          + '<span>🎧 音色试听（四种主力音色）</span>'
          + '<button class="dk-btn" id="dk-voice-audition-refresh" style="font-size:11px;padding:1px 8px">🔄 重新读</button>'
          + '<span class="dk-msg" style="font-size:10px;color:#999">当前：' + esc(eng || '未设引擎') + ' / ' + esc(cur || '未设音色')
          + ' · <span id="dk-voice-audition-hint"></span></span></div>'
        if (!vs.length) {
          h += '<div class="dk-msg" style="font-size:11px;color:#999">读不到音色清单（看下面引擎表的报错，或点「重新读」）</div>'
        } else {
          h += vs.map(function (v) {
            var on = cur && cur === v.voice
            return '<div class="dk-vrow" data-voice="' + esc(v.voice) + '" style="display:flex;gap:8px;align-items:center;border-bottom:1px dashed #f0ecff;padding:4px 0;flex-wrap:wrap">'
              + '<span style="flex:1;font-size:12px">' + (on ? '✅ ' : '') + '<b>' + esc(v.label || v.voice) + '</b>'
              + '<span style="color:#999;font-size:10px"> · ' + esc(v.voice) + (v.hint ? ' · ' + esc(v.hint) : '') + '</span></span>'
              + '<button class="dk-btn" data-audition="' + esc(v.voice) + '" style="font-size:11px;padding:2px 8px">▶️ 试听</button>'
              + '<button class="dk-btn ok" data-usevoice="' + esc(v.voice) + '" style="font-size:11px;padding:2px 8px">用这个</button>'
              + '</div>'
          }).join('')
          h += '<audio id="dk-voice-audio" preload="none" style="width:100%;margin-top:6px;display:none"></audio>'
        }
        h += '<div class="dk-msg" style="font-size:10px;color:#999;line-height:1.6">试听走的是同一个本地适配层（9881）—— 会按你选的音色真合成一句，首次没起服务可能要等几十秒。</div>'
        return h
      }

      function loadVoices() {
        if (state.voicesBusy) return
        state.voicesBusy = true
        api('tts-voices', { ns: state.ns || undefined }).then(function (d) {
          state.voicesBusy = false
          state.voices = (d && d.ok) ? d : (state.voices || {})
          if (state.tab === 'llm') paintBody()
        }).catch(function () { state.voicesBusy = false })
      }

      function bindAudition() {
        var rb = panel.querySelector('#dk-voice-audition-refresh')
        if (rb) rb.onclick = function () { state.voices = null; loadVoices() }
        var audio = panel.querySelector('#dk-voice-audio')
        var hint = panel.querySelector('#dk-voice-audition-hint')
        Array.prototype.forEach.call(panel.querySelectorAll('[data-audition]'), function (btn) {
          btn.onclick = function () {
            var v = btn.getAttribute('data-audition')
            btn.disabled = true
            var old = btn.textContent
            btn.textContent = '合成中…'
            if (hint) hint.textContent = '（' + v + ' 正在合成，首次起服务要等）'
            apiPost('tts-preview', { ns: state.ns || undefined, voice: v }).then(function (d) {
              btn.disabled = false
              btn.textContent = old
              if (!d || !d.ok) {
                if (hint) hint.textContent = '合成失败：' + ((d && (d.error || d.reason)) || '?')
                return
              }
              if (hint) hint.textContent = '（' + v + ' ' + Math.round((d.ms || 0) / 100) / 10 + 's · ' + (d.bytes || 0) + ' B）'
              if (audio) {
                audio.style.display = 'block'
                audio.src = d.url
                try { audio.play() } catch (eP) { }
              }
            }).catch(function (e2) {
              btn.disabled = false
              btn.textContent = old
              if (hint) hint.textContent = '合成失败：' + (e2 && e2.message ? e2.message : '?')
            })
          }
        })
        Array.prototype.forEach.call(panel.querySelectorAll('[data-usevoice]'), function (btn) {
          btn.onclick = function () {
            var v = btn.getAttribute('data-usevoice')
            var eng = (state.extVoice && state.extVoice.model) || ((state.voices && state.voices.current && state.voices.current.model) || 'gsv')
            apiPost('ext-config', { ns: state.ns || undefined, which: 'voice', patch: { provider: 'http', voice: v, model: eng, endpoint: 'http://127.0.0.1:9881/v1/audio/speech' } }).then(function (d) {
              if (d && d.ok) {
                state.extVoice = Object.assign({}, state.extVoice || {}, { provider: 'http', voice: v, model: eng, loaded: true })
                state.msg = '已切到音色「' + v + '」（下一条回复生效）'
              } else {
                state.msg = '切换失败：' + ((d && (d.error || d.reason)) || '?')
              }
              paintBody()
            })
          }
        })
      }
`;

/* ────────────────────────── host ────────────────────────── */

const HOST_ROUTES = `
  // [qqbot-mod] contact-move（主人 2026-10-27）：「💠 联系方式」的数据源。
  //   QQ 侧读 group-tiers.json + groups.json + msg-history 的条数；B 站侧读本机两份台账；
  //   学习心得沿用 memory.db 的 insight/growth（记忆页那块已经删掉，改在这里展示）。
  route(ctx, 'GET', '/api/qqbot-settings/contact', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      const ext = async (rel) => import('file:///' + join(root, '.qqbot-extensions', rel).replace(/\\\\/g, '/'));
      const out = { ok: true, root, qq: { groups: [], people: [], counts: { groups: 0, people: 0 } }, bili: [], insights: [] };
      // 群名表
      let gNames = {};
      try { gNames = JSON.parse(readFileSync(join(root, '.qqbot', 'groups.json'), 'utf8')) || {}; } catch { }
      // 台账条数 + 昵称
      const stats = {};
      try {
        const mh = join(root, '.qqbot', 'msg-history');
        if (existsSync(mh)) {
          for (const d of readdirSync(mh)) {
            const mm = /^(group|c2c)_(.+)$/.exec(d);
            if (!mm) continue;
            const kind = mm[1], id = mm[2];
            const key = kind + ':' + id;
            let cnt = 0, name = '';
            try {
              const dir = join(mh, d);
              const files = readdirSync(dir).filter((f) => /^\\d{4}-\\d{2}-\\d{2}\\.jsonl$/.test(f)).sort();
              const last = files[files.length - 1];
              if (last) {
                const lines = readFileSync(join(dir, last), 'utf8').split(String.fromCharCode(10)).filter(Boolean);
                cnt = lines.length;
                for (let i = lines.length - 1; i >= 0 && i > lines.length - 80; i--) {
                  try {
                    const o = JSON.parse(lines[i]);
                    const n = String(o.n || '');
                    if (n && n !== 'self' && !/^[0-9A-Fa-f]{32}$/.test(n)) { name = n; break; }
                  } catch { }
                }
              }
            } catch { }
            stats[key] = { kind, id, msgs: cnt, name };
          }
        }
      } catch { }
      // 特别关心名单（群 / 人）+ 关系档案里的角色
      let tiers = { priority: [], priorityPeople: [] };
      try { tiers = JSON.parse(readFileSync(join(root, '.qqbot-extensions', 'data', 'group-tiers.json'), 'utf8')) || tiers; } catch { }
      let relmap = {};
      try {
        const core = await ext('lib/memory-panel-core.mjs');
        const ch = core.loadCharacter ? core.loadCharacter(root) : null;
        if (ch && ch.relationOf) relmap = ch.relationOf;
      } catch { }
      const priG = new Set((tiers.priority || []).map((x) => String(x).replace(/^group:/, '')));
      const priP = new Set((tiers.priorityPeople || []).map((x) => String(x).replace(/^c2c:/, '')));
      // 群：台账里有的都列，特别关心的排前面；再补上"只在 tiers 里有"的
      const seenG = new Set();
      const groups = [];
      Object.values(stats).forEach((s) => {
        if (s.kind !== 'group') return;
        seenG.add(s.id);
        const gname = (gNames[s.id] && gNames[s.id].name) || s.name || s.id;
        groups.push({ id: s.id, name: gname, msgs: s.msgs, priority: priG.has(s.id) });
      });
      priG.forEach((id) => {
        if (seenG.has(id)) return;
        const gname = (gNames[id] && gNames[id].name) || id;
        groups.push({ id, name: gname, msgs: 0, priority: true });
      });
      groups.sort((a, b) => (Number(b.priority) - Number(a.priority)) || (b.msgs - a.msgs));
      // 人：优先看特别关心名单 + 熟识度
      const people = [];
      const seenP = new Set();
      priP.forEach((id) => {
        const s = stats['c2c:' + id] || null;
        seenP.add(id);
        people.push({ id, name: (s && s.name) || id.slice(-6), role: relmap[(s && s.name) || ''] || '', priority: true, note: '' });
      });
      Object.values(stats).forEach((s) => {
        if (s.kind !== 'c2c') return;
        if (seenP.has(s.id)) return;
        people.push({ id: s.id, name: s.name || s.id.slice(-6), role: relmap[s.name || ''] || '', priority: false, note: '' });
      });
      out.qq.groups = groups.slice(0, 40);
      out.qq.people = people.slice(0, 40);
      out.qq.counts = { groups: groups.length, people: people.length };
      // B 站台账
      const pushBili = (o, defType) => {
        if (!o || typeof o !== 'object') return;
        const at = Number(o.ts || o.at || 0) || 0;
        const dynId = String(o.dynamicId || o.dyn_id || '');
        out.bili.push({
          at,
          type: String(o.type || defType),
          text: String(o.text || o.title || o.summary || o.desc || o.topic || '').trim(),
          url: String(o.url || (dynId ? 'https://t.bilibili.com/' + dynId : '')),
          ok: o.ok === false ? false : true,
        });
      };
      try {
        const p1 = join(root, '.qqbot', 'bili-dynamic-log.jsonl');
        if (existsSync(p1)) for (const L of readFileSync(p1, 'utf8').split(String.fromCharCode(10))) { const t = L.trim(); if (t) { try { pushBili(JSON.parse(t), 'dynamic'); } catch { } } }
      } catch { }
      try {
        const p2 = join(root, '.qqbot', 'bili-ops', 'records.jsonl');
        if (existsSync(p2)) for (const L of readFileSync(p2, 'utf8').split(String.fromCharCode(10))) { const t = L.trim(); if (t) { try { pushBili(JSON.parse(t), 'log'); } catch { } } }
      } catch { }
      try {
        const p3 = join(root, 'data', 'bili-ops', 'records.jsonl');
        if (existsSync(p3)) for (const L of readFileSync(p3, 'utf8').split(String.fromCharCode(10))) { const t = L.trim(); if (t) { try { pushBili(JSON.parse(t), 'log'); } catch { } } }
      } catch { }
      out.bili.sort((a, b) => b.at - a.at);
      out.bili = out.bili.slice(0, 40);
      // 学习心得
      try {
        const mem = await ext('lib/memory.mjs');
        const list = mem.loadMemories(root, '__global__') || [];
        out.insights = list.filter((m) => ['insight', 'growth'].includes(String(m.kind || '')))
          .map((m) => ({ id: m.id, kind: m.kind, text: String(m.text || ''), source: String(m.source || 'chat'), ts: m.ts || 0 }))
          .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 20);
      } catch (eI) { out.insightErr = String(eI && eI.message || eI); }
      writeJson(res, 200, out);
    } catch (e) {
      writeJson(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  // [qqbot-mod] voice-audition（主人 2026-10-27）：四个主力音色 + 真合成试听。
  route(ctx, 'GET', '/api/qqbot-settings/tts-voices', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(join(root, '.qqbot-extensions', 'voice-config.json'), 'utf8')) || {}; } catch { }
      let prof = {};
      try { prof = JSON.parse(readFileSync(join(root, '..', 'skills', 'local-tts', 'adapter', 'profiles.json'), 'utf8')) || {}; } catch { }
      if (!prof || !prof.curated) {
        try { prof = JSON.parse(readFileSync('F:/qqbot/skills/local-tts/adapter/profiles.json', 'utf8')) || {}; } catch { }
      }
      const curated = (prof.curated || []).map((c) => ({ voice: c.voice, label: c.label, hint: c.hint || '', backend: (prof.voices && prof.voices[c.voice] && prof.voices[c.voice].backend) || '' }));
      writeJson(res, 200, {
        ok: true,
        curated,
        current: { voice: cfg.voice || '', model: cfg.model || '', provider: cfg.provider || '', endpoint: cfg.endpoint || '', speed: cfg.speed || 1 },
        profilePath: 'skills/local-tts/adapter/profiles.json',
      });
    } catch (e) {
      writeJson(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  route(ctx, 'POST', '/api/qqbot-settings/tts-preview', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const bot = nsBot(String(body.ns || ''));
      const root = resolveMemoryRoot(bot);
      const voice = String(body.voice || '').trim();
      const engine = String(body.engine || '').trim();
      if (!voice) { writeJson(res, 200, { ok: false, error: '没给音色名' }); return; }
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(join(root, '.qqbot-extensions', 'voice-config.json'), 'utf8')) || {}; } catch { }
      const ext = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'tts-core.mjs').replace(/\\\\/g, '/'));
      const text = String(body.text || '你好呀，我是小蓝。这个声音你听得惯吗？').slice(0, 60);
      const t0 = Date.now();
      const r = await ext.synthesize(text, {
        dataRoot: root,
        provider: 'http', // 试听一律走本地（只有本地才有音色可选）
        endpoint: String(cfg.endpoint || 'http://127.0.0.1:9881/v1/audio/speech'),
        model: engine || String(cfg.model || 'gsv'),
        voice,
        speed: Number(body.speed || cfg.speed || 1) || 1,
        keepText: false,
        timeoutMs: 300000,
      });
      const ms = Date.now() - t0;
      if (!r || !r.ok || !r.path) {
        writeJson(res, 200, { ok: false, error: String((r && (r.error || r.reason)) || '合成失败'), ms, via: (r && r.via) || '' });
        return;
      }
      // 复制到 preview 目录（固定名，方便反复覆盖，不占 tts 目录额度）
      const pvDir = join(root, '.qqbot', 'tts', 'preview');
      try { mkdirSync(pvDir, { recursive: true }); } catch { }
      const safe = voice.replace(/[^0-9A-Za-z_-]/g, '_');
      const dst = join(pvDir, safe + '.mp3');
      try { copyFileSync(r.path, dst); } catch { }
      writeJson(res, 200, {
        ok: true, voice, engine: engine || cfg.model || 'gsv', ms,
        bytes: Number(r.bytes || 0), via: r.via || '',
        url: '/api/qqbot-settings/tts-preview-file?name=' + encodeURIComponent(safe + '.mp3') + '&ns=' + encodeURIComponent(String(body.ns || '')) + '&t=' + Date.now(),
      });
    } catch (e) {
      writeJson(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  route(ctx, 'GET', '/api/qqbot-settings/tts-preview-file', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      const name = String(u.searchParams.get('name') || '');
      if (!/^[0-9A-Za-z_-]+\\.mp3$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
      const p = join(root, '.qqbot', 'tts', 'preview', name);
      if (!existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
      const buf = readFileSync(p);
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(buf.length), 'cache-control': 'no-store' });
      res.end(buf);
    } catch (e) {
      res.writeHead(500); res.end(String(e && e.message ? e.message : e));
    }
  });
`;

function patchHost(src) {
  const log = [];
  if (src.includes("'/api/qqbot-settings/contact'")) {
    log.push('= host 路由已存在');
    return { src, log };
  }
  const anchors = [
    `  route(ctx, ['GET', 'POST'], '/api/qqbot-settings/timers'`,
    `  route(ctx, 'GET', '/api/qqbot-settings/draw-info'`,
    `  route(ctx, 'POST', '/api/qqbot-settings/open-dir'`,
  ];
  for (const a of anchors) {
    const i = src.indexOf(a);
    if (i < 0) continue;
    src = src.slice(0, i) + HOST_ROUTES + '\n' + src.slice(i);
    log.push('✓ host 加 contact / tts-voices / tts-preview / tts-preview-file 四条路由（插在 ' + a.trim().slice(0, 48) + ' 前）');
    return { src, log };
  }
  throw new Error('找不到 host 路由插入点');
}

/* ────────────────────────── main ────────────────────────── */

const mode = process.argv.includes('--apply') ? 'apply' : 'check';
const generated = [];
for (const file of TARGETS) {
  if (!existsSync(file)) { console.log('✗ 找不到 ' + file); process.exitCode = 1; continue; }
  const raw = readFileSync(file, 'utf8');
  const hadCrlf = raw.includes('\r\n');
  let src = crlf(raw);
  const isClient = file.endsWith('qqbot-settings.js');
  const r = isClient ? patchClient(src) : patchHost(src);
  src = r.src;
  const changed = src !== crlf(raw);
  const rel = file.slice(PLUGIN.length + 1);
  console.log(`\n── ${rel}${changed ? '（需要写入）' : '（已是最新）'}`);
  r.log.forEach((l) => console.log('   ' + l));
  if (changed) generated.push({ file, rel, body: toCrlf(src, hadCrlf) });
}

if (mode === 'apply' && generated.length) {
  console.log('\n目标 generation：' + (IS_LIVE ? 'live' : '非 live') + ' · ' + GENERATION);
  for (const g of generated) {
    copyFileSync(g.file, g.file + '.orig-muu');
    writeFileSync(g.file, g.body);
    console.log('  ✔ 写入 ' + g.rel + '（备份 .orig-muu）');
  }
  console.log('\n写完记得：node --check，然后 node qqbot-mod/patches/live-overlay/capture.mjs 固化 overlay');
} else if (mode === 'apply') {
  console.log('\n没有需要写入的改动。');
} else {
  console.log('\n[check] 上面是预演；加 --apply 真正写入。');
}
