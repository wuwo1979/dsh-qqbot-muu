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
import { search, searchByFacets, resolveToken, loadIndex, haystackOf, stickerDir } from '../lib/sticker-resolve.mjs';
import { shortTagline, facetsOf } from '../lib/sticker-schema.mjs';
import { validateImageFile } from '../lib/media-file.mjs';

const MAX_CANDIDATES = 12;

const chatId = (x) => String((x && (x.openid != null ? x.openid : (x.gid != null ? x.gid : x.id))) ?? '');
const isOpenid = (s) => /^[A-Za-z0-9_-]{16,}$/.test(String(s || ''));
const shortId = (id) => (String(id || '').length > 14 ? String(id).slice(0, 12) + '…' : String(id || ''));
const marker = (p) => `[MEDIA:image|${String(p).replace(/\\/g, '/')}]`;
const stickerMarker = (id) => `[STICKER:${String(id || '')}]`;

function facetInput(args = {}) {
  const out = {};
  for (const k of ['emotion', 'scene', 'action', 'intensity', 'platform']) {
    const v = String(args[k] || '').trim();
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

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
  description: '按语义或五面标签（情绪/场景/动作/强度/平台）在本地表情库找图。默认只返回候选 id + 短标签，回复里写 [STICKER:id] 即发图，不把路径/长描述吃进上下文；给了 target 就直接发。',
  inputSchema: {
    query: { type: 'string', description: '想要的画面/情绪，如「无语」「猫猫震惊」「晚安」' },
    id: { type: 'string', description: '已知表情 id（也可写 id.ext）；与 query 二选一，id 优先' },
    emotion: { type: 'string', description: '情绪过滤，如「无语,累」；同面多值取并集，不同面取交集' },
    scene: { type: 'string', description: '场景过滤，如「群聊,吐槽」' },
    action: { type: 'string', description: '动作过滤，如「挥手,躺」' },
    intensity: { type: 'string', enum: ['low', 'mid', 'high'], description: '强度过滤（low=轻 / mid=中 / high=强）' },
    platform: { type: 'string', enum: ['qq', 'wechat', 'both'], description: '适用平台（both=两端通用）' },
    target: { type: 'string', description: '可选：群 openid / 用户 openid / 唯一群名。给了就直接发；不给只给 id 与标记' },
    scope: { type: 'string', enum: ['group', 'c2c'], description: '可选：目标类型，用 openid 时建议写明' },
    caption: { type: 'string', description: '可选：图后面跟的一句话（仅直接发送时）' },
    limit: { type: 'integer', description: `候选数量（1~${MAX_CANDIDATES}，默认 3）` },
    mode: { type: 'string', enum: ['compact', 'path'], description: 'compact（默认）= 只回 id+短标签；path = 回绝对路径（调试用）' },
  },
  run: async (args, env) => {
    const dataRoot = String(env?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || '');
    if (!dataRoot) return { ok: false, msg: '拿不到数据根（env.dataRoot 为空），无法读表情库，也没法发图' };

    const limit = Math.max(1, Math.min(MAX_CANDIDATES, Math.round(Number(args.limit) || 3)));
    const idRaw = String(args.id || '').trim();
    const query = String(args.query || '').trim();
    const facets = facetInput(args);
    const compact = String(args.mode || 'compact') !== 'path';

    let picks = [];
    if (idRaw) {
      const hit = resolveToken(dataRoot, idRaw);
      if (!hit.ok) return { ok: false, msg: `找不到表情「${idRaw}」：${hit.reason || 'unknown'}` };
      picks = [{ path: hit.path, item: hit.item, score: 1 }];
    } else if (query) {
      const sem = await semanticRank(dataRoot, query, loadIndex(dataRoot).items);
      picks = await search(dataRoot, query, { limit, semantic: sem, facets });
      if (!picks.length) {
        const total = loadIndex(dataRoot).items.length;
        return {
          ok: false,
          msg: `本地表情库（${total} 张）里没有匹配${query ? `「${query}」` : '这些标签'}的图 —— 不要编造文件名；可以换个说法，或先用 sticker_tag 给图片补标签`,
        };
      }
    } else if (facets) {
      picks = await searchByFacets(dataRoot, facets, { limit });
      if (!picks.length) {
        const total = loadIndex(dataRoot).items.length;
        return { ok: false, msg: `本地表情库（${total} 张）里没有同时满足这些标签的图（${Object.entries(facets).map(([k, v]) => k + '=' + v).join(' ')}）` };
      }
    } else {
      return { ok: false, msg: '需要 query（想要的表情）或 id（已知表情）或至少一个 facet 标签' };
    }

    const best = picks[0];
    const checked = validateImageFile(best.path, { allowedRoots: [stickerDir(dataRoot)] });
    if (!checked.ok) {
      return { ok: false, msg: `表情文件不可发送：${checked.reason}（索引与磁盘不一致时需要重新扫描）`, data: { path: best.path } };
    }

    const candidates = picks.slice(0, limit).map((p) => ({
      id: p.item?.id || '',
      tags: shortTagline(p.item || {}),
      score: Number(p.score || 0),
      // path/desc/完整 facets 只在调试模式返回；对话上下文里默认不出现
      ...(compact ? {} : {
        facets: facetsOf(p.item || {}),
        desc: String(p.item?.descZh || p.item?.desc || '').slice(0, 30),
        path: p.path,
        marker: marker(p.path),
      }),
    }));

    const targetRaw = String(args.target || '').trim();
    if (!targetRaw) {
      if (compact) {
        const lines = candidates.map((c) => `${c.id} | ${c.tags}`);
        return {
          ok: true,
          msg: `候选（只给 id 和短标签，别把路径写出来）：\n${lines.join('\n')}\n把 ${stickerMarker(candidates[0].id)} 原样放进回复末尾就会发这张；把握不到九成就不发。`,
          data: { candidates },
        };
      }
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
        msg: `图没发出去（${t.scope === 'c2c' ? '私聊' : '群'}「${t.label}」）：QQ 侧拒绝或主动消息配额不足。可以在当前会话直接输出 ${stickerMarker(best.item?.id || '')} 兜底`,
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
      data: { candidates: candidates.map(({ id, tags, score }) => ({ id, tags, score })), sentId: best.item?.id || '' },
    };
  },
};
