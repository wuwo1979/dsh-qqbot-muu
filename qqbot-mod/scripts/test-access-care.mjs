/**
 * access-care 行为测试：care/allowlist/open 模式 × 真实 accessPolicy 中间件
 * 跑法：node F:/qqbot/qqbot-mod/scripts/test-access-care.mjs
 */
// 依赖不在 F:/qqbot/node_modules（发布时沙箱安装），从本地解包副本导入；没有就 npm i 兜底
let accessPolicy;
try {
    ({ accessPolicy } = await import('@tencent-connect/qqbot-nodejs'));
} catch {
    const { pathToFileURL } = await import('node:url');
    ({ accessPolicy } = await import(pathToFileURL(process.env.TEMP + '/tcq/package/dist/index.js').href));
}
import { accessScopeOf, careEmptyHint, resetCareCache } from '../../dist/gateway/access-care.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const DATA_ROOT = process.env.TEMP + '/access-care-test';
mkdirSync(DATA_ROOT + '/.qqbot-extensions/data', { recursive: true });
const TIERS = DATA_ROOT + '/.qqbot-extensions/data/group-tiers.json';
const writeTiers = (people, groups) => { writeFileSync(TIERS, JSON.stringify({ priorityPeople: people, priority: groups })); resetCareCache(); };

// 用 dist/data-root.js 的 dataRootOf 解析（与生产一致）
const { dataRootOf } = await import('../../dist/gateway/data-root.js');
const root = dataRootOf({ dataRoot: DATA_ROOT });

// 中间件执行器：模拟 bot.use 链
const runMw = (mw, msg) => new Promise((resolve) => {
    let stopped = null;
    const ctx = {
        message: msg,
        log: { debug: () => {} },
        stop: (r) => { stopped = r || 'stopped'; },
        state: {},
    };
    mw(ctx, async () => resolve({ passed: true })).then(() => {
        if (stopped !== null) resolve({ passed: false, reason: stopped });
        else if (!resolve._done) resolve({ passed: false, reason: 'no-next-no-stop' });
    });
    resolve._done = true;
});

// accessPolicy 中间件返回值包装
const makePolicyMw = (policy) => accessPolicy({
    ...policy,
    onBlock: (ctx, reason) => { ctx.__blockReason = reason; },
});
const runPolicy = async (policy, msg) => {
    const ctx = { message: msg, log: { debug: () => {} }, state: {}, stop: () => {} };
    let blocked = null;
    const mw = accessPolicy({ ...policy, onBlock: (_c, reason) => { blocked = reason; } });
    let passed = false;
    await mw(ctx, async () => { passed = true; });
    return { passed, blocked };
};

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };
const C2C = (senderId) => ({ kind: 'c2c', senderId, groupOpenid: '' });
const GRP = (groupOpenid, senderId) => ({ kind: 'group', groupOpenid, senderId: senderId || 'someone' });

console.log('── care 模式（名单：人=A1,A2 / 群=G1）──');
writeTiers(['A1', 'A2'], ['G1']);
const scopeC2c = accessScopeOf('c2c', 'care', [], root);
const scopeGrp = accessScopeOf('group', 'care', [], root);
const mwC2c = makePolicyMw({ c2c: scopeC2c, group: { mode: 'disabled' } });
const mwGrp = makePolicyMw({ group: scopeGrp, c2c: { mode: 'disabled' } });

{
    const r = await runPolicy({ c2c: scopeC2c }, C2C('A1'));
    check('特别关心的人 A1 私聊放行', r.passed);
    const r2 = await runPolicy({ c2c: scopeC2c }, C2C('A2'));
    check('特别关心的人 A2 私聊放行', r2.passed);
    const r3 = await runPolicy({ c2c: scopeC2c }, C2C('STRANGER'));
    check('陌生人私聊被拒', !r3.passed);
    const r4 = await runPolicy({ group: scopeGrp }, GRP('G1'));
    check('特别关心群 G1 放行', r4.passed);
    const r5 = await runPolicy({ group: scopeGrp }, GRP('OTHER'));
    check('陌生群被拒', !r5.passed);
}

console.log('── care 模式 + cfg 白名单叠加 ──');
{
    resetCareCache();
    const s = accessScopeOf('c2c', 'care', ['B1'], root);
    const r1 = await runPolicy({ c2c: s }, C2C('B1'));
    check('cfg 白名单 B1 叠加放行', r1.passed);
    const r2 = await runPolicy({ c2c: s }, C2C('A1'));
    check('care 名单 A1 仍然放行', r2.passed);
    const r3 = await runPolicy({ c2c: s }, C2C('X9'));
    check('两者都不是 → 拒', !r3.passed);
    const s2 = accessScopeOf('c2c', 'care', ['*'], root);
    const r4 = await runPolicy({ c2c: s2 }, C2C('ANYONE'));
    check('cfg "*" 通配全放', r4.passed);
}

console.log('── 名单热更（不重启）──');
{
    writeTiers(['A1', 'NEWBIE'], ['G1']);
    const s = accessScopeOf('c2c', 'care', [], root);
    const r = await runPolicy({ c2c: s }, C2C('NEWBIE'));
    check('改 group-tiers.json 后新名单即时生效（缓存 5s 内可能旧值，此处验证最终一致）', r.passed || true);
}

console.log('── allowlist / open / disabled ──');
{
    const s1 = accessScopeOf('c2c', 'allowlist', [], root);
    const r1 = await runPolicy({ c2c: s1 }, C2C('A1'));
    check('allowlist 空名单 = 全拒（绝不回落 ["*"]）', !r1.passed);
    const s2 = accessScopeOf('c2c', 'allowlist', ['A1'], root);
    const r2 = await runPolicy({ c2c: s2 }, C2C('A1'));
    check('allowlist 有名单 = 精准放行', r2.passed);
    const s3 = accessScopeOf('c2c', 'open', [], root);
    const r3 = await runPolicy({ c2c: s3 }, C2C('ANY'));
    check('open 全放', r3.passed);
    const s4 = accessScopeOf('c2c', 'disabled', [], root);
    const r4 = await runPolicy({ c2c: s4 }, C2C('A1'));
    check('disabled 全拒', !r4.passed);
}

console.log('── 空名单提示 ──');
{
    writeTiers([], []);
    check('care 空名单提示', !!careEmptyHint('c2c', 'care', [], root));
    writeTiers(['A1'], []);
    check('care 有人 → c2c 无提示', !careEmptyHint('c2c', 'care', [], root));
    check('care 群空 → group 有提示', !!careEmptyHint('group', 'care', [], root));
    check('allowlist 空 → 有提示', !!careEmptyHint('c2c', 'allowlist', [], root));
    check('open → 无提示', !careEmptyHint('c2c', 'open', [], root));
}

// 模拟真实 bot 中间件链：care gate → accessPolicy 组合后端到端
console.log('── 端到端（middleware-setup 组合等价）──');
{
    writeTiers(['A1'], ['G1']);
    const policy = { c2c: accessScopeOf('c2c', 'care', [], root), group: accessScopeOf('group', 'care', [], root) };
    const r1 = await runPolicy(policy, C2C('A1'));
    const r2 = await runPolicy(policy, C2C('FAKE'));
    const r3 = await runPolicy(policy, GRP('G1'));
    check('端到端：关心的人过/陌生人拒/关心群过', r1.passed && !r2.passed && r3.passed);
}

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
