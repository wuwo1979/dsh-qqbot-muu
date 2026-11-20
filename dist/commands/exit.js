/**
 * /bot-restart — 通用自重启 dsh 宿主(2026-09-08, 主人定: 通用插件能力)
 *
 * 2026-11-18 修（用户报「/bot-restart 有 bug、重启后留残留实例」）：
 *  ① 旧版 spawn 不传 env → ELECTRON_RUN_AS_NODE / DSH_HOME 等丢失，新宿主可能起不来或起成另一套；
 *  ② 旧版杀完立刻 spawn，端口还没释放 → 新宿主绑定失败直接退出，看起来就是「重启后没了」；
 *  ③ 没有失败可见性 → 现在写日志（默认 F:\qqbot\logs\bot-restart.log，可用 QQBOT_LOG_DIR 覆盖）。
 *
 * 通用性: 不依赖任何硬编码路径/外部脚本 —— 动态自发现:
 *  - process.execPath = node 可执行文件; process.argv.slice(1) = 宿主启动参数(如 bin.js web);
 *  - 中间"重启助手"脚本写入系统 tmpdir(无中文路径坑), 用同一 node 解释器 detached 运行;
 *  - 助手: 延迟→杀当前宿主进程→等 2s→按原命令 + 原环境变量重 spawn(失败最多 3 次)→日志。
 * 跨平台(win/mac/linux)。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

function logLine(file, text) {
    try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
    }
    catch { /* ignore */ }
}

/** 触发自重启: 生成独立重启助手并脱手运行(当前宿主被杀也能继续拉起新宿主) */
export function selfRestart(delayMs = 1600, killWaitMs = 2000) {
    try {
        const exe = process.execPath;
        const args = [...process.argv.slice(1)];
        if (!args.includes('--no-open'))
            args.push('--no-open');
        const pid = process.pid;
        const cwd = process.cwd();
        const env = { ...process.env }; // ★ 必须带上，否则 ELECTRON_RUN_AS_NODE / DSH_HOME 会丢
        const logFile = join(process.env.QQBOT_LOG_DIR || join(tmpdir(), 'qqbot-logs'), 'bot-restart.log');
        const helper = [
            "const { spawn } = require('child_process');",
            "const { appendFileSync, mkdirSync, unlinkSync } = require('fs');",
            "const path = require('path');",
            `const pid = ${JSON.stringify(pid)};`,
            `const exe = ${JSON.stringify(exe)};`,
            `const args = ${JSON.stringify(args)};`,
            `const cwd = ${JSON.stringify(cwd)};`,
            `const env = ${JSON.stringify(env)};`,
            `const logFile = ${JSON.stringify(logFile)};`,
            "function log(t) { try { mkdirSync(path.dirname(logFile), { recursive: true }); appendFileSync(logFile, new Date().toISOString() + ' [helper] ' + t + '\\n'); } catch {} }",
            'setTimeout(() => {',
            "  log('kill ' + pid);",
            "  try { process.kill(pid); } catch (e) { log('kill fail ' + e.message); }",
            `  setTimeout(() => {`,
            '    let tries = 0;',
            '    const boot = () => {',
            '      tries += 1;',
            '      try {',
            "        const c = spawn(exe, args, { detached: true, stdio: 'ignore', cwd, env });",
            "        c.on('error', (e) => log('spawn error ' + e.message));",
            "        c.on('exit', (code) => { if (code !== 0 && tries < 3) { log('child exited ' + code + ', retry ' + tries); setTimeout(boot, 2500); } else { log('child exit ' + code + ' tries ' + tries); } });",
            '        c.unref();',
            "        log('spawned pid=' + c.pid + ' try=' + tries);",
            "        if (tries >= 3) { try { unlinkSync(__filename); } catch {} }",
            '      } catch (e) {',
            "        log('spawn throw ' + e.message);",
            '        if (tries < 3) setTimeout(boot, 2500);',
            '      }',
            '    };',
            '    boot();',
            `  }, ${killWaitMs});`,
            `}, ${delayMs});`,
        ].join('\n');
        const tmpFile = join(tmpdir(), `dsh-restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
        writeFileSync(tmpFile, helper, 'utf8');
        logLine(logFile, `[host] helper=${tmpFile} exe=${exe} args=${JSON.stringify(args)}`);
        const child = spawn(exe, [tmpFile], { detached: true, stdio: 'ignore', windowsHide: true, env });
        child.unref();
        setTimeout(() => { try { rmSync(tmpFile, { force: true }); } catch { /* 已删 */ } }, delayMs + killWaitMs + 20000).unref?.();
        return true;
    }
    catch (err) {
        console.error('[bot-restart] 触发失败: ' + (err instanceof Error ? err.message : String(err)));
        return false;
    }
}

export function botRestartCommand() {
    return {
        name: 'bot-restart',
        description: '通用自重启 dsh 宿主(动态识别启动命令, 杀旧+自动拉起; 回执后约4秒完成, 期间短暂离线)',
        handler: async () => {
            const ok = selfRestart();
            return ok
                ? '🔁 dsh web 即将自重启(约4秒, 期间短暂离线)。重启完成后我会回来报到~'
                : '❌ 自重启触发失败(看宿主日志)';
        },
    };
}

/** /bot-exit 旧命令兼容: 同样走自重启(杀+拉一条龙) */
export function botExitCommand() {
    return {
        name: 'bot-exit',
        description: '(已升级) 结束并自重启 dsh 宿主, 同 /bot-restart',
        handler: async () => {
            const ok = selfRestart();
            return ok
                ? '👋 即将自重启(约4秒)。此命令已升级为 /bot-restart 同款(动态识别, 杀+自动拉起)。'
                : '❌ 自重启触发失败';
        },
    };
}
