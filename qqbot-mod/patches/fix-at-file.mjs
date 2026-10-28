#!/usr/bin/env node
/**
 * fix-at-file.mjs — 修 dsh-at-file 在旧宿主上一启动就崩的问题（本机应急修复）
 *
 * 症状链：
 *   1. dsh-at-file 的 registerAtFileSettings 直接调 ctx.settings.register(...)
 *   2. 本机宿主是老版（settings 服务没 register()，从插件 Config schema 推导）→ TypeError
 *   3. dsh-at-file 在 profile 里是 **required** 插件 → "startup failed: 1 required plugin did not activate"
 *   4. 桌面端回落 **安全模式**（屏蔽所有第三方插件）→ @zaofan/dsh-qqbot 连带用不了
 *
 * 修法：加兼容垫片 —— 宿主没有 register() 时退化成内存态配置（get/update/watch 齐全）。
 *       启动不再失败，@file 功能照常，只是那几项"可视化设置"不可编辑。
 *
 * 用法：node fix-at-file.mjs [--check|--revert]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const F = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/web/node_modules/dsh-at-file/lib/index.js';
const ORIG = F + '.orig';

const FROM = `function registerAtFileSettings(ctx) {
  return ctx.settings.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: "live" });
}`;

const TO = `function registerAtFileSettings(ctx) {
  // ⚠️ 本机兼容垫片（2026-10-22 修复）：
  //   老版宿主（dsh 0.1.7 系）的 settings 服务**没有 register()** —— 它从插件 Config schema 推导设置。
  //   原实现直接调用 ⇒ TypeError: ctx.settings.register is not a function。
  //   而 dsh-at-file 在 profile 里是 **required** 插件 ⇒ 整个 DSH 启动中止
  //   ("startup failed: 1 required plugin did not activate") ⇒ 桌面端回落到安全模式
  //   ⇒ 安全模式屏蔽所有第三方插件 ⇒ qqbot 连带用不了。
  //   这里退化成内存态配置：启动不再失败、@file 功能照常，只是那几项"可视化设置"不可编辑。
  var svc = ctx && ctx.settings;
  if (!svc || typeof svc.register !== "function") {
    var state = AtFileSettingsSchema({});
    return {
      get: function () { return state; },
      update: async function (patch) {
        state = AtFileSettingsSchema(Object.assign({}, state, patch));
        return state;
      },
      watch: function () { return function () {}; },
      dispose: function () {},
    };
  }
  return svc.register(AT_FILE_NAMESPACE, AtFileSettingsSchema, { applies: "live" });
}`;

const argv = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);

if (!existsSync(F)) { log(`✗ 文件不存在: ${F}`); process.exit(1); }

if (argv.has('--revert')) {
  if (!existsSync(ORIG)) { log('✗ 没有备份'); process.exit(1); }
  copyFileSync(ORIG, F);
  log(`已还原: ${F}`);
  process.exit(0);
}

let src = readFileSync(F, 'utf8');
if (src.includes(TO)) { log('= 已经修过了，跳过。'); process.exit(0); }
if (!src.includes(FROM)) { log('✗ 原文未匹配（版本可能不同），不敢乱改。'); process.exit(1); }

log('  ✓ 原文匹配');
if (argv.has('--check')) { log('\n(--check) 未写入。'); process.exit(0); }

if (!existsSync(ORIG)) { copyFileSync(F, ORIG); log(`备份: ${ORIG}`); }

src = src.replace(FROM, TO);
writeFileSync(F, src, 'utf8');

log('写入完成，语法自检…');
try {
  execFileSync(process.execPath, ['--check', F], { stdio: 'inherit' });
  log('语法 OK');
} catch {
  copyFileSync(ORIG, F);
  log('✗ 语法检查失败 → 已回滚');
  process.exit(1);
}

log(`
修好了。接下来必须**正常重启 DSH Desktop**（不是安全模式），
启动才会重新尝试加载 web profile，qqbot 也才会回来。
回滚: node fix-at-file.mjs --revert
`);
