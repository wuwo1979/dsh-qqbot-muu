/**
 * memory-model-test.mjs — 检索模型可选（本地 ONNX / Ollama）+ 换模型后重建向量
 *
 * 用户要求：给负责检索记忆的加个模型选择；图片检索同理，以本地为主、可协同云端。
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'F:/qqbot/qqbot-mod/.devdata-memmodel';
const LIB = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

function clean() {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(join(ROOT, '.qqbot-extensions'), { recursive: true });
  mkdirSync(join(ROOT, '.qqbot'), { recursive: true });
}

function writeCfg(obj) {
  writeFileSync(join(ROOT, '.qqbot-extensions', 'memory-config.json'), JSON.stringify(obj, null, 2), 'utf8');
}

async function main() {
  clean();
  const emb = await import(LIB + 'embedder.mjs');
  const { openDb, rebuildEmbeddings, embeddingModelInfo, currentEmbedderInfo } = await import(LIB + 'memory.mjs');

  // ── 配置解析 ──
  const d0 = emb.loadRetrieval(ROOT);
  ok('默认用本地模型', d0.embeddingModel === 'local', d0.embeddingModel);
  ok('表情检索缺省跟随记忆', d0.stickerEmbeddingModel === 'local', d0.stickerEmbeddingModel);

  writeCfg({ retrieval: { embeddingModel: 'ollama:nomic-embed-text', stickerEmbeddingModel: 'ollama:bge-m3' } });
  const d1 = emb.loadRetrieval(ROOT);
  ok('读记忆检索模型', d1.embeddingModel === 'ollama:nomic-embed-text', d1.embeddingModel);
  ok('读表情检索模型', d1.stickerEmbeddingModel === 'ollama:bge-m3', d1.stickerEmbeddingModel);

  ok('模型标识 local → onnx', emb.modelTagOf('local') === 'onnx:bge-small-zh');
  ok('模型标识 ollama 前缀保留', emb.modelTagOf('ollama:bge-m3') === 'ollama:bge-m3');
  ok('模型标识裸名补前缀', emb.modelTagOf('nomic-embed-text') === 'ollama:nomic-embed-text');

  // ── 词频兜底 ──
  const v1 = emb.lexicalVec('今天写代码');
  const v2 = emb.lexicalVec('今天写代码');
  const v3 = emb.lexicalVec('完全不同的内容');
  ok('词频向量 256 维', v1.length === 256, v1.length);
  ok('词频向量归一', Math.abs(Math.hypot(...v1) - 1) < 1e-6, Math.hypot(...v1));
  ok('词频向量稳定', v1.every((x, i) => x === v2[i]));
  ok('不同文本不同向量', v1.some((x, i) => x !== v3[i]));

  // ── 实际取向量：本地优先，Ollama 不可达时自动回退 ──
  writeCfg({ retrieval: { embeddingModel: 'local', timeoutMs: 5000 } });
  const raw = await emb.embedTexts(ROOT, ['今天写代码', '猫在键盘上睡觉'], { kind: 'passage' });
  ok('本地取向量不抛', Array.isArray(raw.vecs) && raw.vecs.length === 2, raw);
  ok('两条向量同维', raw.vecs[0].length > 0 && raw.vecs[0].length === raw.vecs[1].length, raw.vecs.map((v) => v.length));
  ok('模型标识非空', !!raw.model && ['local', 'lexical'].includes(raw.mode), raw);

  const bad = await emb.embedTexts(ROOT, ['测试'], {
    kind: 'query',
    cfg: { embeddingModel: 'ollama:no-such-model', ollamaBase: 'http://127.0.0.1:9', timeoutMs: 300 },
  });
  ok('Ollama 不可达自动回退', Array.isArray(bad.vecs) && bad.vecs.length === 1 && bad.vecs[0].length > 0, bad.mode);

  // ── 换模型后重建向量 ──
  const h = openDb(ROOT);
  const now = Date.now();
  const ins = h.db.prepare('INSERT INTO mem(id, scope, kind, subj, text, vec, ts, hits, src) VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run('m1', 'c2c:u1', 'fact', '对方', '对方名叫妈妈，在读研究生', null, now, 0, 'test');
  ins.run('m2', 'c2c:u1', 'preference', '对方', '对方习惯熬夜写代码', null, now, 0, 'test');
  ok('重建前没有模型记录', embeddingModelInfo(ROOT).model === '', embeddingModelInfo(ROOT));

  const r = await rebuildEmbeddings(ROOT, { batch: 8 });
  ok('重建完成', r && r.ok !== false && r.updated === 2, r);
  const info = embeddingModelInfo(ROOT);
  ok('写入模型标识', !!info.model && info.rows === 2, info);
  const vecs = h.db.prepare('SELECT id, length(vec) AS n FROM mem ORDER BY id').all();
  ok('两行都有向量', vecs.every((x) => Number(x.n) > 0), vecs);

  const cur = await currentEmbedderInfo(ROOT);
  ok('当前可用模型可探测', !!cur.model && cur.dim > 0, cur);
  ok('插件目录存在', existsSync(emb.pluginDir()), emb.pluginDir());

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
