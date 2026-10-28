#!/usr/bin/env node
/**
 * bili-ops-test.mjs — B 站运营（bili_ops）离线自检
 *
 * 不联网、不调模型、不出图/配音/ffmpeg：
 *   配置默认值 / 隐私边界 / 每日额度 / 任务状态机 / 发布门禁 /
 *   评论草稿→审核 / SRT 格式 / 改名参数校验 / 主人权限。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-bili-ops';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, '.qqbot'), { recursive: true });
process.env.QQBOT_MEMORY_DATA_ROOT = ROOT;
delete process.env.DEEPSEEK_API_KEY;

const OPS = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/bili-ops.mjs';
const SW = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/script-writer.mjs';
const TOOL = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/tools/bili_ops.mjs';

let pass = 0;
let fail = 0;
const ok = (s) => {
  pass += 1;
  console.log('  PASS  ' + s);
};
const bad = (s) => {
  fail += 1;
  console.log('  FAIL  ' + s);
  process.exitCode = 1;
};
const chk = (c, s) => (c ? ok(s) : bad(s));

const O = await import(OPS);
const SWm = await import(SW);
const tool = (await import(TOOL)).default;
const env = { logger: { info() {}, warn() {}, debug() {} }, caps: { dataRoot: ROOT } };
const owner = { ...env, user: { openid: 'owner', isOwner: true } };
const stranger = { ...env, user: { openid: 'x', isOwner: false } };

console.log('\n[1] 配置默认值');
{
  const cfg = O.loadOpsConfig(ROOT);
  chk(cfg.publish.mode === 'web', '默认发布走 web 自动投稿');
  chk(cfg.publish.requireApproval === true, '默认需要主人审核');
  chk(cfg.publish.autoPublish === false, '默认不开启免审直发');
  chk(cfg.schedule.enabled === false, '定时任务默认关闭');
  // 仓库里的默认配置文件也要能被解析
  const repo = JSON.parse(fs.readFileSync('F:/qqbot/dshqqbot/.qqbot-extensions/bili-ops-config.json', 'utf8'));
  chk(repo.publish && repo.publish.mode === 'web' && repo.publish.requireApproval === true, '仓库默认配置口径一致');
}

console.log('\n[2] 隐私边界');
{
  const body = SWm.buildRequestBody({ topic: '量子计算入门', style: 'default', panels: 4, seconds: 40 });
  const s = JSON.stringify(body);
  chk(!/SESSDATA|bili_jct|cookie|openid|senderId/i.test(s), '请求体不含 Cookie / 账号标识');
  chk(!/memory\.db|记忆库|聊天记录/.test(s), '请求体不含记忆库 / 聊天记录');
  chk(/量子计算入门/.test(s), '请求体只带选题本身');
  const masked = O.maskKey('sk-1234567890abcdef');
  chk(/\*\*\*/.test(masked) && !masked.includes('1234567890'), 'Key 打码不泄露原文');
  chk(SWm.sanitizeTopic('a\nb<script>c') === 'a bscript c' || !/[\n<>]/.test(SWm.sanitizeTopic('a\nb<script>c')), '选题清洗掉换行与尖括号');
}

console.log('\n[3] 每日额度');
{
  const limits = { dailyComments: 1, dailyVideos: 1, dailyRenames: 1 };
  const q1 = O.checkQuota(ROOT, 'comment', limits);
  chk(q1.ok && q1.used === 0, '初始额度可用');
  O.bumpQuota(ROOT, 'comment');
  const q2 = O.checkQuota(ROOT, 'comment', limits);
  chk(!q2.ok && /额度已用完/.test(q2.error), '用完后拦截且原因可读');
  // 模拟跨天
  const qf = path.join(ROOT, '.qqbot', 'bili-ops-quota.json');
  fs.writeFileSync(qf, JSON.stringify({ date: '2000-01-01', comments: 99 }), 'utf8');
  chk(O.checkQuota(ROOT, 'comment', limits).ok, '跨天自动重置');
}

console.log('\n[4] 任务状态机与记录');
{
  const job = O.newJob(ROOT, { topic: '测试选题' });
  chk(!!job.id && job.status === 'draft', '新建任务为 draft');
  chk(fs.existsSync(path.join(job.dir, 'meta.json')), 'meta.json 已落盘');
  const got = O.getJob(ROOT, job.id);
  chk(got && got.topic === '测试选题', '能读回任务');
  O.updateJob(ROOT, job.id, { status: 'rendered', title: '标题', durationSec: 12.5 });
  chk(O.getJob(ROOT, job.id).status === 'rendered', '状态可更新');
  const list = O.listJobs(ROOT, { limit: 5 });
  chk(list.length >= 1 && list[0].id === job.id, '列表按时间倒序');
  O.appendRecord(ROOT, { type: 'unit', jobId: job.id });
  const recs = O.readRecords(ROOT, { limit: 5 });
  chk(recs.length >= 1 && recs[0].type === 'unit', '记录可追加可读取');
}

console.log('\n[5] 发布门禁');
{
  const cfg = O.loadOpsConfig(ROOT);
  const job = O.newJob(ROOT, { topic: '门禁测试' });
  const r0 = await O.publishJob(ROOT, job.id, { mode: 'web' }, cfg);
  chk(!r0.ok && /还没有成片/.test(r0.error), '无成片时直接拒绝');
  const fakeVideo = path.join(job.dir, 'video.mp4');
  fs.writeFileSync(fakeVideo, 'fake', 'utf8');
  O.updateJob(ROOT, job.id, { status: 'rendered', video: fakeVideo });

  const r1 = await O.publishJob(ROOT, job.id, { mode: 'web' }, cfg);
  chk(!r1.ok && /未审核/.test(r1.error), '未审核不能上传');

  const r2 = await O.publishJob(ROOT, job.id, { mode: 'manual' }, cfg);
  chk(r2.ok && r2.mode === 'manual' && r2.pkg, 'manual 模式返回成片包');

  // 把额度改成 0，验证它也在请求前拦住
  O.saveOpsConfig(ROOT, { limits: { dailyVideos: 0, dailyComments: 20, dailyRenames: 1 } });
  const cfg0 = O.loadOpsConfig(ROOT);
  const r3 = await O.publishJob(ROOT, job.id, { mode: 'web', force: true }, cfg0);
  chk(!r3.ok && /额度已用完/.test(r3.error), '额度为 0 时在请求前拦截');
  O.saveOpsConfig(ROOT, { limits: { dailyVideos: 1, dailyComments: 20, dailyRenames: 1 } });

  // 免审直发：门禁放行后才会走到 Cookie 检查（无网络）
  const cfgA = O.loadOpsConfig(ROOT);
  cfgA.publish.autoPublish = true;
  const r4 = await O.publishJob(ROOT, job.id, { mode: 'web' }, cfgA);
  chk(!r4.ok && /登录|Cookie|cookie|扫码/.test(String(r4.error)), '免审直发会继续走到登录检查（未登录时失败）');
}

console.log('\n[6] SRT 格式');
{
  const srt = O.buildSrt([
    { narration: '第一句', start: 0, end: 2.5 },
    { narration: '第二句', start: 2.5, end: 6.25 },
  ]);
  chk(/^1\r?\n00:00:00,000 --> 00:00:02,500\r?\n第一句/.test(srt), '首条时间轴正确');
  chk(/2\r?\n00:00:02,500 --> 00:00:06,250\r?\n第二句/.test(srt), '第二条时间轴正确');
}

console.log('\n[7] 评论草稿 → 审核');
{
  const d = await O.draftComment(ROOT, { bvid: 'BV1xx411c7mD', message: '这个讲得很清楚，学到了' });
  chk(d.ok && d.draft.status === 'pending', '生成草稿但不发送');
  chk(O.listCommentDrafts(ROOT).length === 1, '草稿入队');
  const q = O.checkQuota(ROOT, 'comment', O.loadOpsConfig(ROOT).limits);
  chk(q.ok, '发送前额度仍可用（草稿不占额度）');
  const r = await O.approveComment(ROOT, { bvid: 'BV1xx411c7mD', aid: 12345, draftId: d.draft.id }, O.loadOpsConfig(ROOT));
  chk(!r.ok && /登录/.test(String(r.error)), '审核后尝试发送（未登录时明确报登录）');
  const t = await tool.run({ action: 'comment', bvid: 'BV1xx411c7mD', message: '再来一条' }, owner);
  chk(t.ok && t.draft && t.draft.status === 'pending', '工具 comment 默认只出草稿');
}

console.log('\n[8] 改名 / 权限');
{
  const r1 = await O.renameAccount(ROOT, '');
  chk(!r1.ok && /昵称不能为空/.test(r1.error), '空昵称被拒');
  const r2 = await O.renameAccount(ROOT, '小蓝的试验号');
  chk(!r2.ok && /登录/.test(String(r2.error)), '未登录时明确提示扫码');
  const denied = await tool.run({ action: 'plan', topic: 'x' }, stranger);
  chk(!denied.ok && /只有主人/.test(denied.error), '非主人不能 plan');
  const emptyTopic = await tool.run({ action: 'plan', topic: '   ' }, owner);
  chk(!emptyTopic.ok && /缺少选题/.test(emptyTopic.error), 'plan 空选题被拒（顺带验证 sanitizeTopic 接线）');
  const denied2 = await tool.run({ action: 'rename', uname: 'x' }, stranger);
  chk(!denied2.ok && /只有主人/.test(denied2.error), '非主人不能改名');
  // 2026-10-24 权限洞回归：旧实现「没有 env.user 就当主人」，群里任何人都能写。
  const byList = await tool.run({ action: 'rename', uname: '' }, { ...env, actorOpenid: 'OWNER1', owners: ['OWNER1'] });
  chk(!byList.ok && /昵称不能为空/.test(byList.error), '白名单里的 actorOpenid 能进到参数校验（不是被权限挡）');
  const byStranger = await tool.run({ action: 'rename', uname: '' }, { ...env, actorOpenid: 'X', owners: ['OWNER1'] });
  chk(!byStranger.ok && /只有主人/.test(byStranger.error), '白名单外的 actorOpenid 被拒');
  const byNobody = await tool.run({ action: 'rename', uname: '' }, { ...env });
  chk(!byNobody.ok && /只有主人/.test(byNobody.error), '拿不到身份一律拒绝（不再默认主人）');
  const byInternal = await tool.run({ action: 'rename', uname: '' }, { ...env, internal: true });
  chk(!byInternal.ok && /昵称不能为空/.test(byInternal.error), 'internal（定时任务）可进到参数校验');
  const bad = await tool.run({ action: 'nope' }, owner);
  chk(!bad.ok && Array.isArray(bad.actions), '未知 action 返回清单');
  const st = await tool.run({ action: 'status' }, owner);
  chk(st.ok && st.schedule.enabled === false, 'status 可读且定时默认关闭');
}

console.log('\n[9] 出图 / 视频分层');
{
  const repo = JSON.parse(fs.readFileSync('F:/qqbot/dshqqbot/.qqbot-extensions/bili-ops-config.json', 'utf8'));
  chk(O.DEFAULT_OPS_CONFIG.image && O.DEFAULT_OPS_CONFIG.image.provider === 'auto', '出图来源默认 auto（和旧 media.provider 解耦）');
  chk(O.DEFAULT_OPS_CONFIG.video.style === 'auto', '视频形态默认 auto');
  chk(repo.image && repo.image.provider === 'auto', '仓库配置含 image.provider');
  chk(repo.video && repo.video.style === 'auto', '仓库配置含 video.style');
  chk(repo.sfx && repo.sfx.enabled !== false, '仓库配置含音效开关');

  const ep = 'https://image.pollinations.ai/prompt/{prompt}';
  const p1 = O.resolvePlan({ mode: 'local-first', image: { provider: 'auto' }, video: { style: 'auto' }, media: { endpoint: ep } });
  chk(p1.imageProvider === 'local' && p1.videoStyle === 'text', '本地优先 → 本地出图 + 文字动效');
  const p2 = O.resolvePlan({ mode: 'cloud-first', image: { provider: 'auto' }, video: { style: 'auto' }, media: { endpoint: ep } });
  chk(p2.imageProvider === 'cloud' && p2.videoStyle === 'image', '云端优先 → 云端出图 + 分镜图');
  chk(O.resolvePlan({ image: { provider: 'cloud' }, media: { endpoint: '' } }).imageProvider === 'local', '无云端 endpoint 时回落本地');
  chk(O.resolvePlan({ mode: 'local-first', image: { provider: 'cloud' }, media: { endpoint: ep } }).imageProvider === 'cloud', '显式云端忽略 mode');
  chk(O.resolvePlan({ mode: 'cloud-first', video: { style: 'text' } }).videoStyle === 'text', '显式文字动效忽略 mode');
  chk(O.resolvePlan({ media: { provider: 'cloud', endpoint: ep } }).imageProvider === 'cloud', '旧 media.provider 键继续有效');
  chk(O.resolvePlan({ media: { provider: 'local' } }).imageProvider === 'local', '旧 media.provider=local 继续有效');

  const cues = O.pickSfxCues(ROOT, { panel: { index: 1, narration: '完成啦！' }, dur: 3 }, 'text', { sfx: { gain: 0.3, maxPerPanel: 2 } });
  chk(Array.isArray(cues) && cues.length === 0, '空音效库挑音效不抛异常（返回空）');
  chk(O.pickSfxCues(ROOT, { panel: { index: 1 }, dur: 3 }, 'image', { sfx: { maxPerPanel: 0 } }).length === 0, 'maxPerPanel=0 时不出音效');
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
console.log(`结论：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
