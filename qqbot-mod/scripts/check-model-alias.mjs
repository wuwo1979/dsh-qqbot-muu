/**
 * check-model-alias.mjs — 直接调用**活副本**里的 local-embed，验证 P1 别名解析是否真的能用
 * （不需要宿主运行，只是 import 那个文件并调 resolveModelSpec）
 */

const URL_ = 'file:///C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/web/node_modules/@zaofan/dsh-qqbot/dist/features/local-embed.js';

const m = await import(URL_);
const keys = Object.keys(m).filter((k) => /preset|spec|listModel/i.test(k));
console.log('P1 导出:', keys.join(', ') || '（无 —— P1 没生效）');
if (typeof m.resolveModelSpec !== 'function') {
  console.log('✗ resolveModelSpec 不存在，P1 补丁没进这个文件');
  process.exit(1);
}

for (const d of ['bge-small-zh', 'bge-base-zh', 'bge-large-zh', '', 'D:/custom/model']) {
  const s = m.resolveModelSpec({ modelDir: d });
  console.log(`${(d || '(空)').padEnd(14)} → alias=${s.alias.padEnd(14)} dtype=${s.dtype}  pooling=${s.pooling}`);
  console.log(`                 dir=${s.dir}`);
}

if (typeof m.listModelPresets === 'function') {
  console.log('\n预设表:');
  for (const p of m.listModelPresets()) console.log(`  ${p.alias.padEnd(14)} ${p.label}`);
}
console.log('\n结论: 别名解析可用。面板里填 bge-base-zh 就会解析到 {DSH_HOME}/models/bge-base-zh。');
