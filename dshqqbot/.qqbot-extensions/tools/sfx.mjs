/**
 * sfx — 【扩展工具】音效库：检索 / 收互联网音效 / 扫本地目录 / 兜底合成
 *
 * 和表情包同构：{dataRoot}/音效/index.json + lib/<layer>/<id>.<ext>
 * 视频合成（bili-ops 的 text/image 两种形态）会自动从这里挑音效；
 * 本工具负责“把音效收进来”。
 *
 * 用法：
 *   sfx {action:'status'}                                  看库里有几类、各多少
 *   sfx {action:'search', query:'转场', kind:'whoosh'}      检索（返回 id/kind/路径）
 *   sfx {action:'add-url', url:'https://…/whoosh.mp3', kind:'whoosh', tags:'转场'}    收一个网络音效
 *   sfx {action:'scan', dir:'F:/音效素材/水下'}             把本地目录批量入库
 *   sfx {action:'builtin'}                                 用 ffmpeg 现场合成 9 个语义音效（空库兜底）
 *
 * 纪律：
 *   · 只收音频扩展名（mp3/wav/m4a/ogg/flac/aac/opus）；
 *   · 按内容 sha1 去重，同一文件不会重复入库；
 *   · 不猜不编：search 没命中就明说没有。
 */
import { existsSync } from 'node:fs';
import {
  KINDS, addFromUrl, addFile, ensureBuiltin, loadIndex, scanDir, search,
  sfxDir, tagsFromName, guessKind, pathOfId,
} from '../lib/sfx-lib.mjs';
import { findFfmpeg } from './storyboard.mjs';

const ACTION = ['status', 'search', 'add-url', 'add-file', 'scan', 'builtin'];

function statusOf(dataRoot) {
  const idx = loadIndex(dataRoot);
  const byKind = {};
  for (const it of idx.items) {
    const k = String(it.kind || '未分类');
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const missing = idx.items.filter((it) => !existsSync(pathOfId(dataRoot, it.id))).length;
  return { dir: sfxDir(dataRoot).replace(/\\/g, '/'), total: idx.items.length, byKind, missing, kinds: KINDS };
}

export default {
  name: 'sfx',
  expose: 'all',
  description: '音效库：按语义检索已有音效、收互联网音效（add-url）、批量扫描本地目录、空库兜底合成。B 站成片的转场/打字/成功/失败音效会自动从这里挑',
  inputSchema: {
    action: { type: 'string', enum: ACTION, description: 'status=看库存 / search=检索 / add-url=收网络音效 / add-file=收单个本地文件 / scan=批量扫目录 / builtin=合成兜底音效' },
    query: { type: 'string', description: 'search 用：想要的音效（「转场」「键盘」「水下」…）' },
    kind: { type: 'string', enum: KINDS, description: '可选：限定语义分类（whoosh/click/pop/typing/water/success/fail/impact/ambient）' },
    url: { type: 'string', description: 'add-url 用：http(s) 音频直链（限 20MB）' },
    file: { type: 'string', description: 'add-file 用：本地音频绝对路径' },
    dir: { type: 'string', description: 'scan 用：本地目录（可有子目录）' },
    tags: { type: 'string', description: '可选：逗号分隔标签，不填就从文件名拆' },
    name: { type: 'string', description: '可选：显示名' },
    recursive: { type: 'boolean', description: 'scan 是否递归子目录，默认 false' },
    limit: { type: 'integer', description: 'search 返回条数（1~30，默认 8）' },
  },
  run: async (args, env) => {
    const dataRoot = String(env?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || '');
    if (!dataRoot) return { ok: false, msg: '拿不到数据根（env.dataRoot 为空），无法访问音效库' };
    const action = String(args.action || 'status').trim().toLowerCase();
    const tags = String(args.tags || '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
    const kind = String(args.kind || '').trim();

    if (action === 'status' || !action) {
      const s = statusOf(dataRoot);
      const desc = Object.entries(s.byKind).map(([k, n]) => k + '×' + n).join(' / ') || '（空库）';
      return { ok: true, msg: `音效库 ${s.dir}\n共 ${s.total} 条：${desc}${s.missing ? '；' + s.missing + ' 条索引有但文件缺失' : ''}`, data: s };
    }

    if (action === 'search') {
      const limit = Math.max(1, Math.min(30, Math.round(Number(args.limit) || 8)));
      const q = String(args.query || '').trim();
      const hits = search(dataRoot, q, { kind, limit });
      if (!hits.length) {
        return { ok: false, msg: `音效库里没有匹配「${q || kind || '全部'}」的音效（共 ${loadIndex(dataRoot).items.length} 条）—— 可以 add-url/scan 收一点，或 action:'builtin' 合成兜底` };
      }
      return {
        ok: true,
        msg: hits.map((h, i) => (i + 1) + '. ' + (h.item.name || h.item.id) + ' [' + (h.item.kind || '未分类') + '] ' + pathOfId(dataRoot, h.item.id)).join('\n'),
        data: { hits: hits.map((h) => ({ id: h.item.id, kind: h.item.kind, name: h.item.name, tags: h.item.tags, path: pathOfId(dataRoot, h.item.id), score: Number(h.score.toFixed(3)) })) },
      };
    }

    if (action === 'add-url') {
      const url = String(args.url || '').trim();
      if (!url) return { ok: false, msg: '缺少 url' };
      const r = await addFromUrl(dataRoot, url, { kind, tags, name: args.name });
      if (!r.ok) return { ok: false, msg: `收录失败：${r.reason}` };
      return {
        ok: true,
        msg: r.duplicate
          ? `这条音效已经在库里（${r.item.id}），没有重复收录`
          : `已收录「${r.item.name}」（${r.item.kind || '未分类'}）→ ${r.path}`,
        data: { item: r.item, path: r.path, duplicate: !!r.duplicate },
      };
    }

    if (action === 'add-file') {
      const file = String(args.file || '').trim();
      if (!file) return { ok: false, msg: '缺少 file' };
      const r = addFile(dataRoot, file, { kind, tags, name: args.name });
      if (!r.ok) return { ok: false, msg: `入库失败：${r.reason}` };
      return { ok: true, msg: `已入库「${r.item.name}」（${r.item.kind || '未分类'}）→ ${r.path}`, data: { item: r.item, path: r.path, duplicate: !!r.duplicate } };
    }

    if (action === 'scan') {
      const dir = String(args.dir || '').trim();
      if (!dir) return { ok: false, msg: '缺少 dir（本地音效目录）' };
      const r = scanDir(dataRoot, { dir, recursive: args.recursive === true, kind });
      if (!r.ok) return { ok: false, msg: r.reason };
      return {
        ok: true,
        msg: `扫描 ${r.scanned} 个音频：新增 ${r.added}，重复 ${r.duplicate}${r.failed.length ? '，失败 ' + r.failed.length : ''}`,
        data: r,
      };
    }

    if (action === 'builtin') {
      const exe = findFfmpeg();
      const r = await ensureBuiltin(dataRoot, { ffmpeg: exe });
      if (!r.ok) {
        return { ok: false, msg: exe ? `合成失败：${(r.failed && r.failed[0] && r.failed[0].reason) || '?'}` : '没找到 ffmpeg，无法合成兜底音效' };
      }
      const s = statusOf(dataRoot);
      return { ok: true, msg: `兜底音效就绪（新合成 ${r.made} 个），库存 ${s.total} 条`, data: { made: r.made, status: s } };
    }

    return { ok: false, msg: '未知 action：' + action + '（可用：' + ACTION.join(' / ') + '）' };
  },
};

// 给测试/其它工具复用
export { tagsFromName, guessKind };
