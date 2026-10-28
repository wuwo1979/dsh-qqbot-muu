/**
 * probe-live.mjs — 只读探针：检查我的补丁片段在**正在跑的那套** 1.10.22 里还匹不匹配
 *
 * 不写任何文件。只是回答一个问题：这些补丁搬过来能不能直接打上。
 */

import { readFileSync, existsSync } from 'node:fs';
import { PLUGIN } from './plugin-dir.mjs';

if (!existsSync(PLUGIN)) { console.log('✗ 找不到插件目录'); process.exit(1); }
console.log('目标: ' + PLUGIN);
if (PLUGIN.includes('.dsh')) console.log('⚠️ 这是死副本，不是桌面端在跑的');

const read = (rel) => {
  const p = PLUGIN.replace(/\/+$/, '') + '/' + rel;
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

const SESSION = read('dist/session/session-manager.js');
const INBOUND = read('dist/transport/inbound.js');
const EMBED = read('dist/features/local-embed.js');
const DEBOUNCE = read('dist/gateway/debounce.js');

const CASES = [
  ['P0-1a', SESSION, `                    return mm?.source?.kind === 'qqbot:group-rules' && mm.source.ns === ns
                        && String(mm.content?.[0]?.text ?? '').includes(CTX_SMART_REMINDER);`],
  ['P0-1b', SESSION, `                            && String(ev.data.content?.[0]?.text ?? '').includes(CTX_SMART_REMINDER)) {`],
  ['P0-1c', SESSION, `                const inBatch = dec.messages.some((m) => {`],
  ['P0-2', INBOUND, `    const userContent = resolveMentionNames(userContentRaw, stickerDir, scope === 'group' ? msg.groupOpenid : undefined);
    if (!userContent && (!msg.attachments || msg.attachments.length === 0))
        return null;`],
  ['P0-3a', INBOUND, `        MK.HISTORY_BEGIN,
        ...historyLines,`],
  ['P0-3b', INBOUND, `    const historyLines = history.map(h => {`],
  ['P0-3c', INBOUND, `        return mentioned && h.senderId ? \`[\${name} (\${h.senderId})] \${c}\` : \`[\${name}] \${c}\`;`],
  ['P1-1', EMBED, `const ASSETS = ['onnx/model_quantized.onnx', 'tokenizer.json', 'config.json'];`],
  ['P1-2', EMBED, `export function checkModelAssets(modelDir) {`],
  ['P1-3', EMBED, `    const modelDir = (opts.modelDir ?? '').trim() || defaultModelDir();`],
  ['P1-5', EMBED, `                extractor = (await mod.pipeline('feature-extraction', name, { dtype: 'q8' }));`],
  ['P1-7', EMBED, `            const input = texts.map((t) => (isQuery ? QUERY_PREFIX + t : t));`],
  ['P2-1', DEBOUNCE, `const BUSY_MAX_WAIT_MS = 3 * 60_000;`],
];

const MARK = {
  'P0-1a': 'includes(rulesFp)',
  'P0-1b': 'includes(rulesFp)) {',
  'P0-1c': 'const rulesFp = (rules.trim()',
  'P0-2': '（只 @ 了你一下，没有文字）',
  'P0-3a': '条**独立**消息，逐条编号',
  'P0-3b': 'const historyLines = history.map((h, _hi) => {',
  'P0-3c': '${_hi + 1}. [${name}',
  'P1-1': 'export const MODEL_PRESETS',
  'P1-2': 'export function checkModelAssets(modelDir, dtype = ',
  'P1-3': 'const cacheKey = `${modelDir}|${spec.dtype}',
  'P1-5': "{ dtype: spec.dtype }",
  'P1-7': 'pooling: spec.pooling',
  'P2-1': 'QQBOT_BUSY_MAX_WAIT_MS',
};

let ready = 0, done = 0, miss = 0;
for (const [id, src, frag] of CASES) {
  if (src === null) { console.log(`❌ ${id}  文件缺失`); miss += 1; continue; }
  const applied = src.includes(MARK[id]);
  const matched = src.includes(frag);
  if (applied) { console.log(`= ${id}  已应用`); done += 1; }
  else if (matched) { console.log(`✓ ${id}  可打`); ready += 1; }
  else { console.log(`✗ ${id}  原文未匹配（1.10.22 改过这段？）`); miss += 1; }
}

console.log('');
console.log(`可打 ${ready} / 已应用 ${done} / 未匹配 ${miss}（共 ${CASES.length}）`);
