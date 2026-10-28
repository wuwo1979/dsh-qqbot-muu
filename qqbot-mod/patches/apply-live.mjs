#!/usr/bin/env node
/**
 * apply-live.mjs — 把 P0/P1/P2 全部补丁打到**正在跑的那套** qqbot（1.10.22）
 *
 * 为什么重写：原来 apply-p0/p1/p2 三个脚本硬编码了 `C:\Users\Administrator\.dsh\...`（死副本），
 * 而且被一次 PowerShell 编码事故弄坏了（BOM + ANSI 读源码）。这里合并成一个，路径走 plugin-dir.mjs。
 *
 * 用法：
 *   node apply-live.mjs            # 打补丁
 *   node apply-live.mjs --check    # 只校验能否打
 *   node apply-live.mjs --revert   # 从 .orig 全量还原
 *
 * 纪律：精确片段匹配（不模糊替换）→ 每个文件备份 .orig（只备份一次）→ 写完 node --check → 失败全回滚。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PLUGIN, pluginPath, announce } from './plugin-dir.mjs';

announce('apply-live');

const F_SESSION = pluginPath('dist/session/session-manager.js');
const F_INBOUND = pluginPath('dist/transport/inbound.js');
const F_EMBED = pluginPath('dist/features/local-embed.js');
const F_DEBOUNCE = pluginPath('dist/gateway/debounce.js');

const PATCHES = [
  // ══════════ P0-1 群守则去重（每 step 重注 1910 字符）══════════
  {
    id: 'P0-1c', file: F_SESSION,
    from: `                const inBatch = dec.messages.some((m) => {`,
    to: `                // ★ P0-1: 群守则内容指纹（取群守则开头 60 字；群守则为空时退回固定通道上下文，
                //   保证指纹非空 —— 否则 includes('') 恒真会让注入永远被跳过）。
                const rulesFp = (rules.trim() || FIXED_CHANNEL_CONTEXT.trim()).slice(0, 60);
                const inBatch = dec.messages.some((m) => {`,
  },
  {
    id: 'P0-1a', file: F_SESSION,
    from: `                    return mm?.source?.kind === 'qqbot:group-rules' && mm.source.ns === ns
                        && String(mm.content?.[0]?.text ?? '').includes(CTX_SMART_REMINDER);`,
    to: `                    // ★ P0-1 修复：原谓词用 includes(CTX_SMART_REMINDER) —— 该串只在
                    //   contextlessSmart 开启时才进 body(默认 false) ⇒ 默认配置下谓词恒 false、
                    //   skipGroupRules 永不置位 ⇒ 每个 pre-step 都重复注入整段群守则(~1910 字符)，
                    //   这些副本又作为 user/message 留在 surface 里被长期重放。
                    //   改为按群守则内容指纹判重：内容没变 → 跳过；群守则改了 → 自动重注。
                    return mm?.source?.kind === 'qqbot:group-rules' && mm.source.ns === ns
                        && String(mm.content?.[0]?.text ?? '').includes(rulesFp);`,
  },
  {
    id: 'P0-1b', file: F_SESSION,
    from: `                            && String(ev.data.content?.[0]?.text ?? '').includes(CTX_SMART_REMINDER)) {`,
    to: `                            && String(ev.data.content?.[0]?.text ?? '').includes(rulesFp)) {`,
  },

  // ══════════ P0-2 空正文不再吞掉同批消息 ══════════
  {
    id: 'P0-2', file: F_INBOUND,
    from: `    const userContent = resolveMentionNames(userContentRaw, stickerDir, scope === 'group' ? msg.groupOpenid : undefined);
    if (!userContent && (!msg.attachments || msg.attachments.length === 0))
        return null;`,
    to: `    let userContent = resolveMentionNames(userContentRaw, stickerDir, scope === 'group' ? msg.groupOpenid : undefined);
    // ★ P0-2 修复：原来这里 return null → 上游静默 return，而 debounce 早已把这条从
    //   窗口删掉、也打过群冷却 ⇒ 只要有人"只 @ 她、不打字"，同批里排在前面的真实消息会
    //   **一起被吞掉**，且全链路零日志。改为给一句占位正文继续走，消息不再丢。
    if (!userContent && (!msg.attachments || msg.attachments.length === 0)) {
        try { logger?.warn?.('[im-qqbot] 入站正文为空(只@未打字?) → 用占位正文继续，避免吞掉同批消息'); } catch { }
        userContent = '（只 @ 了你一下，没有文字）';
    }`,
  },

  // ══════════ P0-3 群历史逐条编号（治"莫名合并"）══════════
  {
    id: 'P0-3b', file: F_INBOUND,
    from: `    const historyLines = history.map(h => {`,
    to: `    const historyLines = history.map((h, _hi) => {`,
  },
  {
    id: 'P0-3c', file: F_INBOUND,
    from: `        return mentioned && h.senderId ? \`[\${name} (\${h.senderId})] \${c}\` : \`[\${name}] \${c}\`;`,
    to: `        return mentioned && h.senderId ? \`\${_hi + 1}. [\${name} (\${h.senderId})] \${c}\` : \`\${_hi + 1}. [\${name}] \${c}\`;`,
  },
  {
    id: 'P0-3a', file: F_INBOUND,
    from: `        MK.HISTORY_BEGIN,
        ...historyLines,`,
    to: `        MK.HISTORY_BEGIN,
        \`（以下是你上次开口之后群友陆续发的 \${historyLines.length} 条**独立**消息，逐条编号；每行是一个不同的人/不同时刻说的一句话，不是你一条消息被拆开。）\`,
        ...historyLines,`,
  },

  // ══════════ P1 本地小模型可选可换 ══════════
  {
    id: 'P1-1', file: F_EMBED,
    from: `const ASSETS = ['onnx/model_quantized.onnx', 'tokenizer.json', 'config.json'];`,
    to: `/** 模型资产清单(任一缺失即不可用) —— P1: 改为按 dtype 推导 */
function onnxFileFor(dtype) {
    const d = String(dtype || 'q8').toLowerCase();
    if (d === 'fp32' || d === 'f32')
        return 'onnx/model.onnx';
    if (d === 'fp16' || d === 'f16')
        return 'onnx/model_fp16.onnx';
    if (d === 'int8')
        return 'onnx/model_int8.onnx';
    return 'onnx/model_quantized.onnx';
}
/** 某 dtype 下必须存在的三个文件 */
function assetsFor(dtype) {
    return [onnxFileFor(dtype), 'tokenizer.json', 'config.json'];
}
/** 向后兼容：默认(q8)资产清单 */
const _ASSETS_Q8 = assetsFor('q8');
/**
 * ★ P1(2026-10-22): 本地小模型预设表。
 *   modelDir 现在支持填别名（bge-small-zh / bge-base-zh / bge-large-zh），参数随模型走；
 *   原来 ASSETS / dtype:'q8' / pooling:'cls' / QUERY_PREFIX 四处写死，换模型"算得出但算不对"。
 */
export const MODEL_PRESETS = {
    'bge-small-zh': { label: 'bge-small-zh-v1.5 (24MB | 最快)', dir: 'bge-small-zh', dtype: 'q8', pooling: 'cls', queryPrefix: QUERY_PREFIX },
    'bge-base-zh': { label: 'bge-base-zh-v1.5 (~100MB | 更准, 推荐)', dir: 'bge-base-zh', dtype: 'q8', pooling: 'cls', queryPrefix: QUERY_PREFIX },
    'bge-large-zh': { label: 'bge-large-zh-v1.5 (~330MB | 最准但慢)', dir: 'bge-large-zh', dtype: 'q8', pooling: 'cls', queryPrefix: QUERY_PREFIX },
};
export function listModelPresets() {
    return Object.keys(MODEL_PRESETS).map((alias) => ({ alias, ...MODEL_PRESETS[alias] }));
}
/** 把 modelDir 三种写法（别名/绝对路径/留空）解析成统一 spec */
export function resolveModelSpec(opts = {}) {
    const raw = String(opts.modelDir ?? '').trim();
    const presetKey = String(opts.modelPreset ?? '').trim();
    const alias = (raw && MODEL_PRESETS[raw]) ? raw : ((presetKey && MODEL_PRESETS[presetKey]) ? presetKey : '');
    const p = alias ? MODEL_PRESETS[alias] : undefined;
    const dshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh');
    const dir = alias ? join(dshHome, 'models', p.dir) : (raw || defaultModelDir());
    return {
        alias: alias || 'custom',
        label: p ? p.label : '自定义目录',
        dir,
        dtype: String(opts.dtype ?? p?.dtype ?? 'q8'),
        pooling: String(opts.pooling ?? p?.pooling ?? 'cls'),
        queryPrefix: typeof opts.queryPrefix === 'string' ? opts.queryPrefix : (p?.queryPrefix ?? QUERY_PREFIX),
    };
}`,
  },
  {
    id: 'P1-2', file: F_EMBED,
    from: `export function checkModelAssets(modelDir) {
    const missing = [];
    let bytes = 0;
    for (const rel of ASSETS) {`,
    to: `export function checkModelAssets(modelDir, dtype = 'q8') {
    const missing = [];
    let bytes = 0;
    for (const rel of assetsFor(dtype)) {`,
  },
  {
    id: 'P1-3', file: F_EMBED,
    from: `    const modelDir = (opts.modelDir ?? '').trim() || defaultModelDir();
    const cached = embedders.get(modelDir);
    if (cached)
        return cached;`,
    to: `    // ★ P1: 先解析预设（别名/绝对路径/空），再决定磁盘目录与推理参数。
    //   缓存键必须含 dtype/pooling/queryPrefix —— 否则改精度仍复用旧实例，看着像"没生效"。
    const spec = resolveModelSpec(opts);
    const modelDir = spec.dir;
    const cacheKey = \`\${modelDir}|\${spec.dtype}|\${spec.pooling}|\${spec.queryPrefix}\`;
    const cached = embedders.get(cacheKey);
    if (cached)
        return cached;`,
  },
  {
    id: 'P1-4', file: F_EMBED,
    from: `                const assets = checkModelAssets(modelDir);`,
    to: `                const assets = checkModelAssets(modelDir, spec.dtype);`,
  },
  {
    id: 'P1-5', file: F_EMBED,
    from: `                extractor = (await mod.pipeline('feature-extraction', name, { dtype: 'q8' }));`,
    to: `                extractor = (await mod.pipeline('feature-extraction', name, { dtype: spec.dtype }));`,
  },
  {
    id: 'P1-7', file: F_EMBED,
    from: `            const input = texts.map((t) => (isQuery ? QUERY_PREFIX + t : t));`,
    to: `            // ★ P1: 前缀与池化随模型走
            const input = texts.map((t) => (isQuery && spec.queryPrefix ? spec.queryPrefix + t : t));`,
  },
  {
    id: 'P1-8', file: F_EMBED,
    from: `            const out = await extractor(input, { pooling: 'cls', normalize: true });`,
    to: `            const out = await extractor(input, { pooling: spec.pooling, normalize: true });`,
  },
  {
    id: 'P1-9', file: F_EMBED,
    from: `    const embedder = {
        modelDir,
        reset,`,
    to: `    const embedder = {
        modelDir,
        modelAlias: spec.alias,
        modelLabel: spec.label,
        dtype: spec.dtype,
        pooling: spec.pooling,
        queryPrefix: spec.queryPrefix,
        reset,`,
  },
  {
    id: 'P1-10', file: F_EMBED,
    from: `    embedders.set(modelDir, embedder);`,
    to: `    embedders.set(cacheKey, embedder);`,
  },

  // ══════════ P2 回合忙等超时 180s → 45s ══════════
  {
    id: 'P2-1', file: F_DEBOUNCE,
    from: `const BUSY_MAX_WAIT_MS = 3 * 60_000;`,
    to: `// ★ P2(2026-10-22): 原来写死 3 分钟。turnActive 只在 turn/end 复位（outbound.js:312），
//   回合异常结束时可能永不复位 ⇒ 该会话消息被堵到超时才放行（"她明明闲着却不回，
//   几分钟后一次性回一大堆"）。压到 45 秒；超时只是"再试一次"，真在跑的长回合会重新计时。
//   可用环境变量 QQBOT_BUSY_MAX_WAIT_MS 临时覆盖（毫秒）。
const BUSY_MAX_WAIT_MS = (() => {
    const raw = Number(process.env.QQBOT_BUSY_MAX_WAIT_MS);
    if (Number.isFinite(raw) && raw >= 5_000 && raw <= 600_000)
        return Math.floor(raw);
    return 45_000;
})();`,
  },
];

// ── 执行 ────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const REVERT = args.has('--revert');
const log = (...a) => console.log(...a);
const origOf = (f) => f + '.orig';

if (REVERT) {
  let n = 0;
  for (const f of new Set(PATCHES.map((p) => p.file))) {
    if (!existsSync(origOf(f))) { log(`跳过(无备份): ${f}`); continue; }
    copyFileSync(origOf(f), f); n += 1; log(`已还原: ${f}`);
  }
  log(`共还原 ${n} 个文件`);
  process.exit(0);
}

const byFile = new Map();
for (const p of PATCHES) {
  if (!byFile.has(p.file)) byFile.set(p.file, []);
  byFile.get(p.file).push(p);
}

let failed = false;
for (const [file, patches] of byFile) {
  log(`\n=== ${file}`);
  if (!existsSync(file)) { log('  ✗ 文件不存在'); failed = true; continue; }
  let src = readFileSync(file, 'utf8');
  const applied = [], skipped = [];

  for (const p of patches) {
    const hasNew = src.includes(p.to);
    const hasOld = src.includes(p.from);
    if (hasNew && !hasOld) { skipped.push(p); continue; }
    if (!hasOld) { log(`  ✗ ${p.id} 原文未匹配`); failed = true; continue; }
    if (CHECK_ONLY) { applied.push(p); continue; }
    src = src.replace(p.from, p.to);
    applied.push(p);
  }
  for (const p of applied) log(`  ✓ ${p.id}`);
  for (const p of skipped) log(`  = ${p.id} 已应用`);

  if (CHECK_ONLY || applied.length === 0) continue;

  if (!existsSync(origOf(file))) { copyFileSync(file, origOf(file)); log(`  备份: ${origOf(file)}`); }
  writeFileSync(file, src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    log('  语法 OK');
  } catch {
    copyFileSync(origOf(file), file);
    log('  ✗ 语法失败 → 已回滚');
    failed = true;
  }
}

log('');
if (CHECK_ONLY) { log(failed ? '结果: 有未匹配项' : '结果: 全部可打'); process.exit(failed ? 1 : 0); }
if (failed) { log('结果: 有失败项'); process.exit(1); }
log('全部完成。**需要重启宿主才生效**（QQ 里发 /bot-restart，或重启 DSH Desktop）。');
log('回滚: node apply-live.mjs --revert');
