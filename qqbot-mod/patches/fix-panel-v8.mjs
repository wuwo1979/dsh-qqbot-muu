// fix-panel-v8.mjs —— 浮窗三处：去掉记忆页冗余的「⭐ 特别关心」编辑块、语音清单不再刷屏、
//                    标签点击加一层兜底委托（任何 bind 抛错也能切页）
// 用法：node qqbot-mod/patches/fix-panel-v8.mjs [--check|--apply]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { pluginPath, announce } from './plugin-dir.mjs';

const REL = 'client/qqbot-settings.js';
const MARK = '[qqbot-mod] panel-v8';

const ops = [
  {
    label: '删记忆页「⭐ 特别关心」编辑块（已在聊天页一键设，冗余）',
    guard: 'tier-ui-removed',
    run(src) {
      const startMark = '// 🎚 批量回复门槛（主人 2026-10-24）：一次给多个会话写覆盖项';
      const endMark = '// ── 🪨 底层信条（主人 2026-10-26）';
      const i = src.indexOf(startMark);
      const j = src.indexOf(endMark);
      if (i < 0 || j < 0 || j < i) throw new Error('找不到 tier 块边界');
      // 只删到 catch 结尾，保留 tiers/pri 变量（后面的批量门槛还要用）
      return src.slice(0, i) + '// [qqbot-mod] tier-ui-removed：特别关心的编辑入口只在「💬 聊天」页（每条消息 ☆ / 顶部群开关）。\n        ' + src.slice(j);
    },
  },
  {
    label: '语音清单只重绘一次（不再无限刷新）',
    guard: 'voices-once',
    run(src) {
      const old = "          if (state.tab === 'llm') paintBody()";
      if (!src.includes(old)) throw new Error('找不到 loadVoices 里的 paintBody');
      return src.replace(old, "          if (state.tab === 'llm' && !state.voicesSeen) { state.voicesSeen = true; try { paintBody() } catch (eV) {} }");
    },
  },
  {
    label: '本地模型页只在没有清单时才去读（不重复请求）',
    guard: 'voices-lazy',
    run(src) {
      const old = "        if (state.tab === 'llm') { try { bindLlmCard() } catch (eL) { console.warn('[qqbot] bindLlmCard', eL && eL.message) } try { loadVoices()";
      if (!src.includes(old)) throw new Error('找不到 llm bind 分支');
      return src.replace(old, "        if (state.tab === 'llm') { try { bindLlmCard() } catch (eL) { console.warn('[qqbot] bindLlmCard', eL && eL.message) } if (!state.voices) try { loadVoices() ");
    },
  },
  {
    label: '标签点击兜底委托（任何 bind 抛错也能切页）',
    guard: 'tab-delegate',
    run(src) {
      const anchor = '        b.innerHTML = body';
      if (!src.includes(anchor)) throw new Error('找不到 b.innerHTML = body');
      const add = anchor + `
        // [qqbot-mod] panel-v8 tab-delegate：标签点击走一次性事件委托，bindBodyEvents 挂了也能切页
        try {
          if (!panel._dkTabDelegate) {
            panel._dkTabDelegate = true
            panel.addEventListener('click', function (ev) {
              var t = ev.target
              var btn = (t && t.closest) ? t.closest('.dk-tab button') : null
              if (!btn || !panel.contains(btn)) return
              var want = btn.getAttribute('data-t')
              if (!want || want === state.tab) return
              state.tab = want; state.msg = ''
              if (want === 'out') { try { loadOutMode() } catch (e) {} try { loadContact() } catch (e) {} }
              if (want === 'bili') { try { loadBiliLog() } catch (e) {} try { loadDrawInfo() } catch (e) {} }
              try { paintBody() } catch (e) {}
            })
          }
        } catch (eTD) {}`;
      return src.replace(anchor, add);
    },
  },
];

function main() {
  const apply = process.argv.includes('--apply');
  announce('浮窗 v8');
  const file = pluginPath(REL);
  if (!existsSync(file)) throw new Error('找不到 ' + file);
  let src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  let changed = 0;
  for (const op of ops) {
    if (op.guard && src.includes(op.guard)) {
      console.log('  = 已是新版：' + op.label);
      continue;
    }
    const out = op.run(src);
    if (out === src) { console.log('  = 无变化：' + op.label); continue; }
    src = out;
    src += ''; // noop
    changed += 1;
    console.log('  ' + (apply ? '✔' : '!') + ' ' + op.label);
    if (!apply) continue;
  }
  if (!apply) {
    console.log(changed ? `  ! ${changed} 处需要写入（加 --apply）` : '  = 全部已是最新');
    return;
  }
  if (!changed) { console.log('  = 全部已是最新，无需写入'); return; }
  copyFileSync(file, file + '.orig-muu');
  writeFileSync(file, src.replace(/\n/g, '\r\n'), 'utf8');
  console.log('  ✔ 写入 ' + REL + '（' + MARK + '）');
}

main();
