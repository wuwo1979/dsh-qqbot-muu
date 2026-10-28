/**
 * memory-panel-ui-test.mjs — 浮窗「记忆」页的模板/接口自检（不需要浏览器）
 *
 * 1) 从 live client 里抽出 renderMemoryPanel 相关函数，在 vm 里用假数据渲染；
 * 2) 调 hooks/memory-panel.mjs 的 run()，确认路由注册和 JSON 响应。
 */
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { PLUGIN } from '../patches/plugin-dir.mjs';

const FILE = PLUGIN + '/client/qqbot-settings.js';
const ROOT = 'F:/qqbot/qqbot-mod/.devdata-mempanel-ui';
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

function sample() {
  const now = Date.now();
  return {
    ok: true, ts: now, dataRoot: 'x',
    stats: { chatTotal: 597, memTotal: 41, personaTotal: 8, scopes: [{ scope: 'group:g1' }, { scope: 'c2c:u1' }] },
    chat: [{ scope: 'group:g1', kind: '群聊', sender: '爸爸', dir: 'in', text: '今晚继续写代码', ts: now - 60000 }],
    memories: [{ scope: 'group:g1', kind: 'preference', subj: '爸爸', text: '爸爸习惯熬夜写代码', ts: now - 120000 }],
    cards: [{ scope: 'group:g1', name: '爸爸', text: '研究生，养猫叫年糕', ts: now - 300000 }],
    familiarity: [{ scope: 'group:g1', name: '爸爸', a: 42, t: 35, s: 39, levelLabel: '熟悉', note: '一起熬夜写代码', source: 'fam', ts: now - 300000 }],
    digest: [{ senderId: 'u1', name: '爸爸', sliceCount: 3, covered: 180, lastOk: now - 600000, lastError: '' }],
    digestStates: [{ senderId: 'u1', name: '爸爸', sliceCount: 3, covered: 180, lastOk: now - 600000, lastError: '' }],
    models: { retrieval: { embeddingModel: 'local', stickerEmbeddingModel: 'ollama:nomic-embed-text' }, agentModel: 'qwen2.5:7b' },
    embedder: { model: 'onnx:bge-small-zh', mode: 'local', dim: 512 },
    health: { local: { available: true }, ollamaModels: ['nomic-embed-text:latest', 'qwen2.5vl:3b'] },
    moods: [{ scope: 'group:g1', text: '有点困但还想聊', ts: now - 300000 }],
    agent: {
      enabled: true, intervalMs: 45000, minNewMessages: 3, model: 'qwen2.5:7b', provider: 'ollama',
      states: [{ scope: 'group:g1', lastAttempt: now - 90000, lastRun: now - 90000, lastTs: now - 120000 }],
      log: [{ ts: now - 90000, ok: true, ms: 820, newMessages: 4, facts: 1, cards: 1, mood: '有点困', relation: { delta: 2, note: '一起熬夜' } }],
    },
    recall: [{ ts: now - 30000, scope: 'group:g1', query: '今晚写代码吗', raw: 3, hits: 1, rewritten: false, ok: true, ms: 12 }],
    biliShares: [
      { ts: now - 60000, bvid: 'BV1xx411c7mD', title: '测试视频', owner: '某UP', url: 'https://www.bilibili.com/video/BV1xx411c7mD', sent: true, via: 'card' },
      { ts: now - 3600000, bvid: 'BV2', title: '没发出去的', url: 'https://www.bilibili.com/video/BV2', sent: false, afterComment: true },
    ],
    errors: [],
  };
}

async function main() {
  const src = readFileSync(FILE, 'utf8');
  const a = src.indexOf('      function fmtMemAgo(ts) {');
  const b = src.indexOf('      function paintBody() {');
  ok('找得到记忆页函数段', a > 0 && b > a, { a, b });
  const code = src.slice(a, b);

  const state = { memBusy: false, memErr: '', memPanel: sample(), tab: 'memory' };
  const ctx = {
    state,
    panel: null,
    api: () => Promise.resolve(null),
    esc: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    Date, Math, String, Number, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis.__r = renderMemoryPanel; this.__ago = fmtMemAgo;', ctx);
  const html = ctx.__r();
  ok('渲染出记忆页', typeof html === 'string' && html.length > 300, html.length);
  ok('有分身区块', html.includes('记忆分身'));
  ok('有召回区块', html.includes('最近召回'));
  ok('有提炼记忆', html.includes('数据库里的提炼记忆'));
  ok('有熟识度统一存储', html.includes('熟识度（与印象卡统一存储）'));
  ok('熟识度数值渲染', html.includes('亲近') && html.includes('42') && html.includes('35'));
  ok('有历史印象区块', html.includes('历史印象（全库高维抽象）') && html.includes('data-digest="u1"'));
  ok('有检索模型选择', html.includes('检索与整理模型') && html.includes('dk-mem-emb') && html.includes('ollama:nomic-embed-text'));
  ok('有印象卡', html.includes('印象卡'));
  ok('有B站分享档', html.includes('B站分享档') && html.includes('测试视频') && html.includes('未发（已留档）'), html.slice(-500));
  ok('有最近台账', html.includes('最近聊天台账'));
  ok('单会话熟识度指向统一记忆', src.includes('dk-fam-go') && src.includes('persona.fam'), '补丁 unify-fam-ui 未应用');
  ok('统一入口可跳记忆页', src.includes('state.tab = \'memory\'; paintBody()') && src.includes('补丁 unify-fam-ui'));
  ok('没有 undefined/NaN', !/undefined|NaN/.test(html), (html.match(/undefined|NaN/g) || []).slice(0, 3));
  ok('时间格式化', ctx.__ago(Date.now() - 30 * 60 * 1000).includes('分钟前'), ctx.__ago(Date.now() - 30 * 60 * 1000));

  state.memPanel = null;
  state.memErr = '接口没有返回：请 /bot-restart';
  const html2 = ctx.__r();
  ok('接口缺失时给人话提示', html2.includes('/bot-restart'), html2);

  // ── hook 路由 ──
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(join(ROOT, '.qqbot'), { recursive: true });
  mkdirSync(join(ROOT, '.qqbot-extensions'), { recursive: true });
  const hook = await import('file:///F:/qqbot/dshqqbot/.qqbot-extensions/hooks/memory-panel.mjs');
  let saved = null;
  const env = {
    dataRoot: ROOT,
    logger: { info: () => {}, warn: () => {} },
    ctx: { webServer: { register: (r) => { saved = r; return () => {}; } } },
  };
  await hook.run(env);
  ok('注册了面板路由', saved && saved.path === '/api/qqbot-settings/memory-panel' && saved.kind === 'exact', saved && saved.path);
  let out = '';
  const res = { writeHead: (c) => { out = 'code:' + c; }, end: (s) => { out += '|' + s; } };
  // 2026-10-23：GET 现在还要算当前向量/健康检查，handler 是 async
  await saved.handler({ method: 'GET', url: '/api/qqbot-settings/memory-panel?limit=5' }, res);
  ok('路由返回 JSON', out.includes('"ok"'), out.slice(0, 120));
  const body = JSON.parse(out.split('|')[1]);
  ok('JSON 可解析', typeof body === 'object' && body !== null, body);
  ok('GET 带熟识度/切片/模型', Array.isArray(body.familiarity) && Array.isArray(body.digestStates) && !!body.models, Object.keys(body));
  ok('GET 带B站分享档', Array.isArray(body.biliShares), body.biliShares);

  const putRes = { writeHead: (c) => { out = 'code:' + c; }, end: () => {} };
  await saved.handler({ method: 'PUT', url: '/api/qqbot-settings/memory-panel' }, putRes);
  ok('非 GET/POST 被拒', out === 'code:405', out);

  // POST set-models：真的写回 memory-config.json
  function fakeReq(body) {
    const h = {};
    return {
      method: 'POST', url: '/api/qqbot-settings/memory-panel',
      on(ev, cb) { h[ev] = cb; return this; },
      destroy() {},
      start() { const b = Buffer.from(JSON.stringify(body || {})); if (h.data) h.data(b); if (h.end) h.end(); },
    };
  }
  let out3 = '';
  const res3 = { writeHead: (c) => { out3 = 'code:' + c; }, end: (s) => { out3 += '|' + s; } };
  const req3 = fakeReq({ action: 'set-models', retrieval: { embeddingModel: 'ollama:nomic-embed-text' }, agentModel: 'qwen2.5:7b' });
  const p3 = saved.handler(req3, res3);
  req3.start();
  await p3;
  const cfgFile = join(ROOT, '.qqbot-extensions', 'memory-config.json');
  const savedCfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  ok('POST 保存模型选择', out3.includes('code:200') && savedCfg.retrieval.embeddingModel === 'ollama:nomic-embed-text', out3);
  ok('POST 保存分身模型', savedCfg.memoryAgent.model === 'qwen2.5:7b', savedCfg.memoryAgent);

  let out4 = '';
  const res4 = { writeHead: (c) => { out4 = 'code:' + c; }, end: () => { /* ignore */ } };
  const req4 = fakeReq({ action: 'no-such-action' });
  const p4 = saved.handler(req4, res4);
  req4.start();
  await p4;
  ok('未知 action 返回 400', out4 === 'code:400', out4);

  // ── inject 路径（真机宿主：ctx 只有 inject，直接取 webServer 会抛）──
  //   2026-10-23 真机教训：钩子里裸写 ctx.webServer 会抛
  //   "cannot get property webServer without inject"，必须走 ctx.inject。
  let saved2 = null;
  const injectCtx = {
    get webServer() { throw new Error('cannot get property "webServer" without inject'); },
    inject: (deps, cb) => {
      if (!deps.includes('webServer')) throw new Error('deps 缺 webServer');
      cb({ webServer: { register: (r) => { saved2 = r; return () => {}; } } });
    },
  };
  const r = await hook.run({
    dataRoot: ROOT,
    logger: { info: () => {}, warn: () => {} },
    injectDelayMs: 0,
    ctx: injectCtx,
  });
  await new Promise((res) => setTimeout(res, 30));
  ok('inject 路径排程', r && r.mounted === 'scheduled-inject', r);
  ok('inject 路径挂上路由', saved2 && saved2.path === '/api/qqbot-settings/memory-panel', saved2 && saved2.path);
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\nPASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

try { await main(); } catch (e) {
  if (e && typeof e === 'object' && '__verifyExit' in e) throw e;
  console.error(e);
  console.log('\nPASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
}
