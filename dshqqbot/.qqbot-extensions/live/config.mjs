/**
 * live/config.mjs — 直播模块配置与密钥定位
 *
 * 约定：
 *   · 非敏感配置：<dataRoot>/.qqbot-extensions/live-config.json
 *   · 敏感密钥：<项目根>/secrets/live/（本模块只读，不写）
 *   · 状态与日志：<项目根>/data/live/（可用 config.storage.root 覆盖）
 *
 * 本文件不打印任何密钥内容，只返回「是否加载成功」。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = join(HERE, '..');

export const DEFAULT_CONFIG = {
  enabled: true,
  platform: 'bilibili',           // bilibili | douyin（douyin 仅占位）
  bilibili: {
    channel: 'web',               // web=社区长连（读事件+可发弹幕）；open=官方开放平台（需入驻/身份码）
    roomId: '',                   // 支持短号/长号；留空则尝试用登录账号的 UID 反查
    alwaysConnect: false,         // 未开播也保持长连（默认 false：开播才连，省资源）
    pollLiveMs: 60000,            // 未开播时的开播轮询间隔
    open: { appId: '', accessKeyId: '', identityCode: '' },
  },
  douyin: {
    enabled: false,
    roomId: '',
    note: '接口占位：抖音直播弹幕长连需要 x-bogus/设备签名与企业开发者白名单，当前不实现。',
  },
  reply: {
    enabled: true,
    dryRun: true,                 // 默认只出草稿不发，确认后再关
    personaName: '小蓝',
    mentionNames: ['小蓝', '小蓝蓝', '鲸鱼娘', '咕噜'],
    keywords: [],                 // 命中即优先回复（示例：['点歌', '歌名']）
    minGapMs: 8000,
    maxPerMinute: 4,
    maxPerHour: 30,
    maxPerDay: 120,
    perUserCooldownMs: 600000,    // 同一人 10 分钟内只回一次
    maxRepliesPerUserPerHour: 2,
    dedupWindowMs: 120000,
    chatSampleRate: 0.12,         // 普通弹幕抽样回复概率（0~1）
    questionSampleRate: 0.5,
    giftMinPrice: 5000,           // 单价 1000=1 元；默认 5 元以上的礼物才回复
    replyToFollow: true,
    replyToEnter: false,          // 进场不逐条回；按窗口聚合
    enterAggregate: { windowMs: 60000, minCount: 5, enabled: true },
    quietHours: [],               // 例：['02:00-07:00']
    quietAllowCritical: true,     // 静默时段仍回 SC / 大航海
    maxChars: 26,
    reserveRatio: 0.2,            // 预留 20% 配额给 SC/大航海，普通弹幕不占用
    llm: {
      maxCallsPerHour: 10,
      maxCallsPerDay: 40,
      maxOutputTokens: 60,
      maxInputChars: 260,
      maxTokensPerDay: 12000,     // 输入+输出粗估上限
      model: 'deepseek-chat',
      timeoutMs: 15000,
      temperature: 0.85,
    },
    skipWords: ['加微', '加v', '代练', '刷单', '网赚', '博彩', '彩票', '私聊', '接单'],
  },
  log: {
    persistEvents: true,
    maxBytes: 1048576,
    keepLines: 2000,
  },
  storage: { root: '' },          // 留空 = <项目根>/data/live
};

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function pathsOf(dataRoot) {
  const dr = String(dataRoot || '').trim() || join(EXT_DIR, '..');
  const configFile = join(dr, '.qqbot-extensions', 'live-config.json');
  let storage = '';
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8'));
    storage = String(raw?.storage?.root || '').trim();
  } catch { /* 配置不存在时用默认值 */ }
  if (!storage) storage = join(dirname(dr), 'data', 'live');
  return {
    dataRoot: dr,
    configFile,
    storage,
    stateFile: join(storage, 'state.json'),
    eventsFile: join(storage, 'events.jsonl'),
    draftsFile: join(storage, 'drafts.jsonl'),
  };
}

export function loadConfig(dataRoot) {
  const p = pathsOf(dataRoot);
  let raw = {};
  try { raw = JSON.parse(readFileSync(p.configFile, 'utf8')) || {}; } catch { raw = {}; }
  const cfg = deepMerge(DEFAULT_CONFIG, raw);
  if (cfg.platform === 'douyin' && !cfg.douyin) cfg.douyin = DEFAULT_CONFIG.douyin;
  return cfg;
}

export function saveConfig(dataRoot, patch = {}) {
  const p = pathsOf(dataRoot);
  let raw = {};
  try { raw = JSON.parse(readFileSync(p.configFile, 'utf8')) || {}; } catch { raw = {}; }
  const next = deepMerge(raw, patch);
  mkdirSync(dirname(p.configFile), { recursive: true });
  const tmp = p.configFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, p.configFile);
  return next;
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function secretDirCandidates(dataRoot) {
  const env = String(process.env.QQBOT_LIVE_SECRETS || '').trim();
  const out = [];
  if (env) out.push(env);
  const dr = String(dataRoot || '').trim() || join(EXT_DIR, '..');
  out.push(join(dr, 'secrets', 'live'));
  out.push(join(dr, '..', 'secrets', 'live'));
  out.push(join(dr, '..', '..', 'secrets', 'live'));
  out.push(join(EXT_DIR, '..', '..', 'secrets', 'live'));
  return out;
}

/**
 * 加载直播平台密钥。只从 secrets/live 目录或环境变量读取。
 * 返回 { bilibili: {...}, files: n }，绝不写入日志。
 */
export function loadSecrets(dataRoot) {
  const merged = {};
  let files = 0;
  for (const dir of secretDirCandidates(dataRoot)) {
    for (const name of ['live-secrets.json', 'bilibili.json']) {
      const f = join(dir, name);
      if (!existsSync(f)) continue;
      const j = readJsonSafe(f);
      if (!j || typeof j !== 'object') continue;
      files += 1;
      const b = j.bilibili || j.bili || j.live || j;
      merged.appId = merged.appId || b.appId || b.app_id || b.projectId || '';
      merged.accessKeyId = merged.accessKeyId || b.accessKeyId || b.access_key_id || b.accesskeyid || '';
      merged.accessKeySecret = merged.accessKeySecret || b.accessKeySecret || b.access_key_secret || b.accesskeysecret || '';
      merged.identityCode = merged.identityCode || b.identityCode || b.identity_code || b.code || '';
    }
  }
  merged.appId = merged.appId || process.env.BILI_LIVE_APP_ID || '';
  merged.accessKeyId = merged.accessKeyId || process.env.BILI_LIVE_ACCESS_KEY_ID || '';
  merged.accessKeySecret = merged.accessKeySecret || process.env.BILI_LIVE_ACCESS_KEY_SECRET || '';
  merged.identityCode = merged.identityCode || process.env.BILI_LIVE_IDENTITY_CODE || '';
  return { bilibili: merged, files, configured: Boolean(merged.accessKeyId && merged.accessKeySecret && merged.appId) };
}

export function loadBiliCookies(dataRoot) {
  try {
    const j = readJsonSafe(join(String(dataRoot || ''), 'bili-cookie.json'));
    return (j && j.cookies && j.cookies.SESSDATA) ? j.cookies : {};
  } catch { return {}; }
}
