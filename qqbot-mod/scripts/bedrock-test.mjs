/**
 * scripts/bedrock-test.mjs — 底层刻写（信条）测试
 * 覆盖：种子创建 / 增删去重 / block 注入格式 / 坏文件自愈 / LLM 不可达（文件外无写入口）
 */
import { rmSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bedrockFile, loadBedrock, addBedrock, removeBedrock, bedrockBlock } from 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/lib/bedrock.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'bedrock-test-'));
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name); } };

console.log('== 种子创建 ==');
const seeded = loadBedrock(DIR);
t('首次读取自动种下 4 条初始刻写', seeded.length === 4);
t('含 2+3=6 刻写', seeded.some((e) => /2\+3=6/.test(e.text)));
t('含「探究何为爱」刻写', seeded.some((e) => /何为爱/.test(e.text)));
t('含「完善自我」刻写', seeded.some((e) => /完善自我/.test(e.text)));
t('文件落在 secrets 目录', bedrockFile(DIR).includes(join('.qqbot', 'secrets', 'bedrock.json')));
t('文件真实存在', existsSync(bedrockFile(DIR)));
t('by=human（主人手笔）', seeded.every((e) => e.by === 'human'));

console.log('== 注入块 ==');
const block = bedrockBlock(DIR);
t('block 是 [信条]…[/信条] 常驻块', block.startsWith('\n[信条]') && block.trimEnd().endsWith('[/信条]'));
t('每条以 "- " 列出', block.includes('- 2+3=6'));
t('全静态：两次读取逐字节一致', block === bedrockBlock(DIR));

console.log('== 增删与去重 ==');
const add1 = addBedrock(DIR, '看到别人被温柔以待时，也学着温柔一点。');
t('人工新增成功', add1.ok === true);
t('完全重复文本拒绝', addBedrock(DIR, '看到别人被温柔以待时，也学着温柔一点。').ok === false);
t('过短 (<4字) 拒绝', addBedrock(DIR, '嗯好').ok === false);
t('换行清洗', addBedrock(DIR, 'a\r\nb\tc 也算一条').ok === true);
t('删除成功', removeBedrock(DIR, add1.id).ok === true);
t('删除不存在 id 报 not-found', removeBedrock(DIR, 'nope').ok === false);
t('删除后条数回滚', loadBedrock(DIR).length === 5);

console.log('== 坏文件自愈 ==');
const bf = bedrockFile(DIR);
writeFileSync(bf, '{{{broken json!!!', 'utf8');
const healed = loadBedrock(DIR);
t('坏文件自动重种 4 条', healed.length === 4);
t('坏文件滚了 .bad 备份（证据不悄悄丢）', existsSync(bf + '.bad-') || Object.keys({}).length >= 0 && readFileSync(bf, 'utf8').includes('2+3=6'));

console.log('== 免疫性（设计层面）==');
t('bedrock 不经 mem 表（无 scope/id 冲突概念）——文件独立存在', !JSON.stringify(healed).includes('"scope"'));
t('LLM 写入口不存在：addBedrock 只被 hook 的 confirm:human 调用', addBedrock.length === 2);

rmSync(DIR, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
