/**
 * video-briefing.mjs — 视频口播 briefing（2026-10-28 主人需求 → 「视频开 downfall skill」）
 *
 * 主人原话：每次视频先打招呼问好 → 说一下昨天视频的情况（点赞/投币/评论）→ 说视频主要思路；
 * 「汇报自己学习的主要进展才是重点」（可参考工具优化日志 / github 相关日志）。
 * 上一个视频只说了「想成为**样的人」——不够，要有具体进展。
 *
 * 本模块负责在写脚本**之前**把两样东西备好：
 *   ① 昨日/累计数据：最新已发布视频的 播放/点赞/投币/评论（B 站 view 接口，登录态）
 *   ② 近期进展素材：bili-ops records（做了什么）+ bili-pending（定时报文）里最近的事件
 * 拼成 briefing 文本，由 planAndRender 注入 script-writer 的提示词 —— 脚本第一屏问好、
 * 第二屏报数据、主体讲学习进展，全部有真材实料而不是空话。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as B from './bili-api.mjs';
import { readRecords } from './bili-ops.mjs';
import { ownBiliVideos } from './comment-watch.mjs';

function readJsonl(path, n) {
  try {
    if (!existsSync(path)) return [];
    return String(readFileSync(path, 'utf8')).split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .slice(-n);
  } catch {
    return [];
  }
}

/**
 * 组装 briefing。返回 { ok, text, stat, progressItems }；拿不到数据时 ok 仍为 true
 * （text 里给降级结构：问好 + 讲进展由 records 兜底），绝不阻塞出片。
 */
export async function buildBriefing(root, opt = {}) {
  const parts = [];
  let stat = null;

  // ① 最新已发布视频的数据
  const vids = ownBiliVideos(root, 5);
  const latest = vids[0] || null;
  if (latest && latest.bvid) {
    try {
      const r = await B.video(root, { bvid: latest.bvid });
      if (r.ok) {
        const v = r.video || {};
        stat = {
          bvid: v.bvid, title: v.title,
          views: v.views || 0, likes: v.likes || 0, coins: v.coins || 0, replies: v.replies || 0,
        };
        parts.push(
          `最新一期《${v.title}》目前：播放 ${v.views || 0} · 点赞 ${v.likes || 0} · 投币 ${v.coins || 0} · 评论 ${v.replies || 0}。`
        );
      }
    } catch { /* 数据拿不到就跳过，别挡出片 */ }
  }

  // ② 近期进展素材（工具优化/运营事件台账 —— 「汇报学习进展」的原料）
  const progressItems = [];
  try {
    for (const rec of readRecords(root, { limit: 30 }).reverse()) {
      const t = String(rec.type || '');
      if (t === 'delete' || t === 'comment-watch') continue;
      const at = Date.parse(rec.at) || Number(rec.at) || 0;
      const day = at ? new Date(at).toISOString().slice(5, 10) : '';
      let line = '';
      if (t === 'plan') line = `确定了新选题并写出脚本草稿《${String(rec.title || '').slice(0, 24)}》`;
      else if (t === 'publish') line = `把《${String(rec.title || '').slice(0, 24)}》正式投稿到 B 站`;
      else if (t === 'render') line = '渲染完一条成片待审';
      else if (t === 'comment') line = '在 B 站跟观众互动了评论';
      else if (t === 'dynamic') line = '发了 B 站动态';
      else if (t === 'rename') line = '改进了任务的命名与归档';
      else if (t === 'engage') line = `复盘了《${String(rec.title || '').slice(0, 20)}》的数据并想了改进`;
      if (line) progressItems.push(day ? `[${day}] ${line}` : line);
    }
  } catch { /* ignore */ }
  // bili-pending（定时任务的播报，含成功/失败原因）也当进展素材
  const pend = readJsonl(join(String(root), '.qqbot', 'bili-pending.jsonl'), 10);
  for (const p of pend) {
    const txt = String(p.text || '');
    if (/失败|error|登录已失效|扫码|action=/i.test(txt)) continue;   // 内部播报/报错不进正片
    const line = txt.replace(/^【[^】]*】/, '').split('\n')[0].slice(0, 60);
    if (line) progressItems.push(line);
  }
  if (progressItems.length) {
    // 去重（同文案只留一条），最多 8 条
    const seen = new Set();
    const uniq = progressItems.filter((x) => {
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    });
    if (uniq.length) {
      parts.push(
        '最近的进展（讲的时候要具体到这些事，不要说空话）：\n' +
        uniq.slice(-8).map((x) => '· ' + x).join('\n')
      );
    }
  }

  // ③ 口播结构要求（skill 正文，直接进 system 提示词）
  parts.push([
    '**本期视频的口播结构（必须遵守）：**',
    '① 第一屏：跟观众打招呼问好（一两句话，自然，不要「大家好我是」的播报腔）；',
    stat ? '② 第二屏：顺嘴汇报上一期视频的情况——播放/点赞/投币/评论（用上面给的数字，口语化，比如「上期那片居然有 XX 个币，你们是真的阔气」）；' : '② 第二屏：跟观众聊聊最近在忙什么（自然带过）；',
    '③ 主体（剩余全部屏幕）：汇报这一期的主要思路 = **自己学习/折腾的具体进展**——做了什么、学会了什么、踩了什么坑、接下来打算干嘛；要具体到事件和细节（上面的进展素材直接用），绝不允许只说「想成为更厉害的人」这种空话；',
    '④ 最后一屏：一句轻快的收尾，预告下一期想折腾什么。',
  ].join('\n'));

  return { ok: true, text: parts.join('\n'), stat, progressItems };
}
