/**
 * hooks/memory-panel.mjs — 浮窗「记忆」页的数据与操作接口
 *
 *   GET  /api/qqbot-settings/memory-panel   → 台账/记忆/印象卡/熟识度/切片/模型
 *   POST /api/qqbot-settings/memory-panel   → 动作：
 *        {action:'digest', senderId?}  重建某个人的历史印象（不传则主人+活跃的人）
 *        {action:'set-models', retrieval:{...}, agentModel?}  保存模型选择
 *        {action:'rebuild'}            按当前模型全量重嵌记忆向量
 *
 * ⚠️ 2026-10-23 修（浮窗「接口没有返回」的真实原因）：
 *   钩子里直接写 `ctx.webServer` 会被 cordis 的 Proxy 拒绝：
 *   `cannot get property "webServer" without inject` —— 钩子当场失败，路由根本没挂上。
 *   所以必须先 `ctx.inject(['webServer'], cb)`，在注入后的 ctx 上注册。
 *   参考插件本体 dist/index.js:326 的同款坑与解法。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectMemoryPanel } from '../lib/memory-panel-core.mjs';
import { digestPerson, digestAll, listTargets } from '../lib/profile-digest.mjs';
import { rebuildEmbeddings, currentEmbedderInfo, dbHealth, maintainDb, readAudit, exportScope, purgeScope, privacyState, setEncryption } from '../lib/memory.mjs';
import { readShares } from '../lib/bili-share.mjs';
import { health as embedderHealth, loadRetrieval } from '../lib/embedder.mjs';
import { loadConfig as loadMemoryConfig } from '../lib/memory.mjs';
import { loadConfig as loadLlmConfig } from '../lib/local-llm.mjs';
import { loadGroupTiers, setGroupTier, clearGroupTier, setPersonTier, clearPersonTier, nameMapFor, resolveTierTargets, nickIndexOf } from '../lib/group-tiers.mjs';
import { loadBedrock, addBedrock, removeBedrock, bedrockFile } from '../lib/bedrock.mjs';
import { loadMemories, forget as forgetMem } from '../lib/memory.mjs';
import { runSelfReflection } from '../lib/memory-agent.mjs';
import { freshness as personaFreshness, refresh as refreshPersona } from '../lib/persona-fresh.mjs';

// 候选：群里出现过的群（带名字，按最近活跃排序，标签是名字不是 openid）
function candidateGroups(dataRoot, priority = []) {
  const pri = (priority || []).map((x) => String(x).replace(/^group:/, ''));
  let j = {};
  // [qqbot-mod] groups-bom-tolerant 2026-10-27：容忍 UTF-8 BOM
  try { j = JSON.parse(String(readFileSync(join(String(dataRoot), '.qqbot', 'groups.json'), 'utf8')).replace(/^\uFEFF/, '')) || {}; } catch { return []; }
  return Object.keys(j)
    .map((id) => ({ id, name: String((j[id] && j[id].name) || '') || ('#' + id.slice(-4)), at: Number(j[id] && j[id].lastAt) || 0, on: pri.includes(id) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 12);
}

// 候选：台账里说过话的人（带昵称与出现次数；机器人自己和不认识名字的不列）
function candidatePeople(dataRoot, priority = []) {
  const pri = (priority || []).map((x) => String(x).replace(/^c2c:/, ''));
  const nicks = nickIndexOf(dataRoot);
  return Object.keys(nicks)
    .filter((sid) => sid && sid !== 'self')
    .map((id) => ({ id, name: nicks[id], on: pri.includes(id) }))
    .slice(0, 24);
}

export const name = 'memory-panel';

const configPathOf = (root) => join(String(root || ''), '.qqbot-extensions', 'memory-config.json');

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { try { req.destroy(); } catch { /* ignore */ } return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const s = Buffer.concat(chunks).toString('utf8').trim();
        resolve(s ? JSON.parse(s) : {});
      } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function saveModels(root, body) {
  const file = configPathOf(root);
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { cfg = {}; }
  cfg.retrieval = { ...(cfg.retrieval || {}) };
  const r = body.retrieval && typeof body.retrieval === 'object' ? body.retrieval : {};
  for (const k of ['embeddingModel', 'stickerEmbeddingModel', 'visionModel', 'rerankModel']) {
    if (r[k] != null) cfg.retrieval[k] = String(r[k]).trim();
  }
  if (body.agentModel != null) cfg.memoryAgent = { ...(cfg.memoryAgent || {}), model: String(body.agentModel).trim() };
  try {
    if (existsSync(file)) copyFileSync(file, file + '.bak');
    writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return { ok: true, retrieval: cfg.retrieval, agentModel: (cfg.memoryAgent || {}).model || '' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// 长任务只允许同时跑一个（本地模型 6GB 显存，并发会互相踩）
const jobs = { digest: null, rebuild: null };

function startJob(kind, fn) {
  if (jobs[kind]) return { started: false, running: true, hint: jobs[kind].hint || '' };
  const job = { hint: '', startedAt: Date.now(), last: null, running: true };
  jobs[kind] = job;
  Promise.resolve()
    .then(fn)
    .then((r) => { job.last = r; })
    .catch((e) => { job.last = { ok: false, reason: e instanceof Error ? e.message : String(e) }; })
    .finally(() => { job.running = false; });
  return { started: true, running: true };
}

function jobView() {
  const view = (j) => (j ? { running: j.running, startedAt: j.startedAt, last: j.last } : null);
  return { digest: view(jobs.digest), rebuild: view(jobs.rebuild) };
}

export async function run(env = {}) {
  const { ctx, dataRoot, logger } = env;

  const attach = (serverCtx, from) => {
    try {
      const ws = serverCtx && serverCtx.webServer;
      if (!ws || typeof ws.register !== 'function') {
        logger?.warn?.('[memory-panel] 宿主没有 webServer，浮窗记忆页不可用');
        return;
      }
      const dispose = ws.register({
        kind: 'exact',
        path: '/api/qqbot-settings/memory-panel',
        handler: async (req, res) => {
          const send = (code, obj) => {
            try {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify(obj));
            } catch { /* ignore */ }
          };
          try {
            const u = new URL(String(req.url || ''), 'http://localhost');
            if (req.method === 'GET' || !req.method) {
              const data = collectMemoryPanel(dataRoot, {
                scope: u.searchParams.get('scope') || '',
                limit: Number(u.searchParams.get('limit')) || 30,
              });
              data.jobs = jobView();
              data.config = loadMemoryConfig(dataRoot) || {};
              // 印象保鲜（主人 2026-10-27）：卡片年龄 / 新切片未消化 / 心情是否过期。纯读，不花 token。
              try { data.freshness = personaFreshness(dataRoot, data.config || {}); } catch { /* ignore */ }
              try { data.embedder = await currentEmbedderInfo(dataRoot); } catch { /* ignore */ }
              try { data.health = await embedderHealth(dataRoot); } catch { /* ignore */ }
              try { data.llm = loadLlmConfig(dataRoot) || {}; } catch { /* ignore */ }
              data.targets = listTargets(dataRoot, { limit: 20 });
              data.tiers = loadGroupTiers(dataRoot, (data.config || {}).groupTiers);
              // 特别关心：面板只展示"名字"，不展示 openid（主人 2026-10-25）
              try {
                const tg = data.tiers || {};
                data.tierNames = {
                  group: nameMapFor(dataRoot, 'group', (tg.priority || []).concat(tg.normal || [])),
                  person: nameMapFor(dataRoot, 'person', tg.priorityPeople || []),
                };
                data.tierCandidates = {
                  groups: candidateGroups(dataRoot, (tg.priority || [])),
                  people: candidatePeople(dataRoot, (tg.priorityPeople || [])),
                };
              } catch { /* 名单只是辅助信息，坏了不影响面板 */ }
              // 库健康：索引缺失/倒排没建/碎片率高这类"不报错只变差"的问题，必须能一眼看见
              try { data.db = dbHealth(dataRoot); } catch { data.db = null; }
              // 隐私：加密状态 + 最近审计（谁在什么时候导出/删除/开关了加密）
              try { data.privacy = privacyState(dataRoot); } catch { data.privacy = null; }
              try { data.audit = readAudit(dataRoot, 30); } catch { data.audit = []; }
              try { data.biliShares = readShares(dataRoot, { limit: 20 }); } catch { data.biliShares = []; }
              // 自我学习（主人 2026-10-26）：底层信条 + 学习心得/成长心得（人可审查）
              try { data.bedrock = loadBedrock(dataRoot); } catch { data.bedrock = []; }
              try {
                data.insights = (loadMemories(dataRoot, '__global__') || [])
                  .filter((m) => ['insight', 'growth'].includes(String(m.kind || '')))
                  .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
                  .slice(0, 30)
                  .map((m) => ({ id: m.id, kind: m.kind, source: m.subj || 'chat', text: m.text, ts: m.ts }));
              } catch { data.insights = []; }
              send(200, data);
              return;
            }
            if (req.method !== 'POST') { send(405, { ok: false, error: '只支持 GET/POST' }); return; }
            const body = await readJsonBody(req);
            const action = String(body.action || '').trim();

            if (action === 'set-models') {
              send(200, saveModels(dataRoot, body));
              return;
            }
            // 库维护：体检 + 检查点 + 备份 +（按需）补索引/VACUUM
            if (action === 'db-maintain') {
              const r = startJob('db-maintain', () => maintainDb(dataRoot, {
                backup: body.backup !== false,
                keep: Number(body.keep) || 5,
                vacuum: body.vacuum === true ? true : 'auto',
                reindex: body.reindex !== false,
              }));
              send(200, { ok: true, action, ...r, jobs: jobView() });
              return;
            }
            // 数据主权：导出某个 scope 的全量记忆（纯文本 + 元信息，落 .qqbot/exports/）
            if (action === 'export-scope') {
              const scope = String(body.scope || '').trim();
              if (!scope) { send(400, { ok: false, error: '缺 scope' }); return; }
              const out = exportScope(dataRoot, scope);
              let file = '';
              try {
                const dir = join(String(dataRoot), '.qqbot', 'exports');
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                const safe = scope.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
                file = join(dir, `memory-${safe}-${Date.now()}.json`);
                writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
              } catch (e) {
                send(500, { ok: false, error: '导出写入失败: ' + (e instanceof Error ? e.message : String(e)) });
                return;
              }
              send(200, { ok: true, action, scope, total: out.total, file, audit: readAudit(dataRoot, 5) });
              return;
            }
            // 数据主权：彻底删除某个 scope 的一切（必须显式 confirm，且不进回收站）
            if (action === 'purge-scope') {
              const scope = String(body.scope || '').trim();
              if (!scope) { send(400, { ok: false, error: '缺 scope' }); return; }
              if (body.confirm !== 'purge') {
                send(400, { ok: false, error: '这是不可逆的彻底删除，需要 confirm:"purge" 才执行' });
                return;
              }
              const r = purgeScope(dataRoot, scope);
              send(200, { ok: true, action, ...r, audit: readAudit(dataRoot, 5) });
              return;
            }
            // 隐私：开/关字段级加密（全库重加密 + 写配置 + 记审计）
            if (action === 'encrypt-toggle') {
              const on = body.on === true || body.on === 'true';
              const r = setEncryption(dataRoot, on);
              send(200, { ok: !!r.ok, action, on, ...r, privacy: privacyState(dataRoot) });
              return;
            }
            if (action === 'fresh-refresh') {
              // 印象保鲜：自我卡（不花 token）+ 最旧的 N 个人（走 digestPerson，自带节流）
              const cfg = loadMemoryConfig(dataRoot) || {};
              const llmCfg = loadLlmConfig(dataRoot) || {};
              const mode = String(body.mode || 'stale').trim();
              const r = startJob('fresh', () => refreshPersona(dataRoot, {
                mode,
                senderId: String(body.senderId || '').trim(),
                name: String(body.name || '').trim(),
                budget: Number(body.budget) || undefined,
                force: body.force !== false,
                cfg,
                llmCfg,
              }));
              send(200, { ok: true, action, mode, ...r, jobs: jobView() });
              return;
            }
            if (action === 'digest') {              const senderId = String(body.senderId || '').trim();
              const scope = String(body.scope || '').trim();
              const force = body.force !== false;
              const cfg = loadMemoryConfig(dataRoot) || {};
              const llmCfg = loadLlmConfig(dataRoot) || {};
              const r = startJob('digest', () => (senderId
                ? digestPerson({ dataRoot, senderId, scope, cfg, llmCfg, force })
                : digestAll({ dataRoot, cfg, llmCfg, limit: Number(body.limit) || 3, force })));
              send(200, { ok: true, action, senderId, scope, ...r, jobs: jobView() });
              return;
            }
            if (action === 'set-tier') {
              const ids = Array.isArray(body.ids) ? body.ids : [body.id];
              const tier = String(body.tier || '').trim();
              const r = tier === 'clear'
                ? clearGroupTier(dataRoot, ids)
                : setGroupTier(dataRoot, ids, tier === 'priority' ? 'priority' : 'normal');
              send(200, { ok: !!r.ok, action, ...r, tiers: loadGroupTiers(dataRoot, {}) });
              return;
            }
            // 特别关心的人（印象卡 / 自行粘贴 openid）：普通群里遇到 TA 也按 priority 档
            if (action === 'set-person-tier') {
              const ids = Array.isArray(body.ids) ? body.ids : [body.id];
              const tier = String(body.tier || '').trim();
              const r = tier === 'clear'
                ? clearPersonTier(dataRoot, ids)
                : setPersonTier(dataRoot, ids, 'priority');
              send(200, { ok: !!r.ok, action, ...r, tiers: loadGroupTiers(dataRoot, {}) });
              return;
            }
            // 按名字加入：群名 / 昵称 / 直接 openid 都收；解析不了就原样报回去让面板提示
            if (action === 'add-tier-by-name') {
              const kind = String(body.kind || 'person') === 'group' ? 'group' : 'person';
              const text = String(body.text || '');
              const rs = resolveTierTargets(dataRoot, kind, text);
              if (!rs.ids.length) {
                send(200, {
                  ok: false,
                  action,
                  reason: rs.ambiguous.length
                    ? ('「' + rs.ambiguous.join('、') + '」对上了好几个人/群，写全一点')
                    : ('没找到「' + (rs.unresolved.join('、') || text) + '」；可以从下面的候选里点，或者直接粘贴 openid'),
                  tiers: loadGroupTiers(dataRoot, {}),
                });
                return;
              }
              const r = kind === 'group' ? setGroupTier(dataRoot, rs.ids, 'priority') : setPersonTier(dataRoot, rs.ids, 'priority');
              send(200, { ok: !!r.ok, action, kind, ids: rs.ids, unresolved: rs.unresolved, ...r, tiers: loadGroupTiers(dataRoot, {}) });
              return;
            }
            if (action === 'rebuild') {
              const r = startJob('rebuild', () => rebuildEmbeddings(dataRoot, {}));
              send(200, { ok: true, action, ...r, jobs: jobView() });
              return;
            }
            // 类海马体层：手动触发一次回放巩固（把同主题情节压成归纳）
            if (action === 'replay') {
              const { replay } = await import('../lib/memory-hippo.mjs');
              const scope = String(body.scope || '').trim();
              const r = startJob('replay', () => replay(dataRoot, scope || '__global__', {
                windowDays: Number(body.windowDays) || 45,
                minSize: Number(body.minSize) || 3,
                maxClusters: Number(body.maxClusters) || 8,
              }));
              send(200, { ok: true, action, scope, ...r, jobs: jobView() });
              return;
            }
            // 把当前认知钉成基线（之后偏移过大就会在面板上报警）
            if (action === 'anchor-beliefs') {
              const { anchorBeliefs } = await import('../lib/memory-hippo.mjs');
              const scope = String(body.scope || '__global__').trim();
              send(200, { ok: true, action, scope, ...anchorBeliefs(dataRoot, scope) });
              return;
            }
            // ── 自我学习（主人 2026-10-26）──
            // 信条增删：必须 confirm:'human'（这是唯一的写入口，LLM 碰不到）
            if (action === 'bedrock-add') {
              if (body.confirm !== 'human') { send(400, { ok: false, error: '缺少人工确认（confirm=human）' }); return; }
              const r = addBedrock(dataRoot, String(body.text || ''), { by: 'human' });
              try { readAudit(dataRoot, 1); } catch { /* ignore */ }
              send(200, { ok: !!r.ok, action, ...r, bedrock: loadBedrock(dataRoot) });
              return;
            }
            if (action === 'bedrock-del') {
              if (body.confirm !== 'human') { send(400, { ok: false, error: '缺少人工确认（confirm=human）' }); return; }
              const r = removeBedrock(dataRoot, String(body.id || ''));
              send(200, { ok: !!r.ok, action, ...r, bedrock: loadBedrock(dataRoot) });
              return;
            }
            // 删一条学习心得（人可审查）
            if (action === 'insight-del') {
              const id = String(body.id || '');
              const n = forgetMem(dataRoot, String(body.scope || '__global__'), id);
              send(200, { ok: n > 0, action, deleted: n });
              return;
            }
            // 手动触发自我反思（可选带 B 站日志摘要；不传则自动从 B 站运营日志取最近几条）
            if (action === 'self-reflect') {
              let biliDigest = String(body.biliDigest || '');
              if (!biliDigest) {
                try {
                  const { readFileSync: _rf, existsSync: _ex } = await import('node:fs');
                  const { join: _join } = await import('node:path');
                  const _rec = _join(String(dataRoot), '.qqbot', 'bili-ops', 'records.jsonl');
                  if (_ex(_rec)) {
                    const _lines = String(_rf(_rec, 'utf8') || '').trim().split('\n').filter(Boolean);
                    biliDigest = _lines.slice(-6).map((l) => {
                      try {
                        const o = JSON.parse(l);
                        return `[${o.type || 'bili'}] ${String(o.title || o.text || o.desc || '').slice(0, 40)}${o.ok === false ? '（未成功）' : ''}`;
                      } catch { return ''; }
                    }).filter(Boolean).join('；').slice(0, 300);
                  }
                } catch { /* B 站摘要只是加分项 */ }
              }
              const r = await runSelfReflection({
                dataRoot,
                cfg: loadMemoryConfig(dataRoot) || {},
                biliDigest,
              });
              send(200, { ok: !!r.ok, action, ...r });
              return;
            }
            send(400, { ok: false, error: '未知 action：' + action });
          } catch (e) {
            send(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        },
      });
      try {
        if (typeof env.registerDispose === 'function') env.registerDispose(dispose);
      } catch { /* ignore */ }
      logger?.info?.(`[memory-panel] 已挂载 /api/qqbot-settings/memory-panel（${from}）`);
    } catch (err) {
      logger?.warn?.(`[memory-panel] 注册路由失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 每天把主人的全库历史重建成印象卡（低优先级：只跑一次，失败只记日志，不挡聊天）
  let digestFirst = null;
  let digestTimer = null;
  const digestTick = async () => {
    if (!dataRoot || jobs.digest) return;
    try {
      const { pickOwner, digestPerson: dp } = await import('../lib/profile-digest.mjs');
      const owner = pickOwner(dataRoot);
      if (!owner) return;
      const cfg = loadMemoryConfig(dataRoot) || {};
      // [mmtr 2026-10-27] 睡眠结算：每次整理前先把主人的 belief 向锚点回归、
      //   到期承诺判定（broken 的自动付关系代价）——「吵架比亲密更容易过去」。
      try {
        const mm = await import('../lib/memory-mmtr.mjs');
        const sl = mm.sleepSettle(dataRoot, 'person:qq:' + owner);
        if (sl && sl.ok && (sl.beliefs || sl.due)) logger?.info?.(`[mmtr] 睡眠结算：belief 回归 ${sl.beliefs} 项，到期承诺 ${sl.due} 个`);
      } catch { /* 睡眠失败不影响整理 */ }
      jobs.digest = { hint: 'auto', startedAt: Date.now(), last: null, running: true };
      const r = await dp({ dataRoot, senderId: owner, cfg });
      jobs.digest.last = r;
      jobs.digest.running = false;
      // [qqbot-mod] digest-log 2026-10-27：历史切片 10-24 后就没再长过，失败原因只进宿主控制台
      //   无从排查 —— 落一份 jsonl 给浮窗/后续排查用（成功失败都记）。
      try {
        mkdirSync(join(String(dataRoot), '.qqbot'), { recursive: true });
        appendFileSync(join(String(dataRoot), '.qqbot', 'digest-log.jsonl'), JSON.stringify({ ts: Date.now(), kind: 'auto', owner, ...r }) + '\n', 'utf8');
      } catch { /* 日志失败不影响主流程 */ }
      if (r && r.ok) logger?.info?.(`[memory-panel] 主人印象卡已更新：${String(r.card || '').slice(0, 60)}`);
    } catch (e) {
      if (jobs.digest) { jobs.digest.last = { ok: false, reason: e instanceof Error ? e.message : String(e) }; jobs.digest.running = false; }
      try {
        mkdirSync(join(String(dataRoot || '.'), '.qqbot'), { recursive: true });
        appendFileSync(join(String(dataRoot || '.'), '.qqbot', 'digest-log.jsonl'), JSON.stringify({ ts: Date.now(), kind: 'auto', ok: false, error: e instanceof Error ? e.message : String(e) }) + '\n', 'utf8');
      } catch { /* ignore */ }
      logger?.warn?.(`[memory-panel] 自动整理失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  try {
    digestFirst = setTimeout(() => { digestTick().catch(() => {}); }, Math.max(5000, Number(env.digestAfterMs) || 60000));
    digestFirst.unref?.();
    digestTimer = setInterval(() => { digestTick().catch(() => {}); }, 6 * 3600_000);
    digestTimer.unref?.();
  } catch { /* ignore */ }
  if (typeof env.registerDispose === 'function') {
    try {
      env.registerDispose(() => {
        try { clearTimeout(digestFirst); clearInterval(digestTimer); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
  }

  // ① 正常路径：延后 1.5s 再 inject，等宿主把 webServer 服务注册完
  if (ctx && typeof ctx.inject === 'function') {
    const delay = Number(env.injectDelayMs);
    const doInject = () => {
      try {
        ctx.inject(['webServer'], (serverCtx) => attach(serverCtx, 'inject'));
      } catch (err) {
        logger?.warn?.(`[memory-panel] inject 失败，尝试直接挂载: ${err instanceof Error ? err.message : String(err)}`);
        attach(ctx, 'direct');
      }
    };
    try {
      setTimeout(doInject, Number.isFinite(delay) && delay >= 0 ? delay : 1500);
    } catch {
      doInject();
    }
    return { mounted: 'scheduled-inject' };
  }
  // ② 兜底：宿主没有 inject（测试/旧宿主）
  attach(ctx, 'direct');
  return { mounted: 'direct' };
}

export default run;
