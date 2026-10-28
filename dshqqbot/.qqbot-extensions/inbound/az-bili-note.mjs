/**
 * inbound/zz-bili-note.mjs — 把 B 站的"待汇报"塞进下一条消息
 *
 * 为什么不做主动发消息：浮窗/插件没有稳定的主动发消息入口，
 * 硬发容易和单脑仲裁、群发队列打架。这里用"下一条消息附带一块 [B站] 提示"，
 * 让模型开口就把"定时浏览结果 / 登录失效"说给主人听，零额外通道。
 *
 * 队列：{dataRoot}/.qqbot/bili-pending.jsonl（定时任务/登录失效写入）
 * 标记：{dataRoot}/.qqbot/bili-login-lost.flag
 * 注入块在 outbound / 本地代答 / 聊天台账三处都会被剥掉。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'zz-bili-note';

function dataRoot() {
  try {
    const cfg = JSON.parse(readFileSync('F:/qqbot/dshqqbot/memory-config.json', 'utf8'));
    return cfg.dataRoot || 'F:/qqbot/dshqqbot';
  } catch { return 'F:/qqbot/dshqqbot'; }
}

function readQueue(file) {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export async function onInbound(ctx, next) {
  try {
    const root = dataRoot();
    const qf = join(root, '.qqbot', 'bili-pending.jsonl');
    const ff = join(root, '.qqbot', 'bili-login-lost.flag');
    const parts = [];

    const items = readQueue(qf);
    if (items.length) {
      const text = items.map((x) => String(x.text || '').slice(0, 600)).join('\n');
      parts.push(`下一条回复里要顺口汇报这些 B 站进展（别生硬念稿）：\n${text}`);
      try { writeFileSync(qf, '', 'utf8'); } catch { /* ignore */ }
    }

    if (existsSync(ff)) {
      try {
        const flag = JSON.parse(readFileSync(ff, 'utf8') || '{}');
        const ts = Number(flag.ts || 0);
        if (ts > 0 && Date.now() - ts < 24 * 3600_000) {
          parts.push('B 站登录已失效：请主人有空重新扫码（action=login_start），之后才能继续读动态/收藏、发评论。');
          writeFileSync(ff, '', 'utf8');
        }
      } catch { /* ignore */ }
    }

    if (parts.length) {
      // 2026-10-27 主人明确要求：B 站/抖音的消息不要发到 QQ 群，只体现在浮窗里。
      // 这些事项浮窗已经能看到（B 站卡「近期操作」/ 登录态徽标），所以这里不再注入 QQ 回复。
      // 想临时恢复注入：把 dataRoot/.qqbot/bili-note-config.json 写成 {"qqForward": true}
      let qqForward = false;
      try { qqForward = JSON.parse(readFileSync(join(root, '.qqbot', 'bili-note-config.json'), 'utf8')).qqForward === true; } catch {}
      if (qqForward && ctx && typeof ctx.rewrite === 'function') {
        const block = `\n[B站]${parts.join('\n')}[/B站]`;
        const base = String((ctx && ctx.text) || '');
        ctx.rewrite({ text: base + block });
      }
    }
  } catch { /* 永不阻断聊天 */ }
  await next();
}

export default onInbound;
