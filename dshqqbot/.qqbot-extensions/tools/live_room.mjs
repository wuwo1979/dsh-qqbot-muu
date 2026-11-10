/**
 * tools/live_room.mjs — 直播助手工具（B 站；抖音占位）
 *
 * 读状态、启停长连、设置房间、手动发一条弹幕；回复策略由模块内部执行。
 */
import { loadConfig } from '../live/config.mjs';
import { getController, startLive, stopLive, liveStatus, panel, isOwner } from '../live/index.mjs';

export const name = 'live_room';

export const description =
  '直播助手（B站）：连接直播间长连，读取弹幕/礼物/进场/关注事件，按策略用主播口吻回复；默认只出草稿不发送。抖音仅保留占位。写操作仅主人可用。';

export const inputSchema = {
  action: {
    type: 'string',
    required: true,
    enum: ['status', 'start', 'stop', 'restart', 'say', 'recent', 'set-room', 'set-reply', 'douyin', 'config'],
    description: 'status=状态；start/stop/restart=连接控制；say=手动发一条弹幕；recent=最近事件；set-room=保存房间号；set-reply=开关/草稿/关键词；douyin=占位信息；config=查看安全配置',
  },
  roomId: { type: 'string', description: 'B 站直播间号（支持短号/长号）' },
  text: { type: 'string', description: 'say：要发送的弹幕内容（≤30 字）' },
  dryRun: { type: 'boolean', description: 'set-reply：true=只出草稿不发（默认），false=真的发弹幕' },
  enabled: { type: 'boolean', description: 'set-reply：回复总开关' },
  alwaysConnect: { type: 'boolean', description: 'set-reply：未开播也保持长连' },
  keywords: { type: 'string', description: 'set-reply：优先回复关键词，逗号分隔' },
  mentionNames: { type: 'string', description: 'set-reply：叫到这些名字时优先回复，逗号分隔' },
  chatSampleRate: { type: 'number', description: 'set-reply：普通弹幕抽样回复概率 0~1' },
  limit: { type: 'number', description: 'recent：返回条数，默认 20' },
};

const OWNER_ACTIONS = new Set(['start', 'stop', 'restart', 'say', 'set-room', 'set-reply']);

function dataRootOf(env = {}) {
  return String(env?.caps?.dataRoot || env?.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
}

function splitList(s) {
  return String(s || '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 30);
}

export async function run(args = {}, env = {}) {
  const dataRoot = dataRootOf(env);
  if (!dataRoot) return { ok: false, error: '拿不到 dataRoot' };
  const cfg = loadConfig(dataRoot);
  const action = String(args.action || 'status');

  if (OWNER_ACTIONS.has(action) && !isOwner(env, cfg)) {
    return { ok: false, error: '只有主人能操作直播连接' };
  }

  if (action === 'status') {
    const s = liveStatus(dataRoot, { logger: env.logger });
    return {
      ok: true,
      msg: `直播${s.running ? '运行中' : '未运行'} · ${s.connection?.state || 'idle'} · 房间 ${s.room?.id || '未解析'} · 草稿模式 ${s.dryRun ? '开' : '关'}`,
      status: s,
    };
  }
  if (action === 'start') {
    const r = await startLive(dataRoot, { logger: env.logger });
    return { ok: r.ok !== false, msg: r.ok === false ? '启动失败：' + r.error : '已启动直播连接', status: r.status };
  }
  if (action === 'stop') {
    const r = await stopLive(dataRoot, { logger: env.logger });
    return { ok: true, msg: '已停止直播连接', status: getController(dataRoot, {}).status(), result: r };
  }
  if (action === 'restart') {
    const c = getController(dataRoot, { logger: env.logger });
    const r = await c.restart();
    return { ok: r.ok !== false, msg: '已重连', status: r.status };
  }
  if (action === 'recent') {
    return panel(dataRoot, { action: 'recent', limit: args.limit }, { logger: env.logger });
  }
  if (action === 'say') {
    const r = await panel(dataRoot, { action: 'say', text: args.text }, { logger: env.logger });
    return { ok: Boolean(r.ok), msg: r.ok ? '已发送' : '发送失败：' + r.error, result: r };
  }
  if (action === 'set-room') {
    const r = await panel(dataRoot, { action: 'set-room', roomId: args.roomId }, { logger: env.logger });
    return { ok: Boolean(r.ok), msg: r.msg || r.error, status: r.status };
  }
  if (action === 'set-reply') {
    const patch = { action: 'set-reply' };
    if (typeof args.dryRun === 'boolean') patch.dryRun = args.dryRun;
    if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
    if (typeof args.alwaysConnect === 'boolean') patch.alwaysConnect = args.alwaysConnect;
    if (args.chatSampleRate !== undefined) patch.chatSampleRate = args.chatSampleRate;
    if (args.keywords !== undefined) patch.keywords = splitList(args.keywords);
    if (args.mentionNames !== undefined) patch.mentionNames = splitList(args.mentionNames);
    const r = await panel(dataRoot, patch, { logger: env.logger });
    return { ok: Boolean(r.ok), msg: r.msg || r.error, status: r.status };
  }
  if (action === 'douyin') {
    return panel(dataRoot, { action: 'douyin' }, { logger: env.logger });
  }
  if (action === 'config') {
    return panel(dataRoot, { action: 'config' }, { logger: env.logger });
  }
  return { ok: false, error: '未知 action：' + action };
}
