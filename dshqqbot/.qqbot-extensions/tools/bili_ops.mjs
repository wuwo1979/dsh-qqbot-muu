/**
 * tools/bili_ops.mjs — B 站账号运营工具
 *
 * 半自动口径（主人 2026-10-24 定）：
 *   AI 自己写脚本/做视频/写评论 → 主人一句「通过」→ 自动上传/发送。
 *
 * 写操作只给主人；定时任务只产出草稿，绝不自己发布。
 */
import * as Ops from '../lib/bili-ops.mjs';
import * as B from '../lib/bili-api.mjs';
import { sanitizeTopic } from '../lib/script-writer.mjs';
import { existsSync } from 'node:fs';

export const name = 'bili_ops';

export const description =
  'B 站账号运营：AI 写脚本→做分镜视频（图片+配音+字幕）→草稿待审核；审核通过后自动投稿；也能改名、写评论/回复、拉数据。写操作仅主人可用。';

/**
 * 宿主对扩展工具的 parameters 有固定形状要求：**每个键直接是一个 value schema**。
 * 写成 JSON-Schema（`{type:'object', properties:{...}}`）会被
 * `[channel-tools] 扩展工具注册失败 bili_ops: unsupported JSON schema:
 * parameters.type must be a value schema object` 拒掉，工具直接不存在。
 * 所以这里和 `memory.mjs` 一样用扁平形状；必填项写在字段的 required 上。
 */
export const inputSchema = {
  action: {
    type: 'string',
    required: true,
    enum: ['plan', 'list', 'show', 'approve', 'reject', 'publish', 'rename', 'comment', 'apologize', 'engage', 'records', 'status'],
    description: 'plan=生成视频草稿；approve=审核通过并自动上传；comment 生成/发送评论；apologize=对指定评论追加道歉并挂动态；engage=拉数据并生成建议回复',
  },
  topic: { type: 'string', description: '视频选题（plan）' },
  scriptJson: {
    type: 'string',
    description:
      '可选：完整脚本 JSON 字符串 {"title","desc","tags":[],"panels":[{"narration","imagePrompt"}]}。'
      + '主模型自己写脚本时传它，可跳过 DeepSeek/本地模型（质量更好、不重复花 token）。',
  },
  style: { type: 'string', enum: ['default', 'funny', 'warm', 'sharp'], description: '风格' },
  panels: { type: 'number', description: '分镜数量 2~12，默认取配置' },
  seconds: { type: 'number', description: '目标时长（秒）' },
  orientation: {
    type: 'string',
    enum: ['horizontal', 'vertical'],
    description: '成片方向：vertical=竖屏 1080×1920（B 站/抖音），horizontal=横屏 1280×720（默认）',
  },
  jobId: { type: 'string', description: '任务 id（show/approve/reject/publish）' },
  mode: { type: 'string', enum: ['web', 'manual'], description: 'publish 模式：web=自动投稿，manual=只给成片包' },
  uname: { type: 'string', description: '新昵称（rename）' },
  bvid: { type: 'string', description: '稿件 BV 号（comment/engage/comments_video：要读哪条视频的评论）' },
  intro: { type: 'string', description: 'comments_video 可选：开场白（默认自动）' },
  outro: { type: 'string', description: 'comments_video 可选：结尾句（默认三连号召）' },
  message: { type: 'string', description: '指定评论文案（comment，可不填让 AI 写）' },
  intent: { type: 'string', description: '评论意图/角度（comment）' },
  tags: { type: 'string', description: 'comments_video 可选：逗号分隔标签，默认「评论区,热评,解说」' },
  draftId: { type: 'string', description: '评论草稿 id（comment approve）' },
  rpid: { type: 'string', description: '要道歉的那条评论 rpid（apologize；comments/engage 可查）' },
  root: { type: 'string', description: 'apologize 可选：楼中楼的根评论 rpid' },
  reason: { type: 'string', description: '道歉原因（apologize，会写进评论和动态）' },
  dynamic: { type: 'boolean', description: 'apologize 是否同时挂一条道歉动态（默认 true）' },
  dynamicText: { type: 'string', description: 'apologize 可选：自定义动态正文' },
  generate: { type: 'boolean', description: 'comment：只生成草稿不发送' },
  approve: { type: 'boolean', description: 'comment：发送已审核草稿（需 draftId）' },
  suggestion: { type: 'string', description: 'comment：给本地模型的修改建议（需 draftId；只改写不发）' },
  reject: { type: 'boolean', description: 'comment：拒绝并丢弃草稿（需 draftId）' },
  limit: { type: 'number', description: 'list/records 返回条数' },
  q: { type: 'string', description: 'records 检索词（整条记录里模糊匹配）' },
  kind: { type: 'string', description: 'records 过滤类型，如 plan/publish/comment/rename/engage（不要用 type，宿主会把它当 schema 类型）' },
  since: { type: 'number', description: 'records 起始时间戳（毫秒）' },
};

function rootOf(env) {
  return Ops.dataRootOf(env || {});
}

/**
 * 主人判定（2026-10-24 修）：
 *  - 定时任务/内部调用显式 internal=true 才放行；
 *  - 测试或宿主明确给了 user.isOwner 时以它为准；
 *  - 生产走 actorOpenid ∈ env.owners（插件 groupAdmin.owners）或 bili-ops-config.ownerOpenids；
 *  - **拿不到身份一律拒绝**。旧实现把「没有 env.user」当主人，
 *    等于群里任何人都能 plan/approve/publish/rename/comment —— 权限洞。
 */
function isOwner(env, cfg) {
  if (env && env.internal === true) return true;
  if (env && env.user && typeof env.user.isOwner === 'boolean') return env.user.isOwner;
  const actor = String((env && (env.actorOpenid || env.senderId || env.userId)) || '').trim();
  if (!actor) return false;
  const owners = [
    ...(Array.isArray(env && env.owners) ? env.owners : []),
    ...(Array.isArray(cfg && cfg.ownerOpenids) ? cfg.ownerOpenids : []),
  ].map((x) => String(x || '').trim()).filter(Boolean);
  return owners.includes(actor);
}

function deny() {
  return { ok: false, error: '只有主人能操作 B 站账号' };
}

/** B 站图/评论先私聊给主人看：群里直接拒绝，避免把半成品发到群里。
 *  2026-10-26 放开：主人在群里下指令也放行（主人抱怨"群里让它做视频没反应"），
 *  非主人照旧一律拒绝；成片仍走 awaiting_review + 主人说"通过"才投稿。 */
function needPrivate(env, what) {
  if (env && env.internal === true) return null;
  const scope = String((env && env.scope) || '');
  // 没有 scope（单测/旧宿主）不拦；明确是群聊才要求私聊
  if (!scope || scope === 'c2c' || scope.startsWith('c2c:')) return null;
  if (scope === 'group' || scope.startsWith('group:')) {
    if (isOwner(env, null)) return null; // 主人可以在群里直接下指令
    return {
      ok: false,
      error: `B 站${what}请私聊我下指令：我会把封面/首帧/评论草稿先发你私聊，你看了说行再发。`,
    };
  }
  return null;
}

/** 把封面、首帧和成片发到当前会话（私聊=主人），失败不阻断任务 */
async function previewJob(env, job) {
  if (env && env.internal === true) return { sent: 0, fails: [] };
  const caps = env && env.caps;
  if (!caps) return { sent: 0, fails: ['no-caps'] };
  const paths = [job.cover, job.panels && job.panels[0] && job.panels[0].image]
    .map((p) => String(p || ''))
    .filter((p) => p && existsSync(p));
  let sent = 0;
  let videoSent = false;
  const fails = [];
  for (const p of paths) {
    let ok = false;
    try {
      if (typeof caps.image === 'function') ok = (await caps.image(p)) !== false;
    } catch { /* try media */ }
    if (!ok) {
      try {
        if (typeof caps.media === 'function') ok = (await caps.media('image', p)) !== false;
      } catch { /* ignore */ }
    }
    if (ok) sent += 1;
    else fails.push(p);
  }
  // 成片也发一份：主人要能直接看片判断，而不是只看封面
  if (job.video && existsSync(job.video)) {
    try {
      if (typeof caps.video === 'function') videoSent = (await caps.video(job.video)) !== false;
    } catch { /* try media */ }
    if (!videoSent) {
      try {
        if (typeof caps.media === 'function') videoSent = (await caps.media('video', job.video)) !== false;
      } catch { /* ignore */ }
    }
    if (!videoSent) fails.push(job.video);
  }
  return { sent, videoSent, fails };
}

function jobBrief(j) {
  return {
    id: j.id,
    status: j.status,
    title: j.title,
    topic: j.topic,
    durationSec: j.durationSec,
    video: j.video,
    cover: j.cover,
    createdAt: j.createdAt,
    bvid: j.published?.bvid || '',
  };
}

export async function run(args = {}, env = {}) {
  const action = String(args.action || '').trim();
  const dataRoot = rootOf(env);
  const cfg = Ops.loadOpsConfig(dataRoot);
  if (cfg.enabled === false) return { ok: false, error: 'B 站运营已关闭（bili-ops-config.json 的 enabled=false）' };

  switch (action) {
    // ── 生成草稿 ────────────────────────────────────────────────
    case 'plan': {
      if (!isOwner(env, cfg)) return deny();
      const np = needPrivate(env, '做视频');
      if (np) return np;
      const topic = sanitizeTopic(args.topic, cfg.guard?.maxTopicChars || 200);
      if (!topic) return { ok: false, error: '缺少选题（topic）' };
      const secret = Ops.readSecret(dataRoot);
      const panels = Number(args.panels) || cfg.video.panels;
      const sw = await import('../lib/script-writer.mjs');

      // 2026-10-24：主模型（云端）可以直接把脚本交进来 —— 她自己在对话里就想好了
      // 标题/简介/分镜，没必要再花一次 LLM 调用（也避免本地 7b 写得很干）。
      let s;
      if (String(args.scriptJson || '').trim()) {
        try {
          const raw = JSON.parse(String(args.scriptJson));
          const ps = Array.isArray(raw.panels) ? raw.panels : [];
          if (ps.length < 2 || ps.length > 12) throw new Error('panels 需要 2~12 屏');
          s = {
            ok: true,
            llm: 'agent',
            title: String(raw.title || topic).slice(0, 80),
            desc: String(raw.desc || '').slice(0, 900),
            tags: (Array.isArray(raw.tags) ? raw.tags : []).map((x) => String(x).slice(0, 20)).slice(0, 8),
            panels: ps.map((p, i) => ({
              narration: String(p?.narration || p?.text || '').trim().slice(0, 200) || `第 ${i + 1} 屏`,
              imagePrompt: String(p?.imagePrompt || p?.image || p?.prompt || '').trim().slice(0, 500) || String(p?.narration || topic).slice(0, 200),
            })),
          };
        } catch (e) {
          return { ok: false, error: 'scriptJson 不是合法脚本：' + (e instanceof Error ? e.message : String(e)) };
        }
      } else {
        s = await sw.writeScript(
          { topic, style: args.style || 'default', panels, seconds: args.seconds },
          cfg.llm,
          { dataRoot, apiKey: secret.apiKey }
        );
      }
      if (!s.ok) return { ok: false, error: s.error || '脚本生成失败' };

      const job = Ops.newJob(dataRoot, { topic, style: args.style || 'default' });
      job.title = s.title;
      job.desc = s.desc;
      job.tags = s.tags;
      job.llm = s.llm;
      // 竖屏 / 横屏：默认横屏；主人说"发 B 站/竖屏"时走 1080×1920
      job.orientation = String(args.orientation || '').toLowerCase() === 'vertical' ? 'vertical' : 'horizontal';
      job.panels = s.panels.map((p) => ({ narration: p.narration, imagePrompt: p.imagePrompt }));
      Ops.saveJob(job);

      const r = await Ops.renderJob(job, cfg, { dataRoot });
      Ops.appendRecord(dataRoot, {
        type: 'plan',
        jobId: job.id,
        title: job.title,
        desc: job.desc,
        tags: job.tags,
        panels: job.panels.length,
        llm: s.llm,
        ok: r.ok,
        warnings: r.detail?.warnings?.length || 0,
      });
      const warnings = (r.detail?.warnings || []).slice(0, 4);
      if (!r.ok) {
        return {
          ok: false,
          error: r.error || '渲染失败',
          jobId: job.id,
          title: job.title,
          warnings,
          msg: `草稿渲染失败：${r.error || '未知原因'}（任务 ${job.id}）`,
        };
      }
      const preview = await previewJob(env, job);
      return {
        ok: true,
        jobId: job.id,
        title: job.title,
        desc: job.desc,
        tags: job.tags,
        panels: job.panels.length,
        durationSec: job.durationSec,
        video: job.video,
        cover: job.cover,
        srt: job.srt,
        llm: s.llm,
        warnings,
        preview,
        msg:
          `视频草稿好了：${job.title}（${job.durationSec}s，${job.panels.length} 屏，文案来自 ${s.llm}）。\n` +
          `简介：${String(job.desc || '').slice(0, 160)}\n` +
          `文件：${job.video || '（未拼成 mp4）'}\n` +
          (preview.sent ? `封面和首帧先发你私聊了（${preview.sent} 张）` : '') +
          (preview.videoSent ? '，成片也发你了' : '') +
          (preview.sent || preview.videoSent ? '，你看下好不好看。\n' : '\n') +
          `等你审核，回「通过 ${job.id}」我就自动投稿。` +
          (warnings.length ? `\n注意：${warnings.join('；')}` : ''),
      };
    }

    // ── 评论朗读视频：拉热评 → 自动拼脚本 → 走同一条渲染/审核管线 ──
    // 用法：{action:'comments_video', bvid:'BV...', limit:5, intro?, outro?, title?, tags?}
    // 分镜自动生成：开场 → 每条热评一屏（「用户」说：内容）→ 结尾三连。
    // 配人声、字幕、音效、成片全在 renderJob 里，和普通视频同一套审核/投稿流程。
    case 'comments_video': {
      if (!isOwner(env, cfg)) return deny();
      const np = needPrivate(env, '做评论朗读视频');
      if (np) return np;
      const bvid = String(args.bvid || '').trim();
      if (!bvid) return { ok: false, error: '缺少 bvid（要读哪条视频的评论）' };
      const v = await B.video(dataRoot, { bvid });
      if (!v.ok) return { ok: false, error: '读视频信息失败：' + (v.error || '') };
      const want = Math.max(2, Math.min(6, Number(args.limit) || 5));
      const cr = await B.comments(dataRoot, { aid: v.video.aid, limit: want });
      const list = cr.ok ? (cr.replies || []) : [];
      if (!list.length) {
        return { ok: false, error: '这条视频没有可读的评论' + (cr.ok ? '' : '（' + cr.error + '）') };
      }

      const intro = String(args.intro || '').trim() || `来看看《${v.video.title}》的评论区，评论区都是人才。`;
      const panels = [{
        narration: intro,
        imagePrompt: `热闹的视频评论区氛围，弹幕和评论卡片飘过，主题：${String(v.video.title).slice(0, 60)}`,
      }];
      for (const c of list) {
        const text = String(c.text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
        if (!text) continue;
        panels.push({
          narration: `「${c.user}」说：${text}`,
          imagePrompt: `社交媒体评论卡片特写，网络热梗氛围，内容关于：${text.slice(0, 80)}`,
        });
      }
      panels.push({
        narration: String(args.outro || '').trim() || '评论区的老哥真是又好笑又有才，喜欢的话三连支持一下，我们下期再见。',
        imagePrompt: '点赞投币收藏三连动画，可爱氛围',
      });
      if (panels.length < 3) return { ok: false, error: '有效评论太少，拼不成一期（至少要 1 条非空评论）' };

      const job = Ops.newJob(dataRoot, { topic: '评论区：' + v.video.title, style: args.style || 'default' });
      job.title = (String(args.title || '').trim() || `读了《${String(v.video.title).slice(0, 24)}》的评论区`).slice(0, 80);
      job.desc = String(args.desc || '').trim() ||
        `读评论区：《${v.video.title}》热评 ${panels.length - 2} 条。原视频：${v.video.bvid}`;
      job.tags = String(args.tags || '').trim()
        ? String(args.tags).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8)
        : ['评论区', '热评', '解说'];
      job.llm = 'comments';
      job.srcBvid = v.video.bvid;
      job.panels = panels.map((p) => ({ narration: p.narration, imagePrompt: p.imagePrompt }));
      Ops.saveJob(job);

      const r = await Ops.renderJob(job, cfg, { dataRoot });
      Ops.appendRecord(dataRoot, {
        type: 'plan',
        jobId: job.id,
        title: job.title,
        desc: job.desc,
        tags: job.tags,
        panels: job.panels.length,
        llm: 'comments',
        srcBvid: v.video.bvid,
        ok: r.ok,
        warnings: r.detail?.warnings?.length || 0,
      });
      const warnings = (r.detail?.warnings || []).slice(0, 4);
      if (!r.ok) {
        return {
          ok: false,
          error: r.error || '渲染失败',
          jobId: job.id,
          title: job.title,
          warnings,
          msg: `评论朗读视频渲染失败：${r.error || '未知原因'}（任务 ${job.id}）`,
        };
      }
      const preview = await previewJob(env, job);
      const readList = list.slice(0, 4).map((c, i) => `${i + 1}. ${c.user}：${String(c.text || '').slice(0, 60)}`).join('\n');
      return {
        ok: true,
        jobId: job.id,
        title: job.title,
        desc: job.desc,
        tags: job.tags,
        panels: job.panels.length,
        durationSec: job.durationSec,
        video: job.video,
        cover: job.cover,
        srt: job.srt,
        llm: 'comments',
        srcBvid: v.video.bvid,
        commentsRead: list.length,
        warnings,
        preview,
        msg:
          `评论朗读视频好了：${job.title}（${job.durationSec}s，读了 ${list.length} 条热评）。\n` +
          `读了这些：\n${readList}\n` +
          `文件：${job.video || '（未拼成 mp4）'}\n` +
          (preview.sent ? `封面和首帧先发你私聊了（${preview.sent} 张）` : '') +
          (preview.videoSent ? '，成片也发你了' : '') +
          (preview.sent || preview.videoSent ? '，你看下好不好看。\n' : '\n') +
          `等你审核，回「通过 ${job.id}」我就自动投稿。` +
          (warnings.length ? `\n注意：${warnings.join('；')}` : ''),
      };
    }

    // ── 查看 ────────────────────────────────────────────────────
    case 'list': {
      const jobs = Ops.listJobs(dataRoot, { limit: Number(args.limit) || 10 }).map(jobBrief);
      return {
        ok: true,
        count: jobs.length,
        jobs,
        msg: jobs.length
          ? jobs.map((j) => `${j.id} · ${j.status} · ${j.title || '(无标题)'} · ${j.durationSec || 0}s`).join('\n')
          : '还没有任务',
      };
    }

    case 'show': {
      const j = Ops.getJob(dataRoot, args.jobId);
      if (!j) return { ok: false, error: '找不到任务 ' + (args.jobId || '') };
      return {
        ok: true,
        job: {
          ...jobBrief(j),
          desc: j.desc,
          tags: j.tags,
          srt: j.srt,
          dir: j.dir,
          llm: j.llm,
          error: j.error,
          published: j.published,
          panels: (j.panels || []).map((p) => ({ index: p.index, narration: p.narration, seconds: p.seconds, image: p.image, audio: p.audio })),
        },
        msg: `${j.title}（${j.status}）\n${j.desc || ''}\n分镜：\n` + (j.panels || []).map((p) => `${p.index}. ${p.narration}`).join('\n'),
      };
    }

    // ── 审核 / 发布 ─────────────────────────────────────────────
    case 'approve': {
      if (!isOwner(env, cfg)) return deny();
      const np = needPrivate(env, '审核投稿');
      if (np) return np;
      if (!args.jobId) return { ok: false, error: '缺少 jobId' };
      const r = await Ops.approveJob(dataRoot, args.jobId, cfg);
      if (!r.ok) return { ok: false, error: r.error, jobId: args.jobId, fallback: r.fallback, dir: r.dir, msg: `发布失败：${r.error}` };
      return { ...r, msg: r.mode === 'manual' ? r.msg : `已审核并投稿成功：${r.bvid ? 'BV' + r.bvid : ''}` };
    }

    case 'reject': {
      if (!isOwner(env, cfg)) return deny();
      const j = Ops.updateJob(dataRoot, args.jobId, { status: 'rejected' });
      if (!j) return { ok: false, error: '找不到任务 ' + (args.jobId || '') };
      Ops.appendRecord(dataRoot, { type: 'reject', jobId: j.id, title: j.title });
      return { ok: true, jobId: j.id, msg: '已标记废弃：' + j.id };
    }

    case 'publish': {
      if (!isOwner(env, cfg)) return deny();
      const np = needPrivate(env, '导出成片');
      if (np) return np;
      if (!args.jobId) return { ok: false, error: '缺少 jobId' };
      const r = await Ops.publishJob(dataRoot, args.jobId, { mode: args.mode }, cfg);
      return r;
    }

    // ── 账号改名 ────────────────────────────────────────────────
    case 'rename': {
      if (!isOwner(env, cfg)) return deny();
      const np = needPrivate(env, '改名');
      if (np) return np;
      const q = Ops.checkQuota(dataRoot, 'rename', cfg.limits);
      if (!q.ok) return { ok: false, error: q.error };
      const r = await Ops.renameAccount(dataRoot, args.uname);
      if (!r.ok) return { ok: false, error: r.error, needLogin: r.needLogin };
      Ops.bumpQuota(dataRoot, 'rename');
      return { ok: true, name: r.name, msg: `已改名：${r.name}（B 站限制 6 个月只能改一次）` };
    }

    // ── 评论 ────────────────────────────────────────────────────
    case 'comment': {
      if (!isOwner(env, cfg)) return deny();
      const np = needPrivate(env, '评论');
      if (np) return np;
      if (!args.bvid && !args.draftId) return { ok: false, error: '缺少 bvid' };
      // 修改建议：只让本地模型改写草稿，不发出去
      if (args.draftId && args.suggestion) {
        const r = await Ops.reviseCommentDraft(dataRoot, { id: args.draftId, suggestion: args.suggestion }, cfg);
        if (!r.ok) return { ok: false, error: r.error, fallbackText: r.fallbackText };
        return {
          ok: true,
          draft: r.draft,
          via: r.via,
          msg: `已按建议改写（本地，${r.ms || 0}ms）：${r.draft.text}\n确认后回「评论通过 ${r.draft.id}」。`,
        };
      }
      if (args.draftId && args.reject === true) {
        const r = await Ops.rejectCommentDraft(dataRoot, { id: args.draftId });
        return r.ok ? { ok: true, msg: '已拒绝并丢弃：' + args.draftId } : { ok: false, error: r.error };
      }
      if (args.approve === true && args.draftId) {
        const r = await Ops.approveComment(dataRoot, { bvid: args.bvid, draftId: args.draftId, aid: args.aid }, cfg);
        if (!r.ok) return { ok: false, error: r.error, text: r.text };
        return { ok: true, rpid: r.rpid, text: r.text, msg: `评论已发出：${r.text}` };
      }
      if (args.draftId) {
        const d = Ops.listCommentDrafts(dataRoot, { limit: 200 }).find((x) => x.id === args.draftId);
        return d
          ? { ok: true, draft: d, msg: `待审草稿：${d.text}\n回「评论通过 ${d.id}」发送，或给 suggestion 让本地改写。` }
          : { ok: false, error: '找不到评论草稿' };
      }
      const r = await Ops.draftComment(dataRoot, { bvid: args.bvid, message: args.message, intent: args.intent }, cfg);
      if (!r.ok) return { ok: false, error: r.error, chain: r.chain };
      return {
        ok: true,
        draft: r.draft,
        msg: `评论草稿（${r.draft.llm}）：${r.draft.text}\n回「评论通过 ${r.draft.id}」我再发出去。`,
      };
    }

    // ── 道歉（评论记录出问题时用）──────────────────────────────
    case 'apologize': {
      if (!isOwner(env, cfg)) return deny();
      const np = needPrivate(env, '道歉');
      if (np) return np;
      if (!args.bvid || !args.rpid) return { ok: false, error: '缺少 bvid 或 rpid（要道歉的那条评论）' };
      const r = await Ops.apologizeComment(dataRoot, {
        bvid: args.bvid,
        rpid: args.rpid,
        root: args.root,
        reason: args.reason,
        message: args.message,
        alsoDynamic: args.dynamic !== false,
        dynamicText: args.dynamicText,
      });
      if (!r.ok) return { ok: false, error: r.error, needLogin: r.needLogin };
      return {
        ...r,
        msg: `已在原评论下追加道歉（rpid=${r.replyRpid}）${r.dynamic?.ok ? `，并挂了道歉动态 ${r.dynamicId}` : '（动态没挂成功，可稍后重试）'}`,
      };
    }

    // ── 运营 ────────────────────────────────────────────────────
    case 'engage': {
      if (!args.bvid) return { ok: false, error: '缺少 bvid' };
      const r = await Ops.engage(dataRoot, { bvid: args.bvid }, cfg);
      if (!r.ok) return { ok: false, error: r.error, needLogin: r.needLogin };
      const lines = r.suggestions.map((s, i) => `${i + 1}. 回复 @${s.user || '未知'}：${s.reply || '（生成失败）'}`);
      return { ...r, msg: `《${r.video.title}》播放 ${r.video.views} · 赞 ${r.video.likes} · 币 ${r.video.coins}\n建议回复：\n${lines.join('\n') || '（还没有新评论）'}` };
    }

    // ── 记录 / 状态 ─────────────────────────────────────────────
    case 'records': {
      const recs = Ops.readRecords(dataRoot, {
        limit: Number(args.limit) || 20,
        q: args.q || '',
        type: args.kind || args.type || '',
        bvid: args.bvid || '',
        jobId: args.jobId || '',
        since: Number(args.since) || 0,
      });
      return { ok: true, count: recs.length, records: recs, msg: recs.map((r) => `${new Date(r.ts).toLocaleString('zh-CN')} · ${r.type} · ${r.title || r.jobId || r.bvid || ''}${r.text ? ' · ' + String(r.text).slice(0, 60) : ''}`).join('\n') || '还没有记录' };
    }

    case 'status': {
      const me = B.loadCookie(dataRoot) ? await B.nav(dataRoot) : { ok: false, needLogin: true, error: '还没登录 B 站' };
      const jobs = Ops.listJobs(dataRoot, { limit: 50 });
      const pending = jobs.filter((j) => j.status === 'awaiting_review');
      const videosToday = Ops.checkQuota(dataRoot, 'video', cfg.limits);
      return {
        ok: true,
        login: me.ok ? { name: me.data?.name, mid: me.data?.mid, level: me.data?.level } : { needLogin: true, error: me.error },
        autoPublish: cfg.publish.autoPublish === true,
        requireApproval: cfg.publish.requireApproval !== false,
        publishMode: cfg.publish.mode,
        schedule: { enabled: cfg.schedule.enabled === true, times: cfg.schedule.times },
        jobs: { total: jobs.length, awaitingReview: pending.length, published: jobs.filter((j) => j.status === 'published').length },
        quota: videosToday,
        msg: me.ok
          ? `B 站：${me.data?.name}（Lv${me.data?.level || '?'}）· 待审 ${pending.length} 个 · 今日视频额度 ${videosToday.used}/${videosToday.limit ?? '∞'}`
          : `B 站未登录或已失效：${me.error}`,
      };
    }

    default:
      return {
        ok: false,
        error: '未知 action：' + action,
        actions: ['plan', 'list', 'show', 'approve', 'reject', 'publish', 'rename', 'comment', 'engage', 'records', 'status'],
      };
  }
}

export default { name, description, inputSchema, run, expose: 'qq' };
