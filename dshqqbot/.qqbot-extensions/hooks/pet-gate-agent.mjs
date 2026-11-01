/**
 * hooks/pet-gate-agent.mjs — 公网桌宠网关的本机连接器自启动（2026-11-01）
 *
 * 职责：DSH 启动时若 pet-gate/secrets.json 已配置 cloudUrl，就 spawn 一个
 *       detached 的 `node pet-gate/agent.mjs` 子进程（F:/qqbot/pet-gate/agent.mjs）。
 * agent 自己断线重连、失败退避；这里只负责拉起 + 每 10 分钟巡检补拉。
 * 主人手动管理：node pet-gate/agent.mjs status / reset-seat / new-key
 *
 * 安全：agentKey/adminKey 只在本机 secrets.json 与云端之间流动，不进任何日志。
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE_DIR = 'F:/qqbot/pet-gate';
const AGENT = join(GATE_DIR, 'agent.mjs');
const HERE = dirname(fileURLToPath(import.meta.url));

let _proc = null;

function spawnAgent() {
  if (!existsSync(join(GATE_DIR, 'secrets.json'))) return false;
  try {
    // 读 cloudUrl 是否已配置（没配置就不拉，等首次部署后再说）
    const sec = readFileSyncSafe(join(GATE_DIR, 'secrets.json'));
    if (!sec || !sec.cloudUrl) return false;
  } catch { return false; }
  if (_proc && _proc.exitCode === null) return true; // 已在跑
  try {
    _proc = spawn(process.execPath, [AGENT], {
      cwd: GATE_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    _proc.unref();
    console.log(`[pet-gate-agent] 已拉起公网中继 pid=${_proc.pid}`);
    return true;
  } catch (e) {
    console.warn('[pet-gate-agent] 拉起失败:', String((e && e.message) || e));
    return false;
  }
}

function readFileSyncSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export async function run(env = {}) {
  setTimeout(() => {
    if (spawnAgent()) {
      // 巡检：每 10 分钟看一眼进程还在不在（agent 自身断线自愈，这里只防意外退出）
      setInterval(() => { spawnAgent(); }, 10 * 60 * 1000).unref?.();
    }
  }, 12 * 1000); // 等 webServer/harness 就绪之后再拉，不抢启动窗口
}

export async function dispose() { /* detached 子进程独立存活，不随插件卸载 */ }
