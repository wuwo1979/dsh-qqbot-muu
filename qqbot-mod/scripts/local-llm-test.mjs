/**
 * local-llm-test.mjs — 本地小模型（Ollama）验收
 *
 * 跑法：node qqbot-mod/scripts/local-llm-test.mjs
 * 退出码 0 = 全通过。
 */
import { loadConfig, health, chat, ask, warmup, status, saveConfig, resetHealthCache } from '../../dshqqbot/.qqbot-extensions/lib/local-llm.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_ROOT = 'F:\\qqbot\\qqbot-mod\\.devdata';
process.env.QQBOT_MEMORY_DATA_ROOT = DATA_ROOT;
mkdirSync(join(DATA_ROOT, '.qqbot-extensions'), { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

console.log('数据根 ' + DATA_ROOT);

// ── 1. 配置层 ────────────────────────────────────────────
console.log('\n[1] 配置');
const cfg = loadConfig(DATA_ROOT);
ok('默认配置可读', !!cfg && typeof cfg.baseUrl === 'string', cfg.baseUrl + ' / ' + cfg.model);
ok('默认模型非空', typeof cfg.model === 'string' && cfg.model.length > 0, cfg.model);
// ★ 用「线上配置里真的在用的那个模型」来测（模型名会换，测试不该写死 qwen2.5:0.5b）
let liveModel = cfg.model;
try {
  const lc = loadConfig('F:/qqbot/dshqqbot');
  if (lc && typeof lc.model === 'string' && lc.model) liveModel = lc.model;
} catch { /* 线上配置读不到就用默认 */ }
const saved = saveConfig(DATA_ROOT, { model: liveModel });
ok('saveConfig 成功', saved.ok === true);
const cfg2 = loadConfig(DATA_ROOT);
ok('保存后读回一致', cfg2.model === liveModel, cfg2.model);
// ★ 之后一律用 cfg2：cfg 是在 saveConfig 之前读的，模型名可能是旧的

// ── 2. 服务探测 ──────────────────────────────────────────
console.log('\n[2] Ollama 服务');
resetHealthCache();
const st = await status(cfg2, true);
console.log('  status: ' + JSON.stringify(st));
ok('服务在线', st.serverUp === true, st.error ? String(st.error) : '');
ok('模型已安装', st.hasModel === true, (st.models || []).join(','));

if (!st.hasModel) {
  console.log('\n⚠ 模型还没拉下来，跳过推理用例（先 ollama pull ' + cfg.model + '）');
  console.log('\nPASS ' + pass + ' / FAIL ' + fail + '  (推理用例跳过)');
  process.exit(fail === 0 ? 0 : 1);
}

// ── 3. 推理 ──────────────────────────────────────────────
console.log('\n[3] 推理');
const w = await warmup(cfg2);
ok('预热成功', w.ok === true, w.ms + 'ms' + (w.error ? ' ' + w.error : ''));
ok('预热在 60 秒内', w.ms < 60000, w.ms + 'ms');

const r1 = await ask('用一句很短的中文打招呼，别解释。', { cfg: cfg2, maxTokens: 24 });
console.log('  出话: ' + JSON.stringify(r1.text || r1.error) + '  ' + r1.ms + 'ms');
ok('返回非空文本', r1.ok === true && (r1.text || '').length > 0);
ok('延迟 < 20 秒', r1.ms < 20000, r1.ms + 'ms');

const r2 = await ask('2+3 等于几？只回一个数字。', { cfg: cfg2, maxTokens: 12 });
console.log('  出话: ' + JSON.stringify(r2.text || r2.error));
ok('能给出一个短答案', r2.ok === true && (r2.text || '').length <= 20, r2.text || '');
// 0.5B 算不对 2+3=6（人设梗），所以梗由代码直答，不靠模型 —— 这里单独验
const { gagReply } = await import('../../dshqqbot/.qqbot-extensions/inbound/local-answer.mjs');
ok('死梗 2+3 直答 = 6', gagReply('2+3等于几') === '6');
ok('无关问题不误触发梗', gagReply('1+1等于几') === '' && gagReply('你好') === '');

const t0 = Date.now();
const r3 = await chat({
  cfg: cfg2,
  messages: [
    { role: 'system', content: '你是一只叫小蓝的鲸鱼娘，说话很短，句尾常带咕噜噜。只回一句话，不超过20字。' },
    { role: 'user', content: '在吗' },
  ],
  maxTokens: 32,
});
const dt = Date.now() - t0;
console.log('  人设出话: ' + JSON.stringify(r3.text || r3.error) + '  ' + dt + 'ms');
ok('人设应答成功', r3.ok === true);
ok('回复长度 ≤ 60 字', (r3.text || '').length <= 60, String((r3.text || '').length) + '字');

// ── 4. 失败路径必须优雅 ──────────────────────────────────
console.log('\n[4] 降级');
const bad = await chat({ messages: [{ role: 'user', content: 'hi' }], cfg: { ...cfg2, baseUrl: 'http://127.0.0.1:59999' }, timeoutMs: 1500 });
ok('端口不通时返回 ok:false 而不抛', bad.ok === false, String(bad.error));
const badModel = await chat({ messages: [{ role: 'user', content: 'hi' }], cfg: cfg2, model: 'no-such-model:0b', timeoutMs: 8000 });
ok('模型不存在时返回 ok:false', badModel.ok === false, String(badModel.error));
ok('缺省参数不崩', (await chat({})).ok === false);

// ── 5. 缓存 ──────────────────────────────────────────────
console.log('\n[5] 健康缓存');
resetHealthCache();
const h1 = await health(cfg2, true);
const t1 = Date.now();
const h2 = await health(cfg2, false);
ok('缓存命中很快（<100ms）', Date.now() - t1 < 100, (Date.now() - t1) + 'ms');
ok('两次结果一致', h1.ok === h2.ok);

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
