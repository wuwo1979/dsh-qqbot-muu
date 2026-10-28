/**
 * sticker_send — 【扩展工具】按「意思」找表情，并真正发出去（或给出可直接输出的媒体标记）
 *
 * 为什么需要它（2026-10-23）：
 *   插件自带的 list_stickers 返回的是 id/文件名，模型经常把文件名当正文发出来
 *   （c36d2851221a.jpg），群里就是一段乱码；而 index.json 里 71 张图 **全是空标签**，
 *   语义检索等于没有。本工具改为：
 *     · 本地 embedding + 标签/描述混合检索（本地为主，云端可选）；
 *     · **直接返回绝对路径**，并可直接发送，不再让模型"记文件名"。
 *
 * 用法：
 *   sticker_send {query:'无语'}                 → 只检索，返回 path + 应输出的媒体标记
 *   sticker_send {query:'无语', target:'<群openid>', scope:'group'}  → 检索并直接发
 *   sticker_send {id:'c36d2851221a', target:...}                    → 指定 id 直发
 *
 * 纪律：
 *   · 没有候选就明确说没有，绝不编造文件名；
 *   · 发送失败把原因（文件不存在 / 闸门拒绝 / QQ 拒绝）分开报。
 */
import { existsSync } from 'node:fs';
import { search, resolveToken, loadIndex, haystackOf } from '../lib/sticker-resolve.mjs';

const MAX_CANDIDATES = 12;

const chatId = (x) => String((x && (x.openid != null ? x.openid : (x.gid != null ? x.gid : x.id))) ?? '');
const isOpenid = (s) => /^[A-Za-z0-9_-]{16,}$/.test(String(s || ''));
const shortId = (id) => (String(id || '').length > 14 ? String(id).slice(0, 12) + '…' : String(id || ''));
const marker = (p) => `[MEDIA:image|${String(p).replace(/\\/g, '/')}]`;

/** 目标解析：openid 直接用；名字必须唯一，绝不猜 */
function resolveTarget(qq, raw, wantScope) {
  const groups = Array.isArray(qq?.groups) ? qq.groups : [];
  const c2c = Array.isArray(qq?.c2c) ? qq.c2c : [];
  const target = String(raw || '').trim();
  if (!target) return { ok: false, reason: '缺少 target' };
  let scope = wantScope === 'c2c' ? 'c2c' : (wantScope === 'group' ? 'group' : '');
  if (isOpenid(target)) {
    if (!scope) {
      if (groups.some((x) => chatId(x) === target)) scope = 'group';
      else if (c2c.some((x) => chatId(x) === target)) scope = 'c2c';
      else scope = target.length > 30 ? 'group' : 'c2c';
    }
    const known = (scope === 'group' ? groups : c2c).find((x) => chatId(x) === target);
    return { ok: true, scope, id: target, label: (known && known.name) || shortId(target) };
  }
  const pool = [];
  if (!scope || scope === 'group') for (const x of groups) if (String(x.name || '').includes(target)) pool.push({ scope: 'group', ...x });
  if (!scope || scope === 'c2c') for (const x of c2c) if (String(x.name || '').includes(target)) pool.push({ scope: 'c2c', ...x });
  if (!pool.length) return { ok: false, reason: `找不到「${target}」` };
  if (pool.length > 1) return { ok: false, reason: `「${target}」命中 ${pool.length} 个，请用 openid` };
  const id = chatId(pool[0]);
  if (!id) return { ok: false, reason: '解析到空 id' };
  return { ok: true, scope: pool[0].scope, id, label: pool[0].name || id };
}

/** 本地语义排序（embedder 不可用就返回 null，退关键词） */
async function semanticRank(dataRoot, query, items) {
  try {
    const mod = await import('../lib/embedder.mjs');
    if (!mod || typeof mod.rankItems !== 'function') return null;
    return await mod.rankItems(dataRoot, query, items, {
      role: 'sticker',
      textOf: (it) => haystackOf(it) || String(it.id || ''),
    });
  } catch {
    return null;
  }
}

export default {
  name: 'sticker_send',
  expose: 'all',
  description: '按语义（或标签/id）在本地表情库找图。默认返回绝对路径和可直接输出的 [MEDIA:image|路径]；给了 target 就直接发到群/私聊。图片标签为空时也能按描述/关键词检索',
  inputSchema: {
    query: { type: 'string', description: '想要的画面/情绪，如「无语」「猫猫震惊」「晚安」' },
    id: { type: 'string', description: '已知表情 id（也可写 id.ext）；与 query 二选一，id 优先' },
    target: { type: 'string', description: '可选：群 openid / 用户 openid / 唯一群名。给了就直接发；不给就只返回路径与媒体标记' },
    scope: { type: 'string', enum: ['group', 'c2c'], description: '可选：目标类型，用 openid 时建议写明' },
    caption: { type: 'string', description: '可选：图后面跟的一句话（仅直接发送时）' },
    limit: { type: 'integer', description: `候选数量（1~${MAX_CANDIDATES}，默认 3）` },
  },
  run: async (args, env) => {
    const dataRoot = String(env?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || '');
    if (!dataRoot) return { ok: false, msg: '拿不到数据根（env.dataRoot 为空），无法读表情库，也没法发图' };

    const limit = Math.max(1, Math.min(MAX_CANDIDATES, Math.round(Number(args.limit) || 3)));
    const idRaw = String(args.id || '').trim();
    const query = String(args.query || '').trim();

    let picks = [];
    if (idRaw) {
      const hit = resolveToken(dataRoot, idRaw);
      if (!hit.ok) return { ok: false, msg: `找不到表情「${idRaw}」：${hit.reason || 'unknown'}` };
      picks = [{ path: hit.path, item: hit.item, score: 1 }];
    } else if (query) {
      const sem = await semanticRank(dataRoot, query, loadIndex(dataRoot).items);
      picks = await search(dataRoot, query, { limit, semantic: sem });
      if (!picks.length) {
        const total = loadIndex(dataRoot).items.length;
        return {
          ok: false,
          msg: `本地表情库（${total} 张）里没有匹配「${query}」的图 —— 不要编造文件名；可以换个说法，或先用 sticker_tag 给图片补标签`,
        };
      }
    } else {
      return { ok: false, msg: '需要 query（想要的表情）或 id（已知表情）' };
    }

    const best = picks[0];
    if (!existsSync(best.path)) {
      return { ok: false, msg: `表情文件不存在：${best.path}（索引与磁盘不一致，需要重新扫描）` };
    }

    const candidates = picks.slice(0, limit).map((p) => ({
      id: p.item?.id || '',
      tags: Array.isArray(p.item?.tags) ? p.item.tags.join('/') : '',
      desc: String(p.item?.descZh || p.item?.desc || '').slice(0, 30),
      path: p.path,
      marker: marker(p.path),
    }));

    const targetRaw = String(args.target || '').trim();
    if (!targetRaw) {
      return {
        ok: true,
        msg: `找到 ${picks.length} 个候选，首选：${candidates[0].marker}\n（直接把这行标记原样放进回复就会发图；不要再写文件名/id）`
          + (candidates.length > 1 ? '\n备选：\n' + candidates.slice(1).map((c) => '  ' + c.marker).join('\n') : ''),
        data: { candidates },
      };
    }

    const qq = env?.qq;
    if (!qq || typeof qq.sendImage !== 'function') {
      return { ok: false, msg: '拿不到 QQ 发送能力（env.qq.sendImage 不可用），无法直接发图', data: { candidates } };
    }
    const t = resolveTarget(qq, targetRaw, args.scope);
    if (!t.ok) return { ok: false, msg: `目标解析失败：${t.reason}` };

    let sent = false;
    try { sent = await qq.sendImage(t.scope, t.id, { localPath: best.path }); } catch { sent = false; }
    const caption = String(args.caption || '').trim();
    if (sent && caption && typeof qq.sendText === 'function') {
      try { await qq.sendText(t.scope, t.id, caption); } catch { /* 配文失败不影响图已发出 */ }
    }
    if (!sent) {
      return {
        ok: false,
        msg: `图没发出去（${t.scope === 'c2c' ? '私聊' : '群'}「${t.label}」）：QQ 侧拒绝或主动消息配额不足。可以在当前会话直接输出 ${marker(best.path)} 兜底`,
        data: { candidates },
      };
    }
    // 记一笔"刚发过表情"：注入层据此判断要不要提醒她配图（2026-10-27 主人：她基本不发图）
    try {
      const dr = String(env?.dataRoot || '').trim();
      if (dr) {
        const { setChatState } = await import('../lib/chatlog-db.mjs');
        setChatState(dr, 'sticker:last', { ts: Date.now(), scope: t.scope, id: t.id, sticker: best.item?.id || '' });
      }
    } catch { /* 记账失败不影响已发出的图 */ }
    return {
      ok: true,
      msg: `已发送表情到${t.scope === 'c2c' ? '私聊' : '群'}「${t.label}」：${best.item?.id || best.path}${caption ? '（附一句话）' : ''}（图走主动通道，占主动配额）`,
      data: { candidates, sentId: best.item?.id || '', sentPath: best.path },
    };
  },
};
