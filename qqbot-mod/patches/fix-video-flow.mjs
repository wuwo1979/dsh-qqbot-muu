/**
 * fix-video-flow —— 2026-10-27
 *
 * 三个真问题：
 *  1. 浮窗「生成视频」走 host 的 `action:'plan'`，它直接 newJob + renderJob，
 *     **从来没写过脚本/分镜** ⇒ 每次都失败在「任务没有分镜（先写脚本）」。
 *     改成调用 lib 的 planAndRender（写脚本 → 分镜 → 出图配音 → mp4），
 *     并且先把任务写盘（status=scripting），失败也留原因。
 *  2. 「打开产物目录」指向旧根 {root}/.qqbot/bili-ops/jobs（早就空了），
 *     真实产物在 bili-ops-config.json 的 storage.root（F:/qqbot/data/bili-ops/jobs）。
 *     改成用 lib.paths(root).jobs，永远跟着配置走。
 *  3. open-dir 的白名单只允许 root 与 .models/skills，产物目录在 F:/qqbot/data 下
 *     ⇒ 被"目录不在数据根里，拒绝打开"挡回来。把 jobs 根与它的上级放进白名单。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, pluginPath } from './plugin-dir.mjs'

const HOST = pluginPath('settings-host.js')
const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const CHECK = args.has('--check') || !APPLY

const norm = (s) => String(s).replace(/\r\n/g, '\n')
const crlf = (orig, out) => (String(orig).includes('\r\n') ? out.replace(/\n/g, '\r\n') : out)

let src = norm(readFileSync(HOST, 'utf8'))
const orig = readFileSync(HOST, 'utf8')
const report = []
let hits = 0

function replaceOnce(label, oldStr, newStr) {
  const i = src.indexOf(oldStr)
  if (i < 0) { report.push(`✗ ${label}：锚点没找到`); return false }
  if (src.indexOf(oldStr, i + 1) >= 0) { report.push(`✗ ${label}：锚点不唯一`); return false }
  if (src.includes(newStr) && newStr.trim() && src.includes(newStr.slice(0, 60)) && newStr !== oldStr) {
    // 已经打过：新的片段在，旧的也不在 → 幂等
    if (src.indexOf(oldStr) < 0) { report.push(`= ${label}：已是新版`); return true }
  }
  src = src.slice(0, i) + newStr + src.slice(i + oldStr.length)
  hits += 1
  report.push(`✓ ${label}`)
  return true
}

// ── ① plan 路由：走 planAndRender ──────────────────────────────────────
const PLAN_OLD = `      } else if (action === 'plan') {
        const topic = String(body.topic || body.text || '').trim();
        if (!topic) return writeJson(res, 200, { ok: false, error: '先写一句要求' });
        const job = lib.newJob(root, { topic, mode: 'web' });
        lib
          .renderJob(job, cfg)
          .then((x) => {
            if (!x || x.ok === false) lib.updateJob(root, job.id, { status: 'failed', error: String((x && x.error) || '生成失败') });
          })
          .catch((e) => lib.updateJob(root, job.id, { status: 'failed', error: String((e && e.message) || e) }));
        r = { ok: true, jobId: job.id, msg: '已开始生成，约 1~2 分钟后刷新看结果' };`

const PLAN_NEW = `      } else if (action === 'plan') {
        // [[qqbot-mod] video-flow] 一句话 → 成片：先写脚本/分镜，再出图配音。
        // 旧实现直接 newJob+renderJob，从没写过 panels，所以永远失败在"任务没有分镜"。
        const topic = String(body.topic || body.text || '').trim();
        if (!topic) return writeJson(res, 200, { ok: false, error: '先写一句要求' });
        const jobId = lib.newJobId();
        const orientation = String(body.orientation || '').toLowerCase() === 'vertical' ? 'vertical' : 'horizontal';
        const panels = Number(body.panels) || 0;
        const scriptJson = String(body.scriptJson || '').trim();
        let secret = {};
        try { secret = lib.readSecret(root) || {}; } catch { }
        lib
          .planAndRender(root, cfg, { jobId, topic, panels, orientation, scriptJson, secret })
          .then((x) => {
            lib.appendRecord(root, {
              type: 'plan',
              jobId,
              title: (x && x.job && x.job.title) || topic.slice(0, 40),
              panels: (x && x.job && x.job.panels && x.job.panels.length) || 0,
              llm: (x && x.script && x.script.llm) || '',
              ok: !!(x && x.ok),
              warnings: (x && x.detail && x.detail.warnings && x.detail.warnings.length) || 0,
              error: (x && x.error) || '',
            });
          })
          .catch((e) => lib.updateJob(root, jobId, { status: 'failed', stage: 'failed', error: String((e && e.message) || e) }));
        r = {
          ok: true,
          jobId,
          msg: '已开始：先写分镜脚本，然后出图、配音、拼片（3~8 分钟，可随时刷新看进度）',
        };`

replaceOnce('plan 路由改为先写脚本再渲染', PLAN_OLD, PLAN_NEW)

// ── ② open-root：指向真实产物目录 ─────────────────────────────────────
replaceOnce(
  "打开产物目录指向真实 jobs 根",
  `        r = openInExplorer(join(root, '.qqbot', 'bili-ops', 'jobs'));`,
  `        r = openInExplorer(lib.paths(root).jobs); // [[qqbot-mod] video-flow] 跟着 storage.root 走，别再用写死的旧路径`
)

// ── ③ open-dir 白名单：允许产物 jobs 根 ───────────────────────────────
replaceOnce(
  'open-dir 允许产物目录',
  `      const abs = resolve(dir);
      const okRoot = root && (abs === resolve(root) || abs.startsWith(resolve(root) + sep));
      const okExtra = /^F:[\\\\/]qqbot[\\\\/].models[\\\\/]/i.test(abs) || /^F:[\\\\/]qqbot[\\\\/]skills[\\\\/]/i.test(abs);
      if (!okRoot && !okExtra) return writeJson(res, 200, { ok: false, path: abs, error: '目录不在数据根里，拒绝打开' });`,
  `      const abs = resolve(dir);
      const okRoot = root && (abs === resolve(root) || abs.startsWith(resolve(root) + sep));
      const okExtra = /^F:[\\\\/]qqbot[\\\\/].models[\\\\/]/i.test(abs) || /^F:[\\\\/]qqbot[\\\\/]skills[\\\\/]/i.test(abs);
      // [[qqbot-mod] video-flow] 成片产物默认落在 storage.root（F:/qqbot/data/bili-ops），
      // 它不在数据根下，之前一直被"目录不在数据根里"挡回去 = 用户说的"打开产物目录始终失效"。
      let _jobsDir = '';
      try {
        const _lib = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-ops.mjs').split(String.fromCharCode(92)).join('/'));
        _jobsDir = _lib.paths(root).jobs;
      } catch { }
      const okJobs = _jobsDir && (abs === resolve(_jobsDir) || abs.startsWith(resolve(_jobsDir) + sep));
      if (!okRoot && !okExtra && !okJobs) return writeJson(res, 200, { ok: false, path: abs, error: '目录不在允许范围里，拒绝打开' });`
)

// 报告 / 写入
for (const line of report) console.log(line)
if (CHECK) {
  console.log(hits ? `\n需要写入 ${hits} 处（--apply 才会真写）` : '\n= 已是最新，无需写入')
  process.exit(0)
}
if (!hits) { console.log('\n= 已是最新，无需写入'); process.exit(0) }

const out = crlf(orig, src)
try {
  copyFileSync(HOST, HOST + '.orig-muu-videoflow')
  writeFileSync(HOST, out, 'utf8')
} catch (e) {
  console.log('✗ 写入失败：' + (e && e.message))
  process.exit(1)
}
console.log(`\n✔ 已写入 ${HOST}`)
console.log('  目标插件目录：' + PLUGIN)
