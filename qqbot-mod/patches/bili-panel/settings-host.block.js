  // 2026-10-24 新增「出图来源 / 视频形态 / 取向」三个下拉：
  //  · GET 返回 options（mode / imageProvider / videoStyle / resolved）；
  //  · POST 增加 action='options' 分支，只写 bili-ops-config.json，不动任务；
  //  · 活体 settings-host.js 的对应实现是 opsCfg + resolvePlan + options 分支。
  // 2026-10-24 修「打开文件夹 / 产物目录」：
  //  · open-root 的路径必须是 {root}/.qqbot/bili-ops/jobs（曾误写成 {root}/bili-ops/jobs，
  //    结果打开了空目录，看起来像"点了没反应"）；
  //  · explorer 起不来时退回 `cmd /c start "" <dir>`，并把 path 回给前端做手动兜底；
  //  · 见活体 settings-host.js 里的 openInExplorer()。
  // [qqbot-mod] B 站管理（浮窗用）：只读任务/记录 + 审核动作；写操作仍由 bili_ops 的主人校验兜底
  async function biliLibOf(root) {
    const p = join(root, '.qqbot-extensions', 'lib', 'bili-ops.mjs');
    return import('file:///' + p.split(String.fromCharCode(92)).join('/'));
  }
  route(ctx, 'GET', '/api/qqbot-settings/bili', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const root = resolveMemoryRoot(nsBot(NSQ(u)));
      if (!root) return writeJson(res, 200, { ok: false, error: '没有数据根', jobs: [], records: [] });
      const lib = await biliLibOf(root);
      const jobs = lib.listJobs(root, { limit: 30 }).map((j) => ({
        id: j.id, title: j.title, status: j.status, at: j.at, durationSec: j.durationSec,
        published: j.published || null, dir: j.dir, warnings: j.warnings || 0, error: j.error || '',
      }));
      const records = lib.readRecords(root, { limit: 20 });
      return writeJson(res, 200, { ok: true, root, jobs, records });
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: String((e && e.message) || e), jobs: [], records: [] });
    }
  });
  route(ctx, 'POST', '/api/qqbot-settings/bili', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const root = resolveMemoryRoot(nsBot(NSQ(u)));
      if (!root) return writeJson(res, 200, { ok: false, error: '没有数据根' });
      const body = await readJsonBody(req).catch(() => ({}));
      const action = String(body.action || '');
      const jobId = String(body.jobId || '');
      if (!jobId) return writeJson(res, 200, { ok: false, error: '缺少 jobId' });
      const lib = await biliLibOf(root);
      const cfg = lib.loadOpsConfig(root);
      let r;
      if (action === 'approve') r = await lib.approveJob(root, jobId, cfg);
      else if (action === 'publish') r = await lib.publishJob(root, jobId, { mode: 'web' }, cfg);
      else if (action === 'reject') {
        lib.updateJob(root, jobId, { status: 'rejected' });
        lib.appendRecord(root, { type: 'reject', jobId, at: Date.now() });
        r = { ok: true };
      } else r = { ok: false, error: '未知动作：' + action };
      return writeJson(res, 200, r);
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  });
