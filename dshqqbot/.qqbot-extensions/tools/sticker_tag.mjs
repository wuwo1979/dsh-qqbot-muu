/**
 * tools/sticker_tag.mjs — 表情标签统一写入 / 审计
 *
 * 插件自带的 sticker_tag 只写 tags + desc（自由词），检索时没法按
 * 情绪/场景/动作/强度/平台组合筛选。这里提供扩展侧的写入口：
 *   · set：一次写五面标签，自动收口到词表，tags 同步拍平（老代码照常读）；
 *   · audit：看覆盖率、重复、缺情绪词，方便补标签；
 * 每条都会写 tagSchema=2 + facetSource，插件侧后续改 tags 也会自动重新推导。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyTagSchema, auditItems, facetsOf, shortTagline, SCHEMA_VERSION,
} from '../lib/sticker-schema.mjs';
import { resolveToken } from '../lib/sticker-resolve.mjs';

const indexFile = (root) => join(String(root || ''), '表情包', 'index.json');

function readIndex(root) {
  const file = indexFile(root);
  if (!existsSync(file)) return null;
  const data = JSON.parse(String(readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
  return Array.isArray(data) ? { items: data, raw: data } : { ...data, items: Array.isArray(data.items) ? data.items : [], raw: data };
}

function writeIndex(root, data) {
  const out = Array.isArray(data.raw) ? data.items : { ...data.raw, items: data.items };
  writeFileSync(indexFile(root), JSON.stringify(out, null, 2), 'utf8');
  return true;
}

export default {
  name: 'sticker_tag',
  expose: 'all',
  description: '给表情包写统一五面标签（情绪/场景/动作/强度/平台），或审计标签覆盖率。只动本地 index.json，不调模型、不费 token。',
  inputSchema: {
    action: { type: 'string', enum: ['set', 'audit'], description: 'set=写标签（默认）；audit=看覆盖率' },
    id: { type: 'string', description: '表情 id（set 时必填，也可写 id.ext）' },
    emotion: { type: 'string', description: '情绪，如「无语」或「无语,累」' },
    scene: { type: 'string', description: '场景，如「群聊,吐槽」' },
    action_tags: { type: 'string', description: '动作，如「挥手,躺」（工具参数名避开 action）' },
    intensity: { type: 'string', enum: ['low', 'mid', 'high'], description: '强度' },
    platform: { type: 'string', enum: ['qq', 'wechat', 'both'], description: '适用平台' },
    labels: { type: 'string', description: '可选自由标签，如「肥鱼,鲸鱼」' },
    limit: { type: 'integer', description: 'audit 时最多列多少条待补标签（默认 12）' },
  },
  run: async (args, env) => {
    const root = String(env?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || '');
    if (!root) return { ok: false, msg: '拿不到数据根，无法读表情索引' };
    const data = readIndex(root);
    if (!data) return { ok: false, msg: `找不到索引：${indexFile(root)}` };

    const action = String(args.action || 'set');
    if (action === 'audit') {
      const audit = auditItems(data.items);
      const limit = Math.max(1, Math.min(40, Number(args.limit) || 12));
      const weak = data.items
        .filter((it) => !facetsOf(it).emotion.length)
        .slice(0, limit)
        .map((it) => ({ id: it.id, tags: Array.isArray(it.tags) ? it.tags.join('/') : '', desc: String(it.desc || it.descZh || '').slice(0, 24) }));
      return {
        ok: true,
        msg: `标签 v${SCHEMA_VERSION}：${audit.total} 张，情绪覆盖 ${audit.emotionCoverage}% / 场景 ${audit.sceneCoverage}% / 动作 ${audit.actionCoverage}%，重复 ${audit.dupes}，缺 schema ${audit.missingSchema}`,
        data: { audit, weak },
      };
    }

    const idRaw = String(args.id || '').trim();
    if (!idRaw) return { ok: false, msg: 'set 需要 id' };
    const hit = resolveToken(root, idRaw);
    if (!hit.ok) return { ok: false, msg: `找不到表情「${idRaw}」：${hit.reason || 'unknown'}` };
    const item = data.items.find((x) => String(x.id) === String(hit.item.id));
    if (!item) return { ok: false, msg: `索引里没有 id=${hit.item.id} 的条目` };

    applyTagSchema(item, {
      emotion: args.emotion,
      scene: args.scene,
      action: args.action_tags,
      intensity: args.intensity,
      platform: args.platform,
      labels: args.labels,
      merge: true,
    });
    writeIndex(root, data);
    const f = facetsOf(item);
    return {
      ok: true,
      msg: `已写入 ${item.id}：${shortTagline(item)}（情绪 ${f.emotion.join('/') || '-'} · 场景 ${f.scene.join('/') || '-'} · 动作 ${f.action.join('/') || '-'} · ${f.intensity} · ${f.platform}）`,
      data: { id: item.id, facets: f, tags: item.tags },
    };
  },
};
