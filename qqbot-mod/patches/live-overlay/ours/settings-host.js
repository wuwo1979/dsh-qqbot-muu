/**
 * qqbot-settings — host 半边: ①im-qqbot settings 命名空间经同源路由暴露给设置面板;
 * ②表情包图库管理 API(列表/缩略图/批量/导入), 与 dsh-qqbot 共享同进程 store 单例。
 * 仅 web profile 装配; 同源 fence 抄 modsearch。
 */
import { readFileSync, writeFileSync, appendFileSync, rmSync, mkdirSync, existsSync, readdirSync, statSync, cpSync, renameSync, openSync, readSync, closeSync, createWriteStream } from 'node:fs';
import { basename, extname, join, resolve, dirname, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { getStickerStore } from '@zaofan/dsh-qqbot/sticker-store';
import { getScheduleStore } from '@zaofan/dsh-qqbot/schedule-store';

export const name = 'qqbot-settings';
/**
 * 服务依赖(2026-09-10 排查修复): 只声明必备的 settings/webServer。
 * ⚠️ 曾声明 ['settings','webServer','agentPresets'] —— cordis 对 inject 声明的服务是
 *    「等齐才调用 apply」语义: 若宿主未提供 agentPresets, 桥的 apply 永远不被调用,
 *    所有 /api/qqbot-settings/* 路由都不会注册(实测表现为全部 404, 面板显示「无账号」)。
 *    agentPresets 现改为可选: apply 内使用时判空降级(缺失时该路由返回 500 提示)。
 */
export const inject = ['settings', 'webServer'];

const NS = 'im-qqbot';
/**
 * 定位宿主 profile 根(账号实例 patch 所在)。优先代码位置(实体安装: 包根上溯 3 级 = profile 根,
 * 上溯层级在单包合并时已按包根位置修正); 若该位置没有 cordis.patch.yml(link/symlink 安装时
 * 本文件被从源码目录加载), 则扫描 ~/.dsh/profiles/* 找装着 @zaofan/dsh-qqbot 的 profile。
 */
function resolveProfileRoot() {
  // 2026-10-20 修(GitHub issue #14): 生成式安装(dsh-market / DSH Desktop)下,
  //   "包根上溯 3 级"得到的是 profiles/.generations/live/<pkg>, 不是 profile 根;
  //   且 Desktop 的 DSH_HOME 在 %APPDATA%dsh-desktopharness, 原兜底写死 ~/.dsh 扫不到。
  //   → 显式环境变量 > 代码位置 > .generations 反推 > 多 home 扫描。
  for (const k of ['DSH_PROFILE_DIR', 'DSH_PROFILE_ROOT']) {
    const v = (process.env[k] ?? '').trim();
    if (v) { try { if (existsSync(join(v, 'cordis.patch.yml'))) return v; } catch { /* 下一个 */ } }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const byLocation = resolve(here, '..', '..', '..');
  try {
    if (existsSync(join(byLocation, 'cordis.patch.yml'))) return byLocation;
  } catch { /* 继续扫描 */ }
  const roots = [];
  try {
    let cur = here;
    for (let n = 0; n < 12; n++) {
      cur = dirname(cur);
      if (basename(cur) === '.generations') { roots.push(dirname(cur)); break; }
    }
  } catch { /* ignore */ }
  const homeEnv = (process.env.DSH_HOME ?? '').trim();
  if (homeEnv) roots.push(join(homeEnv, 'profiles'));
  roots.push(join(homedir(), '.dsh', 'profiles'));
  for (const base of roots) {
    try {
      for (const name of readdirSync(base)) {
        const prof = resolve(base, name);
        try {
          if (!statSync(prof).isDirectory()) continue;
        } catch { continue; }
        try {
          if (existsSync(join(prof, 'cordis.patch.yml'))) return prof;
        } catch { /* 走下一判据 */ }
        try {
          if (existsSync(join(prof, 'node_modules', '@zaofan', 'dsh-qqbot'))) return prof;
        } catch { /* 走下一判据 */ }
        try {
          const pkg = JSON.parse(readFileSync(join(prof, 'package.json'), 'utf8'));
          const blob = JSON.stringify(pkg.dsh?.profile?.bundles ?? []) + JSON.stringify(pkg.dependencies ?? {});
          if (blob.includes('@zaofan/dsh-qqbot')) return prof;
        } catch { /* 无 package.json, 跳过 */ }
      }
    } catch { /* 该 profiles 根不存在 */ }
  }
  return byLocation;
}
const PROFILE_ROOT = resolveProfileRoot();
/** cordis.patch.yml = 宿主插件装配文件(账号实例声明处; 改它需重启 dsh 生效) */
const PATCH_FILE = join(PROFILE_ROOT, 'cordis.patch.yml');

/** dsh 家目录(与宿主保持一致: 优先环境变量 DSH_HOME, 否则回落 ~/.dsh) */
const DSH_HOME_DIR = ((process.env.DSH_HOME ?? '').trim()) || join(homedir(), '.dsh');
/** agent 预设根目录 —— ⚠️ 仅 ≤0.1.6 的**旧机制**(每预设一个子目录, 目录名=预设 id)。
 *  dsh 0.1.7 起预设改为「profile 配置里的声明行」(@deepseek-ai/dsh-agent-preset),
 *  既没有目录、也没有写接口, 所以这里只作为旧版回落路径保留。 */
const PRESET_ROOT = join(DSH_HOME_DIR, '.agent-presets');
/** 复制预设时排除的备份/压缩类文件(不把主人的隐私压缩包带进新预设) */
const COPY_SKIP = /\.(rar|zip|7z|bak|tmp|log|diag)$/i;
/** 预设 id 校验: 文件夹命名规范(字母数字开头, 允许 - _) */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 同源回环 fence: 仅本机 loopback + 同源/无 Origin 放行 */
function isTrusted(req) {
  const h = req.headers?.host;
  if (typeof h !== 'string') return false;
  let hostname;
  try { hostname = new URL(`http://${h}`).hostname; } catch { return false; }
  const loopback = /^(\[::1\]|localhost|127(\.\d{1,3}){3})$/.test(hostname);
  if (!loopback) return false;
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const o = req.headers?.origin;
  if (o === undefined) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 8 * 1024 * 1024) return undefined;
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
}

/** 读命名空间当前解析值 + revision(redact 防密钥外泄) */
/**
 * 兜底：从 profile 的 cordis.patch.yml 里读某个 entry 的 config（2026-09-23 适配 dsh 0.1.7）。
 *
 * 背景：0.1.7 把设置机制换成了「从 profile 里插件条目的 config schema 推导」，
 * 注册入口 `installSection` 已移除 → 插件静默降级后 `describe()` 里不再有本实例的 ns，
 * 于是 /read 返回 {value:undefined,revision:undefined}（JSON 序列化后正好是 {}），
 * 前端就显示"读取失败: {}"。
 *
 * 这里只做「块级 + 简单标量」提取（不整文件 YAML 解析，因为含 !!js 标签）：
 * 找 `- id: <entryId>` 块的 `config:` 子树，逐行取标量，跳过 !!js 与嵌套子块；
 * secret 类字段按宿主 describe(redactSecrets) 的口径打码。
 */
function readEntryConfigFromPatch(entryId) {
  try {
    if (!existsSync(PATCH_FILE)) return null;
    const lines = readFileSync(PATCH_FILE, 'utf8').split(/\r\n|\n/);
    const esc = String(entryId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headRe = new RegExp('^\\s*-\\s*id:\\s*[\'"]?' + esc + '[\'"]?\\s*$');
    const start = lines.findIndex((l) => headRe.test(l));
    if (start < 0) return null;
    const headIndent = (lines[start].match(/^\s*/) || [''])[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const ind = (lines[i].match(/^\s*/) || [''])[0].length;
      if (/- /.test(lines[i]) && ind <= headIndent) { end = i; break; }
    }
    const block = lines.slice(start + 1, end);
    const ci = block.findIndex((l) => /^\s*config:\s*$/.test(l));
    if (ci < 0) return null;
    const cfgIndent = (block[ci].match(/^\s*/) || [''])[0].length;
    const out = {};
    const parseScalar = (v) => {
      const s = String(v).trim().replace(/^['"]|['"]$/g, '');
      if (s === 'true') return true;
      if (s === 'false') return false;
      if (s === 'null' || s === '~') return null;
      if (/^-?\d+$/.test(s)) return Number(s);
      return s;
    };
    // 递归解析（2026-09-24：之前只取一层，groupAdmin 这类嵌套对象的子字段全被跳过 →
    // 前端读回来是 undefined，勾选后"保存了却跳回去"）
    const parseBlock = (from, to, indent) => {
      const obj = {};
      for (let i = from; i < to; i++) {
        const raw = block[i];
        if (!raw.trim() || /^\s*#/.test(raw)) continue;
        if (((raw.match(/^\s*/) || [''])[0]).length !== indent) continue;
        const m = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
        if (!m) continue;
        const key = m[1];
        const rest = m[2].trim();
        let subEnd = i + 1;
        while (subEnd < to) {
          const l = block[subEnd];
          if (l.trim() && ((l.match(/^\s*/) || [''])[0]).length <= indent) break;
          subEnd++;
        }
        if (rest === '') {
          const inner = block.slice(i + 1, subEnd);
          if (inner.some((l) => /^\s*-\s/.test(l))) {
            const arr = [];
            for (const l of inner) {
              const am = /^\s*-\s*(.*)$/.exec(l);
              if (am && am[1].trim()) arr.push(parseScalar(am[1]));
            }
            obj[key] = arr;
          } else {
            obj[key] = parseBlock(i + 1, subEnd, indent + 2);
          }
        } else if (rest === '[]') {
          obj[key] = [];
        } else if (rest.startsWith('!!js')) {
          obj[key] = rest;                                  // 表达式：原样返回（前端只读展示）
        } else {
          obj[key] = parseScalar(rest);
        }
        i = subEnd - 1;
      }
      return obj;
    };
    const parsed = parseBlock(ci + 1, block.length, cfgIndent + 2);
    const redact = (o) => {
      if (!o || typeof o !== 'object') return o;
      for (const k of Object.keys(o)) {
        if (/secret|token|password|_key$/i.test(k)) o[k] = '__REDACTED__';
        else if (o[k] && typeof o[k] === 'object') redact(o[k]);
      }
      return o;
    };
    redact(parsed);
    for (const [k, v] of Object.entries(parsed)) out[k] = v;
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}
/** 读一个实例的配置视图；宿主 describe 拿不到时回落到 profile patch。 */
function viewOf(settings, ns) {
  const target = ns || NS;
  let list = [];
  try { list = settings.describe({ redactSecrets: true }) || []; } catch { list = []; }
  const d = list.find((x) => x.ns === target);
  if (d) return { value: d.value, revision: d.revision };
  const fb = readEntryConfigFromPatch(target);
  // revision 用 -1 标记"兜底视图、没有乐观锁基线"（/update 见负数就跳过 expectedRevision）
  if (fb) return { value: fb, revision: -1 };
  return { value: undefined, revision: undefined };
}

/**
 * ── 插件自有设置存储（2026-09-24）──
 *
 * 为什么不再写 profile 的 `cordis.patch.yml`：
 *   ① 0.1.7 下写 patch 会被宿主当**热更新**提交 → 插件重新 apply → 本插件启动时若凭据无效会再写
 *      → 自反馈闭环（实测把 dsh 启动刷死、无限弹二维码）；
 *   ② 手拼 YAML 保不住字段类型（实测 appId 写成裸数字、owners 空数组写成空串 → 宿主 schema 校验失败）；
 *   ③ 不支持"新增键"（groupAdmin.pollJoinRequests 这类写不进去）。
 *
 * 改用插件自己的 JSON 存储：不触发任何热更新、JSON 天生有类型、随便加键，
 * 而且**用户不需要手改任何配置文件**（可视化的初衷）。
 * 位置：{DSH_HOME}/qqbot-settings/<instanceNs>.json
 */
const OWN_SETTINGS_DIR = join(DSH_HOME_DIR, 'qqbot-settings');
/** appSecret 的回显掩码：前端看到它 / 空值 = 保留原值（不覆盖）。
 *  2026-10-25 提到模块级：/read 与 /accounts 都要用。 */
const SECRET_MASK = '********';

/**
 * 路径按 profile 隔离（2026-10-11；规则必须与 `src/features/ns-guard.ts` 的 `nsPathsOf()` 保持一致，改一处同步另一处）：
 *   新布局 `{DSH_HOME}/qqbot-settings/<profile>/<ns>.json` —— 各 profile 各一份，**同一个 ns 也不再互相覆盖**；
 *   老布局 `{DSH_HOME}/qqbot-settings/<ns>.json`            —— 所有 profile 共用（就是本次踩坑的根源），仅作读取兜底。
 * 读：新路径优先 → 老路径兜底（老数据不丢）；写：一律写新路径 —— 读取已兜底到老文件，首次保存天然是
 * "老内容 + 本次改动"，等于**自动搬家**。
 *
 * ⚠️ profile 名（2026-10-12 修）：**不能只读 `process.env.DSH_PROFILE`**。宿主不会把 profile 名放进
 * 自己的环境变量 —— DSH 是通过 `ctx.get('profileContext').name` 提供的，`DSH_PROFILE` 只在
 * **每次 shell / 工具调用**时由 harness 临时注入（见 `@deepseek-ai/dsh-shell-env`）。于是这里永远拿到空
 * → 永远落 `_default/`，"各 profile 各一份"形同虚设（实测 `writer.json` 记的是 `"profile": "unknown"`）。
 * 现在与 `src/shared/utils.ts` 的 `resolveProfileName()` **同规则**：环境变量 → `PROFILE_ROOT` 目录名
 * （要求其父目录名为 `profiles`，挡住源码 checkout 目录）→ 落 `_default`。改一处务必同步另一处。
 */
function resolveProfileName() {
  // ── 按维护手册 §「profile 定位的正解：回写环境变量，别改推断逻辑」 ──
  //    宿主的 profileContext 是权威答案，src/index.ts 的 apply() 已经把它回写到：
  //      process.env.DSH_PROFILE / DSH_PROFILE_DIR
  //      globalThis.__dshProfileName / __dshProfileContext
  //    这里只要**读**它，别自己猜路径。

  // ① 环境变量（apply 阶段回写，最直接）
  const env = String(process.env.DSH_PROFILE || '').trim();
  if (env) return env;

  // ② apply() 落下的全局变量 —— **这是关键补的一层**：
  //    settings-host.js 有可能在 apply() 之前就被加载（模块顶层求值），
  //    那时环境变量还没回写；但真正用到 profile 名是在请求处理阶段（惰性化后），
  //    那时 __dshProfileName 早就有了。
  try {
    const g = globalThis.__dshProfileName;
    if (typeof g === 'string' && g.trim()) return g.trim();
  } catch { /* 下一层 */ }

  // ③ 老宿主没有 profileContext 服务 → 只能从 PROFILE_ROOT 目录名反推
  try {
    if (basename(dirname(PROFILE_ROOT)) === 'profiles') {
      const n = basename(PROFILE_ROOT);
      if (n && n !== 'profiles') return n;
    }
  } catch { /* 放弃 */ }

  return '';
}
/**
 * 当前 profile 对应的存档子目录名。
 *
 * ⚠️ 2026-10-25 修 issue #20：原来是个**模块顶层求值的 const** ——
 *   Desktop 宿主在模块加载那一刻还没往环境里放 DSH_PROFILE，
 *   算出来就是 `_default`，之后永不重算 ⇒ 读 qqbot-settings/_default/xxx.json
 *   （真实存档在 qqbot-settings/desktop/xxx.json）⇒ 凭据读不到 ⇒ nsBot() null。
 *   改成每次调用时现算（开销是几次字符串/目录读，API 请求级，可忽略）。
 */
function nsProfileDir() {
  // 惰性求值（issue #20 的核心修复）：原来这是个模块顶层 const，
  // 算的时候 apply() 还没回写 DSH_PROFILE → 永远落 _default。
  const n = String(resolveProfileName()).trim().replace(/[^A-Za-z0-9_-]/g, '_');
  if (n) return n;
  return '_default';
}
function safeNsOf(ns) {
  return String(ns || NS).replace(/[^A-Za-z0-9_-]/g, '_') || 'im-qqbot';
}
function ownSettingsDir(ns) {
  return join(OWN_SETTINGS_DIR, nsProfileDir(ns));
}
function ownSettingsPath(ns) {
  return join(ownSettingsDir(ns), safeNsOf(ns) + '.json');
}
function legacySettingsPath(ns) {
  return join(OWN_SETTINGS_DIR, safeNsOf(ns) + '.json');
}
function readOwnSettings(ns) {
  try {
    for (const p of [ownSettingsPath(ns), legacySettingsPath(ns)]) {   // 新优先 → 老兜底
      if (!existsSync(p)) continue;
      const o = JSON.parse(readFileSync(p, 'utf8'));
      if (o && typeof o === 'object') return o;
    }
    return {};
  } catch { return {}; }
}
/**
 * 写入者指纹（2026-10-11）：`<ns>.writer.json` 记「这个设置槽是哪个 profile 在写」。
 *
 * 起因（主人实测）：web 与 desktop 两个 profile 挂了**同一个 settingsNs**，于是共用
 * `{DSH_HOME}/qqbot-settings/<ns>.json` —— 谁最后保存谁生效，凭据(appId/appSecret)/preset/cwd
 * 一起被换掉（web 的配置被 desktop 顶替，紧接着 QQ 连接也被顶掉、收不到消息）。
 *
 * 指纹放**单独文件**而不塞进设置 JSON：配置结构保持干净，前端无感。
 * 规则：槽里已记着"别的 profile"、而本实例在另一个 profile → **拒绝静默覆盖**（抛 NS_CONFLICT）。
 * 想强行接管：删掉 `<ns>.writer.json` 再保存，或干脆给其中一个 profile 换 settingsNs。
 */
function nsWriterPath(ns) {
  return ownSettingsPath(ns).replace(/\.json$/, '.writer.json');
}
function readNsWriter(ns) {
  try {
    const p = nsWriterPath(ns);
    if (!existsSync(p)) return null;
    const o = JSON.parse(readFileSync(p, 'utf8'));
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}
function myProfileName() {
  // 2026-10-12：改用 resolveProfileName()（同规则见其定义处注释）——
  // 原来只读 process.env.DSH_PROFILE，宿主里永远是空 → 指纹恒为 "unknown" → NS_CONFLICT 拦截永久失效。
  return resolveProfileName() || 'unknown';
}
/** 该设置槽是否正被**别的** profile 占用（供 /read 与 /update 共用） */
function nsConflictOf(ns) {
  const prev = readNsWriter(ns);
  const me = myProfileName();
  if (!prev || !prev.profile) return null;
  if (prev.profile === 'unknown' || me === 'unknown' || prev.profile === me) return null;
  return { prev: String(prev.profile), me };
}
function writeOwnSettings(ns, obj) {
  const p = ownSettingsPath(ns);
  const me = myProfileName();
  const conflict = nsConflictOf(ns);
  if (conflict) {
    const err = new Error(
      `设置槽 "${ns}" 已被 profile "${conflict.prev}" 占用，而本实例在 profile "${conflict.me}"：` +
      `两个 profile 共用同一个 settingsNs 会互相覆盖（凭据/preset/cwd 一起被换）。` +
      `修法：给其中一个 profile 换 settingsNs（如 "${ns}-${conflict.me}"）；` +
      `确实要让本 profile 接管，就先删掉 ${nsWriterPath(ns)} 再保存。`,
    );
    err.code = 'NS_CONFLICT';
    throw err;
  }
  try { mkdirSync(ownSettingsDir(ns), { recursive: true }); } catch { /* ignore */ }
  try { if (existsSync(p)) writeFileSync(p + '.bak-' + Date.now(), readFileSync(p)); } catch { /* 备份失败不阻塞 */ }
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  try { writeFileSync(nsWriterPath(ns), JSON.stringify({ profile: me, at: Date.now(), file: p }, null, 2), 'utf8'); } catch { /* 指纹写失败不阻塞 */ }
  return p;
}
/** 深合并一层（够用：本插件嵌套只到 groupAdmin / sticker.gates 这一层）。 */
function mergeDeepOne(cur, patch) {
  const out = Object.assign({}, cur);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (v === '__REDACTED__') continue;   // 脱敏占位符绝不写回
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = Object.assign({}, out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 按 (条目, **所属映射**, 键名) 去掉重复键，保留**最后一次**出现（YAML 语义）。
 *  2026-09-24 兜底：写 patch 前必跑。重复键会让宿主的 YAML 严格解析直接抛错
 *  （YAMLException: duplicated mapping key）→ dsh 完全启动不了。
 *
 *  ⚠️ 2026-10-09 修：旧签名是 `条目id + 缩进长度 + 键名`，而"同一 `- id:` 块内的同一
 *  缩进"**不等于**"同一个映射"——并列的两个子映射只要共用键名，前一个的键就会被整段
 *  删掉。实测 profile patch 里的两个典型形状都会被写坏：
 *    · `presets.read-only` / `presets.workspace-write`（键名 sandbox/approval 相同）
 *      → 前两个只剩空值，只有最后一个 danger-full-access 还留着键；
 *    · `perModel` 下两个模型的 pin（键名 upstreams/exclude/pinMode 相同）
 *      → 第一个模型的键被删，留下一个裸列表。
 *  后果不是"启动不了"，而是更隐蔽的**该行配置校验失败、被宿主静默跳过**：
 *  例如 `@deepseek-ai/dsh-permission-presets` 的 presets 缺必填 sandbox ⇒ 权限预设
 *  服务不注册（面板报 permissionPresets 不可用），`dsh-cline-pass` 的 perModel 期望对象
 *  却拿到列表 ⇒ 面板路由 404。设置页每保存一次账号就复现一次。
 *
 *  现在的签名带上**父键路径**（缩进栈）：只有真正同一个映射里的同名键才算重复，
 *  与 YAML 的 `duplicated mapping key` 判定一致。同时修两处漏判：
 *    · 键名不再限定 `[A-Za-z0-9_-]` —— `cline-pass/deepseek-v4.1-flash:` 这种含 `/` `.`
 *      的键原来被当成"非键行"，它下面的键就失去了父级，仍会被误删；
 *    · 块标量（`section: |`）的正文按缩进跳过，不会被当成键参与判重。 */
export function dedupeYamlKeys(text) {
  const lines = String(text).split(/\r?\n/);
  const seen = new Map(); const keep = new Array(lines.length).fill(true);
  let cur = '';
  const stack = [];           // 打开的父键路径: [{ indent, key }]
  let blockIndent = -1;       // ≥0 = 正在跳过某个块标量的正文
  let listSeq = 0;            // ★ 列表项序号（issue #11 修①）—— 必须在循环外，循环内会被逐行重置
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const blank = l.trim() === '';
    const indent = blank ? -1 : l.length - l.trimStart().length;
    // 块标量正文: 比键更深的行全部跳过, 直到缩进回到键这一层。
    if (blockIndent >= 0) {
      if (blank || indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (blank || l.trimStart().startsWith('#')) continue;
    const mId = /^(\s*)-\s*id:\s*(\S+)\s*$/.exec(l);
    if (mId) { cur = mId[2]; seen.clear(); stack.length = 0; continue; }

    // ★★ 2026-10-16（issue #11 / tyjianxianyu 报，本机已复现并验证）★★
    //   修①：**列表项必须压栈**。YAML 里 `- provider: buddy` 的每个 item 都是**独立节点**，
    //   原来这里把 `-` 开头的行直接放过去、不压栈 ⇒ 它下面的子键（如 `model: A`）会挂到
    //   **上一个 item 的父级**上 ⇒ 两个 item 的同名子键拿到**同一个签名** ⇒ 前一个被当成
    //   "重复键"删掉。实测（issue 的最小输入）：`allowedModels` 两项的 `model:` 2 个 → 只剩 1 个。
    //   线上真实后果：删掉 `subagent-model-selection-settings` 的 `model:` 行 ⇒
    //   "subagent model selection requires non-empty provider and model ids" ⇒ 该 entry 校验失败
    //   ⇒ 服务不注册 ⇒ **所有会话 resume 失败**。
    //   用递增序号标识同层不同 item，保证签名互不相同。
    //   ⚠️ 序号计数器必须在**循环外**（放循环里每行重置 ⇒ 所有 item 都叫 `-[1]` ⇒ 等于没修）。
    const mItem = /^(\s*)-\s+\S/.exec(l);
    if (mItem) {
      const itemIndent = mItem[1].length;
      while (stack.length && stack[stack.length - 1].indent >= itemIndent) stack.pop();
      stack.push({ indent: itemIndent, key: '-[' + (++listSeq) + ']' });
      continue;
    }

    //   修②：**键名允许含冒号**。YAML 键名可以带 `:`（如 `include:aaa:`、`include:mnemon-xxx:`），
    //   原正则 `([^\s:][^:]*?)` 明确禁止冒号 ⇒ 这类行不被识别为键、不压栈 ⇒ 它们下面的子键
    //   挂错父级 ⇒ 同样被误删（issue 里的"位置 1"，隐蔽、不报错，只是 auto-capture 拿不到数据源）。
    //   `(?!-)` 保留：行首 `-` 已由上面的列表项分支处理，这里只认真正的键。
    const mK = /^(\s*)(?!-)(\S.*?):(\s|$)/.exec(l);
    if (!mK) continue;
    const keyIndent = mK[1].length;
    const key = mK[2];
    if (/^[|>]/.test(l.slice(mK[0].length).trim())) blockIndent = keyIndent;
    while (stack.length && stack[stack.length - 1].indent >= keyIndent) stack.pop();
    const parent = stack.map((f) => f.key).join('/');
    const sig = cur + '|' + parent + '|' + key;
    if (seen.has(sig)) keep[seen.get(sig)] = false;
    seen.set(sig, i);
    stack.push({ indent: keyIndent, key });
  }
  return lines.filter((_, i) => keep[i]).join('\n');
}

/** 请求里的目录参数(dataDir 显式传; 空=primary 主账号) */
function dirOf(u, key) {
  return (u?.searchParams?.get(key) || '').trim() || undefined;
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

/** 注册一条路由, 统一 fence + method 检查。
 * ⚠️ 2026-09-10 关键修复: 同 path 只向 dsh webServer register 一次, 多 method 内部按
 *    req.method 分发。原实现对每个 route() 调用各 register 一次 —— dsh webServer 对同一
 *    path 重复 register 会抛错, 导致 apply 从该处中断, 其后所有路由全部未注册
 *    (实测: /group/botplay-events 的 GET+POST 同路径 → 其后 30 个路由缺失,
 *     dock 聊天视图/群发/审批全挂)。route() 本就接受 method 数组, 这里补按 path 去重。 */
const routeByPath = new Map();
function route(ctx, method, path, handler) {
  const methods = (Array.isArray(method) ? method : [method]).map((m) => String(m).toUpperCase());
  let reg = routeByPath.get(path);
  if (!reg) {
    reg = { handlers: new Map() };
    routeByPath.set(path, reg);
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isTrusted(req)) return writeJson(res, 403, { error: 'refused: same-origin loopback only' });
        const h = reg.handlers.get(String(req.method || '').toUpperCase());
        if (!h) return writeJson(res, 405, { error: 'method not allowed' });
        try { await h(req, res); } catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
      },
    }), `qqbot-settings: ${path}`);
  }
  for (const m of methods) reg.handlers.set(m, handler);
}

// ── workspace 会话重排：SSE 中枢（全进程单例）──────────────────────────────
//   ⚠️ 2026-10-05 修复「watchers 恒为 0、前端永远收不到推送」：
//   该 SSE 端点原先写在 apply() 内、用裸 ctx.webServer.register 注册；而 route() 的按 path
//   去重是**模块级**的 ⇒ 多 bot 实例（im-qqbot-2 / im-qqbot-3 各 apply 一次）时，SSE handler
//   与 debug / test-reorder 的 handler 会落在**不同实例的闭包**里：浏览器把连接加进 A 实例的
//   Set，debug 端点读的却是 B 实例的 Set ⇒ 永远 watchers:0，推送也发给了空集合。
//   实测铁证：curl 订阅 SSE 已收到 ': connected'，同一时刻 debug 仍报 watchers:0。
//   改法：订阅集合/状态/注册全部收敛到 globalThis 单例 —— 无论模块被求值几次、apply 几次，
//   全进程只有一份，谁注册的 handler 都读写同一份。
const WS_HUB = (globalThis.__qqbotWorkspaceWatchHub || (globalThis.__qqbotWorkspaceWatchHub = {
  watchers: new Set(),
  last: { at: 0, sessionId: '' },
  registered: false,
  bound: false,
}));

/** 向所有订阅中的浏览器推一条"某会话刚产出"（空 sessionId = 测试帧，让前端自己挑） */
function wsBroadcast(sessionId) {
  WS_HUB.last = { at: Date.now(), sessionId: String(sessionId || '') };
  const frames = [...WS_HUB.watchers];
  if (!frames.length) return;
  const isTest = !sessionId;
  for (const r of frames) {
    try {
      r.write(isTest
        ? 'data: ' + JSON.stringify({ sessionId: null, test: true, at: Date.now() }) + '\n\n'
        : 'data: ' + JSON.stringify({ sessionId: String(sessionId), at: Date.now() }) + '\n\n');
    } catch { WS_HUB.watchers.delete(r); }
  }
}

export function apply(ctx) {
  // ── 桥装载诊断(2026-09-10 排查路由全 404): 落 ~/.dsh/qqbot-bridge-diag.log ──
  // 用途: 宿主重启后可确认 apply 是否真的被 cordis 调用(以及当时 ctx 上有哪些服务)。
  try {
    // ⚠️ 未在 inject 声明的服务裸访问会抛 "without inject"（0.1.7 实测）→ 逐个 try 探测
    const probe = (n) => { try { return (ctx && ctx[n]) ? 'Y' : 'N'; } catch { return 'NO-INJECT'; } };
    const services = ['settings', 'webServer', 'agentPresets'].map((s) => s + '=' + probe(s)).join(' ');
    appendFileSync(
      join(homedir(), '.dsh', 'qqbot-bridge-diag.log'),
      `[${new Date().toISOString()}] bridge apply 被调用 inject=${JSON.stringify(inject)} ${services}\n`,
    );
  } catch { /* 诊断失败不影响装载 */ }
  // ── 临时诊断(排查"设置读取失败"): settings 服务可用性 + 已注册命名空间 ──
  route(ctx, 'GET', '/api/qqbot-settings/_debug', async (_req, res) => {
    try {
      const hasSettings = !!ctx.settings;
      let nss = [];
      let describeErr = null;
      try {
        const all = ctx.settings.describe({});
        nss = (Array.isArray(all) ? all : []).map((x) => x.ns);
      } catch (e) { describeErr = String(e?.message ?? e); }
      // 触发式反归档诊断(2026-09-11): 有多少次真的把归档的 QQ 会话拉回可见(见 dist/session/workspace-attach.js)
      let workspaceAttach = null;
      try {
        const wa = await import('./dist/session/workspace-attach.js');
        workspaceAttach = typeof wa.workspaceAttachState === 'function' ? wa.workspaceAttachState() : null;
      } catch { /* 模块未部署时忽略 */ }
      writeJson(res, 200, { hasSettings, nss, describeErr, workspaceAttach });
    } catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
  });

  // ── 设置面板读写桥(多账号: ?ns= 选实例命名空间; 缺省 im-qqbot 主账号) ──
  route(ctx, 'GET', '/api/qqbot-settings/read', async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const ns = u.searchParams.get('ns') || NS;
    const base = viewOf(ctx.settings, ns) || {};
    const own = readOwnSettings(ns);
    // 自有存储优先：它就是用户在设置页保存的那份
    const value = Object.assign({}, base.value || {}, own);
    // ── 2026-10-25 修「保存一次 appSecret 就变成旧值」──────────────────────
    //   原来把 appSecret 明文一起回给前端。value = Object.assign(base.value, own)，
    //   而 base 来自 cordis.patch.yml（**历史旧值**，2026-09-24 起就不再写它了）。
    //   一旦 own 里缺 appSecret，patch 的旧值就露出来；前端把它当"当前值"，
    //   下次保存原样提交回来 → 盖掉用户存的那份 → 每次保存都被顶回去。
    //   修法：这个接口永远只回掩码，前端已有的「掩码/空 = 保留原值」逻辑会正确处理。
    if (value && typeof value === 'object' && value.appSecret) {
      value.appSecret = SECRET_MASK;
    }
    // 2026-10-11: 顺手把"这个槽是谁在写"告诉前端 —— 被**别的 profile**占用时设置页能一眼看到（判据同 writeOwnSettings）
    const w = readNsWriter(ns);
    const conflict = nsConflictOf(ns);
    writeJson(res, 200, {
      value,
      revision: base.revision,
      source: Object.keys(own).length ? 'own' : 'patch',
      writerProfile: w && w.profile ? String(w.profile) : '',
      writerAt: w && w.at ? Number(w.at) : 0,
      nsConflict: conflict ? { writtenBy: conflict.prev, currentProfile: conflict.me } : null,
    });
  });
  route(ctx, 'POST', '/api/qqbot-settings/update', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'body must be JSON object' });
    const ns = typeof body.ns === 'string' && body.ns ? body.ns : NS;
    // ⚠️ 2026-09-24 起：保存一律写**插件自有存储**（{DSH_HOME}/qqbot-settings/<ns>.json），
    //    绝不写 profile 的 cordis.patch.yml —— 写 patch 会被宿主当热更新提交，本插件启动时
    //    若凭据无效会再写配置，形成自反馈闭环（实测把 dsh 启动刷死、无限弹二维码）。
    //    自有存储还让「用户不必手改任何配置文件」（可视化的初衷）。
    try {
      const cur = readOwnSettings(ns);
      const merged = mergeDeepOne(cur, body.patch ?? {});
      const file = writeOwnSettings(ns, merged);
      // 通知插件实例重新读取（桥与插件同进程；不写宿主配置 → 不触发任何热更新）
      try { ctx.emit('qqbot/settings-changed', ns); } catch { /* 无监听者也无妨 */ }
      const base = viewOf(ctx.settings, ns) || {};
      writeJson(res, 200, {
        value: Object.assign({}, base.value || {}, merged),
        revision: base.revision,
        mode: 'own',
        file,
        note: '已保存（插件自有存储，热生效）',
      });
    } catch (e) {
      // 2026-10-11: 设置槽被**别的 profile** 占用 → 409 + 原样文案（前端直接显示；绝不静默覆盖）
      if (e && e.code === 'NS_CONFLICT') return writeJson(res, 409, { error: String(e.message ?? e), code: 'NS_CONFLICT' });
      writeJson(res, 500, { error: '保存失败：' + String(e?.message ?? e) });
    }
  });

  // ── 定时唤醒辅助: 机器人见过的聊天台账(群/私聊带昵称) ──
  // 台账文件 {store.dataDir}/known-chats.jsonl 由 dsh-qqbot 中间件 append(见 dsh-qqbot src/features/chat-ledger.ts)。
  // 用途: Web 设置④区下拉点选目标(免抄 openid)——群无群名, 用最近发言者昵称帮主人辨认。
  // 多账号: ?dataDir= 指定账号图库目录(台账与之同目录); 缺省 primary。
  // ── 推断本插件的 dataRoot（与插件 src/gateway/data-root.ts 的算法保持一致）──
  //   为什么要这么做：桥和插件在运行时可能是**两份模块实例**（各自的模块级变量不共享）。
  //   插件在 bootstrap 里 initContextlessStore(dataRoot) 用的是正确路径；桥若没 init，
  //   contextless-store 的 ensurePath() 只能兜底到 {DSH_HOME}，于是"面板保存"写一个文件、
  //   "插件实际读取"读另一个文件 → 表现为保存无效 / 开关显示不一致（2026-09-27 实测）。
  function resolveContextlessDataRoot() {
    try {
      const parsed = parsePatch();
      const bots = (parsed && Array.isArray(parsed.bots)) ? parsed.bots : [];
      // 优先取"未禁用"的实例，其次任意一个有 cwd 的
      const pick = bots.filter((b) => b && !b.disabled && b.cfg && (b.cfg.cwd || b.cfg.dataRoot));
      const list = pick.length ? pick : bots.filter((b) => b && b.cfg && (b.cfg.cwd || b.cfg.dataRoot));
      for (const b of list) {
        const cfg = b.cfg || {};
        if (cfg.dataRoot) return String(cfg.dataRoot);
        if (cfg.cwd) return join(String(cfg.cwd), 'dshqqbot');   // 与 DEFAULT_DATA_SUBDIR 一致
      }
    } catch { /* 推不出来就交给 ensurePath 兜底 */ }
    // [qqbot-mod] panel-v5 patch 里没有 cwd/dataRoot（早在 2026-09-24 就搬进插件自有存储了）时，
    // 用 nsBot 合并自有存储后的 dataRoot 兜底——否则边栏扩展面板会报「还没绑过机器人？」。
    try {
      const b = nsBot('im-qqbot');
      if (b && b.cfg && b.cfg.dataRoot) return String(b.cfg.dataRoot);
    } catch { /* ignore */ }
    return '';
  }
  /** 确保 contextless-store 绑定到正确的数据根（幂等；路径变了会重新绑定） */
  async function loadContextlessStore() {
    const mod = await import('./dist/features/contextless-store.js');   // ← 函数体内用真正的动态 import（不能调自己）
    try {
      const dr = resolveContextlessDataRoot();
      if (dr) mod.initContextlessStore(dr);
    } catch { /* ignore */ }
    return mod;
  }

  // ── QQ 群管理登录二维码 → 直接送到 dsh web 界面 ──
  //   为什么需要它（2026-10-02）：AI 登录 qun.qq.com 时用的是**无头**浏览器（没有窗口），
  //   二维码只能"发图"给主人；而主人在手机上收到图后**扫不了自己的屏幕**
  //   （腾讯只认摄像头对着另一块屏幕扫："不支持图片识别或长按扫描二维码授权"）。
  //   把二维码挂到 dsh web 上，主人就能在**自己电脑的浏览器**里打开、用手机对着屏幕扫。
  //   用法：http://127.0.0.1:<dsh端口>/api/qqbot-settings/qun-qr
  route(ctx, 'GET', '/api/qqbot-settings/qun-qr', async (_req, res) => {
    try {
      const cands = [];
      const dr = resolveContextlessDataRoot();
      if (dr) cands.push(join(dr, 'qun-login-qr.png'));
      // 兜底：插件写二维码用的 dataRoot 可能与桥推出来的不一致（实测出现过两个数据根）
      try {
        const parsed = parsePatch();
        for (const b of ((parsed && parsed.bots) || [])) {
          const c = (b && b.cfg && (b.cfg.dataRoot || b.cfg.cwd)) || '';
          if (c) cands.push(join(String(c), 'dshqqbot', 'qun-login-qr.png'));
        }
      } catch { /* ignore */ }
      let hit = '';
      for (const c of cands) {
        try { if (c && existsSync(c)) { hit = c; break; } } catch { /* ignore */ }
      }
      if (!hit) {
        return writeJson(res, 404, { ok: false, error: '还没有二维码（先让 AI 调 qq_group_admin 的 action=login）', tried: cands });
      }
      const buf = readFileSync(hit);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store, must-revalidate' });
      res.end(buf);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ── 🔨 锤子 · 踢人面板（2026-10-02 主人定）──
  //   登录态与 AI **完全共享**：两边读写同一个 {dataRoot}/qun-cookie.json，
  //   所以「面板登录完 AI 立刻能用 / AI 登录完面板立刻已登录」，不需要任何同步逻辑。
  async function qunAdminMod() { return import('./dist/features/qun-admin.js'); }
  async function qunLoginMod() { return import('./dist/features/qun-login.js'); }
  /** 踢人面板统一取数据根（与插件/工具同源） */
  function qunRoot() { return resolveContextlessDataRoot() || ''; }
  function qunErrHuman(m) {
    return m.indexOf('NOT_LOGGED_IN') >= 0 ? '还没登录（先刷新二维码扫码）' : m;
  }

  /** 登录状态（顺手拿群列表验证凭据是否还有效） */
  route(ctx, 'GET', '/api/qqbot-settings/qun/status', async (_req, res) => {
    try {
      const dr = qunRoot();
      if (!dr) return writeJson(res, 200, { ok: true, logged: false, hint: '推不出数据根' });
      const mod = await qunAdminMod();
      const c = mod.loadQunCookie(dr);
      if (!c) return writeJson(res, 200, { ok: true, logged: false });
      let valid = false;
      let groups = [];
      try {
        // ★ 用**真实接口**验证凭据是否有效，不能靠"群列表有没有数据"猜：
        //   之前靠猜，skey 已被顶掉（接口 ec:4 no login）时依然报 valid=true，
        //   面板显示"已登录"、群列表却是空的，非常误导。
        valid = await mod.verifyQunCookie(dr);
        if (valid) groups = await mod.qunGroups(dr);
      } catch { valid = false; }
      writeJson(res, 200, {
        ok: true, logged: true, valid, uin: c.uin,
        groups: (groups || []).map((g) => ({ gc: g.gc, gn: g.gn, role: g.role })),
      });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  /** 触发/刷新登录：静默无头先试（有凭据或有本机 QQ 头像就免扫码），需要扫码就写出二维码文件 */
  route(ctx, 'POST', '/api/qqbot-settings/qun/login', async (_req, res) => {
    try {
      const dr = qunRoot();
      if (!dr) return writeJson(res, 400, { ok: false, error: '推不出数据根' });
      const admin = await qunAdminMod();
      let qr = false;
      let msg = '';
      try {
        const lg = await qunLoginMod();
        const r = await lg.qunBrowserLoginStart(dr, { headless: true });
        msg = r.msg || '';
        if (r.cookie) {
          admin.saveQunCookie(dr, { ...r.cookie, at: Date.now() });
          return writeJson(res, 200, { ok: true, logged: true, uin: r.cookie.uin, msg });
        }
        qr = !!r.qrPath;
      } catch (e) { msg = String((e && e.message) || e); }
      if (!qr) {
        // 浏览器这条路不通 → 退回纯网络二维码（写的是同一个文件路径）
        try {
          const s = await admin.qunLoginStart(dr);
          qr = !!(s && s.ok && s.qrPath);
          if (s && s.msg) msg = (msg ? msg + ' / ' : '') + s.msg;
        } catch { /* ignore */ }
      }
      writeJson(res, 200, { ok: true, logged: false, needScan: qr, msg });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  /** 轮询扫码结果（顺带把挂着的登录会话推进一次） */
  route(ctx, 'GET', '/api/qqbot-settings/qun/poll', async (_req, res) => {
    try {
      const dr = qunRoot();
      if (!dr) return writeJson(res, 200, { ok: true, logged: false });
      const admin = await qunAdminMod();
      try {
        const lg = await qunLoginMod();
        if (lg.qunLoginSessionAlive(dr)) {
          const w = await lg.qunBrowserLoginWait(dr, 2500);
          if (w.cookie) {
            admin.saveQunCookie(dr, { ...w.cookie, at: Date.now() });
            return writeJson(res, 200, { ok: true, logged: true, uin: w.cookie.uin });
          }
        }
      } catch { /* ignore */ }
      try {
        if (admin.qunLoginPending(dr)) {
          const p = await admin.qunLoginPoll(dr, 2500);
          if (p.done) return writeJson(res, 200, { ok: true, logged: true });
        }
      } catch { /* ignore */ }
      const c = admin.loadQunCookie(dr);
      writeJson(res, 200, { ok: true, logged: !!(c && c.skey), uin: c ? c.uin : '' });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  /** 成员搜索：?gc=群号&q=uin或昵称（q 可空 = 全量） */
  route(ctx, 'GET', '/api/qqbot-settings/qun/members', async (req, res) => {
    try {
      const dr = qunRoot();
      if (!dr) return writeJson(res, 400, { ok: false, error: '推不出数据根' });
      const u = new URL(req.url ?? '/', 'http://x');
      const gc = String(u.searchParams.get('gc') || '').trim();
      const q = String(u.searchParams.get('q') || '').trim();
      if (!gc) return writeJson(res, 400, { ok: false, error: 'gc 必填' });
      const mod = await qunAdminMod();
      const r = await mod.qunMembers(dr, gc, q || undefined);
      writeJson(res, 200, { ok: true, count: r.count, note: r.note, members: (r.members || []).slice(0, 300) });
    } catch (e) { writeJson(res, 200, { ok: false, error: qunErrHuman(String((e && e.message) || e)) }); }
  });

  /** 踢人 {gc, uins:[...]} */
  route(ctx, 'POST', '/api/qqbot-settings/qun/kick', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { ok: false, error: 'bad body' });
    const gc = String(body.gc || '').trim();
    const list = (Array.isArray(body.uins) ? body.uins : []).map((x) => String(x).trim()).filter(Boolean);
    if (!gc || !list.length) return writeJson(res, 400, { ok: false, error: 'gc / uins 必填' });
    try {
      const dr = qunRoot();
      if (!dr) return writeJson(res, 400, { ok: false, error: '推不出数据根' });
      const mod = await qunAdminMod();
      const rs = await mod.qunKick(dr, gc, list.slice(0, 20));
      const okCount = rs.filter((x) => x.ec === 0).length;
      writeJson(res, 200, { ok: okCount > 0, results: rs, msg: '成功 ' + okCount + '/' + rs.length });
    } catch (e) { writeJson(res, 200, { ok: false, error: qunErrHuman(String((e && e.message) || e)) }); }
  });

  /** 退出登录（清掉本地凭据，下次要重新扫码） */
  route(ctx, 'POST', '/api/qqbot-settings/qun/logout', async (_req, res) => {
    try {
      const dr = qunRoot();
      if (!dr) return writeJson(res, 400, { ok: false, error: '推不出数据根' });
      const mod = await qunAdminMod();
      mod.clearQunCookie(dr);
      try {
        const lg = await qunLoginMod();
        lg.qunLoginSessionClose(dr);
      } catch { /* ignore */ }
      writeJson(res, 200, { ok: true, msg: '已退出登录' });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // ── 无上下文模式（2026-09-27 主人定）──
  //   会话级开关：dock 面板里对**某个会话**开启；开启后该会话每轮只带
  //   「@ 之前 N 条群消息 + 系统规则」，历史对话全部丢弃（大幅省 token）。
  //   开关存 {dataRoot}/.qqbot/contextless.json（由插件在 bootstrap 时初始化）。
  route(ctx, 'GET', '/api/qqbot-settings/contextless', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const key = (u.searchParams.get('sessionKey') || '').trim();
      const mod = await loadContextlessStore();   // 先 init 到同一个 dataRoot，避免两份模块实例各写一个文件
      if (key) return writeJson(res, 200, mod.getContextless(key));
      return writeJson(res, 200, { list: mod.listContextless() });
    } catch (e) {
      return writeJson(res, 500, { error: String((e && e.message) || e) });
    }
  });
  route(ctx, 'POST', '/api/qqbot-settings/contextless', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'body must be JSON object' });
      const key = String(body.sessionKey || '').trim();
      if (!key) return writeJson(res, 400, { error: 'sessionKey required' });
      const mod = await loadContextlessStore();   // 先 init 到同一个 dataRoot，避免两份模块实例各写一个文件
      if (body.remove === true) { mod.clearContextless(key); return writeJson(res, 200, { ok: true, removed: true }); }
      // 2026-10-01: smart = 无上下文模式·智能判断（与 window 互斥，面板单选取值）
      const next = mod.setContextless(key, { enabled: body.enabled, window: body.window, smart: body.smart, memoMax: body.memoMax });
      return writeJson(res, 200, { ok: true, value: next });
    } catch (e) {
      return writeJson(res, 500, { error: String((e && e.message) || e) });
    }
  });

  route(ctx, 'GET', '/api/qqbot-settings/known-chats', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const store = dirOf(u, 'dataDir') ? getStickerStore(dirOf(u, 'dataDir')) : getStickerStore();
      const dataDir = store.dataDir;
      const lines = [];
      try {
        const raw = readFileSync(join(dataDir, 'known-chats.jsonl'), 'utf8');
        for (const l of raw.split('\n')) {
          const t = l.trim();
          if (!t) continue;
          try {
            const o = JSON.parse(t);
            if (o && typeof o.id === 'string' && (o.scope === 'group' || o.scope === 'c2c')) {
              lines.push({ ts: typeof o.ts === 'number' ? o.ts : 0, scope: o.scope, id: o.id, name: typeof o.name === 'string' ? o.name : undefined });
            }
          } catch { /* 坏行跳过 */ }
        }
      } catch { /* 台账文件尚不存在 */ }
      const map = new Map();
      for (const l of lines) {
        const key = l.scope + ':' + l.id;
        const cur = map.get(key);
        if (!cur) map.set(key, { scope: l.scope, id: l.id, name: l.name, lastSeen: l.ts, count: 1 });
        else {
          cur.count += 1;
          if (l.ts > cur.lastSeen) { cur.lastSeen = l.ts; if (l.name) cur.name = l.name; }
        }
      }
      // [qqbot-mod] known-chats-merge：台账会漏，把"她聊过的群/人"也补进来
      try {
        const _kcNs = String(u.searchParams.get("ns") || "");
        const _kcBot = (typeof nsBot === "function" ? nsBot(_kcNs) : null) || (typeof bots !== "undefined" ? bots[0] : null);
        const _kcRoot = _kcBot ? resolveMemoryRoot(_kcBot) : "";
        if (_kcRoot) {
          const _kcAdd = (scope, id, name, ts) => {
            if (!id || (scope !== "group" && scope !== "c2c")) return;
            const k = scope + ":" + id;
            const cur = map.get(k);
            if (!cur) map.set(k, { scope: scope, id: id, name: name, lastSeen: Number(ts) || 0, count: 1 });
            else if ((Number(ts) || 0) > (Number(cur.lastSeen) || 0)) { cur.lastSeen = Number(ts) || 0; if (name) cur.name = name; }
          };
          try {
            const _kcDb = join(_kcRoot, ".qqbot", "memory.db");
            if (existsSync(_kcDb)) {
              const _sqlite = await import("node:sqlite");
              const _db = new _sqlite.DatabaseSync(_kcDb, { readOnly: true });
              try {
                const _rows = _db.prepare("SELECT scope, MAX(ts) AS t FROM mem GROUP BY scope").all();
                for (const _r of _rows) {
                  const _s = String((_r && _r.scope) || "");
                  const _i = _s.indexOf(":");
                  if (_i > 0) _kcAdd(_s.slice(0, _i), _s.slice(_i + 1), undefined, Number(_r.t) || 0);
                }
              } finally { _db.close(); }
            }
          } catch { }
          // [[qqbot-mod] robot-name-fix 2026-10-26] c2c 对端真人昵称从 chat 表补：
          // msg-history 台账里对方昵称常是 openid、「机器人」是 bot 自己，都不可用；
          // chat 表 in 行的 sender 是 ingest 洗过的真人名（如「爸爸」）
          try {
            const _kcDb2 = join(_kcRoot, ".qqbot", "memory.db");
            if (existsSync(_kcDb2)) {
              const _sqlite2 = await import("node:sqlite");
              const _db2 = new _sqlite2.DatabaseSync(_kcDb2, { readOnly: true });
              try {
                const _rows2 = _db2.prepare(
                  "SELECT scope, sender, COUNT(*) AS c FROM chat WHERE dir='in' AND scope LIKE 'c2c:%' GROUP BY scope, sender ORDER BY c DESC"
                ).all();
                const _picked = new Map();
                for (const _r of _rows2) {
                  const _s = String((_r && _r.scope) || "");
                  const _nm2 = String((_r && _r.sender) || "");
                  if (!_s || !_nm2) continue;
                  if (_nm2 === "对方" || _nm2 === "机器人" || _nm2.length >= 16) continue;
                  if (!_picked.has(_s)) _picked.set(_s, _nm2);
                }
                for (const [_s, _nm2] of _picked) {
                  const _k = "c2c:" + _s.slice(4);
                  const _cur = map.get(_k);
                  if (_cur) { if (!_cur.name) _cur.name = _nm2; }
                  else map.set(_k, { scope: "c2c", id: _s.slice(4), name: _nm2, lastSeen: 0, count: 1 });
                }
              } finally { _db2.close(); }
            }
          } catch { }
          try {
            const _kcLog = join(_kcRoot, ".qqbot", "local-answer-log.jsonl");
            if (existsSync(_kcLog)) {
              const _lines = readFileSync(_kcLog, "utf8").split(String.fromCharCode(10));
              for (let _li = Math.max(0, _lines.length - 400); _li < _lines.length; _li++) {
                const _t = String(_lines[_li] || "").trim();
                if (!_t) continue;
                try {
                  const _o = JSON.parse(_t);
                  const _s2 = String((_o && _o.scope) || "");
                  const _j = _s2.indexOf(":");
                  if (_j > 0) _kcAdd(_s2.slice(0, _j), _s2.slice(_j + 1), undefined, Number(_o.ts) || 0);
                } catch { }
              }
          // [[qqbot-mod] panel-v3] 并入 .qqbot/msg-history：机器人不在线/会话没注册时写下的台账也算"聊过"，
          // 这样登录后私聊与特别关心的历史在浮窗聊天页能选到（原本只知道 known-chats.jsonl）。
          try {
            const _kcMH = join(_kcRoot, ".qqbot", "msg-history");
            if (existsSync(_kcMH)) {
              for (const _d of readdirSync(_kcMH)) {
                const _mm = /^(group|c2c)_(.+)$/.exec(String(_d));
                if (!_mm) continue;
                const _p = join(_kcMH, _d);
                const _files = readdirSync(_p).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(String(f))).sort();
                const _last = _files[_files.length - 1];
                if (!_last) continue;
                const _fp = join(_p, _last);
                let _ts = 0;
                try { _ts = Number(statSync(_fp).mtimeMs) || 0; } catch { }
                let _nm = "";
                try {
                  const _ls = readFileSync(_fp, "utf8").split(String.fromCharCode(10)).filter(Boolean).slice(-60);
                  for (let _i = _ls.length - 1; _i >= 0; _i--) {
                    try {
                      const _o = JSON.parse(_ls[_i]);
                      const _n = String((_o && _o.n) || "");
                      // [qqbot-mod] robot-name-fix：机器人自己的行（me=true 或 n=「机器人」）不能当对端名
                      if (_o && _o.me === true) continue;
                      if (_n && _n !== "self" && _n !== "机器人" && !/^[0-9A-Fa-f]{32}$/.test(_n)) { _nm = _n; break; }
                    } catch { }
                  }
                } catch { }
                // [qqbot-mod] group-title-fix 2026-10-27：msg-history 里扫到的 n 是**群成员昵称**，
                //   不能当群名（否则群聊标题变成某个群友的名字）；只有私聊(c2c)才用它当对端名
                _kcAdd(_mm[1], _mm[2], (_mm[1] === 'c2c' ? _nm : '') || undefined, _ts);
              }
            }
          } catch { }

            }
          } catch { }
        }
      } catch { }
      try {
        // [qqbot-mod] 群名优先用群注册表（已知账台账里的 name 常常是最后说话的人名）
        const _gnPath = [join(getStickerStore().dataDir, '..', '.qqbot', 'groups.json'), join(getStickerStore().dataDir, '..', '..', '.qqbot', 'groups.json')].find((f) => { try { return existsSync(f) } catch (e) { return false } }) || join(getStickerStore().dataDir, '..', '.qqbot', 'groups.json');
        // [qqbot-mod] groups-bom-tolerant 2026-10-27：groups.json 若被外部工具以 UTF-8 BOM 重写，
        //   JSON.parse 会整段抛错 → 群名表失效 → 群聊标题回退成最后说话的成员名（浮窗聊天页 Bug）
        const _gn = JSON.parse(String(readFileSync(_gnPath, 'utf8')).replace(/^\uFEFF/, '') || '{}');
        for (const _c of map.values()) {
          if (_c.scope === 'group') {
            const _g = _gn[_c.id];
            if (_g && _g.name) _c.name = _g.name;
            else if (!_c.name) _c.name = '群 ' + String(_c.id).slice(-6);
          }
        }
      } catch (eGN) {}
      const chats = [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 200);
      writeJson(res, 200, { chats });
    } catch (e) {
      writeJson(res, 500, { error: String(e?.message ?? e) });
    }
  });

  // ── 定时任务管理(会话内 AI 用 schedule_timer 建的: once/daily, .qqbot/timers.json) ──
  // 多账号: ?schedDir= / body.schedDir 指定账号定时目录(join(cwd,'.qqbot')); 缺省 primary。
  // 本页只管 查看/开关/删除(新建在 QQ 会话里让 AI 建)。
  function timerJobs(schedDir) {
    const store = schedDir ? getScheduleStore(schedDir) : getScheduleStore();
    const now = Date.now();
    return store.list().map((j) => ({
      id: j.id, kind: j.kind, scope: j.scope, peerId: j.peerId,
      atTime: j.atTime || null, dueAt: j.dueAt || null,
      prompt: j.prompt, createdAt: j.createdAt, enabled: j.enabled,
      lastRunDate: j.lastRunDate || null,
      nextFireAt: store.nextFireAt(j, now),
    }));
  }

  // ═══ [[qqbot-mod] accounts] 账号管理：B 站 + 抖音 一个入口 ═══
  const __qqNsOf = (req) => { try { return new URL(req.url ?? '/', 'http://x').searchParams.get('ns') || NS } catch { return NS } }
  // 动态 import 加 mtime 击穿：模块改了不用重启宿主，下次请求就是新版（ESM 同 URL 会永久缓存）
  const __qqExtImport = async (root, rel) => {
    const p = join(root, rel)
    let v = 0
    try { v = statSync(p).mtimeMs } catch {}
    return import('file:///' + p.split(String.fromCharCode(92)).join('/') + '?v=' + v)
  }
  const __qqPlatforms = async (root) => __qqExtImport(root, join('.qqbot-extensions', 'lib', 'platforms', 'index.mjs'))
  route(ctx, 'GET', '/api/qqbot-settings/platforms', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x')
      const force = u.searchParams.get('force') === '1'
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const m = await __qqPlatforms(root)
      // [qqbot-mod] overview-cache 2026-10-27：进程内 30s TTL + 单飞；force=1（浮窗点🔄）绕过缓存
      const o = await m.overview(root, { force })
      const cfg = (() => { try { return JSON.parse(readFileSync(join(root, '.qqbot-extensions', 'voice-config.json'), 'utf8')) } catch { return {} } })()
      return writeJson(res, 200, { ...o, voice: { provider: cfg.provider || '', model: cfg.model || '', voice: cfg.voice || '' } })
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '账号总览失败：' + String((e && e.message) || e) })
    }
  })
  route(ctx, 'GET', '/api/qqbot-settings/platforms-detail', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x')
      const id = String(u.searchParams.get('id') || '')
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const m = await __qqPlatforms(root)
      const d = await m.detail(root, id)
      return writeJson(res, 200, d)
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '账号详情失败：' + String((e && e.message) || e) })
    }
  })
  route(ctx, 'POST', '/api/qqbot-settings/platforms-cookie', async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const id = String((body && body.id) || '')
      const cookie = String((body && body.cookie) || '')
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const dy = await __qqExtImport(root, join('.qqbot-extensions', 'lib', 'platforms', 'douyin.mjs'))
      if (id !== 'douyin') return writeJson(res, 200, { ok: false, error: '目前只有抖音需要手工粘 Cookie' })
      const r = dy.saveCookie(root, cookie, String((body && body.note) || ''))
      // [qqbot-mod] douyin-ops 2026-10-27：存 cookie 也记一笔（含条数，之前只显示 0 条造成"没保存上"的错觉）
      if (r && r.ok) try { dy.opsLog(root, 'cookie-save', { count: r.count || (Array.isArray(r.pairs) ? r.pairs.length : 0), note: String((body && body.note) || '') }) } catch {}
      return writeJson(res, 200, r)
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '保存 Cookie 失败：' + String((e && e.message) || e) })
    }
  })
  route(ctx, 'GET', '/api/qqbot-settings/qr-svg', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x')
      const text = String(u.searchParams.get('text') || '').slice(0, 512)
      if (!text) return writeJson(res, 200, { ok: false, error: '缺 text' })
      const p = join(root0ForNs(nsOf(req)), '.qqbot-extensions', 'lib', 'platforms', 'douyin.mjs')
      let q = null
      try { const mod = await import('file:///' + p.split(String.fromCharCode(92)).join('/') + '?v=' + (statSync(p).mtimeMs || 0)); q = await mod.qrSvg(text) } catch {}
      if (!q || !q.ok) {
        // 兜底：不依赖 douyin.mjs，直接用 vendored qrcode 生成（2026-10-27 B 站码加载不出来的保险丝）
        try {
          const spec = 'file:///F:/qqbot/dshqqbot/.qqbot-extensions/vendor/qrcode/node_modules/qrcode/lib/index.js'
          const Q = (await import(spec)).default || (await import(spec))
          const svg2 = await Q.toString(String(text), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', width: 220 })
          q = { ok: true, svg: svg2 }
        } catch (eF) { q = { ok: false, error: (q && q.error) || String((eF && eF.message) || eF) } }
      }
      if (!q || !q.ok) return writeJson(res, 200, { ok: false, error: (q && q.error) || '生成失败' })
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(q.svg)
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '二维码生成失败：' + String((e && e.message) || e) })
    }
  })

  // ═══ [[qqbot-mod] douyin-comments] 抖音评论速览（只读） ═══
  route(ctx, 'GET', '/api/qqbot-settings/douyin-comments', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x')
      const link = String(u.searchParams.get('link') || '')
      const cursor = Number(u.searchParams.get('cursor') || 0) || 0
      const count = Math.min(50, Number(u.searchParams.get('count') || 20) || 20)
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const dy = await __qqExtImport(root, join('.qqbot-extensions', 'lib', 'platforms', 'douyin.mjs'))
      const id = await dy.parseVideoLink(link)
      if (!id || !id.ok) return writeJson(res, 200, { ok: false, error: (id && id.error) || '没认出视频 ID' })
      const r = await dy.commentList(root, id.awemeId, { cursor, count })
      // [qqbot-mod] douyin-ops：拉过谁家评论也记一笔，方便回溯
      if (r && r.ok) try { dy.opsLog(root, 'comments-pull', { awemeId: id.awemeId, total: r.total || 0, count: (r.comments || []).length, via: id.via || '' }) } catch {}
      return writeJson(res, 200, { ...r, via: id.via || '', awemeId: id.awemeId, videoUrl: 'https://www.douyin.com/video/' + id.awemeId })
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '拉评论失败：' + String((e && e.message) || e) })
    }
  })

  // ═══ [[qqbot-mod] douyin-log] 抖音发布日志/历史操作（与 B 站同构，本地记录） ═══
  route(ctx, 'GET', '/api/qqbot-settings/douyin-log', async (req, res) => {
    try {
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const dy = await __qqExtImport(root, join('.qqbot-extensions', 'lib', 'platforms', 'douyin.mjs'))
      return writeJson(res, 200, dy.opsRead(root, { limit: 60 }))
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '读抖音日志失败：' + String((e && e.message) || e) })
    }
  })
  // ═══ [[qqbot-mod] douyin-replies] 抖音回复待审队列（自动发被挡，终点=复制手动发） ═══
  route(ctx, 'GET', '/api/qqbot-settings/douyin-replies', async (req, res) => {
    try {
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const dy = await __qqExtImport(root, join('.qqbot-extensions', 'lib', 'platforms', 'douyin.mjs'))
      return writeJson(res, 200, dy.replyList(root))
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '读待审回复失败：' + String((e && e.message) || e) })
    }
  })
  route(ctx, 'POST', '/api/qqbot-settings/douyin-replies', async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const dy = await __qqExtImport(root, join('.qqbot-extensions', 'lib', 'platforms', 'douyin.mjs'))
      const act = String(body.action || '')
      if (act === 'draft') {
        const r = dy.replyDraft(root, { awemeId: body.awemeId, nickname: body.nickname, comment: body.comment, text: body.text, videoUrl: body.videoUrl })
        if (r.ok) try { dy.opsLog(root, 'reply-draft', { awemeId: String(body.awemeId || ''), who: String(body.nickname || '') }) } catch {}
        return writeJson(res, 200, r)
      }
      if (act === 'update') return writeJson(res, 200, dy.replyUpdate(root, { id: String(body.id || ''), text: body.text, status: body.status }))
      return writeJson(res, 200, { ok: false, error: '未知动作：' + (act || '（空）') })
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '待审回复操作失败：' + String((e && e.message) || e) })
    }
  })
  // 打开抖音产物目录（对齐 B 站卡的「📂 产物目录」）
  route(ctx, 'POST', '/api/qqbot-settings/douyin', async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const bot = nsBot(__qqNsOf(req))
      const root = resolveMemoryRoot(bot)
      const dir = join(root, 'data', 'douyin-ops')
      try { mkdirSync(dir, { recursive: true }) } catch {}
      const action = String(body.action || '')
      if (action === 'open-ops') {
        let last = ''
        for (const go of [() => spawn('cmd', ['/c', 'start', '', dir], { detached: true, stdio: 'ignore', windowsHide: true }), () => spawn('explorer', [dir], { detached: true, stdio: 'ignore', windowsHide: true })]) {
          try { const c = go(); c.on?.('error', () => {}); c.unref(); return writeJson(res, 200, { ok: true, path: dir }) } catch (e) { last = String((e && e.message) || e) }
        }
        return writeJson(res, 200, { ok: false, error: '打不开目录：' + last, path: dir })
      }
      return writeJson(res, 200, { ok: false, error: '未知动作' })
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: '抖音操作失败：' + String((e && e.message) || e) })
    }
  })

  // ═══ [[qqbot-mod] panel-v3] ① B 站发布日志：浮窗里能审查"我发了什么" ═══
  route(ctx, 'GET', '/api/qqbot-settings/bili-log', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const limit = Math.max(1, Math.min(80, Number(u.searchParams.get('limit') || 20) || 20));
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      const rows = [];
      const pushRow = (o, src) => {
        if (!o || typeof o !== 'object') return;
        const at = Number(o.ts || o.at || 0) || 0;
        const dynId = String(o.dynamicId || o.dyn_id || '');
        rows.push({
          src,
          at,
          type: String(o.type || (src === 'dynamic' ? 'dynamic' : 'log')),
          text: String(o.text || o.title || o.summary || o.desc || '').trim(),
          url: String(o.url || (dynId ? 'https://t.bilibili.com/' + dynId : '')),
          dynamicId: dynId,
          jobId: String(o.jobId || ''),
          ok: o.ok === false ? false : true,
          err: String(o.error || ''),
          via: String(o.via || ''),
        });
      };
      try {
        const p1 = join(root, '.qqbot', 'bili-dynamic-log.jsonl');
        if (existsSync(p1)) {
          for (const line of readFileSync(p1, 'utf8').split(String.fromCharCode(10))) {
            const t = line.trim();
            if (!t) continue;
            try { pushRow(JSON.parse(t), 'dynamic'); } catch { }
          }
        }
      } catch { }
      try {
        const p2 = join(root, '.qqbot', 'bili-ops', 'records.jsonl');
        if (existsSync(p2)) {
          for (const line of readFileSync(p2, 'utf8').split(String.fromCharCode(10))) {
            const t = line.trim();
            if (!t) continue;
            try { pushRow(JSON.parse(t), 'ops'); } catch { }
          }
        }
      } catch { }
      rows.sort((a, b) => b.at - a.at);
      return writeJson(res, 200, { ok: true, root, total: rows.length, rows: rows.slice(0, limit) });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ═══ [[qqbot-mod] panel-v3] ② 语音合成方案：列清楚、选得动、真写 voice-config.json ═══
  const TTS_ENGINES = [
    {
      id: 'edge', label: 'edge 在线（微软）', kind: 'cloud', port: 0,
      voices: ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural'],
      speed: '≈0.5×实时 · 零显存 · 要联网',
      use: '本地服务没起时的兜底；音质一般但最稳',
    },
    {
      id: 'gsv', label: 'GPT-SoVITS 本地', kind: 'local', port: 9880, dir: '.models/gpt-sovits',
      voices: ['xiaolan', 'gentle'],
      speed: '聊天实时首选（6GB 卡够）',
      use: '群聊发语音条：5 秒参考音就能克隆',
    },
    {
      id: 'breeze', label: 'Breeze TTS 2 int8-hybrid', kind: 'local', port: 7860, dir: '.models/breeze-tts2',
      voices: ['breeze', 'breeze_design'],
      speed: '≈0.10×实时（3.8s 音频要 38s）',
      use: '离线成片配音：音色自然、慢，不适合抢答',
    },
    {
      id: 'index', label: 'IndexTTS-2.5（情感克隆）', kind: 'local', port: 9890, dir: '.models/index-tts',
      voices: ['xiaolan_emo', 'xiaolan_emo_soft'],
      speed: 'RTF≈22-30（比 GSV 慢约 25 倍）',
      use: '离线视频配音 / 读评论：情感最足',
    },
  ];

  function dirSizeSync(p) {
    try {
      if (!p || !existsSync(p)) return 0;
      const st = statSync(p);
      if (st.isFile()) return st.size;
      let sum = 0;
      for (const f of readdirSync(p)) sum += dirSizeSync(join(p, f));
      return sum;
    } catch { return 0; }
  }

  async function probePort(port) {
    if (!port) return false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1200);
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: ac.signal });
      return !!r && (r.ok || r.status === 404 || r.status === 405 || r.status === 400);
    } catch {
      try {
        const r2 = await fetch('http://127.0.0.1:' + port + '/', { signal: ac.signal });
        return !!r2;
      } catch { return false; }
    } finally { clearTimeout(timer); }
  }

  route(ctx, 'GET', '/api/qqbot-settings/tts-engines', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      const cfg = readExtCfg(extCfgPath(root, 'voice'));
      const adapterUp = await probePort(9881);
      const engines = [];
      for (const e of TTS_ENGINES) {
        const up = e.port ? await probePort(e.port) : true;
        const sizeBytes = e.dir ? dirSizeSync(join(root, '..', '..', e.dir)) : 0;
        const sizeAlt = e.dir ? dirSizeSync(join('F:/qqbot', e.dir)) : 0;
        engines.push({
          id: e.id, label: e.label, kind: e.kind, port: e.port, voices: e.voices,
          speed: e.speed, use: e.use,
          up: e.id === 'edge' ? true : (e.port === 9880 || e.port === 9890 ? (up || adapterUp) : up),
          rawUp: up,
          sizeGB: Math.round(((sizeBytes || sizeAlt) / (1024 * 1024 * 1024)) * 100) / 100,
          dir: e.dir || '',
        });
      }
      const cur = String(cfg.model || '');
      const curEngine = String(cfg.provider || 'edge') === 'edge' ? 'edge' : (TTS_ENGINES.find((x) => x.id === cur) ? cur : 'gsv');
      return writeJson(res, 200, {
        ok: true, root, path: extCfgPath(root, 'voice'), config: cfg,
        adapter: { port: 9881, up: adapterUp, endpoint: 'http://127.0.0.1:9881/v1/audio/speech' },
        current: { engine: curEngine, provider: String(cfg.provider || 'edge'), model: cur, voice: String(cfg.voice || ''), mode: String(cfg.mode || 'sometimes'), prob: cfg.prob },
        engines,
      });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  route(ctx, 'POST', '/api/qqbot-settings/tts-engines', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const engineId = String((body && body.engine) || '').trim();
      const wanted = TTS_ENGINES.find((x) => x.id === engineId);
      if (!wanted) return writeJson(res, 400, { ok: false, error: '未知方案：' + engineId });
      const bot = nsBot(String((body && body.ns) || ''));
      const root = resolveMemoryRoot(bot);
      const p = extCfgPath(root, 'voice');
      if (!p) return writeJson(res, 400, { ok: false, error: '找不到数据目录' });
      const cur = readExtCfg(p);
      const voice = String((body && body.voice) || '').trim() || wanted.voices[0] || '';
      const patch = engineId === 'edge'
        ? { provider: 'edge', voice, endpoint: 'http://127.0.0.1:9881/v1/audio/speech', model: '' }
        : { provider: 'http', voice, model: engineId, endpoint: 'http://127.0.0.1:9881/v1/audio/speech' };
      if (body && typeof body.mode === 'string' && body.mode) patch.mode = body.mode;
      if (body && typeof body.prob === 'number') patch.prob = Math.max(0, Math.min(1, body.prob));
      const next = Object.assign({}, cur, patch);
      for (const k of ['systemPrompt', 'baseUrl']) if (next[k] === '') delete next[k];
      try {
        if (existsSync(p)) copyFileSync(p, p + '.bak-' + Date.now());
      } catch { }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
      const up = wanted.port ? await probePort(wanted.port) : true;
      return writeJson(res, 200, {
        ok: true, engine: engineId, path: p, config: readExtCfg(p), up,
        note: up ? '' : ('端口 ' + wanted.port + ' 没开：' + engineId + ' 现在合成会失败，先跑 skills/local-tts/scripts/start-services.ps1 -Backend adapter'),
      });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ═══ [[qqbot-mod] panel-v3] ③ 打开任意产物目录（explorer → cmd start → PowerShell，三重兜底）═══
  route(ctx, 'POST', '/api/qqbot-settings/open-dir', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const bot = nsBot(String((body && body.ns) || ''));
      const root = resolveMemoryRoot(bot);
      let dir = String((body && body.path) || '').trim();
      let _lib = null;
      try {
        _lib = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-ops.mjs').split(String.fromCharCode(92)).join('/'));
      } catch { }
      if (body && body.kind === 'bili-jobs') {
        // [qqbot-mod] 2026-10-28：客户端别再猜路径 —— 产物根目录以 bili-ops 的 paths() 为准
        try { dir = (_lib && _lib.paths(root).jobs) || dir; } catch { }
      }
      if (!dir && body && body.jobId) {
        const job = _lib && _lib.getJob ? _lib.getJob(root, String(body.jobId)) : null;
        dir = (job && job.dir) || '';
      }
      if (!dir) return writeJson(res, 400, { ok: false, error: '缺 path/kind/jobId' });
      const abs = resolve(dir);
      const okRoot = root && (abs === resolve(root) || abs.startsWith(resolve(root) + sep));
      const okExtra = /^F:[\\/]qqbot[\\/].models[\\/]/i.test(abs) || /^F:[\\/]qqbot[\\/]skills[\\/]/i.test(abs);
      // [[qqbot-mod] video-flow] 成片产物默认落在 storage.root（F:/qqbot/data/bili-ops），
      // 它不在数据根下，之前一直被"目录不在数据根里"挡回去 = 用户说的"打开产物目录始终失效"。
      let _jobsDir = '';
      try { _jobsDir = (_lib && _lib.paths) ? _lib.paths(root).jobs : ''; } catch { }
      const okJobs = _jobsDir && (abs === resolve(_jobsDir) || abs.startsWith(resolve(_jobsDir) + sep));
      if (!okRoot && !okExtra && !okJobs) return writeJson(res, 200, { ok: false, path: abs, error: '目录不在允许范围里，拒绝打开' });
      try { if (!existsSync(abs)) mkdirSync(abs, { recursive: true }); } catch { }
      // [qqbot-mod] 2026-10-28 主人反馈：原来 spawn 探测后直接回"已打开"，失败全被吞 ——
      //   弹窗永远说成功、窗口从不出现。改成 spawnSync 可验证，三重兜底（cmd start → explorer → powershell）。
      //   注：别用 rundll32 —— 第一版把 WINDIR 错当 dll 参数传进去，弹「RUNDLL 存在错误」对话框（主人截图）。
      const tries = [
        ['cmd', ['/c', 'start', '', abs]],
        ['explorer', [abs]],
        ['powershell', ['-NoProfile', '-Command', 'Start-Process -FilePath explorer.exe -ArgumentList "' + abs.replace(/"/g, '') + '"']],
      ];
      let last = '';
      for (const [cmd, args] of tries) {
        try {
          const r = spawnSync(cmd, args, { timeout: 6000, windowsHide: true, stdio: 'ignore' });
          const bad = r.error || (r.status && r.status !== 0 && r.status !== 1);
          if (bad) { last = (r.error && r.error.message) || ('exit ' + r.status); continue; }
          let _cnt = -1;
          try { _cnt = readdirSync(abs).length } catch { }
          return writeJson(res, 200, { ok: true, path: abs, via: cmd, count: _cnt, msg: '已打开（' + _cnt + ' 项，via ' + cmd + '）' });
        } catch (e) {
          last = String((e && e.message) || e);
        }
      }
      return writeJson(res, 200, { ok: false, path: abs, error: '调不起资源管理器：' + last });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ═══ [[qqbot-mod] panel-v3] ③ 出图/视频方案：模型路径、大小、服务状态 ═══
  route(ctx, 'GET', '/api/qqbot-settings/draw-info', async (req, res) => {
    try {
      const bot = nsBot(String(new URL(req.url ?? '/', 'http://x').searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      const draw = readExtCfg(join(root, '.qqbot-extensions', 'draw-config.json'));
      const active = String(draw.activeProfile || 'balanced');
      const prof = (draw.profiles && draw.profiles[active]) || {};
      const modelPath = String(prof.modelPath || prof.model || '').trim();
      const modelSize = modelPath ? dirSizeSync(modelPath) : 0;
      const sdUp = await probePort(7861);
      const jobsDir = join(root, '.qqbot', 'bili-ops', 'jobs');
      let jobCount = 0;
      try { jobCount = existsSync(jobsDir) ? readdirSync(jobsDir).length : 0; } catch { }
      return writeJson(res, 200, {
        ok: true, root,
        draw: {
          activeProfile: active,
          profiles: Object.keys(draw.profiles || {}),
          modelPath,
          modelSizeGB: Math.round((modelSize / (1024 * 1024 * 1024)) * 100) / 100,
          sdServer: { port: 7861, up: sdUp },
        },
        video: {
          jobsDir,
          jobCount,
          ffmpeg: 'F:/qqbot/.venv-draw/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe',
          skillFrameRender: 'F:/qqbot/skills/video-frame-render/scripts/render.py',
          skillH3: 'F:/qqbot/skills/h3-video/SKILL.md',
        },
        tts: { adapter: 'F:/qqbot/skills/local-tts/adapter/server.py', dir: 'F:/qqbot/.models' },
      });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // [qqbot-mod] contact-move（主人 2026-10-27）：「💠 联系方式」的数据源。
  //   QQ 侧读 group-tiers.json + groups.json + msg-history 的条数；B 站侧读本机两份台账；
  //   学习心得沿用 memory.db 的 insight/growth（记忆页那块已经删掉，改在这里展示）。
  route(ctx, 'GET', '/api/qqbot-settings/contact', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      const ext = async (rel) => import('file:///' + join(root, '.qqbot-extensions', rel).replace(/\\/g, '/'));
      const out = { ok: true, root, qq: { groups: [], people: [], counts: { groups: 0, people: 0 } }, bili: [], insights: [] };
      // 群名表
      let gNames = {};
      // [qqbot-mod] groups-bom-tolerant：同上，容忍 BOM
      try { gNames = JSON.parse(String(readFileSync(join(root, '.qqbot', 'groups.json'), 'utf8')).replace(/^\uFEFF/, '')) || {}; } catch { }
      try {
        // [qqbot-mod] 群注册表可能被清空：从 msg-history 目录兜底补齐"有哪些群"
        const _mh = join(root, '.qqbot', 'msg-history');
        for (const d of readdirSync(_mh)) {
          const m = /^group_(.+)$/.exec(String(d));
          if (!m) continue;
          if (!gNames[m[1]]) gNames[m[1]] = { name: '', from: 'msg-history' };
        }
      } catch (e) {}
      // 台账条数 + 昵称
      const stats = {};
      try {
        const mh = join(root, '.qqbot', 'msg-history');
        if (existsSync(mh)) {
          for (const d of readdirSync(mh)) {
            const mm = /^(group|c2c)_(.+)$/.exec(d);
            if (!mm) continue;
            const kind = mm[1], id = mm[2];
            const key = kind + ':' + id;
            let cnt = 0, name = '';
            try {
              const dir = join(mh, d);
              const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
              const last = files[files.length - 1];
              if (last) {
                const lines = readFileSync(join(dir, last), 'utf8').split(String.fromCharCode(10)).filter(Boolean);
                cnt = lines.length;
                for (let i = lines.length - 1; i >= 0 && i > lines.length - 80; i--) {
                  try {
                    const o = JSON.parse(lines[i]);
                    const n = String(o.n || '');
                    if (n && n !== 'self' && !/^[0-9A-Fa-f]{32}$/.test(n)) { name = n; break; }
                  } catch { }
                }
              }
            } catch { }
            stats[key] = { kind, id, msgs: cnt, name };
          }
        }
      } catch { }
      // 特别关心名单（群 / 人）+ 关系档案里的角色
      let tiers = { priority: [], priorityPeople: [] };
      try { tiers = JSON.parse(readFileSync(join(root, '.qqbot-extensions', 'data', 'group-tiers.json'), 'utf8')) || tiers; } catch { }
      let relmap = {};
      try {
        const core = await ext('lib/memory-panel-core.mjs');
        const ch = core.loadCharacter ? core.loadCharacter(root) : null;
        if (ch && ch.relationOf) relmap = ch.relationOf;
      } catch { }
      const priG = new Set((tiers.priority || []).map((x) => String(x).replace(/^group:/, '')));
      const priP = new Set((tiers.priorityPeople || []).map((x) => String(x).replace(/^c2c:/, '')));
      // 群：台账里有的都列，特别关心的排前面；再补上"只在 tiers 里有"的
      const seenG = new Set();
      const groups = [];
      Object.values(stats).forEach((s) => {
        if (s.kind !== 'group') return;
        seenG.add(s.id);
        const gname = (gNames[s.id] && gNames[s.id].name) || s.name || s.id;
        groups.push({ id: s.id, name: gname, msgs: s.msgs, priority: priG.has(s.id) });
      });
      priG.forEach((id) => {
        if (seenG.has(id)) return;
        const gname = (gNames[id] && gNames[id].name) || id;
        groups.push({ id, name: gname, msgs: 0, priority: true });
      });
      groups.sort((a, b) => (Number(b.priority) - Number(a.priority)) || (b.msgs - a.msgs));
      // 人：优先看特别关心名单 + 熟识度
      const people = [];
      const seenP = new Set();
      priP.forEach((id) => {
        const s = stats['c2c:' + id] || null;
        seenP.add(id);
        people.push({ id, name: (s && s.name) || id.slice(-6), role: relmap[(s && s.name) || ''] || '', priority: true, note: '' });
      });
      Object.values(stats).forEach((s) => {
        if (s.kind !== 'c2c') return;
        if (seenP.has(s.id)) return;
        people.push({ id: s.id, name: s.name || s.id.slice(-6), role: relmap[s.name || ''] || '', priority: false, note: '' });
      });
      out.qq.groups = groups.slice(0, 40);
      out.qq.people = people.slice(0, 40);
      out.qq.counts = { groups: groups.length, people: people.length };
      // B 站台账
      const pushBili = (o, defType) => {
        if (!o || typeof o !== 'object') return;
        const at = Number(o.ts || o.at || 0) || 0;
        const dynId = String(o.dynamicId || o.dyn_id || '');
        out.bili.push({
          at,
          type: String(o.type || defType),
          text: String(o.text || o.title || o.summary || o.desc || o.topic || '').trim(),
          url: String(o.url || (dynId ? 'https://t.bilibili.com/' + dynId : '')),
          ok: o.ok === false ? false : true,
        });
      };
      try {
        const p1 = join(root, '.qqbot', 'bili-dynamic-log.jsonl');
        if (existsSync(p1)) for (const L of readFileSync(p1, 'utf8').split(String.fromCharCode(10))) { const t = L.trim(); if (t) { try { pushBili(JSON.parse(t), 'dynamic'); } catch { } } }
      } catch { }
      try {
        const p2 = join(root, '.qqbot', 'bili-ops', 'records.jsonl');
        if (existsSync(p2)) for (const L of readFileSync(p2, 'utf8').split(String.fromCharCode(10))) { const t = L.trim(); if (t) { try { pushBili(JSON.parse(t), 'log'); } catch { } } }
      } catch { }
      try {
        const p3 = join(root, 'data', 'bili-ops', 'records.jsonl');
        if (existsSync(p3)) for (const L of readFileSync(p3, 'utf8').split(String.fromCharCode(10))) { const t = L.trim(); if (t) { try { pushBili(JSON.parse(t), 'log'); } catch { } } }
      } catch { }
      out.bili.sort((a, b) => b.at - a.at);
      out.bili = out.bili.slice(0, 40);
      // 学习心得
      try {
        const mem = await ext('lib/memory.mjs');
        const list = mem.loadMemories(root, '__global__') || [];
        out.insights = list.filter((m) => ['insight', 'growth'].includes(String(m.kind || '')))
          .map((m) => ({ id: m.id, kind: m.kind, text: String(m.text || ''), source: String(m.source || 'chat'), ts: m.ts || 0 }))
          .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 20);
      } catch (eI) { out.insightErr = String(eI && eI.message || eI); }
      writeJson(res, 200, out);
    } catch (e) {
      writeJson(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  // [qqbot-mod] voice-audition（主人 2026-10-27）：四个主力音色 + 真合成试听。
  route(ctx, 'GET', '/api/qqbot-settings/tts-voices', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(join(root, '.qqbot-extensions', 'voice-config.json'), 'utf8')) || {}; } catch { }
      let prof = {};
      try { prof = JSON.parse(readFileSync(join(root, '..', 'skills', 'local-tts', 'adapter', 'profiles.json'), 'utf8')) || {}; } catch { }
      if (!prof || !prof.curated) {
        try { prof = JSON.parse(readFileSync('F:/qqbot/skills/local-tts/adapter/profiles.json', 'utf8')) || {}; } catch { }
      }
      const curated = (prof.curated || []).map((c) => ({ voice: c.voice, label: c.label, hint: c.hint || '', backend: (prof.voices && prof.voices[c.voice] && prof.voices[c.voice].backend) || '' }));
      writeJson(res, 200, {
        ok: true,
        curated,
        current: { voice: cfg.voice || '', model: cfg.model || '', provider: cfg.provider || '', endpoint: cfg.endpoint || '', speed: cfg.speed || 1 },
        profilePath: 'skills/local-tts/adapter/profiles.json',
      });
    } catch (e) {
      writeJson(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  route(ctx, 'POST', '/api/qqbot-settings/tts-preview', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const bot = nsBot(String(body.ns || ''));
      const root = resolveMemoryRoot(bot);
      const voice = String(body.voice || '').trim();
      const engine = String(body.engine || '').trim();
      if (!voice) { writeJson(res, 200, { ok: false, error: '没给音色名' }); return; }
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(join(root, '.qqbot-extensions', 'voice-config.json'), 'utf8')) || {}; } catch { }
      const ext = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'tts-core.mjs').replace(/\\/g, '/'));
      const text = String(body.text || '你好呀，我是小蓝。这个声音你听得惯吗？').slice(0, 60);
      // [qqbot-mod] preview-sample 2026-10-27：预录样本缓存（主人反馈：试听不该每次都真合成 ——
      //   本地后端没起就要干等几十秒甚至失败）。首次合成成功后把音频存进 samples/，
      //   之后同一个音色+引擎直接秒播；换引擎才重录。
      const DEFAULT_PREVIEW_TEXT = '你好呀，我是小蓝。这个声音你听得惯吗？';
      const isStdText = String(body.text || DEFAULT_PREVIEW_TEXT) === DEFAULT_PREVIEW_TEXT;
      const engName = engine || String(cfg.model || 'gsv');
      const pvDir = join(root, '.qqbot', 'tts', 'preview');
      const safe = voice.replace(/[^0-9A-Za-z_-]/g, '_');
      if (isStdText) {
        const samp = join(pvDir, 'smp_' + safe + '__' + String(engName).replace(/[^0-9A-Za-z_-]/g, '_') + '.mp3');
        if (existsSync(samp)) {
          try {
            const dst0 = join(pvDir, safe + '.mp3');
            copyFileSync(samp, dst0);
            writeJson(res, 200, {
              ok: true, voice, engine: engName, ms: 0, cached: true, bytes: statSync(samp).size,
              url: '/api/qqbot-settings/tts-preview-file?name=' + encodeURIComponent(safe + '.mp3') + '&ns=' + encodeURIComponent(String(body.ns || '')) + '&t=' + Date.now(),
            });
            return;
          } catch { /* 缓存读失败就走正常合成 */ }
        }
      }
      const t0 = Date.now();
      const r = await ext.synthesize(text, {
        dataRoot: root,
        provider: 'http', // 试听一律走本地（只有本地才有音色可选）
        endpoint: String(cfg.endpoint || 'http://127.0.0.1:9881/v1/audio/speech'),
        model: engine || String(cfg.model || 'gsv'),
        voice,
        speed: Number(body.speed || cfg.speed || 1) || 1,
        keepText: false,
        timeoutMs: 120000,   // [qqbot-mod] 300s→120s：试听不该让前端干等 5 分钟
      });
      const ms = Date.now() - t0;
      if (!r || !r.ok || !r.path) {
        writeJson(res, 200, { ok: false, error: String((r && (r.error || r.reason)) || '合成失败'), ms, via: (r && r.via) || '' });
        return;
      }
      // 复制到 preview 目录（固定名，方便反复覆盖，不占 tts 目录额度）
      try { mkdirSync(pvDir, { recursive: true }); } catch { }
      const dst = join(pvDir, safe + '.mp3');
      try { copyFileSync(r.path, dst); } catch { }
      // [qqbot-mod] preview-sample：首次成功 → 存预录样本（同音色+引擎下次秒播）
      if (isStdText) {
        try { copyFileSync(r.path, join(pvDir, 'smp_' + safe + '__' + String(engName).replace(/[^0-9A-Za-z_-]/g, '_') + '.mp3')); } catch { }
      }
      writeJson(res, 200, {
        ok: true, voice, engine: engName, ms,
        bytes: Number(r.bytes || 0), via: r.via || '',
        url: '/api/qqbot-settings/tts-preview-file?name=' + encodeURIComponent(safe + '.mp3') + '&ns=' + encodeURIComponent(String(body.ns || '')) + '&t=' + Date.now(),
      });
    } catch (e) {
      writeJson(res, 200, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  route(ctx, 'GET', '/api/qqbot-settings/tts-preview-file', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(String(u.searchParams.get('ns') || ''));
      const root = resolveMemoryRoot(bot);
      // [qqbot-mod] preview-any 2026-10-28 主人要求「直接播放预先合成好的」：
      //   支持按 voice 直取 —— 不指定引擎，目录里有该音色任何一份预录样本就播（优先 gsv）。
      const voiceQ = String(u.searchParams.get('voice') || '').trim();
      let p = '';
      if (voiceQ) {
        const safeQ = voiceQ.replace(/[^0-9A-Za-z_-]/g, '_');
        if (safeQ && !safeQ.includes('..')) {
          const pvDir = join(root, '.qqbot', 'tts', 'preview');
          const pick = ['smp_' + safeQ + '__gsv.mp3', 'smp_' + safeQ + '__index.mp3', 'smp_' + safeQ + '__breeze.mp3'];
          for (const cand of pick) { if (existsSync(join(pvDir, cand))) { p = join(pvDir, cand); break; } }
          if (!p) {
            try {
              const any_ = readdirSync(pvDir).find((f) => f.startsWith('smp_' + safeQ + '__') && f.endsWith('.mp3'));
              if (any_) p = join(pvDir, any_);
            } catch { }
          }
        }
      } else {
        const name = String(u.searchParams.get('name') || '');
        if (!/^[0-9A-Za-z_-]+\.mp3$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
        const p2 = join(root, '.qqbot', 'tts', 'preview', name);
        if (existsSync(p2)) p = p2;
      }
      if (!p) { res.writeHead(404); res.end('not found'); return; }
      const buf = readFileSync(p);
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(buf.length), 'cache-control': 'no-store' });
      res.end(buf);
    } catch (e) {
      res.writeHead(500); res.end(String(e && e.message ? e.message : e));
    }
  });


  // [qqbot-mod] comment-status v3：台账 rpid 逐条以"匿名能不能翻到"判定 + 扫最近视频最新评论补漏
  route(ctx, 'GET', '/api/qqbot-settings/bili-comment-status', async (req, res) => {
    try {
      const uq = new URL(req.url, 'http://x').searchParams;
      const ns = String(uq.get('ns') || '');
      const limit = Math.max(1, Math.min(20, Number(uq.get('limit') || 8)));
      const bot = nsBot(ns);
      const root = resolveMemoryRoot(bot);
      let api = null;
      try {
        const extRoot = join(String(bot.cwd || 'F:/qqbot'), 'dshqqbot', '.qqbot-extensions', 'lib', 'bili-api.mjs').replace(/\\/g, '/');
        api = await import('file:///' + extRoot);
      } catch (e) { api = null; }
      if (!api) return writeJson(res, 200, { ok: false, error: '找不到 bili-api.mjs' });

      const me = api.loadCookie(root);
      const myMid = String((me && me.cookies && me.cookies.DedeUserID) || '');

      // ① 本地台账
      const files = [join(root, '.qqbot', 'bili-ops', 'records.jsonl'), join(root, '..', 'data', 'bili-ops', 'records.jsonl')];
      const recs = [];
      for (const fp of files) {
        if (!existsSync(fp)) continue;
        for (const ln of readFileSync(fp, 'utf8').split('\n').filter(Boolean).slice(-600)) {
          try {
            const o = JSON.parse(ln);
            if (!o || !o.rpid) continue;
            recs.push({ at: Number(o.at || o.ts || 0), type: String(o.type || ''), rpid: String(o.rpid), bvid: String(o.bvid || ''), text: String(o.text || '') });
          } catch (e) {}
        }
      }
      recs.sort((a, b) => b.at - a.at);

      const vids = [];
      const pushVid = (b) => { const v = String(b || '').trim(); if (/^BV[0-9A-Za-z]{8,14}$/.test(v) && vids.indexOf(v) < 0) vids.push(v); };
      try { const lv = api.readLastVideo(root); if (lv && lv.bvid) pushVid(lv.bvid); } catch (e) {}
      for (const r of recs) { if (vids.length >= 4) break; pushVid(r.bvid); }

      const aidOf = new Map();
      for (const bvid of vids) {
        try {
          const m = await api.fetchVideoMeta(root, bvid);
          if (m && m.ok) aidOf.set(bvid, { aid: Number(m.aid || 0), title: String(m.title || '') });
        } catch (e) {}
      }

      // ② 台账 rpid 逐条判定（匿名翻 3 页 = 真判据）
      const rows = [];
      const seen = new Set();
      for (const r of recs) {
        if (rows.length >= limit) break;
        if (seen.has(r.rpid)) continue;
        seen.add(r.rpid);
        const meta = aidOf.get(r.bvid) || { aid: 0, title: '' };
        const item = { bvid: r.bvid, title: meta.title, rpid: r.rpid, text: r.text, at: r.at || null, aid: meta.aid, status: 'unknown', hint: '', href: 'https://www.bilibili.com/video/' + r.bvid };
        if (!meta.aid) { item.status = 'unknown'; item.hint = '拿不到 aid（视频可能已删）'; rows.push(item); continue; }
        let anon = null;
        try { anon = await api.locateComment(root, { aid: meta.aid, rpid: r.rpid, anon: true, pages: 3 }); } catch (e) {}
        if (anon && anon.ok && anon.found) {
          item.status = 'public'; item.state = anon.state; item.attr = anon.attr;
          item.hint = '匿名能翻到 = 真公开'; item.via = anon.via;
        } else {
          let self = null;
          try { self = await api.locateComment(root, { aid: meta.aid, rpid: r.rpid, anon: false, pages: 2 }); } catch (e) {}
          if (self && self.ok && self.found) {
            const folded = Math.floor(Number(self.attr || 0) / 2 ** 38) % 2 === 1;
            item.status = folded ? 'review' : 'hidden';
            item.state = self.state; item.attr = self.attr;
            item.hint = folded ? '被折叠：只有自己看得见' : '登录可见、匿名不可见（审核/降权）';
          } else if (r.type === 'comment-failed') { item.status = 'failed'; item.hint = '当时就没发出去'; }
          else { item.status = 'gone'; item.hint = '两边都翻不到：可能已删'; }
        }
        rows.push(item);
      }

      // ③ 补漏：翻每个候选视频"最新 20 条"，把属于我的、台账里没有的也列出来
      const extras = [];
      for (const bvid of vids) {
        const meta = aidOf.get(bvid); if (!meta || !meta.aid) continue;
        let r = null;
        try { r = await api.comments(root, { aid: meta.aid, limit: 20, sort: 'latest' }); } catch (e) {}
        const list = (r && r.ok && (r.replies || [])) || [];
        for (const c of list) {
          const mine = (myMid && String(c.mid) === myMid) || c.isSelf === true;
          if (!mine) continue;
          const rpid = String(c.rpid || '');
          if (!rpid || seen.has(rpid)) continue;
          seen.add(rpid);
          extras.push({
            bvid, title: meta.title, rpid, aid: meta.aid,
            text: String(c.text || ''), at: (Number(c.time || 0) || 0) * 1000 || null,
            state: Number(c.state ?? 0), attr: Number(c.attr ?? 0),
            status: 'public', hint: '线上最新评论里翻到（台账没记）', via: 'live-latest',
            href: 'https://www.bilibili.com/video/' + bvid,
          });
        }
      }

      const all = [...extras, ...rows].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
      writeJson(res, 200, { ok: true, root, myMid, checkedAt: Date.now(), videos: vids, liveCount: extras.length, rows: all });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });


  route(ctx, ['GET', 'POST'], '/api/qqbot-settings/timers', async (req, res) => {
    // POST = 旧版客户端统一 action: body {id, schedDir?, enabled?} —— enabled 存在=开关, 缺省=删除
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body.id !== 'string') return writeJson(res, 400, { error: 'id required' });
      const store = typeof body.schedDir === 'string' && body.schedDir ? getScheduleStore(body.schedDir) : getScheduleStore();
      const removing = body.enabled === undefined;
      const ok = removing ? store.remove(body.id) : store.setEnabled(body.id, body.enabled === true);
      try { store.flush(); } catch { /* ignore */ }
      if (!ok) return writeJson(res, 404, { error: '任务不存在' });
      return writeJson(res, 200, { ok: true });
    }
    const u = new URL(req.url ?? '/', 'http://x');
    writeJson(res, 200, { jobs: timerJobs(dirOf(u, 'schedDir')) });
  });
  // 开关: {id, enabled, schedDir?}
  route(ctx, 'POST', '/api/qqbot-settings/timers/toggle', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body.id !== 'string') return writeJson(res, 400, { error: 'id required' });
    const store = typeof body.schedDir === 'string' && body.schedDir ? getScheduleStore(body.schedDir) : getScheduleStore();
    const ok = store.setEnabled(body.id, body.enabled === true);
    try { store.flush(); } catch { /* ignore */ }
    if (!ok) return writeJson(res, 404, { error: '任务不存在' });
    writeJson(res, 200, { ok: true });
  });
  // 删除: {id, schedDir?}
  route(ctx, 'POST', '/api/qqbot-settings/timers/delete', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body.id !== 'string') return writeJson(res, 400, { error: 'id required' });
    const store = typeof body.schedDir === 'string' && body.schedDir ? getScheduleStore(body.schedDir) : getScheduleStore();
    const ok = store.remove(body.id);
    try { store.flush(); } catch { /* ignore */ }
    if (!ok) return writeJson(res, 404, { error: '任务不存在' });
    writeJson(res, 200, { ok: true });
  });

  // ── 账号与预设管理(第4 tab) ──
  // 账号实例声明在 cordis.patch.yml(改它需重启 dsh 生效); appSecret 明文存本机 profile, 勿提交 git。

  /** YAML 单引号标量(含 ' 转义为 '') */
  function yq(v) { return `'${String(v ?? '').replace(/'/g, "''")}'` }
  /** appSecret 裸写规则: 纯安全字符直接裸, 否则单引号 */
  function ysec(v) { const s = String(v ?? ''); return /^[A-Za-z0-9+/=_\-]+$/.test(s) ? s : yq(s) }
  /** 顶层块行判断(0 缩进以 "- " 开头) */
  function isTopLine(l) { return /^-\s/.test(l) }
  /** 块头是 im-qqbot 实例? */
  function isBotHead(l) { const m = /^-\s*id:\s*(\S+)\s*$/.exec(l.trim()); return m ? /^im-qqbot(-|$)/.test(m[1]) : false }
  function botIdOf(headLine) { const m = /^-\s*id:\s*(\S+)\s*$/.exec(headLine.trim()); return m ? m[1] : '' }

  /** 解析 patch: 返回 {raw, bots:[{id,start,end,ins,cfg:{appId,appSecret,preset,cwd},disabled}], hasFile}
   *  patch 语义(宿主 dsh-app-boot applyEntryPatches): 顶层 `- id: X` 只能覆盖已存在 id(bundle insert 建的);
   *  新增实例必须 `- insert:` 包装(其下 4 空格 `- id: Y`)。本文件里两种形态都识别。 */
  function parsePatchFrom(rawText) {
    const hasFile = existsSync(PATCH_FILE);
    const raw = rawText !== undefined && rawText !== null ? String(rawText) : (hasFile ? readFileSync(PATCH_FILE, 'utf8') : '');
    // 行尾容错: 兼容 CRLF(2026-09-08 曾因 patch 被写成 CRLF 导致整段解析失败)
    const lines = raw.split(/\r?\n/);
    const bots = [];
    let i = 0;
    while (i < lines.length) {
      const t = lines[i];
      if (isTopLine(t) && isBotHead(t)) {
        // 顶层覆盖形态: head 缩进 0
        const id = botIdOf(t);
        const start = i;
        let j = i + 1;
        const cfg = {};
        let disabled = false;
        let inCfg = false;
        while (j < lines.length && (lines[j].trim() === '' || !isTopLine(lines[j]))) {
          const c = lines[j];
          if (/^\s{2}config:\s*$/.test(c)) inCfg = true;
          else if (/^\s{2}disabled:\s*true\s*$/.test(c)) disabled = true;
          else if (inCfg && /^\s{4}(\S[^:]*):\s*(.*)$/.test(c)) {
            const km = /^\s{4}(\S[^:]*):\s*(.*)$/.exec(c);
            cfg[km[1]] = km[2].trim().replace(/^'|'$/g, '').replace(/''/g, "'");
          }
          j += 1;
        }
        bots.push({ id, start, end: j, ins: false, cfg, disabled, headLine: start });
        i = j;
      } else if (isTopLine(t) && /^\s*-\s*insert:\s*$/.test(t)) {
        // insert 形态: 找其下 4 空格 `- id: im-qqbot*`
        const insStart = i;
        let k = i + 1;
        let found = null;
        while (k < lines.length && (lines[k].trim() === '' || /^\s/.test(lines[k]) && !/^-\s/.test(lines[k]) || /^\s{2,}/.test(lines[k]))) {
          // 在 insert 列表内(行以空白开头或为列表项), 找 4 空格 "- id:"
          const c = lines[k];
          const m4 = /^\s{4}-\s*id:\s*(\S+)\s*$/.exec(c);
          if (m4 && /^im-qqbot(-|$)/.test(m4[1])) { found = { line: k, id: m4[1] }; break; }
          if (/^-\s/.test(c) && !/^\s/.test(c)) break; // 下一个顶层条目
          if (c.trim() !== '' && !/^\s/.test(c) && !/^-\s/.test(c)) break;
          k += 1;
        }
        if (found) {
          const id = found.id;
          let j = found.line + 1;
          const cfg = {};
          let disabled = false;
          let inCfg = false;
          while (j < lines.length && (lines[j].trim() === '' || /^\s{2,}/.test(lines[j]) && !isTopLine(lines[j]))) {
            const c = lines[j];
            if (/^\s{6}config:\s*$/.test(c)) inCfg = true;
            else if (/^\s{6}disabled:\s*true\s*$/.test(c)) disabled = true;
            else if (inCfg && /^\s{8}(\S[^:]*):\s*(.*)$/.test(c)) {
              const km = /^\s{8}(\S[^:]*):\s*(.*)$/.exec(c);
              cfg[km[1]] = km[2].trim().replace(/^'|'$/g, '').replace(/''/g, "'");
            }
            if (isTopLine(lines[j])) break;
            j += 1;
          }
          bots.push({ id, start: insStart, end: j, ins: true, cfg, disabled, headLine: found.line });
          i = j;
        } else {
          i += 1;
        }
      } else {
        i += 1;
      }
    }
    return { raw, hasFile, bots };
  }
  /** 从磁盘读取并解析(parsePatchFrom 的包装) */
  function parsePatch() { return parsePatchFrom(undefined); }

  /** 渲染一个实例块。主 im-qqbot(bundle 已 insert)→ 顶层覆盖; 新实例 → `- insert:` 包装(4/6/8 缩进) */
  function renderBotBlock(inst) {
    const id = String(inst.id || 'im-qqbot');
    const isMain = id === 'im-qqbot';
    const L0 = isMain ? 0 : 4; // 条目行缩进(主=0, insert 内=4)
    const pad0 = ' '.repeat(L0);
    const pad2 = ' '.repeat(L0 + 2);
    const pad4 = ' '.repeat(L0 + 4);
    const out = [];
    if (!isMain) out.push('- insert:');
    out.push(`${pad0}- id: ${id}`);
    if (!isMain) out.push(`${pad2}name: '@zaofan/dsh-qqbot'`);
    if (inst.disabled) out.push(`${pad2}disabled: true`);
    out.push(`${pad2}config:`);
    if (inst.appId) out.push(`${pad4}appId: ${yq(inst.appId)}`);
    if (inst.appSecret) out.push(`${pad4}appSecret: ${ysec(inst.appSecret)}`);
    if (!isMain) out.push(`${pad4}settingsNs: ${yq(id)}`); // 多账号实例身份: settings 命名空间按实例唯一
    if (inst.preset) out.push(`${pad4}preset: ${yq(inst.preset)}`);
    out.push(`${pad4}requireMention: false`);
    out.push(`${pad4}historyLimit: 20`);
    if (inst.cwd) out.push(`${pad4}cwd: ${yq(inst.cwd)}`);
    if (inst.dataRoot) out.push(`${pad4}dataRoot: ${yq(inst.dataRoot)}`); // 数据根(可选; 保存时保留, 见 saveInstances)
    return out.join('\n');
  }

  /** 在已有条目块内只更新指定键，保留原结构(缩进/位置/未知字段如 groupAdmin、dataRoot、name)。
   *  ⚠️ 2026-09-10 新增: 原实现用 renderBotBlock 整块重建 —— 会把 insert: 下的 im-qqbot-2 提成顶层
   *  `- id: im-qqbot`(新版无此 entry, 直接让整棵插件树加载失败), 并丢掉 name/settingsNs/historyLimit/
   *  groupAdmin/dataRoot 等未在渲染里列出的字段。改为原地增量更新后结构不再被破坏。
   *  ⚠️ 2026-09-10 二次修复: 除更新已存在的键外, 还要**补写缺失的键**(如原本没有 cwd 的实例),
   *  否则前端填了 cwd 也保存不进去(实测 im-qqbot-3 只更新 3/4 个键)。disabled 走块头层(children of id)。
   *  @param {string[]} lines 文件全部行(会被原地修改)
   *  @param {number} start 块首行索引(含, 即 `- id:` 或 `- insert:` 行)
   *  @param {number} end 块结束行索引(不含)
   *  @param {Record<string,string>} kv 要写入的键值(值为字符串); 已存在则改, 缺失则按规矩新增
   *  @returns {number} 实际写入的键数 */
  function updateKeysInBlock(lines, start, end, kv) {
    // 块头行: insert 包装时块首是 `- insert:`, 真正的 `- id:` 在下一行
    let headIdx = start;
    for (let i = start; i < Math.min(start + 3, end); i += 1) {
      if (/^\s*-\s*id:/.test(lines[i])) { headIdx = i; break; }
    }
    const headIndent = ((lines[headIdx] ?? '').match(/^\s*/) ?? [''])[0].length;
    const childIndent = headIndent + 2;      // name: / disabled: / config: 的缩进

    const pending = new Map(Object.entries(kv));
    let touched = 0;
    // ① 已存在的键: 原地改写(保留原缩进)
    for (let i = headIdx + 1; i < end && pending.size > 0; i += 1) {
      const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      const key = m[2];
      if (!pending.has(key)) continue;
      lines[i] = `${m[1]}${key}: ${pending.get(key)}`;
      pending.delete(key);
      touched += 1;
    }
    if (pending.size === 0) return touched;

    // ② 缺失的键: 找本条目自己的 `config:` 行(缩进 = childIndent, 避免命中嵌套的 groupAdmin 等)
    let cfgLine = -1;
    for (let i = headIdx + 1; i < end; i += 1) {
      if (new RegExp(`^\\s{${childIndent}}config:\\s*$`).test(lines[i])) { cfgLine = i; break; }
    }
    const keyIndent = childIndent + 2;       // config 下子键的缩进
    const addLines = [];
    for (const [key, val] of pending) {
      // disabled 属于条目层(childIndent), 也放这里 —— YAML 不要求键顺序
      addLines.push(`${' '.repeat(key === 'disabled' ? childIndent : keyIndent)}${key}: ${val}`);
    }
    if (cfgLine >= 0) {
      // 找 config: 之下最后一个同级键(含其子块), 插在后面。
      // 注意: 同级键的缩进 == keyIndent(不是 >), 用 >= 才能走到最后一个键;
      //       带子块的键(如 groupAdmin:) 其子行缩进 > keyIndent 也要一并跨过。
      let scan = cfgLine + 1;
      let lastLine = cfgLine;
      while (scan < end) {
        const blank = lines[scan].trim() === '';
        const ind = ((lines[scan].match(/^\s*/) ?? [''])[0]).length;
        if (!blank && ind >= keyIndent) { lastLine = scan; scan += 1; continue; }
        break;
      }
      lines.splice(lastLine + 1, 0, ...addLines);
    } else {
      // 没有 config: —— 在块头后补一个 config: 再放键
      let insertAt = end;
      for (let i = headIdx + 1; i < end; i += 1) {
        const ind = ((lines[i].match(/^\s*/) ?? [''])[0]).length;
        if (lines[i].trim() !== '' && ind <= headIndent && /- /.test(lines[i])) { insertAt = i; break; }
      }
      lines.splice(insertAt, 0, `${' '.repeat(childIndent)}config:`, ...addLines);
    }
    return touched + addLines.length;
  }


  /** 保存实例清单(全量同步; 行级重建, 其它插件行/注释原样保留)
   *  借鉴 dsh-qqbot-panel(2026-09-06): appSecret 空值/掩码(********) = 保留原值,
   *  只有提供全新非掩码值才覆盖 —— 前端只回显掩码, 不会因漏传/未改而误清 secret。
   *  ⚠️ 2026-09-09: dataRoot 同理 —— 前端不编辑它, 保存时必须保留原值,
   *     否则 accounts/save 会把 patch.yml 里的 dataRoot 覆盖掉(图库路径回退 cwd 的根因)。
   *  ⚠️ 2026-09-10: 已存在的条目改为"原地只更新字段", 不再整块重建(见 updateKeysInBlock 注释)。 */
  function saveInstances(instances) {
    const { raw, hasFile, bots } = parsePatch();
    if (!hasFile) return { ok: false, error: '找不到 cordis.patch.yml(仅 web profile 支持)' };
    const lines = raw.split('\n');
    const removals = [];
    const updates = [];
    const appends = [];
    const targetIds = new Set(instances.filter((x) => !x.remove).map((x) => String(x.id)));
    // 删除: 只删「没被提交的机器人条目」或显式 remove 的条目, 且范围严格限定在该条目自身:
    //   起点 = 它自己的 `- id:` 行(headLine, 不是包裹它的 `- insert:` 行),
    //   终点 = 下一个同级机器人条目的 headLine(或该 insert 块结束)。
    // ⚠️ 2026-09-10 事故一: 原用 { start: b.start }(insert 包装时为 `- insert:` 行) 且 end 取块末,
    //    导致同一 insert 下的其它插件条目(mcp-chrome)被连带删除。现改为按 headLine 精确切分。
    // ⚠️ 2026-09-10 事故二: 前端把"空骨架实例"(如用于禁用幽灵 im-qqbot 的 `- id: im-qqbot`
    //    + disabled: true, appId/appSecret 均为空)过滤掉不提交 → 会被当成"要删除"而误删,
    //    删掉后下次启动又触发扫码。故: 无凭据(appId/appSecret 皆空)的条目一律保留, 不参与自动删除。
    const removeIds = new Set(instances.filter((x) => x.remove).map((x) => String(x.id)));
    const doomed = bots.filter((b) => {
      if (removeIds.has(b.id)) return true;
      if (targetIds.has(b.id)) return false;
      const hasCred = !!(b.cfg?.appId || b.cfg?.appSecret);
      return hasCred;
    });
    for (const b of doomed) {
      const sameGroup = bots
        .filter((o) => o !== b && o.ins === b.ins && o.start === b.start && o.headLine > b.headLine)
        .sort((x, y) => x.headLine - y.headLine);
      const nextHead = sameGroup.length ? sameGroup[0].headLine : b.end;
      let tail = nextHead;
      while (tail > b.headLine + 1 && (lines[tail - 1] ?? '').trim() === '') tail -= 1;
      removals.push({ start: b.headLine, end: tail });
    }
    for (const inst of instances) {
      if (inst.remove) continue;
      const orig = bots.find((b) => b.id === String(inst.id));
      // 掩码/空 → 保留原 secret(仅当原值存在; 全新账号本就无原值则维持空)
      let secret = String(inst.appSecret ?? '');
      if (!secret || secret === SECRET_MASK) secret = orig?.cfg?.appSecret ? String(orig.cfg.appSecret) : '';
      // 前端不编辑 dataRoot → 保留原值(2026-09-09: 曾因保存覆盖丢失导致图库路径回退 cwd)
      let dataRoot = inst.dataRoot;
      if (dataRoot === undefined && orig?.cfg?.dataRoot) dataRoot = orig.cfg.dataRoot;

      if (orig) {
        const kv = {};
        // ✅ 2026-09-24：已有账号的 appId/appSecret/preset/cwd 只写**自有存储**，不再写 patch。
        //    原因：patch 里 - insert: 下挂多条目时，updateKeysInBlock 的块边界会跨到隔壁条目，
        //    实测把 im-qqbot-2 的凭据写进了 mcp-chrome、并给 im-qqbot-3 追加重复键。
        //    插件启动时自有存储会覆盖 patch 值，所以只写自有存储完全等效，且绝不会写歪。
        //    disabled 例外：它是宿主的 entry 属性、不在 config 里，必须继续写 patch。
        const ownKv = {};
        if (inst.appId !== undefined) ownKv.appId = String(inst.appId);
        if (secret) ownKv.appSecret = String(secret);
        if (inst.preset !== undefined && String(inst.preset) !== '') ownKv.preset = String(inst.preset);
        if (inst.cwd !== undefined && String(inst.cwd) !== '') ownKv.cwd = String(inst.cwd);
        try {
          const nsKey = String(inst.settingsNs || inst.id);
          writeOwnSettings(nsKey, Object.assign(readOwnSettings(nsKey), ownKv));
        } catch { /* 自有存储失败 → 退化到写 patch（下面仍会处理 disabled） */ }
        if (inst.disabled !== undefined) kv.disabled = inst.disabled ? 'true' : 'false';
        if (Object.keys(kv).length) updates.push({ id: String(inst.id), kv });
        updates.push({ id: String(inst.id), kv });
      } else {
        appends.push(renderBotBlock({ ...inst, appSecret: secret, dataRoot }));
      }
    }
    // 先删块(倒序), 再逐条原地改字段。
    // ⚠️ 每次更新前重新 parsePatch 取最新下标: splice 过(删除或插入新键)之后,
    //    之前算好的 start/end 会错位, 曾导致插入落到错误缩进上把 YAML 写坏。
    for (const r of removals.sort((a, b) => b.start - a.start)) lines.splice(r.start, r.end - r.start);
    for (const u of updates) {
      let fresh = null;
      try {
        const reparsed = parsePatchFrom(lines.join('\n'));
        fresh = reparsed.bots.find((b) => b.id === u.id) ?? null;
      } catch { fresh = null; }
      if (!fresh) continue;
      updateKeysInBlock(lines, fresh.start, fresh.end, u.kv);
    }
    let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    if (appends.length) out += (out.trimEnd() ? '\n' : '') + appends.join('\n') + '\n';
    writeFileSync(`${PATCH_FILE}.bak`, raw, 'utf8');
    // ✅ 2026-09-24 兜底①：写前按 (条目,缩进,键) 去重。
    //    起因：`- insert:` 下挂多条目时块边界会跨到隔壁条目，曾把凭据写进 mcp-chrome、
    //    并给 im-qqbot-3 追加重复键；重复键会让宿主 YAML 解析抛错、dsh 完全起不来。
    out = dedupeYamlKeys(out);
    // ✅ 2026-09-24 兜底②：把凭据同步写进插件自有存储。
    //    插件启动时自有存储**覆盖** patch 的值，所以即便 patch 被写歪，机器人照样用正确凭据连上。
    try {
      for (const inst of instances) {
        if (inst.remove) continue;
        const nsKey = String(inst.settingsNs || inst.id);
        const cur = readOwnSettings(nsKey);
        let sec = String(inst.appSecret ?? '');
        if (!sec || sec === SECRET_MASK) sec = cur.appSecret ? String(cur.appSecret) : '';
        if (inst.appId !== undefined) cur.appId = inst.appId;
        if (sec) cur.appSecret = sec;
        if (inst.preset) cur.preset = String(inst.preset);
        if (inst.cwd) cur.cwd = String(inst.cwd);
        if (inst.disabled !== undefined) cur.disabled = !!inst.disabled;
        writeOwnSettings(nsKey, cur);
      }
    } catch { /* 自有存储失败不阻塞 patch 写入 */ }
    writeFileSync(PATCH_FILE, out, 'utf8');
    return { ok: true, file: PATCH_FILE, needRestart: true };
  }


  // 账号列表(多账号: 每条带 settings ns 与数据目录, 供二级 UI 按账号读写)
  // 借鉴 zhengjy01/dsh-qqbot-panel(2026-09-06): appSecret 只回显掩码(不泄露明文),
  // 并带 hasSecret 供前端区分"已保存"与"真空"; 保存时空值/掩码 = 保留原 secret。

  route(ctx, 'GET', '/api/qqbot-settings/accounts', async (_req, res) => {
    try {
      const { bots, hasFile } = parsePatch();
      const reg = await import('./dist/features/session-registry.js');
      writeJson(res, 200, {
        hasFile,
        instances: bots.map((b) => {
          // ⚠️ 2026-09-28 修：保存时 cwd/preset/appId 只写【自有存储】(见 saveInstances 的 2026-09-24 注释)，
          //   但回显原先只读 patch → 界面上填过的 cwd/preset 保存后就"变空"/"显示旧值"。
          //   **自有存储优先**（那是用户在设置页保存的最新值；patch 是历史旧值），与 /read 一致。
          let ownCfg = {};
          try { ownCfg = readOwnSettings(String(b.cfg?.settingsNs || b.id)) || {}; } catch { ownCfg = {}; }
          const pickOwn = (k) => {
            const o = ownCfg[k];
            if (o !== undefined && o !== '') return o;
            const c = b.cfg ? b.cfg[k] : undefined;
            return c !== undefined && c !== '' ? c : '';
          };
          const cwd = pickOwn('cwd');
          const presetMerged = pickOwn('preset');
          const appIdMerged = pickOwn('appId');
          const hasSecretMerged = !!pickOwn('appSecret');
          // 数据根与 dist 侧 dataRootOf 对齐: 未配 dataRoot → `{cwd}/dshqqbot`(2026-09-12 新默认)
          const droot = b.cfg?.dataRoot || (cwd ? join(cwd, 'dshqqbot') : '');
          return {
            id: b.id,
            ns: b.id, // settings 命名空间 = 实例 id(主 im-qqbot; 非主实例 render 已写 settingsNs=id)
            appId: appIdMerged,
            appSecret: hasSecretMerged ? SECRET_MASK : '', // 掩码回显(借鉴 panel: masked)
            hasSecret: hasSecretMerged,
            preset: presetMerged,
            cwd,
            disabled: !!b.disabled || ownCfg.disabled === true,
            online: typeof reg.isBotOnline === 'function' ? reg.isBotOnline(b.id) : false, // 在线状态(bot ws ready 事件驱动)
            // 账号数据目录(各号各库各定时): 图库={cwd}/表情包, 定时={cwd}/.qqbot
            dataDir: droot ? join(droot, '表情包') : '',
            schedDir: droot ? join(droot, '.qqbot') : '',
          };
        }),
      });
    } catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
  });
  // 保存账号清单: body {instances:[{id,appId,appSecret,preset,cwd,disabled,remove}]}
  route(ctx, 'POST', '/api/qqbot-settings/accounts/save', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || !Array.isArray(body.instances)) return writeJson(res, 400, { error: 'instances 数组必填' });
    try {
      const r = saveInstances(body.instances);
      writeJson(res, r.ok ? 200 : 400, r);
    } catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
  });

  // ── 工作区列表(借鉴 zhengjy01/dsh-qqbot-panel 的 workspace picker, 2026-09-06):
  //    列出"已有 dsh 会话"的工作区目录 + 会话数, 供账号 cwd 挑选(避免指到空目录/错目录)。
  //    dsh 把会话按工作区路径归到 ~/.dsh/sessions/--<编码路径>--, 目录内 *.zstd = 会话数。
  /** dsh session 目录名 → 工作区绝对路径(~XXXX 为 UTF-16 code unit, - 为段分隔, 首段补盘符冒号) */
  function decodeSessionDirName(name) {
    try {
      const segs = name.split('-').filter(Boolean);
      if (segs.length === 0) return '';
      const decoded = segs.map((s) => s.replace(/~([0-9A-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))));
      // 首段是盘符(D / C) → 补冒号; 其余段拼回路径分隔
      // ① Windows 盘符：首段是单个字母 → X:\a\b
      if (/^[A-Za-z]$/.test(decoded[0])) {
        const sep = '\\';
        return decoded[0] + ':' + (decoded.length > 1 ? sep + decoded.slice(1).join(sep) : sep);
      }
      // ② POSIX（Linux/Android）：编码时丢了前导 '/'，这里补回来
      return '/' + decoded.join('/');
    } catch { return ''; }
  }
  route(ctx, 'GET', '/api/qqbot-settings/workspaces', async (_req, res) => {
    try {
      const sessionsRoot = join(homedir(), '.dsh', 'sessions');
      const out = [];
      if (existsSync(sessionsRoot)) {
        for (const ent of readdirSync(sessionsRoot, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const dir = join(sessionsRoot, ent.name);
          let count = 0;
          try {
            // 会话文件(.zstd)在 workspace 目录的深层子目录里, 需递归统计
            const stack = [dir];
            while (stack.length) {
              const cur = stack.pop();
              for (const f of readdirSync(cur, { withFileTypes: true })) {
                const p = join(cur, f.name);
                if (f.isDirectory()) stack.push(p);
                else if (f.isFile() && f.name.endsWith('.zstd')) count += 1;
              }
            }
          } catch { /* 目录读取失败忽略 */ }
          const path = decodeSessionDirName(ent.name);
          out.push({ dir: ent.name, path: path || ent.name, count });
        }
      }
      out.sort((a, b) => b.count - a.count);
      writeJson(res, 200, { workspaces: out });
    } catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
  });

  // ── agent 预设: 列表/复制/打开文件夹/说明 ──
  /** QQ 通道工具插件的规范行 id/name(复制预设时自动补上; 新行名跟随本安装主包) */
  const CHANNEL_TOOLS_ROW_ID = 'qqbot-channel-tools';
  const CHANNEL_TOOLS_ROW_NAME = '@zaofan/dsh-qqbot/channel-tools';
  /** 检测 preset 的 agent.cordis.yml 是否已含 qqbot-channel-tools 插件行 */
  function presetHasChannelTools(base) {
    try {
      const txt = readFileSync(join(base, 'agent.cordis.yml'), 'utf8');
      // 匹配连续的 "- id: qqbot-channel-tools" 与 "name: .../channel-tools" 两行(m: $=每行行尾)
      return /id:\s*qqbot-channel-tools\s*\n[ \t]*name:\s*['"]?[^'\n]*\/channel-tools['"]?\s*$/m.test(txt);
    } catch { return false; }
  }
  /** 若 preset 缺 channel-tools 插件行, 在 agent.cordis.yml 末尾自动补上(幂等) */
  function ensureChannelToolsRow(base) {
    const p = join(base, 'agent.cordis.yml');
    let txt = '';
    try { txt = readFileSync(p, 'utf8'); } catch { return false; }
    if (presetHasChannelTools(base)) return true;
    const sep = txt.endsWith('\n') ? '' : '\n';
    txt += `${sep}- id: ${CHANNEL_TOOLS_ROW_ID}\n  name: '${CHANNEL_TOOLS_ROW_NAME}'\n`;
    writeFileSync(p, txt, 'utf8');
    return true;
  }
  function scanPresets() {
    if (!existsSync(PRESET_ROOT)) return [];
    const out = [];
    for (const dir of readdirSync(PRESET_ROOT, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const id = dir.name;
      const base = join(PRESET_ROOT, id);
      if (!existsSync(join(base, 'agent.cordis.yml'))) continue;
      let name = '';
      try {
        const pm = join(base, 'preset.yml');
        if (existsSync(pm)) {
          const m = /^name:\s*(.*)$/m.exec(readFileSync(pm, 'utf8'));
          if (m) name = m[1].trim().replace(/^["']|["']$/g, '');
        }
      } catch { /* ignore */ }
      let mtime = 0;
      try { mtime = statSync(join(base, 'agent.cordis.yml')).mtimeMs; } catch { /* ignore */ }
      out.push({ id, name: name || id, mtime, hasChannelTools: presetHasChannelTools(base) });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }
  /**
   * 列出可用预设（双模式，2026-09-23 适配 dsh 0.1.7）。
   *  - dsh 0.1.7+：走宿主 `agentPresets.list()` —— 新版预设是 profile 配置里的
   *    「声明行」(@deepseek-ai/dsh-agent-preset)，**已无目录**，扫目录只会得到空列表；
   *  - dsh ≤0.1.6：回落 `scanPresets()` 扫 {DSH_HOME}/.agent-presets 目录（旧机制）。
   *  统一返回 [{id, name, description, source}]，source=registry|dir。
   */
  /**
   * 安全取宿主 agentPresets 服务（2026-09-23 实测修正）。
   * ⚠️ cordis 对**未在 inject 里声明**的服务, 裸访问 `ctx.xxx` 会直接抛
   *    "cannot get property \"agentPresets\" without inject"（0.1.7 上实测命中）。
   *    而桥的 inject 只声明 settings/webServer（多声明会让宿主缺服务时整个 apply 不执行），
   *    所以这里必须用 **ctx.get()**（不抛）探测，拿不到返回 null 走旧目录回落。
   */
  function getAgentPresets() {
    try {
      if (ctx && typeof ctx.get === 'function') {
        const svc = ctx.get('agentPresets');
        if (svc) return svc;
      }
    } catch { /* ignore */ }
    try { return (ctx && ctx.agentPresets) || null; } catch { return null; }
  }
  async function listPresets() {
    const ap = getAgentPresets();
    if (ap && typeof ap.list === 'function') {
      try {
        const arr = await ap.list();
        if (Array.isArray(arr) && arr.length) {
          return arr
            .map((p) => ({
              id: String((p && p.id) || ''),
              name: String((p && (p.name || p.id)) || ''),
              description: String((p && p.description) || ''),
              source: 'registry',
            }))
            .filter((p) => p.id);
        }
      } catch { /* registry 不可用 → 回落旧目录 */ }
    }
    return scanPresets().map((p) => ({
      id: p.id,
      name: p.name,
      description: '',
      source: 'dir',
      mtime: p.mtime,
      hasChannelTools: p.hasChannelTools,
    }));
  }
  /**
   * 写操作在新版下的统一提示（2026-09-23）。
   * dsh 0.1.7+ 的注册表「不写入任何声明、没有任何接口接受 YAML 写回」，
   * 新增/覆盖预设只能写 profile 的 bundle 补丁 —— 与其静默失败，不如给出明确指引。
   * 返回 null 表示走旧版目录流程。
   */
  function presetWriteBlocked() {
    const ap = getAgentPresets();
    if (ap && typeof ap.list === 'function') {
      return '当前 dsh 版本的预设是「profile 配置里的声明行」，不再是目录文件（官方注册表不接受任何写回）。'
        + '请在 profile 的 cordis.patch.yml 里用 `- insert:` 添加/修改 `@deepseek-ai/dsh-agent-preset` 行'
        + '（或用创造模式生成 bundle），保存后由 patchReload 热生效。';
    }
    return null;
  }
  route(ctx, 'GET', '/api/qqbot-settings/presets', async (_req, res) => {
    try {
      const presets = await listPresets();
      const viaRegistry = presets.some((p) => p.source === 'registry');
      writeJson(res, 200, { root: viaRegistry ? null : PRESET_ROOT, presets, mode: viaRegistry ? 'registry' : 'dir' });
    } catch (e) {
      writeJson(res, 500, { error: String((e && e.message) || e) });
    }
  });
  // 复制并双名: {sourceId, newId, newName}
  route(ctx, 'POST', '/api/qqbot-settings/presets/copy', async (req, res) => {
    const body = await readJsonBody(req);
    // dsh 0.1.7+：预设是 profile patch 里的声明行 → 复制 = 整段搬运 + 改写 id/name
    if (getAgentPresets()) {
      if (!body || typeof body.sourceId !== 'string' || typeof body.newId !== 'string') {
        return writeJson(res, 400, { error: 'sourceId/newId 必填' });
      }
      const nId = body.newId.trim();
      if (!ID_RE.test(nId)) return writeJson(res, 400, { error: '预设 id 只能字母/数字开头，含 - _' });
      if (nId === String(body.sourceId).trim()) return writeJson(res, 400, { error: '新预设 id 不能与源相同' });
      const nName = String(body.newName ?? nId).trim() || nId;
      try {
        const arr = await getAgentPresets().list();
        if (Array.isArray(arr) && arr.some((x) => x && x.id === nId)) {
          return writeJson(res, 409, { error: '预设 ' + nId + ' 已存在' });
        }
      } catch { /* 列表不可用时靠 patch 自身判断 */ }
      const srcId = String(body.sourceId).trim();
      // 先按 patch 里的原块整段复制（原汁原味、字节保真）；
      // patch 里没有（如宿主内置预设 standard）→ 回退用宿主文档读出组成再生成
      let r = copyPresetDecl(srcId, nId, nName);
      if (!r.ok) r = await copyPresetViaDocument(srcId, nId, nName);
      if (!r.ok) return writeJson(res, 404, { error: r.error });
      return writeJson(res, 200, { ok: true, newId: nId, backup: r.backup, note: '已写入 profile patch，热生效（新会话生效）' });
    }
    if (!body || typeof body.sourceId !== 'string' || typeof body.newId !== 'string') {
      return writeJson(res, 400, { error: 'sourceId/newId 必填' });
    }
    const newId = body.newId.trim();
    if (!ID_RE.test(newId)) return writeJson(res, 400, { error: '预设 id 只能字母/数字开头，含 - _（也是文件夹名）' });
    const src = join(PRESET_ROOT, String(body.sourceId).trim());
    const dst = join(PRESET_ROOT, newId);
    if (!existsSync(join(src, 'agent.cordis.yml'))) return writeJson(res, 404, { error: '源预设不存在' });
    if (existsSync(dst)) return writeJson(res, 409, { error: `预设 ${newId} 已存在` });
    try {
      cpSync(src, dst, { recursive: true, filter: (s) => !COPY_SKIP.test(s) });
      // 复制出的新预设自动补上 QQ 通道工具插件行(缺则加; 幂等)——保证新人格在 QQ 里能发图/查表情包
      ensureChannelToolsRow(dst);
      // 人设名写入新 preset.yml(name 为 YAML 双引号标量; JSON 转义兼容)
      const pm = join(dst, 'preset.yml');
      if (existsSync(pm)) {
        const txt = readFileSync(pm, 'utf8');
        const nameYaml = JSON.stringify(String(body.newName ?? newId));
        const next = txt.replace(/^name:.*$/m, `name: ${nameYaml}`);
        writeFileSync(pm, next, 'utf8');
      }
      writeJson(res, 200, { ok: true, newId });
    } catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
  });
  // 从内置"标准模式(standard)"新建一个预设(空机器起步用): 复制宿主 standard + 自动补 QQ 通道工具行
  // 复用宿主原生 agentPresets.copy(from,id,name) —— 复制出的正是宿主当前标准版, 保证能跑; 无需自己拼组合。
  route(ctx, 'POST', '/api/qqbot-settings/presets/new', async (req, res) => {
    const body = await readJsonBody(req);
    // dsh 0.1.7+：从 profile patch 里的 preset-standard 声明整段复制出一个新预设
    if (getAgentPresets()) {
      const nId = String(body?.id ?? '').trim();
      const nName = String(body?.name ?? '').trim() || nId;
      if (!ID_RE.test(nId)) return writeJson(res, 400, { error: '预设 id 只能字母/数字开头，含 - _' });
      // standard 是**宿主内置**预设（不在用户 patch 里）→ 用宿主的预设文档读它的组成
      let r = await copyPresetViaDocument('standard', nId, nName);
      if (!r.ok) {
        // 兜底：万一 patch 里正好也有一份 preset-standard，就直接整段复制
        const local = copyPresetDecl('standard', nId, nName);
        if (local.ok) r = local;
      }
      if (!r.ok) return writeJson(res, 500, { error: r.error });
      return writeJson(res, 200, { ok: true, newId: nId, backup: r.backup, note: '已从 standard 生成新预设并写入 profile patch，热生效' });
    }
    const newId = String(body?.id ?? '').trim();
    const newName = String(body?.name ?? '').trim() || undefined;
    if (!ID_RE.test(newId)) return writeJson(res, 400, { error: '预设 id 只能字母/数字开头，含 - _（也是文件夹名）' });
    try {
      const ap = getAgentPresets();
      if (!ap || typeof ap.copy !== 'function') {
        return writeJson(res, 500, { error: '宿主未提供 agentPresets 服务, 无法从标准模式新建' });
      }
      await ap.copy('standard', newId, newName);
      const dstDir = join(PRESET_ROOT, newId);
      ensureChannelToolsRow(dstDir);
      writeJson(res, 200, { ok: true, newId });
    } catch (e) {
      const msg = String(e?.message ?? e);
      // 宿主 RemoteError 里的用户可读文案: 取含中文(预设/已存在)的后段
      const m = /(预设|preset|id|已存在|exist)[^\n]*$/im.exec(msg);
      writeJson(res, 500, { error: m ? m[0] : msg });
    }
  });
  // 打开预设文件夹(本机弹资源管理器; 仅限 presetRoot 内白名单路径)
  route(ctx, 'POST', '/api/qqbot-settings/presets/open', async (req, res) => {
    const blocked = presetWriteBlocked();
    if (blocked) return writeJson(res, 501, { error: blocked });
    const body = await readJsonBody(req);
    const id = String(body?.id ?? '').trim();
    if (!ID_RE.test(id)) return writeJson(res, 400, { error: '非法的预设 id' });
    const dir = join(PRESET_ROOT, id);
    if (!dir.startsWith(PRESET_ROOT) || !existsSync(join(dir, 'agent.cordis.yml'))) {
      return writeJson(res, 404, { error: '预设不存在' });
    }
    try {
      // [qqbot-mod] 2026-10-28: cmd start 直启（rundll32 首版参数传错会弹错误框，弃用）
      const child = spawn('cmd', ['/c', 'start', '', dir], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      writeJson(res, 200, { ok: true });
    } catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
  });


  // ── 预设人格文件浏览/编辑(2026-09-07): "展开改写人格"。安全: 仅 PRESET_ROOT/{id} 内白名单文件;
  //    写权限仅限"复制出来带QQ工具标记"的副本(防误改内置/半成品); 大小上限 200KB。
  //
  // ── 2026-09-24 适配 dsh 0.1.7：预设改为 profile patch 里的声明行后，目录没了，
  //    但「人设正文」仍在 patch 内（persona 插件 config.prefix 的块标量）。
  //    这里为它提供"虚拟文件"读写：只动那一段块标量，其余内容一个字节都不碰。
  const PRESET_EDIT_EXT = /.(yml|yaml|json|mjs|js|md|txt)$/i;
  const PRESET_EDIT_MAX = 200 * 1024;

  /** 定位 profile patch 里某个预设声明块 `- id: preset-<id>`。 */
  function locatePresetBlock(lines, presetId) {
    const esc = String(presetId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^\\s*-\\s*id:\\s*[\'"]?preset-' + esc + '[\'"]?\\s*$');
    const head = lines.findIndex((l) => re.test(l));
    if (head < 0) return null;
    const headIndent = (lines[head].match(/^\s*/) || [''])[0].length;
    let end = lines.length;
    for (let i = head + 1; i < lines.length; i++) {
      const ind = (lines[i].match(/^\s*/) || [''])[0].length;
      if (/- /.test(lines[i]) && ind <= headIndent) { end = i; break; }
    }
    return { head, headIndent, end };
  }

  /**
   * 读预设的人设正文（0.1.7 路径）。
   * 结构: preset 块 → `- id: persona` → `prefix|text|prompt: |-` → 块标量正文
   * @returns {{text:string, indent:number, bodyStart:number, bodyEnd:number}|null}
   */
  function readPresetPersona(presetId, linesOverride) {
    try {
      if (!existsSync(PATCH_FILE)) return null;
      const lines = linesOverride || readFileSync(PATCH_FILE, 'utf8').split(/\r\n|\n/);
      const blk = locatePresetBlock(lines, presetId);
      if (!blk) return null;
      let pi = -1;
      for (let i = blk.head + 1; i < blk.end; i++) {
        if (/^\s*-\s*id:\s*['"]?persona['"]?\s*$/.test(lines[i])) { pi = i; break; }
      }
      if (pi < 0) return null;
      const personaIndent = (lines[pi].match(/^\s*/) || [''])[0].length;
      let ki = -1;
      let indent = 0;
      let inline = false;
      let inlineVal = '';
      for (let i = pi + 1; i < blk.end; i++) {
        const l = lines[i];
        if (/^\s*#/.test(l)) continue;                                   // 注释行跳过
        const mB = /^(\s*)(?:prefix|text|prompt):\s*\|-?\s*$/.exec(l);
        if (mB) { ki = i; indent = mB[1].length; inline = false; break; }
        const mI = /^(\s*)(?:prefix|text|prompt):\s+(\S.*)$/.exec(l);    // 行内标量写法
        if (mI) { ki = i; indent = mI[1].length; inline = true; inlineVal = mI[2].trim(); break; }
        const ind = (l.match(/^\s*/) || [''])[0].length;
        if (/- /.test(l) && ind <= personaIndent) break;
      }
      if (ki < 0) return null;
      if (inline) {
        // 行内写法（如 `prefix: 你是一个 xx 助手`）→ 直接返回那一句
        let v = inlineVal;
        if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
        return { text: v, indent: indent + 2, bodyStart: ki + 1, bodyEnd: ki + 1, inline: true, lineIndex: ki };
      }
      let bEnd = ki + 1;
      while (bEnd < blk.end) {
        const raw = lines[bEnd];
        if (raw.trim() === '') { bEnd++; continue; }
        if (((raw.match(/^\s*/) || [''])[0]).length <= indent) break;
        bEnd++;
      }
      let last = bEnd;
      while (last > ki + 1 && lines[last - 1].trim() === '') last--;
      const body = lines.slice(ki + 1, last);
      const cuts = body.filter((l) => l.trim()).map((l) => (l.match(/^\s*/) || [''])[0].length);
      const cut = cuts.length ? Math.min(...cuts) : indent + 2;
      // 纯空白行原样保留（既不切片也不补缩进），保证「读出 → 原样写回」字节级一致
      const text = body.map((l) => (l.trim() === '' ? l : l.slice(cut))).join('\n');
      return { text, indent: cut, bodyStart: ki + 1, bodyEnd: last };
    } catch { return null; }
  }

  /**
   * 复制一个预设声明（dsh 0.1.7 路径）：在 profile patch 里把 `- id: preset-<src>` 整段
   * 复制一份，只改写三处后追加到顶层数组 —— `- id:` / `config.id` / `config.name`，其余一个字节不动。
   * 行内换行按原文保真，缩进原样搬运。
   */
  function copyPresetDecl(srcId, newId, newName) {
    try {
      if (!existsSync(PATCH_FILE)) return { ok: false, error: 'profile patch 不存在' };
      const raw = readFileSync(PATCH_FILE, 'utf8');
      const parts = raw.split(/(\r\n|\n)/);
      const lineTexts = [];
      const eols = [];
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) lineTexts.push(parts[i]);
        else eols.push(parts[i]);
      }
      const blk = locatePresetBlock(lineTexts, srcId);
      if (!blk) return { ok: false, error: '在 profile patch 里找不到源预设 preset-' + srcId };
      const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const headRe = new RegExp('id:\\s*[\'"]?preset-' + escRe(srcId) + '[\'"]?');
      const seg = lineTexts.slice(blk.head, blk.end);
      const out = [];
      let cfgIndent = -1;
      for (let i = 0; i < seg.length; i++) {
        let l = seg[i];
        const ind = (l.match(/^\s*/) || [''])[0].length;
        if (i === 0) {
          l = l.replace(headRe, 'id: preset-' + newId);
        } else {
          const mCfg = /^(\s*)config:\s*$/.exec(l);
          if (mCfg) { cfgIndent = mCfg[1].length; }
          else if (cfgIndent >= 0 && ind === cfgIndent + 2) {
            if (/^\s*id:\s/.test(l)) l = l.replace(/id:\s*.*$/, 'id: ' + newId);
            else if (/^\s*name:\s/.test(l)) l = l.replace(/name:\s*.*$/, 'name: ' + newName);
          }
        }
        out.push(l);
      }
      const eol = eols[blk.end - 1] || eols[blk.head] || '\n';
      let add = '';
      for (const l of out) add += l + eol;
      let text = raw;
      if (!/[\r\n]$/.test(text)) text += eol;
      text += add;
      const bak = PATCH_FILE + '.bak-copy-' + Date.now();
      try { writeFileSync(bak, raw, 'utf8'); } catch { /* 备份失败不阻塞 */ }
      writeFileSync(PATCH_FILE, text, 'utf8');
      return { ok: true, backup: bak, newId };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  /**
   * 用宿主的 `agentPresets.readDocument(id)` 读来源预设的组成，生成一条新的 preset 声明写进 patch。
   * 用途：**内置预设**（如 `standard`，它不在用户 patch 里）或任何 patch 中不存在的预设。
   * readDocument 官方标注"仅用于查看"——我们只把它当模板读出来，写进**自己的** profile patch。
   */
  async function copyPresetViaDocument(srcId, newId, newName) {
    const ap = getAgentPresets();
    if (!ap || typeof ap.readDocument !== 'function') {
      return { ok: false, error: '宿主未提供 agentPresets.readDocument（读不了内置预设的组成）' };
    }
    let doc;
    try { doc = await ap.readDocument(srcId); }
    catch (e) { return { ok: false, error: '读取源预设 ' + srcId + ' 失败：' + String((e && e.message) || e) }; }
    const content = String((doc && doc.content) || '');
    if (!content.trim()) return { ok: false, error: '源预设 ' + srcId + ' 的组成为空' };
    const pad = '          ';
    const head = [
      '# ── 复制自 ' + srcId + '（组成由宿主的预设文档读出）──',
      '- insert:',
      '    - id: preset-' + newId,
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: ' + newId,
      '        name: ' + newName,
      '        plugins:',
    ];
    const bodyLines = content.split(/\r\n|\n/).map((l) => (l.trim() === '' ? '' : pad + l));
    const raw = readFileSync(PATCH_FILE, 'utf8');
    const parts = raw.split(/(\r\n|\n)/);
    const eol = parts[1] ?? '\n';
    let text = raw;
    if (!/[\r\n]$/.test(text)) text += eol;
    text += head.join(eol) + eol + bodyLines.join(eol) + eol;
    const bak = PATCH_FILE + '.bak-newpreset-' + Date.now();
    try { writeFileSync(bak, raw, 'utf8'); } catch { /* 备份失败不阻塞 */ }
    writeFileSync(PATCH_FILE, text, 'utf8');
    return { ok: true, backup: bak, newId, from: 'document' };
  }

  /** YAML 标量序列化。forceQuote=true 时强制加引号（保留原字段的字符串类型 —— 例如 appId
   *  的 schema 是 string，裸写数字会被 YAML 解析成 number → 宿主 schema 校验失败）。 */
  function yScalar(v, forceQuote) {
    if (v === null || v === undefined) return "''";
    if (typeof v === 'boolean') return String(v);
    const s = String(v);
    if (typeof v === 'number' && !forceQuote) return s;       // 真正的数字字段（historyLimit 等）保持数字
    if (forceQuote) return "'" + s.replace(/'/g, "''") + "'";
    if (typeof v === 'string') {
      if (s === '' || /[:#'"\[\]{}&*!|>%@`,]/.test(s) || /^\s|\s$/.test(s) || /^(true|false|null|~|-?\d)/i.test(s)) {
        return "'" + s.replace(/'/g, "''") + "'";
      }
    }
    return s;
  }
  /** 把值序列化成"一行 YAML"（数组走流式，避免多行插入）。keepType 提示按原字段类型保真。 */
  function yValue(v, keepQuoted, origWasArray) {
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return '[' + v.map((it) => yScalar(it, typeof it === 'string')).join(', ') + ']';
    }
    if (v === '' || v === null || v === undefined) {
      // ⚠️ 空值必须看原字段类型：原本是数组的（owners）写成 `''` 会让宿主 schema 校验失败
      return origWasArray ? '[]' : "''";
    }
    return yScalar(v, keepQuoted || typeof v === 'string');
  }

  /**
   * 把一批字段合并进 profile patch 里某个 entry 的 `config`（dsh 0.1.7 路径，2026-09-24）。
   *
   * 为什么需要：0.1.7 的 `settings.update()` 只接受 **schema 里声明为 volatile** 的字段
   * （源码：`const form = volatileForm(schema); if (!form) throw new Error('Plugin entry "x" has no volatile fields')`），
   * 本插件用自定义 config、没有 schemastery schema → 保存必被拒。这里改为直接改 profile patch：
   * **已存在的字段就地替换值**；patch 里没有的字段记入 `missing` 返回给前端（不擅自新增结构）。
   * 支持一层嵌套对象。写前自动备份，换行逐行保真。
   */
  function mergeEntryConfigInPatch(entryId, patch) {
    try {
      if (!existsSync(PATCH_FILE)) return { ok: false, error: 'profile patch 不存在' };
      if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch 必须是对象' };
      const raw = readFileSync(PATCH_FILE, 'utf8');
      const parts = raw.split(/(\r\n|\n)/);
      const lineTexts = [];
      const eols = [];
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) lineTexts.push(parts[i]);
        else eols.push(parts[i]);
      }
      const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const headRe = new RegExp('^\\s*-\\s*id:\\s*[\'"]?' + esc(entryId) + '[\'"]?\\s*$');
      const start = lineTexts.findIndex((l) => headRe.test(l));
      if (start < 0) return { ok: false, error: '在 profile patch 里找不到 entry ' + entryId };
      const headIndent = (lineTexts[start].match(/^\s*/) || [''])[0].length;
      let end = lineTexts.length;
      for (let i = start + 1; i < lineTexts.length; i++) {
        const ind = (lineTexts[i].match(/^\s*/) || [''])[0].length;
        if (/- /.test(lineTexts[i]) && ind <= headIndent) { end = i; break; }
      }
      let ci = -1;
      for (let i = start + 1; i < end; i++) {
        if (/^\s*config:\s*$/.test(lineTexts[i])) { ci = i; break; }
      }
      if (ci < 0) return { ok: false, error: 'entry ' + entryId + ' 在 profile patch 里没有 config: 段' };
      const cfgIndent = (lineTexts[ci].match(/^\s*/) || [''])[0].length;
      const keyIndent = cfgIndent + 2;
      let cEnd = ci + 1;
      for (let i = ci + 1; i < end; i++) {
        if (lineTexts[i].trim() && ((lineTexts[i].match(/^\s*/) || [''])[0]).length <= cfgIndent) break;
        cEnd = i + 1;
      }
      const missing = [];
      const setKey = (key, value, from, to, indent) => {
        // ⚠️ 脱敏占位符绝不写回（2026-09-24 实测事故）：设置页读到的是 viewOf 打码过的
        //    `__REDACTED__`，若原样写入就会把真密钥覆盖掉。这个值一律视为"未修改"。
        if (value === '__REDACTED__') return true;
        const re = new RegExp('^\\s{' + indent + '}' + esc(key) + ':\\s*(.*)$');
        for (let i = from; i < to; i++) {
          if (!re.test(lineTexts[i])) continue;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            let subEnd = i + 1;
            for (let j = i + 1; j < to; j++) {
              if (lineTexts[j].trim() && ((lineTexts[j].match(/^\s*/) || [''])[0]).length <= indent) break;
              subEnd = j + 1;
            }
            for (const [k, v] of Object.entries(value)) {
              if (v === undefined) continue;
              if (!setKey(k, v, i + 1, subEnd, indent + 2)) missing.push(key + '.' + k);
            }
            return true;
          }
          // 按**原字段类型**保真写入（引号风格 / 数组 / 空值），避免写坏宿主 schema：
          // 实测踩坑：appId 裸写数字 → "expected string"；owners 空值写成 '' → "expected array"
          const origRaw = String(lineTexts[i] || '');
          const origVal = ((origRaw.match(/:\s*(.*)$/) || [])[1] || '').trim();
          const origWasArray = origVal === '[]' || origVal.startsWith('- ');
          const keepQuoted = /^['"]/.test(origVal);
          lineTexts[i] = ' '.repeat(indent) + key + ': ' + yValue(value, keepQuoted, origWasArray);
          return true;
        }
        return false;
      };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (!setKey(k, v, ci + 1, cEnd, keyIndent)) missing.push(k);
      }
      let out = '';
      for (let i = 0; i < lineTexts.length; i++) {
        out += lineTexts[i];
        if (i < eols.length) out += eols[i];
      }
      const bak = PATCH_FILE + '.bak-cfg-' + Date.now();
      try { writeFileSync(bak, raw, 'utf8'); } catch { /* 备份失败不阻塞 */ }
      writeFileSync(PATCH_FILE, out, 'utf8');
      return { ok: true, backup: bak, missing };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  /** 写回人设正文（只替换那段块标量，写前自动备份整个 patch）。
   *  ⚠️ 换行符**逐行保真**：patch 可能 LF/CRLF 混用（实测踩过），统一 eol 会改掉别处字节。 */
  function writePresetPersona(presetId, text) {
    try {
      if (!existsSync(PATCH_FILE)) return { ok: false, error: 'profile patch 不存在' };
      const raw = readFileSync(PATCH_FILE, 'utf8');
      const parts = raw.split(/(\r\n|\n)/);
      const lineTexts = [];
      const eols = [];
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) lineTexts.push(parts[i]);
        else eols.push(parts[i]);
      }
      const found = readPresetPersona(presetId, lineTexts);
      if (!found) return { ok: false, error: '没找到该预设的人设段落（persona / prefix）' };
      let pad;
      let insertAt;
      let endAt;
      if (found.inline) {
        // 行内标量 → 升级成块标量（`prefix: |-` + 缩进正文），这样多行人设也存得下
        const keyRaw = lineTexts[found.lineIndex];
        const key = (/(prefix|text|prompt):/.exec(keyRaw) || [])[1] || 'prefix';
        const keyIndent = (keyRaw.match(/^\s*/) || [''])[0];
        lineTexts[found.lineIndex] = keyIndent + key + ': |-';
        pad = keyIndent + '  ';
        insertAt = found.lineIndex + 1;
        endAt = found.lineIndex + 1;
      } else {
        pad = ' '.repeat(found.indent);
        insertAt = found.bodyStart;
        endAt = found.bodyEnd;
      }
      const nl = eols[insertAt - 1] || '\n';   // 沿用原段落的换行风格
      const body = String(text).split(/\r\n|\n|\r/).map((l) => (l.trim() === '' ? l : pad + l));
      const head = lineTexts.slice(0, insertAt);
      const tail = lineTexts.slice(endAt);
      let out = '';
      for (let i = 0; i < head.length; i++) out += head[i] + (eols[i] ?? '\n');
      for (const l of body) out += l + nl;
      for (let i = 0; i < tail.length; i++) {
        out += tail[i];
        const ei = endAt + i;
        if (ei < eols.length) out += eols[ei];
      }
      const bak = PATCH_FILE + '.bak-persona-' + Date.now();
      try { writeFileSync(bak, raw, 'utf8'); } catch { /* 备份失败不阻塞 */ }
      writeFileSync(PATCH_FILE, out, 'utf8');
      return { ok: true, backup: bak };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  function presetDirSafe(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    const dir = resolve(PRESET_ROOT, id);
    if (!dir.startsWith(resolve(PRESET_ROOT) + sep)) return null;
    if (!existsSync(join(dir, 'agent.cordis.yml'))) return null;
    return dir;
  }
  function presetWritable(id) {
    // 安全规则: 仅"复制出来带 QQ 工具标记"的预设可改写(底层/实验预设保持只读)。
    const p = scanPresets().find((x) => x.id === id);
    return !!(p && p.hasChannelTools);
  }
  route(ctx, 'GET', '/api/qqbot-settings/presets/files', async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const rid = String(q.get('id') || '').trim();
    // dsh 0.1.7+：预设声明在 profile patch 里 → 对外虚拟成「人设正文」一个可编辑文件
    if (getAgentPresets()) {
      if (!ID_RE.test(rid)) return writeJson(res, 400, { error: '非法的预设 id' });
      const persona = readPresetPersona(rid);
      if (!persona) return writeJson(res, 404, { error: '该预设没有内联人设段落（persona / prefix）；人格可能在外部 .mjs 文件里' });
      return writeJson(res, 200, {
        id: rid,
        dir: '(profile patch)',
        writable: true,
        files: [{ name: 'persona（人设正文）', size: Buffer.byteLength(persona.text, 'utf8'), mtime: 0 }],
      });
    }
    const dir = presetDirSafe(rid);
    if (!dir) return writeJson(res, 404, { error: '预设不存在' });
    try {
      const files = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && PRESET_EDIT_EXT.test(d.name))
        .map((d) => { const st = statSync(join(dir, d.name)); return { name: d.name, size: st.size, mtime: st.mtimeMs }; })
        .sort((a, b) => (b.name === 'agent.cordis.yml' ? 1 : 0) - (a.name === 'agent.cordis.yml' ? 1 : 0) || a.name.localeCompare(b.name));
      writeJson(res, 200, { id: q.get('id'), dir, writable: presetWritable(q.get('id')), files });
    } catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
  });
  route(ctx, ['GET', 'PUT'], '/api/qqbot-settings/presets/file', async (req, res) => {
    // dsh 0.1.7+：只支持「人设正文」这一个虚拟文件的读写（落在 profile patch 的 persona 块标量里）
    if (getAgentPresets()) {
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const id = String(body?.id ?? '').trim();
        if (!ID_RE.test(id)) return writeJson(res, 400, { error: '非法的预设 id' });
        const content = String(body?.content ?? '');
        if (Buffer.byteLength(content, 'utf8') > PRESET_EDIT_MAX) return writeJson(res, 400, { error: '内容过大(上限 200KB)' });
        const w = writePresetPersona(id, content);
        if (!w.ok) return writeJson(res, 500, { error: w.error });
        return writeJson(res, 200, {
          ok: true,
          name: 'persona（人设正文）',
          size: Buffer.byteLength(content, 'utf8'),
          backup: w.backup,
          note: '已写入 profile patch，patchReload 热生效（新会话生效）',
        });
      }
      const q = new URL(req.url, 'http://x').searchParams;
      const id = String(q.get('id') || '').trim();
      if (!ID_RE.test(id)) return writeJson(res, 400, { error: '非法的预设 id' });
      const persona = readPresetPersona(id);
      if (!persona) return writeJson(res, 404, { error: '该预设没有内联人设段落（persona / prefix）' });
      return writeJson(res, 200, { id, name: 'persona（人设正文）', content: persona.text, writable: true });
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const id = String(body?.id ?? '');
      const dir = presetDirSafe(id);
      const name = String(body?.name ?? '');
      if (!dir || !PRESET_EDIT_EXT.test(name)) return writeJson(res, 400, { error: '参数不合法' });
      const p = join(dir, name);
      if (!existsSync(p) || !resolve(p).startsWith(resolve(dir) + sep)) return writeJson(res, 404, { error: '文件不存在' });
      if (!presetWritable(id)) return writeJson(res, 403, { error: '安全限制: 仅"带QQ工具标记"的复制预设可改写(底层预设只读)' });
      const content = String(body?.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > PRESET_EDIT_MAX) return writeJson(res, 400, { error: '内容过大(上限 200KB)' });
      try {
        const tmp = p + '.tmp-' + Date.now();
        writeFileSync(tmp, content, 'utf8');
        renameSync(tmp, p);
        writeJson(res, 200, { ok: true, name, size: Buffer.byteLength(content, 'utf8') });
      } catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
      return;
    }
    const q = new URL(req.url, 'http://x').searchParams;
    const id = q.get('id') || '';
    const dir = presetDirSafe(id);
    const name = String(q.get('name') || '');
    if (!dir || !PRESET_EDIT_EXT.test(name)) return writeJson(res, 400, { error: '参数不合法' });
    const p = join(dir, name);
    if (!existsSync(p) || !resolve(p).startsWith(resolve(dir) + sep)) return writeJson(res, 404, { error: '文件不存在' });
    try { writeJson(res, 200, { id, name, content: readFileSync(p, 'utf8') }); }
    catch (e) { writeJson(res, 500, { error: String(e?.message ?? e) }); }
  });

  // ── QQ 菜单/指令面板管理(2026-09-07): 经 QQBot.api 网关转发官方接口(v2/menu、v2/panels CRUD+target)。
  //    面板=机器人在会话/群里的指令入口; 菜单=长按/下拉快捷菜单。白名单 path, 仅本机 loopback 可调。
  const QQ_API_PATH_RE = new RegExp('^/v2/(menu|panels)(/[A-Za-z0-9_-]+)?(/target)?$');
  route(ctx, 'POST', '/api/qqbot-settings/qq/proxy', async (req, res) => {
    const body = await readJsonBody(req);
    const ns = String(body?.ns ?? '');
    const method = String(body?.method ?? 'GET').toUpperCase();
    const path = String(body?.path ?? '');
    if (!QQ_API_PATH_RE.test(path)) return writeJson(res, 400, { error: '仅支持 /v2/menu 与 /v2/panels 相关接口' });
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return writeJson(res, 400, { error: '不支持的方法' });
    try {
      const gc = await groupClientOf(ns);
      const apiG = gc && gc.client && gc.client.api;
      if (!apiG || typeof apiG.get !== 'function') return writeJson(res, 400, { error: '找不到该账号实例(未配置/未连接)' });
      const fn = apiG[method.toLowerCase()];
      if (typeof fn !== 'function') return writeJson(res, 400, { error: '网关不支持 ' + method });
      const out = (method === 'GET' || method === 'DELETE')
        ? await fn(path, body && body.query)
        : await fn(path, body && body.body);
      writeJson(res, 200, out ?? { ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e && e.code;
      writeJson(res, 200, { ok: false, err: { code: code || 'QQ_API_ERROR', human: msg } });
    }
  });

  // ── 扫码绑定注册流程(每个账号走 QQ 官方绑定, 拿平台下发的 appId/appSecret) ──(每个账号走 QQ 官方绑定, 拿平台下发的 appId/appSecret) ──
  // 前端拿 qrUrl 打开授权页(手机 QQ 扫码) → host 轮询 → 完成回填。displayQrCodeToConsole=false。
  const bindSessions = new Map(); // id -> {url, creds, error, stop}
  let bindSeq = 0;
  route(ctx, 'POST', '/api/qqbot-settings/bind/start', async (_req, res) => {
    const id = 'bind-' + (++bindSeq) + '-' + Date.now().toString(36);
    try {
      const { startQrConnect } = await import('@tencent-connect/qqbot-connector');
      const sess = { url: '', creds: null, error: null };
      bindSessions.set(id, sess);
      const stop = startQrConnect({
        onSuccess: (creds) => { sess.creds = Array.isArray(creds) ? creds[0] : creds; },
        onFailure: (err) => { sess.error = String(err?.message ?? err); },
        onQrDisplayed: (url) => { sess.url = url; },
        onQrExpired: () => { /* 前端轮询会拿到新 url */ },
      }, { displayQrCodeToConsole: false, source: 'dsh-qqbot' });
      sess.stop = stop;
      // 等第一个二维码 URL(最多 12s)
      const deadline = Date.now() + 12000;
      while (!sess.url && !sess.error && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!sess.url) {
        stop();
        bindSessions.delete(id);
        return writeJson(res, 500, { error: sess.error || '获取绑定二维码超时' });
      }
      writeJson(res, 200, { id, url: sess.url });
    } catch (e) {
      writeJson(res, 500, { error: String(e?.message ?? e) });
    }
  });
  route(ctx, 'GET', '/api/qqbot-settings/bind/poll', async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const id = u.searchParams.get('id') || '';
    const sess = bindSessions.get(id);
    if (!sess) return writeJson(res, 404, { error: '绑定会话不存在或已结束' });
    if (sess.creds) { bindSessions.delete(id); return writeJson(res, 200, { status: 'done', appId: sess.creds.appId, appSecret: sess.creds.appSecret }); }
    if (sess.error) { bindSessions.delete(id); return writeJson(res, 200, { status: 'error', error: sess.error }); }
    writeJson(res, 200, { status: 'wait', url: sess.url });
  });
  route(ctx, 'POST', '/api/qqbot-settings/bind/cancel', async (req, res) => {
    const body = await readJsonBody(req);
    const sess = bindSessions.get(String(body?.id ?? ''));
    if (sess) { try { sess.stop?.(); } catch { /* ignore */ } bindSessions.delete(String(body?.id ?? '')); }
    writeJson(res, 200, { ok: true });
  });

  // ── 图库管理 ──
  // 列表: /api/qqbot-settings/stickers?layer=&q=&untagged=1&includeTrash=1
  route(ctx, 'GET', '/api/qqbot-settings/stickers', async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const layer = u.searchParams.get('layer') || undefined;
    const q = u.searchParams.get('q') || undefined;
    const untagged = u.searchParams.get('untagged') === '1';
    const includeTrash = u.searchParams.get('includeTrash') === '1';
    const store = dirOf(u, 'dataDir') ? getStickerStore(dirOf(u, 'dataDir')) : getStickerStore();
    const items = store.queryAll({ layer: layer === 'all' ? undefined : layer, q: q || undefined, untagged, includeTrash });
    writeJson(res, 200, { items, total: items.length });
  });

  // 缩略图: /api/qqbot-settings/sticker-img?id=xxx (id 由 store 内部解析路径, 不外接路径)
  route(ctx, 'GET', '/api/qqbot-settings/sticker-img', async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const id = u.searchParams.get('id') || '';
    const store = dirOf(u, 'dataDir') ? getStickerStore(dirOf(u, 'dataDir')) : getStickerStore();
    const meta = store.get(id);
    if (!meta) return writeJson(res, 404, { error: 'not found' });
    const p = store.pathOf(id);
    const buf = readFileSync(p);
    const ext = extname(p).replace('.', '').toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
    res.end(buf);
  });

  // 批量: {op:'promote'|'trash'|'restore'|'tag', ids:[], tags?:string[], desc?:string}
  route(ctx, 'POST', '/api/qqbot-settings/stickers/batch', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const store = typeof body.dataDir === 'string' && body.dataDir ? getStickerStore(body.dataDir) : getStickerStore();
    const op = body.op;
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    let okN = 0;
    for (const id of ids) {
      if (op === 'promote') { if (store.promote(id)) okN += 1; }
      else if (op === 'trash') { if (store.markTrash(id)) okN += 1; }
      else if (op === 'restore') { if (store.restore(id)) okN += 1; }
      else if (op === 'tag') { if (store.setDescTags(id, Array.isArray(body.tags) ? body.tags : undefined, typeof body.desc === 'string' ? body.desc : undefined)) okN += 1; }
      else return writeJson(res, 400, { error: `unknown op ${op}` });
    }
    try { store.flush(); } catch { /* ignore */ } // 批量改完立即落盘, 防杀进程丢最后一笔
    writeJson(res, 200, { ok: okN, total: ids.length });
  });

  // 导入: {paths?: string[], urls?: string[], files?: [{name,dataBase64}]} → 逐项导入
  route(ctx, 'POST', '/api/qqbot-settings/stickers/import', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const store = typeof body.dataDir === 'string' && body.dataDir ? getStickerStore(body.dataDir) : getStickerStore();
    const results = [];
    const paths = Array.isArray(body.paths) ? body.paths : [];
    const urls = Array.isArray(body.urls) ? body.urls : [];
    const files = Array.isArray(body.files) ? body.files : [];
    for (const p of paths) {
      try {
        const r = store.importLocalFile(String(p));
        results.push({ ref: String(p), status: r.status, id: r.id, error: r.error });
      } catch (e) { results.push({ ref: String(p), status: 'error', error: String(e?.message ?? e) }); }
    }
    for (const url of urls) {
      try {
        const r = await store.capture(String(url), { sourceUrl: String(url) }, undefined);
        results.push({ ref: String(url), status: r.status, id: r.id, error: r.error });
      } catch (e) { results.push({ ref: String(url), status: 'error', error: String(e?.message ?? e) }); }
    }
    for (const f of files) {
      const name = String(f?.name ?? 'upload');
      const b64 = typeof f?.dataBase64 === 'string' ? f.dataBase64 : '';
      try {
        if (!b64) throw new Error('no data');
        const buf = Buffer.from(b64, 'base64');
        const tmpDir = join(store.dataDir, '.import');
        mkdirSync(tmpDir, { recursive: true });
        const tmp = join(tmpDir, `${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
        writeFileSync(tmp, buf);
        const r = store.importLocalFile(tmp);
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
        results.push({ ref: name, status: r.status, id: r.id, error: r.error });
      } catch (e) { results.push({ ref: name, status: 'error', error: String(e?.message ?? e) }); }
    }
    try { store.flush(); } catch { /* ignore */ } // 导入完立即落盘
    writeJson(res, 200, { results });
  });

  // ── ⑥QQ 群管理面板(P3, 2026-09-05): 多群管理 host 路由(读/写走 GroupAdminClient; 面板=主人直发免 QQ 审批) ──
  // 数据: {cwd}/.qqbot/{groups.json 群注册表, join-pending.json 待审, group-audit.jsonl 审计日志}
  // 鉴权: 与全路由一致走 route() 同源 loopback fence; 面板主人级鉴权(P4 加强)。
  /**
   * 把【插件自有存储】的值合并进 patch 解析出的实例列表。
   *
   * ⚠️ 2026-09-28 根治同类问题：
   *   自 2026-09-24 起，已有账号的 appId / appSecret / preset / cwd 只写自有存储、不写 patch
   *   （避免多条目 insert 时块边界写歪 YAML）。但桥里有若干地方**只读 patch** 取账号配置，
   *   于是用户存进自有存储的值读不到 —— 表现为：
   *     · 账号页填了「工作目录」保存后回显为空
   *     · 改「Agent 预设(人格)」后界面仍显示旧人格（看起来"没改成"）
   *     · nsBot() 拿到旧的 appSecret/cwd → 用错凭据连不上（掉线）/ 群管理图库走错路径
   *
   * ⚠️⚠️ 优先级必须【自有存储优先】：自有存储 = 用户在设置页保存的最新值；
   *   patch = 历史遗留的旧值。这与 /read 接口的做法一致：
   *     const value = Object.assign({}, base.value || {}, own)   // own 覆盖 base
   *   （人家第一版写成"patch 优先"，方向搞反，导致界面始终显示旧人格 —— 已修正。）
   */
  function mergeOwnIntoCfg(cfg, nsLike) {
    let own = {};
    try { own = readOwnSettings(String(nsLike)) || {}; } catch { own = {}; }
    // ── 2026-10-25 修「保存一次密钥就变」的另一半 ──────────────────────
    //   patch 里的 appSecret 是**历史旧值**（2026-09-24 起已不再写 patch）。
    //   原来自有存储缺 appSecret 时就一直回退到 patch ⇒ patch 一旦被写脏，
    //   用户怎么保存都会被它顶回去。改成：**只在自有存储没有时继承一次并落盘**，
    //   之后永远以自有存储为准。
    try {
      if ((!own || !own.appSecret) && cfg && cfg.appSecret) {
        const seeded = Object.assign({}, own, { appSecret: String(cfg.appSecret) });
        writeOwnSettings(String(nsLike), seeded);
        own = seeded;
      }
    } catch { /* 继承失败不影响本次读取 */ }
    const pick = (k) => {
      const o = own[k];
      if (o !== undefined && o !== '') return o;      // ← 自有存储优先（用户最新保存的）
      const c = cfg ? cfg[k] : undefined;
      return c !== undefined && c !== '' ? c : (cfg ? cfg[k] : undefined);
    };
    return {
      ...cfg,
      appId: pick('appId'),
      appSecret: pick('appSecret'),
      preset: pick('preset'),
      cwd: pick('cwd'),
      dataRoot: pick('dataRoot'),
      // ⚠️ 2026-09-30 补：localModel 也是"面板保存写自有存储"的字段之一。
      //   漏了它 → /local-model/status 与 localModelDirOf 读的是 patch 默认值 →
      //   一开面板就把 lexicalFallback 同步成 false（"评分又没了"）。
      localModel: (() => {
        const o = own.localModel;
        if (o && typeof o === 'object') return o;
        const c = cfg ? cfg.localModel : undefined;
        return c && typeof c === 'object' ? c : (o !== undefined ? o : c);
      })(),
    };
  }

  function nsBot(ns) {
    const { bots } = parsePatch();
    const id = ns && ns !== 'im-qqbot' ? String(ns) : 'im-qqbot';
    const b = bots.find((x) => x.id === id);
    if (!b) return null;
    // ⚠️ 2026-09-28 修（同类问题根治）：自 2026-09-24 起，已有账号的 appId/appSecret/preset/cwd
    //   只写【插件自有存储】，不再写 profile patch（避免多条目 insert 时块边界写歪 YAML）。
    //   但这里原先只读 patch → 用户存进自有存储的 cwd/appSecret 读不到 →
    //   数据目录算成空 / 用错凭据连不上（掉线）→ 群管理、图库、无上下文、Excel 导出全部走错路径。
    //   现在统一走 mergeOwnIntoCfg（**自有存储优先**，与 /read 接口一致；patch 是历史旧值）。
    const m = mergeOwnIntoCfg(b.cfg || {}, b.cfg?.settingsNs || id);
    const appId = m.appId || '';
    const appSecret = m.appSecret || '';
    // 数据根: dataRoot(新) > `{cwd}/dshqqbot`(**2026-09-12 新默认**, 与 dist 侧 dataRootOf 对齐);
    // nsBot 的 cwd 字段按数据根返回(全为数据目录用途) —— 未配 dataRoot 的实例不再落到工作目录。
    const cwdCfg = m.cwd || '';
    const cwd = (m.dataRoot || (cwdCfg ? join(cwdCfg, 'dshqqbot') : ''));
    if (!appId || !appSecret) return null;
    // ⚠️ 2026-09-30 修（同类问题继续根治）：
    //   下游有大量 `bot.cfg.dataRoot` / `bot.cfg.localModel` 写法（export.xlsx、value-samples、
    //   图库、群管理、localModelDirOf …），但 nsBot 原先**只返回 {id,appId,appSecret,cwd,ns}**，
    //   根本没有 cfg 字段 → 那些地方拿到的永远是 undefined → 数据根算空 / 找不到模型目录。
    //   这里把"合并自有存储后的 cfg"一并带出（并补上推导出的 dataRoot），让下游写法自然成立。
    //   注意：cwd 字段仍是【数据根】（历史语义），cfg.cwd 才是工作目录，别混用。
    const cfgMerged = { ...m, dataRoot: m.dataRoot || cwd };
    return { id, appId, appSecret, cwd, ns: id, cfg: cfgMerged };
  }
  async function groupClientOf(ns) {
    const bot = nsBot(ns);
    if (!bot) return null;
    const mod = await import('./dist/api/group-admin.js');
    return { bot, client: mod.createGroupAdmin({ appId: bot.appId, appSecret: bot.appSecret }) };
  }
  /** 已判定「群不存在」的 gid → 判定时刻（死群退避用，24h TTL；内存即可，重启重探一次） */
  const DEAD_GROUP_CACHE = new Map();
  /**
   * 审计日志滚动上限（2026-09-14 补）：原来是纯 append，没有上限 ——
   *   面板群列表接口每刷一次就要为**每个已死的群**写一条 group.dead（实测 9 天 4.2 万行 / 7.5MB）。
   *   这里加**大小上限**：超过 2MB 就只保留最近 2000 行，任何一类事件刷屏都挡得住。
   */
  const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
  const AUDIT_KEEP_LINES = 2000;
  function audit(cwd, entry) {
    try {
      mkdirSync(join(cwd, '.qqbot'), { recursive: true });
      const af = join(cwd, '.qqbot', 'group-audit.jsonl');
      writeFileSync(af, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { flag: 'a' });
      try {
        if (statSync(af).size > AUDIT_MAX_BYTES) {
          const lines = readFileSync(af, 'utf8').split('\n').filter(Boolean);
          writeFileSync(af, lines.slice(-AUDIT_KEEP_LINES).join('\n') + '\n', 'utf8');
        }
      } catch { /* 压缩失败不影响主链 */ }
    } catch { /* ignore */ }
  }
  // [qqbot-mod] groups-bom-tolerant：容忍 UTF-8 BOM
  function readGroupsJson(cwd) {
    try { return JSON.parse(String(readFileSync(join(cwd, '.qqbot', 'groups.json'), 'utf8')).replace(/^\uFEFF/, '') || '{}'); } catch { return {}; }
  }
  function writeGroupsJson(cwd, g) {
    // [qqbot-mod] 群注册表只增不减：上游偶发用空对象覆盖（表现为"群列表突然空了"），
    //   所以写入前先读旧表合并，旧键与旧名字都保留，新值有 name 才覆盖。
    try {
      mkdirSync(join(cwd, '.qqbot'), { recursive: true });
      const _f = join(cwd, '.qqbot', 'groups.json');
      let _old = {};
      try { _old = JSON.parse(String(readFileSync(_f, 'utf8')).replace(/^\uFEFF/, '') || '{}') || {}; } catch (eOld) { _old = {}; }
      const _merged = Object.assign({}, _old);
      for (const _k of Object.keys(g || {})) {
        const _o = _old[_k] || {};
        const _n = g[_k] || {};
        const _name = String(_n.name || '').trim() || String(_o.name || '').trim();
        _merged[_k] = Object.assign({}, _o, _n, _name ? { name: _name } : {});
      }
      // [qqbot-mod] groups-keep：合并后仍是空表就别写，宁可不更新也不要把好表清空
      if (!Object.keys(_merged).length) return;
      writeFileSync(_f, JSON.stringify(_merged, null, 1), 'utf8');
    } catch { /* ignore */ }
  }
  // 🗂 目标分组(2026-09-12 从浏览器 localStorage 搬到 host): 主人与 AI **共用同一份分组** ——
  //    dock「📇 群组管理 → 🗂 分组」编辑它, agent 侧 broadcast_send 直接按分组名群发。
  //    结构: [{ id, name, members: ['group:openid' | 'c2c:openid', ...] }] → {cwd}/.qqbot/target-groups.json
  function readTargetGroupsJson(cwd) {
    try {
      const o = JSON.parse(readFileSync(join(cwd, '.qqbot', 'target-groups.json'), 'utf8') || '{}');
      return Array.isArray(o && o.groups) ? o.groups : [];
    } catch { return []; }
  }
  function writeTargetGroupsJson(cwd, groups) {
    try { mkdirSync(join(cwd, '.qqbot'), { recursive: true }); writeFileSync(join(cwd, '.qqbot', 'target-groups.json'), JSON.stringify({ groups }, null, 1), 'utf8'); } catch { /* ignore */ }
  }
  function readPendingJson(cwd) {
    try { return JSON.parse(readFileSync(join(cwd, '.qqbot', 'join-pending.json'), 'utf8') || '{}'); } catch { return {}; }
  }
  // ── botplay 事件独立文件存储(2026-09-10 M4.3): {dataRoot}/botplay-events.json
  //    (主人定: 事件配置放工作目录根, 和「表情包」等平级; 曾放 .qqbot 子目录, 读时兼容迁移)
  function readBotplayEventsFile(cwd) {
    try {
      const root = join(cwd, 'botplay-events.json');
      if (existsSync(root)) return JSON.parse(readFileSync(root, 'utf8') || '{}');
      const legacy = join(cwd, '.qqbot', 'botplay-events.json');
      if (existsSync(legacy)) { try { renameSync(legacy, root); } catch { /* 迁移失败继续读旧 */ } return JSON.parse(readFileSync(legacy, 'utf8') || '{}'); }
      return {};
    } catch { return {}; }
  }
  function writeBotplayEventsFile(cwd, events) {
    try {
      const f = join(cwd, 'botplay-events.json');
      const tmp = f + '.tmp-' + Date.now();
      writeFileSync(tmp, JSON.stringify({ version: 1, events: Array.isArray(events) ? events : [] }, null, 2), 'utf8');
      renameSync(tmp, f);
      return true;
    } catch { return false; }
  }
  // 从 settings 现值取 botplayEvents(迁移/兜底用)
  function botplayEventsFromSettings(ns) {
    try { const v = viewOf(ctx.settings, ns); const ev = v && v.value && v.value.botplayEvents; return Array.isArray(ev) ? ev : []; } catch { return []; }
  }
  const NSQ = (u) => (u.searchParams.get('ns') || '').trim() || undefined;
  const GQ = (u) => (u.searchParams.get('gid') || '').trim();

  // ── Web 会话 → QQ 目标反查(悬浮球自动选目标用) ──
  // dsh-qqbot 的 sessionId = sha256(`qqbot:{appId}:{scope}:{peerId}`) 前 32 hex 排成 UUID。
  // 输入 web 当前会话 sessionId, 遍历所有实例的注册表群 + 台账私聊, 命中即返回归属。
  function deriveSessionIdOf(appId, scope, peerId) {
    const hash = createHash('sha256').update(`qqbot:${appId}:${scope}:${peerId}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }
  function chatLedgerNames(dataDir) {
    const out = new Map(); // key=scope:id -> {name, ts}
    try {
      const raw = readFileSync(join(dataDir, 'known-chats.jsonl'), 'utf8');
      for (const l of raw.split('\n')) {
        const t = l.trim(); if (!t) continue;
        try {
          const o = JSON.parse(t);
          if (o && typeof o.id === 'string' && (o.scope === 'group' || o.scope === 'c2c') && o.id) {
            const key = o.scope + ':' + o.id;
            const cur = out.get(key);
            if (!cur || (o.ts || 0) > cur.ts) out.set(key, { name: o.name || '', ts: o.ts || 0 });
          }
        } catch { /* 坏行 */ }
      }
    } catch { /* 无台账 */ }
    return out;
  }
  route(ctx, 'GET', '/api/qqbot-settings/session-lookup', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const sessionId = (u.searchParams.get('sessionId') || '').trim();
      if (!sessionId) return writeJson(res, 400, { error: 'sessionId 必填' });
      const { bots } = parsePatch();
      const botByNs = new Map();
      for (const bot of bots) {
        // ⚠️ 2026-09-28：appId/cwd 可能只在【自有存储】里（2026-09-24 起的保存策略），
        //   合并后再判断，否则这类账号会被误跳过。
        const mcfg = mergeOwnIntoCfg(bot.cfg || {}, bot.cfg?.settingsNs || bot.id);
        if (bot.disabled || !mcfg.appId || !mcfg.cwd) continue;
        botByNs.set(bot.id, { ...bot, cfg: mcfg });
      }
      const hits = [];
      const seen = new Set();
      // 按实例台账补昵称(dataRoot/表情包/known-chats.jsonl)
      const nameOf = (ns, scope, peerId) => {
        const bot = botByNs.get(ns);
        if (!bot) return '';
        try {
          const cwd = bot.cfg.dataRoot || bot.cfg.cwd;
          const ld = chatLedgerNames(join(cwd, '表情包')).get(scope + ':' + peerId);
          return (ld && ld.name) || '';
        } catch { return '' }
      };
      const pushHit = (ns, scope, peerId, name, via) => {
        const key = ns + ':' + scope + ':' + peerId;
        if (seen.has(key)) return;
        seen.add(key);
        hits.push({ ns, scope, peerId, name, via });
      };
      // ① 权威: 真实会话记录(唯一可靠源 —— fork 后 sessionId 为 randomUUID, derive 推导会 miss)
      const sessReg = await import('./dist/features/session-registry.js');
      for (const r of sessReg.findSessionBySessionIdWeb(sessionId)) {
        pushHit(r.ns, r.scope, r.peerId, nameOf(r.ns, r.scope, r.peerId), 'session');
      }
      // ② 兜底: 确定性推导(会话记录未建立/被回收时, 从注册表+台账推导; 与权威命中自动去重)
      for (const bot of bots) {
        if (bot.disabled || !bot.cfg?.appId || !bot.cfg?.cwd) continue;
        const appId = bot.cfg.appId;
        const cwd = bot.cfg.dataRoot || bot.cfg.cwd;
        const ns = bot.id;
        const ledger = chatLedgerNames(join(cwd, '表情包'));
        const groups = readGroupsJson(cwd);
        const gids = new Set([...Object.keys(groups), ...[...ledger.keys()].filter((k) => k.startsWith('group:')).map((k) => k.slice(6))]);
        for (const gid of gids) {
          if (!gid) continue;
          if (deriveSessionIdOf(appId, 'group', gid) !== sessionId) continue;
          const regMeta = groups[gid];
          const ld = ledger.get('group:' + gid);
          pushHit(ns, 'group', gid, (regMeta && regMeta.name) || (ld && ld.name) || '', 'derive');
        }
        for (const [key2, ld] of ledger) {
          if (!key2.startsWith('c2c:')) continue;
          const openid = key2.slice(4);
          if (!openid || deriveSessionIdOf(appId, 'c2c', openid) !== sessionId) continue;
          pushHit(ns, 'c2c', openid, ld.name || '', 'derive');
        }
      }
      writeJson(res, 200, { ok: true, sessionId, hits });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 群列表(注册表 + pending 出现过的群 + 台账群; 逐个调官方 info 校验有效性+补群名, 11255=群已注销/不存在则标记失效并过滤)
  route(ctx, 'GET', '/api/qqbot-settings/group/accounts', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(NSQ(u));
      if (!bot) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const _qaRoot = (typeof resolveMemoryRoot === 'function') ? resolveMemoryRoot(bot) : bot.cwd;
      const reg = readGroupsJson(_qaRoot);
      const pend = readPendingJson(_qaRoot);
      const map = new Map();
      for (const [gid, meta] of Object.entries(reg)) {
        if (!gid) continue;
        map.set(gid, { gid, name: (meta && meta.name) || '', from: 'registry', lastAt: (meta && meta.lastAt) || 0 });
      }
      for (const gid of Object.keys(pend)) {
        if (!gid) continue;
        if (map.has(gid)) { const m = map.get(gid); m.from = 'registry+pending'; }
        else map.set(gid, { gid, name: '', from: 'pending', lastAt: 0 });
      }
      try {
        const store = getStickerStore(_qaRoot ? join(_qaRoot, '表情包') : undefined);
        const raw = readFileSync(join(store.dataDir, 'known-chats.jsonl'), 'utf8');
        for (const l of raw.split('\n')) {
          const t = l.trim(); if (!t) continue;
          try {
            const o = JSON.parse(t);
            if (o && o.scope === 'group' && typeof o.id === 'string' && o.id) {
              if (map.has(o.id)) { if (!map.get(o.id).name && o.name) map.get(o.id).name = o.name; }
              else map.set(o.id, { gid: o.id, name: o.name || '', from: 'ledger', lastAt: typeof o.ts === 'number' ? o.ts : 0 });
            }
          } catch { /* 坏行跳过 */ }
        }
      } catch { /* 无台账 */ }
      // 逐个校验有效性 + 用官方群名补全显示名(注册表里的群也顺手回写官方名)
      // [qqbot-mod] groups-msghistory：注册表被清空时（groups.json 变成 {}）兜底——
      //   只要有过群聊，.qqbot/msg-history/group_<id>/ 里一定有当天的台账，群就不会凭空消失。
      try {
        const _mhRoot = join(_qaRoot, '.qqbot', 'msg-history');
        for (const _d of readdirSync(_mhRoot)) {
          const _mm = /^group_(.+)$/.exec(_d);
          if (!_mm) continue;
          const _gid = _mm[1];
          let _lastAt = 0;
          let _nm = '';
          try {
            const _files = readdirSync(join(_mhRoot, _d)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
            const _last = _files[_files.length - 1];
            if (_last) {
              const _p = join(_mhRoot, _d, _last);
              try { _lastAt = statSync(_p).mtimeMs } catch { _lastAt = 0 }
              try {
                const _lines = readFileSync(_p, 'utf8').split('\n').filter(Boolean).slice(-80);
                for (let _i = _lines.length - 1; _i >= 0; _i--) {
                  try {
                    const _o = JSON.parse(_lines[_i]);
                    const _n = String((_o && _o.n) || '').trim();
                    if (_n && _n !== 'self' && !/^[0-9A-Fa-f]{32}$/.test(_n)) { _nm = _n; break }
                  } catch { /* 坏行跳过 */ }
                }
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
          if (map.has(_gid)) {
            const _m2 = map.get(_gid);
            // [qqbot-mod] group-title-fix：不拿群成员昵称补群名（官方 getGroupInfo 回填更可靠）
            if (!_m2.lastAt) _m2.lastAt = _lastAt;
          } else {
            map.set(_gid, { gid: _gid, name: '', from: 'msg-history', lastAt: _lastAt });
          }
        }
      } catch (eMH) { /* 没有台账目录就算了 */ }
      const gc = await groupClientOf(NSQ(u));
      const out = [];
      const aliveReg = {};
      if (gc) {
        for (const g of [...map.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))) {
          // 死群退避（2026-09-14 补）：已判「群不存在」的 gid 24h 内不再重复校验 ——
          //   原来这里每次都全量校验，面板每刷一次就为每个死群写一条 group.dead（实测 9 天 4.2 万行）。
          //   命中缓存直接跳过（**也不写审计**），过 24h 再探一次（万一群复活/又被拉回去）。
          const deadAt = DEAD_GROUP_CACHE.get(g.gid);
          if (deadAt && Date.now() - deadAt < 24 * 3600_000) continue;
          try {
            const info = await gc.client.getGroupInfo(g.gid);
            if (info.ok && info.data) {
              const official = info.data.group_name || '';
              if (official) g.name = official;
              out.push(g);
              aliveReg[g.gid] = { name: official || (reg[g.gid] && reg[g.gid].name) || '', lastAt: (reg[g.gid] && reg[g.gid].lastAt) || Date.now() };
            } else {
              // [qqbot-mod] groups-trust-ledger-keep：台账里有近期记录的群就是活的，
              //   getGroupInfo 查不到大概率是权限/接口问题，不能把群从列表里抹掉。
              if (g.from === 'ledger' || g.from === 'msg-history' || g.from === 'registry+pending') {
                out.push({ ...g, unverified: true });
                continue;
              }
              // 11255 等 = 群已注销/不存在 → 不返回给 UI(避免选中后调用报错), 仅保留审计
              DEAD_GROUP_CACHE.set(g.gid, Date.now());
              audit(bot.cwd, { ev: 'group.dead', ns: bot.id, gid: g.gid, code: info.err && info.err.code, human: info.err && info.err.human });
            }
          } catch (e2) {
            audit(bot.cwd, { ev: 'group.check-error', ns: bot.id, gid: g.gid, error: String((e2 && e2.message) || e2) });
            out.push(g); // 网络类错误不判死, 保守保留
          }
        }
        // 回写有效群注册表(自动剔除已注销群)
        // [qqbot-mod] groups-trust-writeroot：读的是 _qaRoot，写也要写同一个根
        if (Object.keys(aliveReg).length >= 0) writeGroupsJson(_qaRoot || bot.cwd, aliveReg);
      } else {
        out.push(...map.values());
      }
      // [qqbot-mod] groups-unverified-keep：探活阶段可能把群判死/跳过（群里机器人被踢过、
      //   或者当前拿不到群客户端），但台账（msg-history）里确凿存在过这个群 —— 补回列表，标 unverified，
      //   否则主人看到的就是「群凭空消失」。
      try {
        const _have = new Set(out.map((x) => x && x.gid));
        for (const _g of map.values()) {
          if (!_g || !_g.gid || _have.has(_g.gid)) continue;
          if (_g.from !== 'msg-history' && _g.from !== 'registry' && _g.from !== 'ledger' && _g.from !== 'registry+pending') continue;
          out.push({
            gid: _g.gid,
            name: _g.name || ('群 ' + String(_g.gid).slice(-6)),
            from: _g.from,
            lastAt: _g.lastAt || 0,
            unverified: true,
          });
        }
      } catch { /* ignore */ }
      writeJson(res, 200, { groups: out });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 待审入群申请(官方列表 + 本地 pending 已处理标记)
  route(ctx, 'GET', '/api/qqbot-settings/group/join_requests', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const gid = GQ(u);
      if (!gid) return writeJson(res, 400, { error: 'gid 必填' });
      const gc = await groupClientOf(NSQ(u));
      if (!gc) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const r = await gc.client.listJoinRequests(gid);
      if (!r.ok) return writeJson(res, 200, { ok: false, err: r.err });
      const pend = readPendingJson(gc.bot.cwd);
      const local = (pend[gid] || []).map((x) => ({ member_openid: x.member_openid, join_request_id: x.join_request_id, notified: !!x.notified, seen_at: x.seen_at }));
      // 验证信息人话化: verify_info 的 method 是英文枚举(admin_review_qa), 复用 dist 的 verifyHuman 翻译
      const gaMod = await import('./dist/api/group-admin.js');
      const vh = (gaMod && typeof gaMod.verifyHuman === 'function') ? gaMod.verifyHuman : (vi) => (vi && (vi.verify_message || vi.method)) || '-';
      const list = (r.data.list || []).map((j) => ({ ...j, verify_human: vh(j.verify_info) }));
      writeJson(res, 200, { ok: true, list, local });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // ── 本地小模型(2026-09-13 主人定): 状态检测 + 一键下载 ──
  // 模型: bge-small-zh-v1.5 (ONNX q8 ≈ 23MB, 中文专训); 放用户级 {DSH_HOME|~/.dsh}/models/bge-small-zh
  // (跨工作区共享一份), 可用 localModel.modelDir 覆盖。下载走 node:https + 镜像兜底。
  const LOCAL_MODEL_FILES = ['onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json'];
  // [qqbot-mod] lm-bases-permodel 2026-10-27：下载源按所选模型走。
  //   原先 LOCAL_MODEL_BASES 写死 bge-small-zh-v1.5 —— 单会话页选 bge-base/large-zh 点
  //   「⬇️ 下载模型」会把 **small 的权重**下进 base/large 目录（tokenizer/维度全不对），
  //   嵌入器加载直接报废 —— 这就是判定模型"选了大的就有点问题"的真因。
  function localModelBasesOf(dir) {
    const m = /^(bge-(small|base|large)-zh)(?:-v1\.5)?$/.exec(basename(String(dir || '')));
    const repo = m ? m[1] + '-v1.5' : 'bge-small-zh-v1.5';
    return [
      `https://hf-mirror.com/Xenova/${repo}/resolve/main`,
      `https://huggingface.co/Xenova/${repo}/resolve/main`,
    ];
  }
  function localModelDirOf(bot) {
    const cfgDir = String((bot && bot.cfg && bot.cfg.localModel && bot.cfg.localModel.modelDir) || "").trim();
    const dshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), ".dsh");
    const modelsRoot = join(dshHome, "models");
    if (cfgDir) {
      // ★ 本地修复(2026-10-22)：别名解析：原来这里原样返回 cfgDir。
      //   面板填预设别名（bge-base-zh / bge-small-zh / bge-large-zh）时，
      //   下游 join(cfgDir, "onnx/model_quantized.onnx") 会相对【进程 cwd】去找，
      //   于是四个资产全判缺失、available:false，面板就把"选择模型"禁用了。
      const c0 = cfgDir.charCodeAt(0);
      const absLike = (cfgDir.length > 1 && cfgDir[1] === ":") || c0 === 47 || c0 === 92;
      return absLike ? cfgDir : join(modelsRoot, cfgDir);
    }
    return join(modelsRoot, "bge-small-zh");
  }
  /** 下载单文件(跟随重定向); 失败抛错 */
  async function downloadFile(url, dest, hops = 0) {
    const { default: https } = await import('node:https');
    return await new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'user-agent': 'dsh-qqbot', accept: '*/*' } }, (resp) => {
        const code = resp.statusCode || 0;
        if (code >= 300 && code < 400 && resp.headers.location && hops < 6) {
          resp.resume();
          const next = new URL(resp.headers.location, url).toString();
          return downloadFile(next, dest, hops + 1).then(resolve, reject);
        }
        if (code !== 200) {
          resp.resume();
          return reject(new Error(`HTTP ${code}`));
        }
        const tmp = dest + '.part';
        const ws = createWriteStream(tmp);
        resp.pipe(ws);
        ws.on('finish', () => ws.close(() => {
          try { renameSync(tmp, dest); } catch (e) { return reject(e); }
          resolve(dest);
        }));
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(180000, () => req.destroy(new Error('下载超时(180s)')));
    });
  }
  // ── 本地小模型：强制重置加载状态（面板「🔄 重新检测」调用）──
  // 背景：local-embed 曾有"一次失败永久关闭"的缺陷，用户点重新检测时希望能立刻再试一次。
  // ⚠️ 桥与插件在同进程：动态 import 同一份 dist 模块，拿到的就是插件正在用的那个实例表。
  route(ctx, 'POST', '/api/qqbot-settings/local-model/reset', async (req, res) => {
    try {
      const mod = await import('./dist/features/local-embed.js');
      let n = 0;
      try { n = typeof mod.resetAllEmbedders === 'function' ? mod.resetAllEmbedders() : 0; } catch (e) { n = -1; }
      return writeJson(res, 200, { ok: true, reset: n });
    } catch (e) {
      return writeJson(res, 500, { error: String((e && e.message) || e) });
    }
  });

  route(ctx, 'GET', '/api/qqbot-settings/local-model/status', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(NSQ(u));
      const dir = localModelDirOf(bot);
      const missing = LOCAL_MODEL_FILES.filter((rel) => !existsSync(join(dir, rel)));
      let bytes = 0;
      for (const rel of LOCAL_MODEL_FILES) { try { bytes += statSync(join(dir, rel)).size; } catch { /* 缺文件不计数 */ } }
      // ⚠️ 2026-09-30 修(主人反馈"评分又没了"): 原来取 bot.cfg.localModel —— 那是**安装 patch 里的默认值**,
      //   而面板保存写的是插件自有 settings; 两边不一致 → 每次打开面板就把 lexicalFallback 同步成 false
      //   (并 resetAllEmbedders) → 评分立刻全部变成"无分"。改为与读取路由同源: 自有 settings 优先, patch 兜底。
      let cfg = (bot && bot.cfg && bot.cfg.localModel) || {};
      try {
        const own = readOwnSettings(NSQ(u));
        if (own && own.localModel && typeof own.localModel === 'object') cfg = own.localModel;
      } catch { /* 自有 settings 读不到就用 patch 默认值兜底 */ }
      // 程序兜底(2026-09-30): 把开关同步进嵌入器模块 —— 变更时顺带重置, 下一次用到的就是新模式(无需重启)
      // ⚠️ 2026-09-31 同时取【嵌入器真实状态】：模型加载失败时评分会静默变成 undefined，
      //   面板只显示"无分"，失败原因只在 dsh 终端的 logger.warn 里 → 用户无从知晓。
      //   这里把 status().reason 一并返回，面板可明确提示"模型加载失败：<原因>"。
      let embStatus;
      try {
        const le = await import('./dist/features/local-embed.js');
        const want = cfg.lexicalFallback === true;
        if (le.isLexicalFallback() !== want) { le.setLexicalFallback(want); le.resetAllEmbedders(); }
        const e = le.createLocalEmbedder({ modelDir: dir });
        if (e && typeof e.status === 'function') embStatus = e.status();
      } catch { /* 嵌入器模块不可用不影响状态接口 */ }
      writeJson(res, 200, {
        ok: true,
        enabled: cfg.enabled !== false,
        modelDir: dir,
        available: missing.length === 0,
        missing,
        bytes,
        // ⚠️ 2026-09-13 修(主人反馈"选了低分不唤醒, 过一会又跳回去"): 原来这里漏返回 valueGate,
        //    面板读回 undefined → 一律按默认 'log' 渲染 → 看着像"保存没生效"(其实配置里已是 block)。
        valueGate: cfg.valueGate === 'off' || cfg.valueGate === 'block' ? cfg.valueGate : 'log',
        valueMinScore: typeof cfg.valueMinScore === 'number' ? cfg.valueMinScore : 0.5,
        // ⚠️ 同 valueGate: **必须返回**, 否则面板勾了保存又跳回未勾选
        lexicalFallback: cfg.lexicalFallback === true,
        embStatus,
        // 附件唤醒开关（2026-09-15）：跟 valueGate 一样**必须返回** ——
        //   否则面板读回 undefined → 勾选框永远按默认渲染，看着像"保存没生效"。
        attachmentPassthrough:
          cfg.attachmentPassthrough && typeof cfg.attachmentPassthrough === 'object'
            ? cfg.attachmentPassthrough
            : undefined,
      });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });
  route(ctx, 'POST', '/api/qqbot-settings/local-model/download', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const bot = nsBot(String((body && body.ns) || ''));
      const dir = localModelDirOf(bot);
      const bases = localModelBasesOf(dir);   // [qqbot-mod] lm-bases-permodel：按所选模型取源
      mkdirSync(join(dir, 'onnx'), { recursive: true });
      const done = [];
      for (const rel of LOCAL_MODEL_FILES) {
        const dest = join(dir, rel);
        if (existsSync(dest)) { done.push(rel + ': 已存在'); continue; }
        let lastErr = '';
        let ok = false;
        for (const base of bases) {
          try { await downloadFile(base + '/' + rel, dest); ok = true; lastErr = ''; break; }
          catch (e) { lastErr = String((e && e.message) || e); }
        }
        if (!ok) return writeJson(res, 500, { ok: false, error: `${rel} 下载失败: ${lastErr}`, done, modelDir: dir });
        done.push(rel + ': OK');
      }
      writeJson(res, 200, { ok: true, done, modelDir: dir });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });
  // 导出 Excel（2026-09-14 主人："好感度熟识度可以一键导出 excel 表格，i need to share"）
  //   零依赖：xlsx 由 dist/features/xlsx.js 现场拼（见那个文件头：不为了导出拖进 exceljs）
  //   三张表：熟识度 / 好感度 / 口径说明（分享给别人时看得懂）
  route(ctx, 'GET', '/api/qqbot-settings/export.xlsx', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(NSQ(u));
      const dataRoot = (bot && bot.cfg && typeof bot.cfg.dataRoot === 'string' && bot.cfg.dataRoot) ? bot.cfg.dataRoot : ((bot && bot.cwd) || '');
      if (!dataRoot) return writeJson(res, 400, { ok: false, error: '找不到数据根目录' });
      const [{ buildXlsx }, affMod, attMod] = await Promise.all([
        import('./dist/features/xlsx.js'),
        import('./dist/features/local-signals.js'),
        import('./dist/features/attitude.js'),
      ]);
      const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit')) || 200));
      const aff = affMod.topAffinity(dataRoot, limit) || [];
      const att = attMod.topAttitude(dataRoot, limit) || [];
      const fmt = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '');
      const shortId = (k) => String(k || '').replace(/^(person|group|c2c):/, '');

      const rows1 = [['#', '昵称', 'openid', '熟识度', '档位', '来过(天)', '消息数', '被点名', '接话', '最近活跃']];
      aff.forEach((x, i) => rows1.push([i + 1, x.name || '', shortId(x.key), x.score ?? '', x.tier || '', x.reviews ?? 0, x.msgs ?? 0, x.mentions ?? 0, x.replies ?? 0, fmt(x.lastAt)]));

      const rows2 = [['#', '昵称', 'openid', '好感度', '档位', '好感占比', '事件数', '最近一次涨跌原因', '最近活跃']];
      att.forEach((x, i) => {
        let tier = '';
        let ratio = '';
        try {
          const g = attMod.attitudeGateFor(dataRoot, x.key);
          tier = g.tier;
          ratio = Math.round(g.ratio * 1000) / 1000;
        } catch { /* 算不出留空 */ }
        rows2.push([i + 1, x.name || '', shortId(x.key), x.a ?? '', tier, ratio, x.events ?? 0, x.lastWhy || '', fmt(x.lastAt)]);
      });

      // 总览：两个维度**按人合并成一行**放第一张（2026-09-14 主人打开文件问"好感度呢？"——
      //   分表藏在底部标签页里容易漏看；分享场景下，一张总表最直观）
      const attByKey = new Map(att.map((x) => [x.key, x]));
      const seenKeys = new Set();
      const merged = [];
      for (const x of aff) { merged.push({ key: x.key, name: x.name, aff: x, att: attByKey.get(x.key) }); seenKeys.add(x.key); }
      for (const x of att) { if (!seenKeys.has(x.key)) merged.push({ key: x.key, name: x.name, aff: undefined, att: x }); }
      merged.sort((a, b) => (b.att?.a ?? -99) - (a.att?.a ?? -99));
      const rows0 = [['#', '昵称', 'openid', '熟识度', '熟识档位', '好感度', '好感档位', '好感占比', '来过(天)', '消息数', '被点名', '接话', '事件数', '最近一次涨跌原因', '最近活跃']];
      merged.forEach((m, i) => {
        let tier = '';
        let ratio = '';
        if (m.att) {
          try {
            const g = attMod.attitudeGateFor(dataRoot, m.key);
            tier = g.tier;
            ratio = Math.round(g.ratio * 1000) / 1000;
          } catch { /* 算不出留空 */ }
        }
        rows0.push([i + 1, m.name || '', shortId(m.key), m.aff?.score ?? '', m.aff?.tier ?? '', m.att?.a ?? '', tier, ratio,
          m.aff?.reviews ?? '', m.aff?.msgs ?? '', m.aff?.mentions ?? '', m.aff?.replies ?? '', m.att?.events ?? '', m.att?.lastWhy ?? '',
          fmt(m.att?.lastAt || m.aff?.lastAt)]);
      });

      const rows3 = [
        ['一键导出 · 口径说明', ''],        ['生成时间', new Date().toLocaleString('zh-CN')],
        ['熟识度', '她把你记得多牢 —— 客观计数 + 记忆曲线，慢变（来过几天、说了多少、被点名、接话）'],
        ['好感度', '她对你什么态度 —— 随事件可升可降（内心倾向判「亲近/拒绝/任务」+ 正文情绪判「暖/冷/中性」）'],
        ['“最近一次涨跌原因”', '形如「内心亲近 +0.5」「内心拒绝 −0.5 / 又烦又冷(重罚) −0.5」「两好相凑 ×1.2」'],
        ['判定把握', '本地小模型对不上号时会**弃权**（不给标签、不动分），所以有些格子是空的'],
        ['红线', '负好感只退礼貌档：少主动，绝不冷落、阴阳、攻击'],
        ['来源', 'dsh-qqbot 插件 · 数据文件 .qqbot/affinity.json 与 attitude.json'],
      ];

      const buf = buildXlsx([
        { name: '总览', rows: rows0, widths: [5, 18, 34, 9, 10, 9, 10, 10, 9, 9, 9, 8, 9, 44, 20] },
        { name: '熟识度', rows: rows1, widths: [5, 18, 34, 10, 10, 10, 9, 9, 8, 20] },
        { name: '好感度', rows: rows2, widths: [5, 18, 34, 10, 10, 11, 9, 44, 20] },
        { name: '说明', rows: rows3, widths: [20, 90] },
      ]);
      const when = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const cn = `熟识度好感度_${when.getFullYear()}${p2(when.getMonth() + 1)}${p2(when.getDate())}_${p2(when.getHours())}${p2(when.getMinutes())}.xlsx`;
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="qqbot-stats.xlsx"; filename*=UTF-8''${encodeURIComponent(cn)}`,
        'content-length': String(buf.length),
        'cache-control': 'no-store',
      });
      res.end(buf);
      audit(dataRoot, { ev: 'export.xlsx', ns: bot && bot.id, rows: aff.length + att.length });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // 好感度台账(2026-09-13 主人定, 观察期): 只读, 供面板显示"谁跟她最熟"
  //   数据源: {dataRoot}/.qqbot/affinity.json (每条群消息累计 互动/被点名/接话; 熟度现算, 公式透明)
    // ★ 本机新增(2026-10-22): 记忆库 / 分流观察页
  //   三层记忆与 router-log 默认没有界面，写了也看不见。这里只加一条【只读】路由：
  //     /api/qqbot-settings/memory              → JSON
  //     /api/qqbot-settings/memory?format=html  → 一页可读表格（5 秒自动刷新）
  //   不写任何文件、不注册到面板，碰不到现有 UI。
  function resolveMemoryRoot(bot) {
    const cands = [];
    const push = (p) => { const s = String(p || '').trim(); if (s && !cands.includes(s)) cands.push(s); };
    try { push(bot && bot.cfg && bot.cfg.dataRoot); } catch { /* ignore */ }
    try { push(process.env.QQBOT_MEMORY_DATA_ROOT); } catch { /* ignore */ }
    try {
      if (bot && bot.cwd) { push(join(bot.cwd, 'dshqqbot')); push(bot.cwd); }
    } catch { /* ignore */ }
    for (const p of cands) { try { if (existsSync(join(p, '.qqbot'))) return p; } catch { /* ignore */ } }
    return cands[0] || '';
  }

  function escMem(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderMemoryPage(p) {
    const fmt = (ts) => { try { return new Date(ts).toLocaleString('zh-CN'); } catch { return ''; } };
    const scopeBlocks = p.scopes.map((s) => {
      const kinds = Object.entries(s.byKind || {}).map(([k, v]) => k + ':' + v).join(' · ') || '—';
      const rows = s.recent.map((r) => '<tr><td class="k k-' + escMem(r.kind) + '">' + escMem(r.kind) + '</td><td>' + escMem(r.text) + '</td><td class="t">' + escMem(fmt(r.ts)) + '</td></tr>').join('');
      return '<h2>' + escMem(s.scope) + ' <span class="cnt">' + s.total + ' 条</span> <span class="kind">' + escMem(kinds) + '</span></h2>'
        + '<table><thead><tr><th>类型</th><th>内容</th><th>时间</th></tr></thead><tbody>' + (rows || '<tr><td colspan="3" class="empty">（还没有记忆）</td></tr>') + '</tbody></table>';
    }).join('');
    const personaRows = ((p.persona || {}).rows || []).map((r) => '<tr><td class="k">' + escMem(r.scope) + '</td><td>' + escMem(r.key) + '</td><td>' + escMem(r.value) + '</td></tr>').join('');
    const personaBlock = '<h2>人格库 <span class="cnt">' + ((p.persona || {}).total || 0) + ' 条</span></h2>'
      + '<table><thead><tr><th>作用域</th><th>键</th><th>值</th></tr></thead><tbody>' + (personaRows || '<tr><td colspan="3" class="empty">（还没有写人设条目）</td></tr>') + '</tbody></table>';
    const tierRows = Object.entries(p.router.tiers || {}).map(([k, v]) => '<tr><td>' + escMem(k) + '</td><td>' + v + '</td></tr>').join('');
    const lastRows = (p.router.last || []).map((r) => '<tr><td>' + escMem(fmt(r.ts)) + '</td><td>' + escMem(r.tier) + '</td><td>' + escMem(r.score) + '</td><td>' + (r.mentioned ? '是' : '') + '</td><td>' + escMem(r.len) + '</td></tr>').join('');
    return '<!doctype html><meta charset="utf-8"><title>小蓝 · 记忆与分流</title>'
      + '<style>body{font:13px/1.6 -apple-system,"Segoe UI",sans-serif;background:#f6f7fb;color:#222;margin:0;padding:18px 22px}h1{font-size:17px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 6px}.cnt{color:#2f9e44;font-weight:400}.kind{color:#888;font-weight:400;font-size:12px}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e6ef;border-radius:6px;overflow:hidden}th,td{padding:6px 9px;text-align:left;border-bottom:1px solid #eef0f6;vertical-align:top}th{background:#eef0f8;font-weight:600;font-size:12px}.k{color:#7c6bd6;white-space:nowrap;font-size:12px}.t{color:#999;white-space:nowrap;font-size:12px}.empty{color:#aaa;text-align:center;padding:14px}.bar{color:#666;font-size:12px;margin-top:6px}.root{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#888;word-break:break-all}</style>'
      + '<h1>🧠 小蓝 · 记忆与分流（只读）</h1>'
      + '<div class="bar">数据根：<span class="root">' + escMem(p.root) + '</span> · 记忆目录：<span class="root">' + escMem(p.memDir) + '</span></div>'
      + '<div class="bar">后端：' + escMem(p.backend || '?') + ' · 人格库 ' + ((p.persona || {}).total || 0) + ' 条</div>'
      + '<div class="bar">分流样本 ' + p.router.lines + ' 条</div>'
      + (scopeBlocks || '<p class="empty">还没有任何记忆文件 —— 在群里说几句话再看。</p>')
      + personaBlock
      + '<h2>分流分档分布</h2><table><thead><tr><th>档位</th><th>条数</th></tr></thead><tbody>' + (tierRows || '<tr><td colspan="2" class="empty">（还没有记录）</td></tr>') + '</tbody></table>'
      + '<h2>最近分流判定</h2><table><thead><tr><th>时间</th><th>档</th><th>分值</th><th>@</th><th>字数</th></tr></thead><tbody>' + (lastRows || '<tr><td colspan="5" class="empty">（还没有记录）</td></tr>') + '</tbody></table>'
      + '<div class="bar">页面每 5 秒自动刷新</div>'
      + '<script>setTimeout(function(){location.reload()},5000)</script>';
  }

  // ★ 本机新增(2026-10-23): 扩展配置读写（本地代答 / 语音）
  //   两份额外配置（本地小模型、语音）原来只能改文件。这里给前端一对读写接口，
  //   面板就能做成"开关 + 下拉"，不用记事本。
  const EXT_CFG_FILES = { local: 'local-llm-config.json', voice: 'voice-config.json' };

  const EXT_VOICES = [
    ['zh-CN-XiaoxiaoNeural', '晓晓 · 女 · 温柔 · edge 在线 · 0MB'],
    ['zh-CN-XiaoyiNeural', '小艺 · 女 · 活泼 · edge 在线 · 0MB'],
    ['zh-CN-XiaochenNeural', '晓辰 · 女 · 慵懒 · edge 在线 · 0MB'],
    ['zh-CN-YunjianNeural', '云健 · 男 · 沉稳/硬气 · edge 在线 · 0MB'],
  ];

  // [qqbot-mod] chat-local-only：没有活跃会话时，至少把"本地代答说过的话"拿出来
function chatLocalOnlyItems(bot, scope, peerId, limit) {
  const out = []
  try {
    const root = resolveMemoryRoot(bot)
    if (!root) return out
    const file = join(root, ".qqbot", "local-answer-log.jsonl")
    if (!existsSync(file)) return out
    const eol = String.fromCharCode(10)
    const rows = readFileSync(file, "utf8").split(eol)
    const from = Math.max(0, rows.length - 400)
    const seen = {}
    for (let i = from; i < rows.length; i++) {
      const line = String(rows[i] || "").trim()
      if (!line) continue
      let o = null
      try { o = JSON.parse(line) } catch { continue }
      if (!o || !o.reply) continue
      const sc = String(o.scope || "")
      if (sc && sc.indexOf(String(peerId)) < 0) continue
      const t = Number(o.ts) || 0
      const k = String(t) + "|" + String(o.reply).slice(0, 24)
      if (seen[k]) continue
      seen[k] = 1
      out.push({ seq: 0, time: t, dir: "out", sender: "", text: String(o.reply), images: [], tag: "", by: String(o.by || "local"), ms: Number(o.ms) || 0, model: String(o.model || "") })
    }
  } catch { /* 读不到就当没有 */ }
  out.sort(function (a, b) { return (Number(a.time) || 0) - (Number(b.time) || 0) })
  const cap = Math.max(1, Math.min(200, Number(limit) || 80))
  while (out.length > cap) out.shift()
  return out
}
function extCfgPath(root, which) {
    const f = EXT_CFG_FILES[String(which || '')];
    if (!f || !root) return '';
    return join(root, '.qqbot-extensions', f);
  }

  function readExtCfg(p) {
    try {
      if (!p || !existsSync(p)) return {};
      const o = JSON.parse(readFileSync(p, 'utf8'));
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch { return {}; }
  }

  // 探一下 Ollama（1.5 秒超时，探不到不算错，只是前端显示"离线"）
  async function probeOllama(cfg) {
    const base = String((cfg && cfg.baseUrl) || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, 1500);
    try {
      const r = await fetch(base + '/api/tags', { signal: ac.signal });
      const j = await r.json();
      const models = ((j && j.models) || []).map((m) => String((m && m.name) || '')).filter(Boolean);
      return { up: true, baseUrl: base, models };
    } catch (e) {
      return { up: false, baseUrl: base, models: [], error: String((e && e.message) || e) };
    } finally { clearTimeout(timer); }
  }

  // 探本地 TTS 适配层（skills/local-tts/adapter，默认 9881；1.5 秒超时，探不到不算错）
  // [qqbot-mod] tts-tiers 2026-10-27：改探 /health —— 里面带 tiers（各引擎降级状态）
  //   和 voices[].usable（该音色的原生引擎现在能不能出声），面板据此标 ⛔。
  async function probeLocalTts(cfg) {
    let base = 'http://127.0.0.1:9881';
    const ep = String((cfg && cfg.endpoint) || '');
    const m = /^(https?:\/\/[^\/]+)/.exec(ep);
    if (m) base = m[1];
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, 1500);
    try {
      const r = await fetch(base + '/health', { signal: ac.signal });
      const j = await r.json();
      const voices = Object.keys((j && j.voices) || {}).map(String).filter(Boolean);
      const tiers = (j && j.tiers) || {};
      const usable = {};
      for (const [k, v] of Object.entries((j && j.voices) || {})) usable[String(k)] = v && v.usable !== false;
      return { up: voices.length > 0, baseUrl: base, voices, tiers, usable,
               engines: Object.keys(tiers).map(String) };
    } catch (e) {
      return { up: false, baseUrl: base, voices: [], tiers: {}, usable: {}, engines: [],
               error: String((e && e.message) || e) };
    } finally { clearTimeout(timer); }
  }

  route(ctx, 'GET', '/api/qqbot-settings/ext-config', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const which = String(u.searchParams.get('which') || 'local');
      if (!EXT_CFG_FILES[which]) return writeJson(res, 400, { ok: false, error: 'which 只能是 local 或 voice' });
      const bot = nsBot(NSQ(u));
      const root = resolveMemoryRoot(bot);
      const p = extCfgPath(root, which);
      const config = readExtCfg(p);
      const payload = { ok: true, which, root, path: p, exists: !!(p && existsSync(p)), config };
      if (which === 'local') payload.ollama = await probeOllama(config);
      if (which === 'voice') {
        payload.voices = EXT_VOICES.map(([id, label]) => ({ id, label }));
        payload.localTts = await probeLocalTts(config);
        // [qqbot-mod] voice-labels 2026-10-27：本地音色下拉带人话标注（ profiles.json 的 curated+voices），
        //   用户反馈"14 个音色每个都没写清楚，也不知道本地引擎在不在线"。
        let prof = {};
        try { prof = JSON.parse(String(readFileSync(join(root, '..', 'skills', 'local-tts', 'adapter', 'profiles.json'), 'utf8')).replace(/^\uFEFF/, '')) || {}; } catch {
          try { prof = JSON.parse(String(readFileSync('F:/qqbot/skills/local-tts/adapter/profiles.json', 'utf8')).replace(/^\uFEFF/, '')) || {}; } catch { }
        }
        const vm = {};
        for (const c of (prof.curated || [])) vm[c.voice] = { label: c.label || '', hint: c.hint || '' };
        for (const [k, v] of Object.entries(prof.voices || {})) vm[k] = Object.assign({ label: '', hint: '' }, vm[k] || {}, { backend: (v && v.backend) || '' });
        payload.voiceMap = vm;
        const tiers = (payload.localTts && payload.localTts.tiers) || {};
        const usable = (payload.localTts && payload.localTts.usable) || {};
        payload.localTts.labeled = (payload.localTts.voices || []).map((id) => {
          const m = vm[id] || {};
          const parts = [];
          if (m.label) parts.push(m.label);
          if (m.backend) parts.push(m.backend + ' 引擎');
          // [qqbot-mod] tts-tiers 2026-10-27：完全用不了的音色直接标注并注明划到了哪档
          const be = String(m.backend || '');
          const tier = tiers[be] || {};
          const bad = tier.demoted || usable[id] === false;
          if (bad) {
            const nxt = (payload.localTts.engines || []).filter((e) => e !== be && !(tiers[e] || {}).demoted);
            parts.push('⛔ 不可用·已划到下一梯队' + (nxt.length ? '（' + nxt.join('/') + '）' : ''));
          }
          return {
            id,
            label: parts.length ? id + ' · ' + parts.join(' · ') : id,
            hint: bad && tier.last_error ? String(tier.last_error).slice(0, 120) : (m.hint || ''),
          };
        });
      }
      return writeJson(res, 200, payload);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  route(ctx, 'POST', '/api/qqbot-settings/ext-config', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const which = String((body && body.which) || 'local');
      if (!EXT_CFG_FILES[which]) return writeJson(res, 400, { ok: false, error: 'which 只能是 local 或 voice' });
      const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : null;
      if (!patch) return writeJson(res, 400, { ok: false, error: '缺 patch' });
      const bot = nsBot(String((body && body.ns) || ''));
      const root = resolveMemoryRoot(bot);
      const p = extCfgPath(root, which);
      if (!p) return writeJson(res, 400, { ok: false, error: '找不到数据目录' });
      const cur = readExtCfg(p);
      const next = Object.assign({}, cur, patch);
      // 这几个键永远不让空串覆盖成 ""：留空=用内置默认
      for (const k of ['systemPrompt', 'model', 'voice', 'baseUrl']) {
        if (next[k] === '') delete next[k];
      }
      try {
        if (existsSync(p)) writeFileSync(p + '.bak-' + Date.now(), readFileSync(p, 'utf8'), 'utf8');
      } catch { /* 备份失败不影响主流程 */ }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
      const out = { ok: true, which, path: p, config: readExtCfg(p) };
      if (which === 'local') out.ollama = await probeOllama(out.config);
      return writeJson(res, 200, out);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ★ 本机新增(2026-10-23): 本地代答判定日志（面板「最近判定」用它）
  //   每条消息一行：by=local|gag|cloud，why=被哪道门挡了，model / ms。
  route(ctx, 'GET', '/api/qqbot-settings/ext-answer-log', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const limit = Math.max(1, Math.min(50, Number(u.searchParams.get('limit') || 8) || 8));
      const bot = nsBot(NSQ(u));
      const root = resolveMemoryRoot(bot);
      const p = root ? join(root, '.qqbot', 'local-answer-log.jsonl') : '';
      let rows = [];
      if (p && existsSync(p)) {
        const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-limit);
        rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      }
      const localCfg = readExtCfg(extCfgPath(root, 'local'));
      return writeJson(res, 200, {
        ok: true, root, path: p, count: rows.length, rows,
        whoAnswers: String(localCfg.whoAnswers || 'simple'),
        model: String(localCfg.model || ''),
      });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // [qqbot-mod] tool-errors-view：工具失败不上群，只在这里看（数据由 dist/transport/tool-presenter.js 写入）
  route(ctx, 'GET', '/api/qqbot-settings/tool-errors', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const limit = Math.max(1, Math.min(50, Number(u.searchParams.get('limit') || 10) || 10));
      const bot = nsBot(NSQ(u));
      const root = resolveMemoryRoot(bot);
      const p = root ? join(root, '.qqbot', 'tool-errors.jsonl') : '';
      let rows = [];
      if (p && existsSync(p)) {
        const lines = readFileSync(p, 'utf8').split(String.fromCharCode(10)).filter(Boolean).slice(-limit);
        rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      }
      rows.reverse();
      return writeJson(res, 200, { ok: true, root: root || '', path: p, count: rows.length, rows });
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: String((e && e.message) || e), rows: [] });
    }
  });
  // [qqbot-mod] B 站管理（浮窗用）：只读任务/记录 + 审核动作；写操作仍由 bili_ops 的主人校验兜底
  async function biliLibOf(root) {
    const p = join(root, '.qqbot-extensions', 'lib', 'bili-ops.mjs');
    return import('file:///' + p.split(String.fromCharCode(92)).join('/'));
  }
  route(ctx, 'GET', '/api/qqbot-settings/bili', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const root = resolveMemoryRoot(nsBot(NSQ(u)));
      if (!root) return writeJson(res, 200, { ok: false, error: '没有数据根', jobs: [], records: [] });
      const lib = await biliLibOf(root);
      let account = null;
      try {
        const api = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-api.mjs').split(String.fromCharCode(92)).join('/'));
        const a = await api.nav(root);
        if (a && a.ok) account = a.data;
      } catch { /* 未登录/接口失败不影响任务列表 */ }
      let opsCfg = {};
      let plan = {};
      try {
        opsCfg = lib.loadOpsConfig(root);
        plan = lib.resolvePlan(opsCfg);
      } catch { /* 配置坏了不影响列表 */ }
      const jobs = lib.listJobs(root, { limit: 30 }).map((j) => ({
        id: j.id, title: j.title, status: j.status, at: j.at, durationSec: j.durationSec,
        published: j.published || null, dir: j.dir, warnings: j.warnings || 0, error: j.error || '',
        cover: j.cover || (j.dir ? join(j.dir, 'cover.jpg') : ''),
        video: j.video || (j.dir ? join(j.dir, 'video.mp4') : ''),
      }));
      const records = lib.readRecords(root, { limit: 20 });
      const drafts = lib.listCommentDrafts(root, { limit: 10 });
      const options = {
        mode: opsCfg.mode || 'local-first',
        imageProvider: (opsCfg.image && opsCfg.image.provider) || 'auto',
        videoStyle: (opsCfg.video && opsCfg.video.style) || 'auto',
        videoRoute: (opsCfg.video && opsCfg.video.route) || 'frames',
        textStyle: (opsCfg.video && opsCfg.video.text && opsCfg.video.text.style) || 'typewriter',
        sfx: !(opsCfg.sfx && opsCfg.sfx.enabled === false),
        resolved: plan,
      };
      return writeJson(res, 200, { ok: true, root, account, jobs, records, drafts, options });
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: String((e && e.message) || e), jobs: [], records: [], drafts: [] });
    }
  });
  route(ctx, 'POST', '/api/qqbot-settings/bili', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const root = resolveMemoryRoot(nsBot(NSQ(u)));
      if (!root) return writeJson(res, 200, { ok: false, error: '没有数据根' });
      const body = await readJsonBody(req).catch(() => ({}));
      const action = String(body.action || '');
      const jobId = String(body.jobId || '');
      const draftId = String(body.draftId || '');
      const lib = await biliLibOf(root);
      const cfg = lib.loadOpsConfig(root);
      // 打开目录：[qqbot-mod] 2026-10-28 改为可验证三连（cmd start → explorer → powershell）。
      //   原来 spawn 完直接回"已打开"，失败全被吞；rundll32 首版参数传错会弹错误框，弃用。
      const openInExplorer = (dir) => {
        try {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const tries = [
            ['cmd', ['/c', 'start', '', dir]],
            ['explorer', [dir]],
            ['powershell', ['-NoProfile', '-Command', 'Start-Process -FilePath explorer.exe -ArgumentList "' + String(dir).replace(/"/g, '') + '"']],
          ];
          let last = '';
          for (const [cmd, args] of tries) {
            try {
              const r = spawnSync(cmd, args, { timeout: 6000, windowsHide: true, stdio: 'ignore' });
              const bad = r.error || (r.status && r.status !== 0 && r.status !== 1);
              if (bad) { last = (r.error && r.error.message) || ('exit ' + r.status); continue; }
              return { ok: true, msg: '已打开 ' + dir + '（via ' + cmd + '）', path: dir };
            } catch (e) {
              last = String((e && e.message) || e);
            }
          }
          return { ok: false, error: '打开失败：' + last, path: dir };
        } catch (e) {
          return { ok: false, error: '打开失败：' + String((e && e.message) || e), path: dir };
        }
      };
      let r;
      // 出图来源 / 视频形态切换：只落配置，不动已生成的任务
      if (action === 'options') {
        const pick = (v, list, dflt) => (list.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : dflt);
        const next = JSON.parse(JSON.stringify(cfg || {}));
        if (body.mode !== undefined) next.mode = pick(body.mode, ['local-first', 'cloud-first'], 'local-first');
        if (body.imageProvider !== undefined) next.image = { ...(next.image || {}), provider: pick(body.imageProvider, ['auto', 'local', 'cloud'], 'auto') };
        if (body.videoStyle !== undefined) next.video = { ...(next.video || {}), style: pick(body.videoStyle, ['auto', 'text', 'image'], 'auto') };
        // 出片路子（2026-10-25）：frames=前端截图拼帧 / text=文字动画 / art=程序化画画
        if (body.videoRoute !== undefined) next.video = { ...(next.video || {}), route: pick(body.videoRoute, ['frames', 'text', 'art'], 'frames') };
        if (body.textStyle !== undefined) next.video = { ...(next.video || {}), text: { ...((next.video || {}).text || {}), style: pick(body.textStyle, ['typewriter', 'code', 'fade', 'slide'], 'typewriter') } };
        if (body.sfx !== undefined) next.sfx = { ...(next.sfx || {}), enabled: body.sfx !== false };
        const saved = lib.saveOpsConfig(root, next);
        if (!saved) r = { ok: false, error: '写配置失败' };
        else r = {
          ok: true,
          msg: '已保存：出图=' + (next.image ? next.image.provider : 'auto') + ' · 视频=' + (next.video ? next.video.style : 'auto') + ' · ' + next.mode,
          options: {
            mode: next.mode,
            imageProvider: next.image && next.image.provider,
            videoStyle: next.video && next.video.style,
            videoRoute: next.video && next.video.route,
            textStyle: next.video && next.video.text && next.video.text.style,
            sfx: !(next.sfx && next.sfx.enabled === false),
            resolved: lib.resolvePlan(next),
          },
        };
      } else if (draftId && action === 'comment-revise') {
        // 评论审核：修改建议（本地模型改写）/ 同意发送 / 拒绝
        r = await lib.reviseCommentDraft(root, { id: draftId, suggestion: body.suggestion }, cfg);
      } else if (draftId && action === 'comment-approve') {
        if (body.text) {
          const up = lib.updateCommentDraft(root, { id: draftId, text: body.text });
          if (!up.ok) return writeJson(res, 200, up);
        }
        r = await lib.approveComment(root, { draftId }, cfg);
      } else if (draftId && action === 'comment-reject') {
        r = lib.rejectCommentDraft(root, { id: draftId });
      } else if (action === 'comment-reply-draft') {
        // [qqbot-mod] reply-thread 2026-10-27：对某一条评论起草楼中楼回复（进既有的待审管线，同意后才真发）
        const bvidR = String(body.bvid || '').trim();
        const rpidR = String(body.rpid || '').trim();
        const commentR = String(body.comment || '').slice(0, 500);
        if (!bvidR || !rpidR) return writeJson(res, 200, { ok: false, error: '缺少 BV 号或评论 rpid' });
        r = await lib.draftComment(root, { bvid: bvidR, intent: commentR || '（原评论内容缺失，请自己补写一句）', message: String(body.text || '').trim(), root: rpidR, user: String(body.user || ''), source: 'reply:' + String(body.user || rpidR) }, cfg);
      } else if (action === 'msgs') {
        // [qqbot-mod] bili-msgs 2026-10-27：私信收件箱（会话列表）
        const apiM = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-api.mjs').split(String.fromCharCode(92)).join('/'));
        r = await apiM.sessions(root, { limit: 20 });
      } else if (action === 'msgs-read') {
        const apiM = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-api.mjs').split(String.fromCharCode(92)).join('/'));
        r = await apiM.msgs(root, { talkerId: String(body.talkerId || '') });
      } else if (action === 'msg-send') {
        const apiM = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-api.mjs').split(String.fromCharCode(92)).join('/'));
        r = await apiM.msgSend(root, { receiverId: String(body.talkerId || body.receiverId || ''), text: String(body.text || '') });
        if (r && r.ok) lib.appendRecord(root, { type: 'msg', text: '→ ' + String(body.talkerId || '') + '：' + String(body.text || '').slice(0, 80) });
      } else if (action === 'dynamics') {
        const api = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-api.mjs').split(String.fromCharCode(92)).join('/'));
        const dy = await api.dynamics(root, { limit: 6 });
        if (!dy || !dy.ok) return writeJson(res, 200, { ok: false, error: (dy && dy.error) || '读动态失败' });
        r = { ok: true, items: dy.items || [] };
      } else if (action === 'plan') {
        // [[qqbot-mod] video-flow] 一句话 → 成片：先写脚本/分镜，再出图配音。
        // 旧实现直接 newJob+renderJob，从没写过 panels，所以永远失败在"任务没有分镜"。
        const topic = String(body.topic || body.text || '').trim();
        if (!topic) return writeJson(res, 200, { ok: false, error: '先写一句要求' });
        const jobId = lib.newJobId();
        const orientation = String(body.orientation || '').toLowerCase() === 'vertical' ? 'vertical' : 'horizontal';
        const panels = Number(body.panels) || 0;
        const scriptJson = String(body.scriptJson || '').trim();
        let secret = {};
        try { secret = lib.readSecret(root) || {}; } catch { }
        lib
          .planAndRender(root, cfg, { jobId, topic, panels, orientation, scriptJson, secret })
          .then((x) => {
            lib.appendRecord(root, {
              type: 'plan',
              jobId,
              title: (x && x.job && x.job.title) || topic.slice(0, 40),
              panels: (x && x.job && x.job.panels && x.job.panels.length) || 0,
              llm: (x && x.script && x.script.llm) || '',
              ok: !!(x && x.ok),
              warnings: (x && x.detail && x.detail.warnings && x.detail.warnings.length) || 0,
              error: (x && x.error) || '',
            });
          })
          .catch((e) => lib.updateJob(root, jobId, { status: 'failed', stage: 'failed', error: String((e && e.message) || e) }));
        r = {
          ok: true,
          jobId,
          msg: '已开始：先写分镜脚本，然后出图、配音、拼片（3~8 分钟，可随时刷新看进度）',
        };
      } else if (action === 'comment-from-video') {
        const bvid = String(body.bvid || '').trim();
        if (!bvid) return writeJson(res, 200, { ok: false, error: '缺少 BV 号' });
        const api = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-api.mjs').split(String.fromCharCode(92)).join('/'));
        const v = await api.video(root, { bvid });
        if (!v || !v.ok) return writeJson(res, 200, { ok: false, error: (v && v.error) || '查视频失败' });
        const cs = await api.comments(root, { aid: v.video.aid, limit: 20 });
        if (!cs || !cs.ok) return writeJson(res, 200, { ok: false, error: (cs && cs.error) || '读评论失败' });
        const top = (cs.replies || [])
          .filter((x) => x && x.text)
          .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0))
          .slice(0, Math.max(1, Number(cfg?.review?.maxPerBatch) || 2));
        const made = [];
        for (const c of top) {
          const d = await lib.draftComment(root, { bvid, intent: c.text }, cfg);
          if (d && d.ok) made.push(d.draft);
        }
        r = { ok: made.length > 0, drafts: made, error: made.length ? '' : '没有生成出草稿', video: v.video.title,
          // [qqbot-mod] reply-thread：把评论本尊也回传（rpid/昵称/内容/赞数），浮窗可以对单条评论起草楼中楼回复
          commentRows: (cs.replies || []).filter((x) => x && x.text).sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0))
            .map((x) => ({ rpid: String(x.rpid || ''), user: x.user || '', text: x.text, likes: Number(x.likes) || 0 })),
          bvid };
      } else if (action === 'login-qr-start') {
        // [qqbot-mod] bili-qr-login 2026-10-27：浮窗内直接扫码登录（cookie 会失效是 B 站风控常态，
        //   不能每次都让用户跑去找私聊入口；ASCII 二维码用宿主自带 qrcode-terminal 生成，前端 <pre> 直显可扫）
        try {
          const apiL = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-api.mjs').split(String.fromCharCode(92)).join('/'));
          const g = await apiL.qrGenerate();
          if (!g || !g.ok) return writeJson(res, 200, { ok: false, error: (g && g.error) || '生成二维码失败' });
          let ascii = ''
          try {
            const qt = await import('qrcode-terminal');
            await new Promise((done) => (qt.default || qt).generate(g.url, { small: true }, (out) => { ascii = String(out || ''); done(); }));
          } catch (eQ) { ascii = ''; }
          // [qqbot-mod] qr-svg-fix 2026-10-27：ASCII 码在 webview 里常常扫不动/生成失败（裸包解析不稳），
          //   优先用 vendored qrcode 生成矢量 SVG（本地生成，不联网），更稳更清晰
          let svg = ''
          try {
            const dy = await __qqExtImport(root, join('.qqbot-extensions', 'lib', 'platforms', 'douyin.mjs'))
            const q = await dy.qrSvg(g.url, { width: 220 })
            if (q && q.ok) svg = String(q.svg || '')
          } catch (eSvg) { svg = '' }
          return writeJson(res, 200, { ok: true, key: g.key, ascii, svg, url: g.url });
        } catch (eL) { return writeJson(res, 200, { ok: false, error: '扫码初始化失败：' + String((eL && eL.message) || eL) }); }
      } else if (action === 'login-qr-poll') {
        try {
          const key = String(body.key || '');
          if (!key) return writeJson(res, 200, { ok: false, error: '缺少 key' });
          const apiL = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'bili-api.mjs').split(String.fromCharCode(92)).join('/'));
          const p = await apiL.qrPoll(key);
          if (!p || !p.ok) return writeJson(res, 200, { ok: false, state: '', error: (p && p.error) || '轮询失败' });
          if (p.state === 'ok') {
            try { await apiL.saveCookie(root, p.cookies); } catch (eS) { return writeJson(res, 200, { ok: false, error: '保存 cookie 失败：' + String((eS && eS.message) || eS) }); }
            const n = await apiL.nav(root).catch(() => null);
            return writeJson(res, 200, { ok: true, state: 'ok', account: (n && n.ok) ? n.data : null, msg: '登录成功' });
          }
          return writeJson(res, 200, { ok: true, state: p.state });
        } catch (eP) { return writeJson(res, 200, { ok: false, error: '轮询异常：' + String((eP && eP.message) || eP) }); }
      } else if (action === 'open-root') {
        r = openInExplorer(lib.paths(root).jobs); // [[qqbot-mod] video-flow] 跟着 storage.root 走，别再用写死的旧路径
      } else if (action === 'delete') {
        const job = lib.getJob(root, jobId);
        if (!job || !job.dir || !existsSync(job.dir)) return writeJson(res, 200, { ok: false, error: '产物目录不存在' });
        lib.appendRecord(root, { type: 'delete', jobId, at: Date.now() });
        rmSync(job.dir, { recursive: true, force: true });
        r = { ok: true, msg: '已删除 ' + jobId };
      } else if (action === 'comment-watch') {
        // [qqbot-mod] 2026-10-28 评论巡检：auto=true 直接回复 B 站评论（拟人间隔，可能要 1~3 分钟）
        const CW = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'comment-watch.mjs').split(String.fromCharCode(92)).join('/'));
        r = await CW.biliCheck(root, { auto: body.auto === true, maxReply: Number(body.maxReply) || 3, limit: Number(body.limit) || 10 });
      } else if (action === 'comment-list') {
        // [qqbot-mod] 2026-10-28 主人要求：B站巡检要能「出评论」——只读列表（带回复状态），不调 LLM 秒回
        const CW = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'comment-watch.mjs').split(String.fromCharCode(92)).join('/'));
        r = await CW.biliList(root, { limit: Number(body.limit) || 10 });
      } else if (action === 'comment-reply') {
        // 单条操作：mode='send' 直接回复该条评论；mode='draft' 重新生成草稿（可反复刷新）
        const CW = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'comment-watch.mjs').split(String.fromCharCode(92)).join('/'));
        r = await CW.biliReply(root, body);
      } else if (action === 'comment-replied') {
        const CW = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'comment-watch.mjs').split(String.fromCharCode(92)).join('/'));
        r = { ok: true, items: CW.repliedList(root) };
      } else if (action === 'douyin-comment-watch') {
        // 抖音评论只读：出草稿（回复走手工，避免风控）
        const CW = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'comment-watch.mjs').split(String.fromCharCode(92)).join('/'));
        r = await CW.douyinCheck(root, { url: String(body.url || ''), limit: Number(body.limit) || 15 });
      } else if (action === 'open-folder') {
        const job = lib.getJob(root, jobId);
        if (!job || !job.dir) return writeJson(res, 200, { ok: false, error: '找不到任务目录：' + jobId });
        r = openInExplorer(job.dir);
      } else if (!jobId) {
        return writeJson(res, 200, { ok: false, error: '缺少 jobId 或 draftId' });
      } else if (action === 'retry') {
        // [qqbot-mod] 2026-10-28：失败任务就地重试——保留原任务 id，重新走渲染管线
        //   （有分镜直接渲染；只有选题的半截任务 renderJob 内部会自动补脚本）。
        const job = lib.getJob(root, jobId);
        if (!job) return writeJson(res, 200, { ok: false, error: '任务不存在' });
        if (job.status === 'rendering') return writeJson(res, 200, { ok: false, error: '正在渲染中，别急' });
        if (job.status === 'awaiting_review') return writeJson(res, 200, { ok: false, error: '已在待审核，直接投稿即可' });
        if (job.published && job.published.bvid) return writeJson(res, 200, { ok: false, error: '这条已经发布过了（' + job.published.bvid + '）' });
        lib.updateJob(root, jobId, { status: 'rendering', stage: 'render', error: '', updatedAt: Date.now() });
        const job2 = lib.getJob(root, jobId);
        lib
          .renderJob(job2, cfg, { dataRoot: root })
          .then((x) => {
            if (!x || x.ok === false) {
              lib.updateJob(root, jobId, { status: 'failed', stage: 'failed', error: String((x && (x.error || x.reason)) || '渲染失败') });
            }
          })
          .catch((e) => lib.updateJob(root, jobId, { status: 'failed', stage: 'failed', error: String((e && e.message) || e) }));
        r = { ok: true, msg: '已重新开始渲染（3~8 分钟，刷新看进度）' };
      } else if (action === 'approve') r = await lib.approveJob(root, jobId, cfg);
      else if (action === 'publish') r = await lib.publishJob(root, jobId, { mode: 'web' }, cfg);
      else if (action === 'reject') {
        lib.updateJob(root, jobId, { status: 'rejected' });
        lib.appendRecord(root, { type: 'reject', jobId, at: Date.now() });
        r = { ok: true };
      } else r = { ok: false, error: '未知动作：' + action };
      return writeJson(res, 200, r);
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  });
  route(ctx, 'GET', '/api/qqbot-settings/bili-file', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const root = resolveMemoryRoot(nsBot(NSQ(u)));
      if (!root) return writeJson(res, 404, { ok: false, error: '没有数据根' });
      const jobId = String(u.searchParams.get('jobId') || '');
      const name = String(u.searchParams.get('name') || 'cover.jpg');
      if (!/^[A-Za-z0-9._-]+$/.test(jobId) || !/^(cover\.jpg|video\.mp4)$/.test(name)) {
        return writeJson(res, 400, { ok: false, error: '非法文件' });
      }
      const lib = await biliLibOf(root);
      const job = lib.getJob(root, jobId);
      if (!job || !job.dir) return writeJson(res, 404, { ok: false, error: '任务不存在' });
      const file = join(job.dir, name);
      if (!file.startsWith(job.dir) || !existsSync(file)) return writeJson(res, 404, { ok: false, error: '文件不存在' });
      const buf = readFileSync(file);
      res.writeHead(200, {
        'content-type': name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg',
        'content-length': buf.length,
        'cache-control': 'no-store',
      });
      res.end(buf);
    } catch (e) {
      return writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });
  route(ctx, 'POST', '/api/qqbot-settings/memory-import', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const root = resolveMemoryRoot(nsBot(NSQ(u)));
      if (!root) return writeJson(res, 200, { ok: false, error: '没有数据根' });
      const body = await readJsonBody(req).catch(() => ({}));
      const file = String(body.file || '').trim();
      if (!file) return writeJson(res, 200, { ok: false, error: '缺少 file（本机 txt/json 路径）' });
      const lib = await import('file:///' + join(root, '.qqbot-extensions', 'lib', 'qq-history-import.mjs').split(String.fromCharCode(92)).join('/'));
      const selfNames = Array.isArray(body.selfNames) ? body.selfNames : String(body.selfNames || '').split(/[,，\s]+/).filter(Boolean);
      const r = await lib.importHistory({
        dataRoot: root,
        file,
        peer: String(body.peer || '').trim(),
        peerOpenid: String(body.peerOpenid || '').trim(),
        selfUin: String(body.selfUin || '').trim(),
        selfNames,
        archive: body.archive !== false,
        limit: Number(body.limit) || 400,
        mask: body.mask !== false,
      });
      return writeJson(res, 200, { ok: !!r.ok, ...r });
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  });
  route(ctx, 'GET', '/api/qqbot-settings/memory', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(NSQ(u));
      const root = resolveMemoryRoot(bot);
      const memDir = root ? join(root, '.qqbot', 'memory') : '';
const dbFile = root ? join(root, '.qqbot', 'memory.db') : '';
      const scopes = [];
      const persona = { total: 0, rows: [] };
      let backend = 'jsonl';
      // ① 优先读 SQLite（记忆库已换成真数据库；jsonl 只是迁移源/旧后端）
      if (dbFile && existsSync(dbFile)) {
        try {
          const { DatabaseSync } = await import('node:sqlite');
          const db = new DatabaseSync(dbFile, { readOnly: true });
          const byScope = new Map();
          for (const r of db.prepare('SELECT scope, kind, COUNT(*) AS c FROM mem GROUP BY scope, kind').all()) {
            const k = String(r.scope || '?');
            if (!byScope.has(k)) byScope.set(k, { scope: k, total: 0, byKind: {}, recent: [] });
            const s = byScope.get(k);
            s.total += Number(r.c) || 0;
            s.byKind[String(r.kind || '?')] = Number(r.c) || 0;
          }
          const recent = db.prepare('SELECT scope, kind, text, ts FROM mem ORDER BY ts DESC LIMIT 500').all();
          for (const r of recent) {
            const s = byScope.get(String(r.scope || '?'));
            if (s && s.recent.length < 8) s.recent.push({ kind: r.kind || '', text: String(r.text || '').slice(0, 160), ts: r.ts || 0 });
          }
          for (const s of byScope.values()) scopes.push(s);
          try {
            const pr = db.prepare('SELECT scope, ckey, cvalue, weight, ts FROM persona ORDER BY ts DESC LIMIT 80').all();
            persona.total = pr.length;
            persona.rows = pr.map((r) => ({ scope: r.scope, key: r.ckey, value: String(r.cvalue || '').slice(0, 150), w: r.weight, ts: r.ts }));
          } catch { /* 没有 persona 表也不影响 */ }
          db.close();
          backend = 'sqlite';
        } catch (e) {
          backend = 'jsonl(回退:' + String((e && e.message) || e).slice(0, 40) + ')';
        }
      }
      // ② 没有 db / db 读不了，才回退旧的 jsonl
      if (backend !== 'sqlite' && memDir && existsSync(memDir)) {
        for (const f of readdirSync(memDir)) {
          if (!f.endsWith('.jsonl') || f.startsWith('_')) continue;
          const items = [];
          try {
            for (const line of readFileSync(join(memDir, f), 'utf8').split('\n')) {
              if (!line.trim()) continue;
              try { items.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
            }
          } catch { /* 读不到就跳过这个 scope */ }
          const byKind = {};
          for (const it of items) byKind[it.kind || '?'] = (byKind[it.kind || '?'] || 0) + 1;
          scopes.push({
            scope: f.replace(/\.jsonl$/, ''),
            total: items.length,
            byKind,
            recent: items.slice(-8).reverse().map((it) => ({ kind: it.kind || '', text: String(it.text || '').slice(0, 160), ts: it.ts || 0 })),
          });
        }
      }
      const router = { lines: 0, tiers: {}, last: [] };
      const rl = root ? join(root, '.qqbot', 'router-log.jsonl') : '';
      if (rl && existsSync(rl)) {
        const arr = readFileSync(rl, 'utf8').split('\n').filter(Boolean).slice(-500);
        router.lines = arr.length;
        for (const l of arr) {
          try { const o = JSON.parse(l); router.tiers[o.tier] = (router.tiers[o.tier] || 0) + 1; } catch { /* ignore */ }
        }
        for (const l of arr.slice(-10).reverse()) {
          try { const o = JSON.parse(l); router.last.push({ tier: o.tier, score: o.score, mentioned: !!o.mentioned, len: (o.s || {}).len, ts: o.ts }); } catch { /* ignore */ }
        }
      }
      const payload = { ok: true, root, memDir, backend, persona, scopes: scopes.sort((a, b) => b.total - a.total), router };
      if (String(u.searchParams.get('format') || '') === 'html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderMemoryPage(payload));
        return;
      }
      return writeJson(res, 200, payload);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

route(ctx, 'GET', '/api/qqbot-settings/affinity', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(NSQ(u));
      const dataRoot = (bot && bot.cfg && typeof bot.cfg.dataRoot === 'string' && bot.cfg.dataRoot) ? bot.cfg.dataRoot : ((bot && bot.cwd) || '');
      if (!dataRoot) return writeJson(res, 200, { ok: true, items: [] });
      const mod = await import('./dist/features/local-signals.js');
      const limit = Math.max(1, Math.min(50, Math.round(Number(u.searchParams.get('limit'))) || 8));
      const items = (mod.topAffinity(dataRoot, limit) || []).map((x) => ({
        key: x.key, name: x.name || '', score: x.score, tier: x.tier || '', reviews: x.reviews || 0, msgs: x.msgs, mentions: x.mentions, replies: x.replies, lastAt: x.lastAt,
      }));
      writeJson(res, 200, { ok: true, items });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // 好感度(2026-09-14 主人"直接推进"): A 值台账 —— 与「熟识度」是**两个维度**, 面板分两列
  //   熟识度 = 她把他记多牢(客观计数+记忆曲线, 慢变) ｜ 好感度 = 她对他什么态度(随事件可升可降)
  //   数据源: {dataRoot}/.qqbot/attitude.json (内心倾向 + 正文情绪 → Δ → A 值, 见 features/attitude.ts)
  route(ctx, 'GET', '/api/qqbot-settings/attitude', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(NSQ(u));
      const dataRoot = (bot && bot.cfg && typeof bot.cfg.dataRoot === 'string' && bot.cfg.dataRoot) ? bot.cfg.dataRoot : ((bot && bot.cwd) || '');
      if (!dataRoot) return writeJson(res, 200, { ok: true, items: [] });
      const mod = await import('./dist/features/attitude.js');
      // ⚠️ 2026-09-15 修(主人反馈"小明不是有好感度吗, 怎么显示 0/—"):
      //   面板那张熟识度表是**按 key 左连接**好感度的(top N 只够"排行榜", 不够"连接") ——
      //   原来默认 limit=8, 排第 9 的人(小明 a=0.064 但 events=128)就 join 不到 → 显示 "—"。
      //   all=1 = 要全量(连接用); 默认仍是 top N 排行语义, 不破坏别处调用。
      const wantAll = u.searchParams.get('all') === '1';
      const limit = wantAll ? 100000 : Math.max(1, Math.min(50, Math.round(Number(u.searchParams.get('limit'))) || 8));
      const items = (mod.topAttitude(dataRoot, limit) || []).map((x) => {
        // 档位名（面板显示用，2026-09-14 主人要求）：按"好感度占其范围的比例"分 很亲近/亲近/中立/冷淡/疏远
        let tier = '';
        let ratio = 0;
        try {
          const g = mod.attitudeGateFor(dataRoot, x.key);
          if (g) { tier = g.tier; ratio = Math.round(g.ratio * 1000) / 1000; }
        } catch { /* 算不出就不显示档位 */ }
        return {
          key: x.key, name: x.name || '', a: x.a, events: x.events || 0, lastAt: x.lastAt || 0, why: x.lastWhy || '', codes: x.lastCodes || [], tier, ratio,
        };
      });
      writeJson(res, 200, { ok: true, items });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // 价值样例库读写(2026-09-13 主人定): {dataRoot}/.qqbot/value-samples.jsonl —— 用户可直接编辑
  function valueSamplesPathOf(bot) {
    const dataRoot = (bot && bot.cfg && typeof bot.cfg.dataRoot === 'string' && bot.cfg.dataRoot)
      ? bot.cfg.dataRoot
      : ((bot && bot.cwd) || '');
    return dataRoot ? join(dataRoot, '.qqbot', 'value-samples.jsonl') : '';
  }
  route(ctx, 'GET', '/api/qqbot-settings/value-samples', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const p = valueSamplesPathOf(nsBot(NSQ(u)));
      if (!p) return writeJson(res, 400, { ok: false, error: '找不到数据目录' });
      const exists = existsSync(p);
      const text = exists ? readFileSync(p, 'utf8') : '';
      const lines = text.split('\n').filter((l) => l.trim());
      let pos = 0;
      let neg = 0;
      let bad = 0;
      for (const l of lines) {
        try { const o = JSON.parse(l); if (o.y === 1) pos += 1; else neg += 1; } catch { bad += 1; }
      }
      writeJson(res, 200, { ok: true, text, total: lines.length, pos, neg, bad, isDefault: !exists, path: p });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });
  route(ctx, 'POST', '/api/qqbot-settings/value-samples', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const p = valueSamplesPathOf(nsBot(String((body && body.ns) || '')));
      if (!p) return writeJson(res, 400, { ok: false, error: '找不到数据目录' });
      const lines = String((body && body.text) || '').split('\n').filter((l) => l.trim());
      const bad = [];
      const clean = [];
      lines.forEach((l, i) => {
        try {
          const o = JSON.parse(l);
          const m = String(o && o.m ? o.m : '').trim();
          if (!m) throw new Error('缺 m 字段');
          clean.push(JSON.stringify({ m, y: o.y === 1 ? 1 : 0, src: typeof o.src === 'string' ? o.src : 'manual' }));
        } catch (e) { bad.push(`第${i + 1}行 ${String((e && e.message) || e)}`); }
      });
      if (bad.length) return writeJson(res, 400, { ok: false, error: `有 ${bad.length} 行格式不对 → ${bad.slice(0, 3).join('; ')}` });
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, clean.join('\n') + (clean.length ? '\n' : ''), 'utf8');
      const pos = clean.filter((l) => JSON.parse(l).y === 1).length;
      writeJson(res, 200, { ok: true, saved: clean.length, pos, neg: clean.length - pos, path: p });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });
  // 「让ai写」(2026-09-13 主人要的): 模拟一条用户消息唤醒她(照抄定时任务的做法: 伪造 msg → handleInbound)
  route(ctx, 'POST', '/api/qqbot-settings/value-samples/let-ai-write', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const ns = String((body && body.ns) || '');
      const mod = await import('@zaofan/dsh-qqbot/channel-tools');
      if (typeof mod.askAiToWriteSamples !== 'function') {
        return writeJson(res, 500, { ok: false, error: '线上插件还是旧版本(需重启宿主加载新代码)' });
      }
      const scope = String((body && body.scope) || 'group') === 'c2c' ? 'c2c' : 'group';
      let peerId = String((body && body.peerId) || '');
      if (!peerId) {
        // 兜底(免得非要先选目标): 从最近评分记录里取最近活跃的群
        try {
          const b2 = nsBot(ns);
          const dr = (b2 && b2.cfg && typeof b2.cfg.dataRoot === 'string' && b2.cfg.dataRoot) ? b2.cfg.dataRoot : ((b2 && b2.cwd) || '');
          const pf = dr ? join(dr, '.qqbot', 'value-scores.jsonl') : '';
          if (pf && existsSync(pf)) {
            const rows = readFileSync(pf, 'utf8').split('\n').filter((l) => l.trim());
            for (let i = rows.length - 1; i >= 0; i--) {
              try { const o = JSON.parse(rows[i]); if (o && o.gid) { peerId = String(o.gid); break; } } catch { /* 坏行跳过 */ }
            }
          }
        } catch { /* 兜底失败就按"没有目标"返回 */ }
      }
      const r = await mod.askAiToWriteSamples(ns, scope, peerId);
      writeJson(res, 200, r);
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // 价值评分记录(观察期): {dataRoot}/.qqbot/value-scores.jsonl 尾 N 条
  // gid= 时**只给该群的记录**(2026-09-13 主人要求: 评分要跟随面板"当前会话"命中的群, 与群管理页一致)
  route(ctx, 'GET', '/api/qqbot-settings/value-scores', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(NSQ(u));
      const gid = (u.searchParams.get('gid') || '').trim();
      const limit = Math.max(1, Math.min(100, Number(u.searchParams.get('limit')) || 20));
      const dataRoot = (bot && bot.cfg && typeof bot.cfg.dataRoot === 'string' && bot.cfg.dataRoot)
        ? bot.cfg.dataRoot
        : ((bot && bot.cwd) || '');
      const p = dataRoot ? join(dataRoot, '.qqbot', 'value-scores.jsonl') : '';
      if (!p || !existsSync(p)) return writeJson(res, 200, { ok: true, items: [], total: 0, totalAll: 0, gid });
      let lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
      const totalAll = lines.length;
      if (gid) {
        lines = lines.filter((l) => {
          try { return String(JSON.parse(l).gid || '') === gid; } catch { return false; }
        });
      }
      const items = lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      writeJson(res, 200, { ok: true, items, total: lines.length, totalAll, gid });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // 本地成员清单(官方成员列表未开放 → 用机器人见过的发言者兜底; 供禁言"选人"与成员 Tab 展示)
  route(ctx, 'GET', '/api/qqbot-settings/group/members_local', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const gid = GQ(u);
      const bot = nsBot(NSQ(u));
      if (!bot) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const store = getStickerStore(bot.cwd ? join(bot.cwd, '表情包') : undefined);
      // 与台账同 dataDir 的 group-members.jsonl
      const mod = await import('./dist/features/chat-ledger.js');
      const members = mod.readGroupMembers(store.dataDir, gid || undefined);
      writeJson(res, 200, { ok: true, members });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 手动审批入群 {ns?, gid, member_openid, op:approve|decline, reason?}
  route(ctx, 'POST', '/api/qqbot-settings/group/approve', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const gid = String(body.gid || '');
    const mid = String(body.member_openid || '');
    const op = String(body.op || '');
    if (!gid || !mid || (op !== 'approve' && op !== 'decline')) return writeJson(res, 400, { error: 'gid/member_openid/op(approve|decline) 必填' });
    try {
      const gc = await groupClientOf(String(body.ns || ''));
      if (!gc) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const listR = await gc.client.listJoinRequests(gid);
      const found = listR.ok ? (listR.data.list || []).find((x) => x.member_openid === mid) : undefined;
      const r = await gc.client.approveJoinRequest(gid, mid, op, {
        ...(found ? { join_request_id: found.join_request_id } : {}),
        ...(op === 'decline' && String(body.reason || '') ? { reject_reason: String(body.reason) } : {}),
      });
      audit(gc.bot.cwd, { ev: 'group.approve', ns: gc.bot.id, gid, member_openid: mid, op, reason: String(body.reason || ''), ok: r.ok, code: r.ok ? undefined : (r.err && r.err.code) });
      writeJson(res, r.ok ? 200 : 200, r.ok ? { ok: true, msg: op === 'approve' ? '已放行' : '已拒绝' } : { ok: false, err: r.err });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 禁言状态 {ns?, gid}
  route(ctx, 'GET', '/api/qqbot-settings/group/mute_state', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const gid = GQ(u);
      if (!gid) return writeJson(res, 400, { error: 'gid 必填' });
      const gc = await groupClientOf(NSQ(u));
      if (!gc) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const r = await gc.client.getMuteState(gid);
      writeJson(res, 200, r.ok ? { ok: true, data: r.data } : { ok: false, err: r.err });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 手动禁言/解禁 {ns?, gid, member_openid, action:mute|unmute, seconds?}
  route(ctx, 'POST', '/api/qqbot-settings/group/mute', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const gid = String(body.gid || '');
    const mid = String(body.member_openid || '');
    const action = String(body.action || '');
    if (!gid || !mid || (action !== 'mute' && action !== 'unmute')) return writeJson(res, 400, { error: 'gid/member_openid/action(mute|unmute) 必填' });
    try {
      const gc = await groupClientOf(String(body.ns || ''));
      if (!gc) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const secs = action === 'mute' ? Math.max(1, Math.min(30 * 86400, Math.round(Number(body.seconds || 600)))) : 0;
      const p2 = (n) => String(n).padStart(2, '0');
      const expire = action === 'mute' ? new Date(Date.now() + secs * 1000) : null;
      const rfc = expire ? expire.getFullYear() + '-' + p2(expire.getMonth() + 1) + '-' + p2(expire.getDate()) + 'T' + p2(expire.getHours()) + ':' + p2(expire.getMinutes()) + ':' + p2(expire.getSeconds()) + '+08:00' : null;
      const r = await gc.client.setMemberMute(gid, mid, rfc);
      audit(gc.bot.cwd, { ev: 'group.mute', ns: gc.bot.id, gid, member_openid: mid, action, seconds: secs, ok: r.ok, code: r.ok ? undefined : (r.err && r.err.code) });
      // ⚠️ 官方对"禁言已退群成员"静默返回成功但不生效(实测 HTTP 200 空体, 状态列表无此人)
      // → 禁言后回读 restrict_chat_setting 验证: 目标不在成员列表 = 已不在群/无法禁言 → 人话提示 + 自动剔除本地名单
      if (r.ok && action === 'mute') {
        try {
          const st = await gc.client.getMuteState(gid);
          const stMembers = (st.ok && st.data && Array.isArray(st.data.members) ? st.data.members : []) || [];
          const present = stMembers.some((m) => m.member_openid === mid);
          if (!present) {
            const store = getStickerStore(gc.bot.cwd ? join(gc.bot.cwd, '表情包') : undefined);
            const ledgerMod = await import('./dist/features/chat-ledger.js');
            ledgerMod.removeGroupMember(store.dataDir, gid, mid);
            audit(gc.bot.cwd, { ev: 'group.member-auto-remove', ns: gc.bot.id, gid, member_openid: mid, reason: '禁言无效(成员已不在群)' });
            return writeJson(res, 200, { ok: false, err: { code: 'MEMBER_NOT_IN_GROUP', human: '该成员已不在群(可能已退群)——已自动从本地成员清单剔除' } });
          }
        } catch (e2) { /* 回读失败不阻断, 按成功返回 */ }
      }
      writeJson(res, r.ok ? 200 : 200, r.ok ? { ok: true, msg: action === 'mute' ? '已禁言 ' + Math.round(secs / 60) + ' 分钟' : '已解除禁言' } : { ok: false, err: r.err });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // [qqbot-mod] video-radar 2026-10-27：视频雷达（拉视频→生评论；B站直发/笔记）
  //   POST /api/qqbot-settings/video-pull {platform:'bili'|'douyin', url?, random?}
  //     → {ok, platform, video:{id,title,author,url,stats}, comments[], draft}
  //   POST /api/qqbot-settings/video-act  {action:'bili-comment'|'note', ...}
  //   GET  /api/qqbot-settings/video-act?action=note-list
  const __extLib = async (root, name) => import('file:///' + join(root, '.qqbot-extensions', 'lib', name).split(String.fromCharCode(92)).join('/'));
  route(ctx, 'POST', '/api/qqbot-settings/video-pull', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const bot = nsBot(String((body && body.ns) || ''));
      const root = resolveMemoryRoot(bot);
      const vc = await __extLib(root, 'video-curator.mjs');
      const r = await vc.pull(root, { platform: body.platform, url: body.url, random: !!body.random });
      if (!r.ok) return writeJson(res, 200, r);
      const d = await vc.draftComment(root, r.video);
      r.draft = d.text;
      r.draftMs = d.ms;
      r.draftFallback = !!d.fallback;
      writeJson(res, 200, r);
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });
  route(ctx, 'POST', '/api/qqbot-settings/video-act', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const bot = nsBot(String((body && body.ns) || ''));
      const root = resolveMemoryRoot(bot);
      const vc = await __extLib(root, 'video-curator.mjs');
      const action = String(body.action || '');
      if (action === 'note') {
        const r = vc.noteAdd(root, body.note || {});
        return writeJson(res, 200, r.ok ? r : { ok: false, error: r.error });
      }
      if (action === 'bili-comment') {
        // S4 档：人已在浮窗点过确认，这里只是执行手。root 级评论（无 root/parent）
        const bops = await __extLib(root, 'bili-ops.mjs');
        const bapi = await __extLib(root, 'bili-api.mjs');
        const v = await bapi.video(root, { bvid: String(body.id || '') });
        if (!v.ok) return writeJson(res, 200, { ok: false, error: '拉视频信息失败：' + (v.error || '?') });
        const r = await bops.replyComment(root, { aid: v.video.aid, message: String(body.message || '') });
        try { vc.noteAdd(root, { platform: 'bili', id: body.id, title: v.video.title, url: v.video.url, comment: String(body.message || '').slice(0, 200), note: r.ok ? '已直发（rpid ' + (r.rpid || '') + '）' : '直发失败：' + (r.error || '?') }); } catch { /* 记账失败不影响 */ }
        return writeJson(res, 200, r);
      }
      writeJson(res, 400, { ok: false, error: '未知 action: ' + action });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });
  route(ctx, 'GET', '/api/qqbot-settings/video-act', async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (u.searchParams.get('action') === 'note-list') {
        const bot = nsBot(String(u.searchParams.get('ns') || ''));
        const root = resolveMemoryRoot(bot);
        const vc = await __extLib(root, 'video-curator.mjs');
        return writeJson(res, 200, { ok: true, notes: vc.noteList(root, { limit: 30 }) });
      }
      writeJson(res, 400, { ok: false, error: '未知 action' });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // 面板代发消息: 以机器人身份向群发文本 {ns?, gid, text, insertContext?}
  // insertContext=true → 发完后往该 QQ 会话 append 一条 user/message(模拟用户消息, 内容以
  // 「用户代你发送: 」开头, web 流可见、不唤醒、不开回合——与入群申请通知同款姿势)。
  // 该文本只进 web 流, QQ 群里收到的是干净原文。
  route(ctx, 'POST', '/api/qqbot-settings/group/send', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const gid = String(body.gid || '').trim();
    const text = String(body.text || '').trim();
    if (!gid || !text) return writeJson(res, 400, { error: 'gid 与 text 必填' });
    if (text.length > 2000) return writeJson(res, 400, { error: '文本过长(最多 2000 字符)' });
    try {
      const gc = await groupClientOf(String(body.ns || ''));
      if (!gc) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const r = await gc.client.sendGroupText(gid, text);
      audit(gc.bot.cwd, { ev: 'group.send', ns: gc.bot.id, gid, text: text.slice(0, 120), ok: r.ok, code: r.ok ? undefined : (r.err && r.err.code) });
      let ctxNote = '';
      if (r.ok && body.insertContext === true) {
        const why = await appendUserRelayToPeer(String(body.ns || 'im-qqbot'), 'group', gid, text).catch((e) => { audit(gc.bot.cwd, { ev: 'group.send.insertContext-failed', ns: gc.bot.id, error: String((e && e.message) || e) }); return 'failed'; });
        if (why) audit(gc.bot.cwd, { ev: 'group.send.insertContext-skipped', ns: gc.bot.id, gid, reason: why });
        ctxNote = why ? '(' + (WHY_MAP[why] || why) + ')' : '(已写入上下文: 用户代你发送)';
      }
      writeJson(res, r.ok ? 200 : 200, r.ok ? { ok: true, msg: '已发送 ✓ ' + ctxNote } : { ok: false, err: r.err });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 面板代发私聊: 以机器人身份向用户发文本 {ns?, openid, text, insertContext?}(悬浮球 dock 发消息用)
  route(ctx, 'POST', '/api/qqbot-settings/chat/send', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const openid = String(body.openid || '').trim();
    const text = String(body.text || '').trim();
    if (!openid || !text) return writeJson(res, 400, { error: 'openid 与 text 必填' });
    if (text.length > 2000) return writeJson(res, 400, { error: '文本过长(最多 2000 字符)' });
    try {
      const gc = await groupClientOf(String(body.ns || ''));
      if (!gc) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const r = await gc.client.sendC2cText(openid, text);
      audit(gc.bot.cwd, { ev: 'chat.send', ns: gc.bot.id, openid, text: text.slice(0, 120), ok: r.ok, code: r.ok ? undefined : (r.err && r.err.code) });
      let ctxNote = '';
      if (r.ok && body.insertContext === true) {
        const why = await appendUserRelayToPeer(String(body.ns || 'im-qqbot'), 'c2c', openid, text).catch((e) => { audit(gc.bot.cwd, { ev: 'chat.send.insertContext-failed', ns: gc.bot.id, error: String((e && e.message) || e) }); return 'failed'; });
        if (why) audit(gc.bot.cwd, { ev: 'chat.send.insertContext-skipped', ns: gc.bot.id, openid, reason: why });
        ctxNote = why ? '(' + (WHY_MAP[why] || why) + ')' : '(已写入上下文: 用户代你发送)';
      }
      writeJson(res, r.ok ? 200 : 200, r.ok ? { ok: true, msg: '已发送 ✓ ' + ctxNote } : { ok: false, err: r.err });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // ── 自定义卡片按钮(2026-09-10 主人要求: 卡片按钮要能写「回文本 / 跳链接 / 执行命令」) ──
  // client 传结构化 cardButtons=[{label, action:'text'|'cmd'|'url', payload}]。
  // 这里生成 cardId、把按钮动作写进 {dataRoot}/.qqbot/card-callbacks.json —— 格式与 dist 侧
  // src/features/card-callback.ts 严格一致(改格式两边都要改); 按钮 data 编 `bpk:<cardId>:<btnId>`:
  //   action=url  → action.type=0 官方跳转(客户端直接跳, 不走回调)
  //   其余        → action.type=1 回调 → 点击后 QQ 推 INTERACTION_CREATE → bootstrap 的
  //                 cardCallbackController 查表执行(text 回文本 / cmd 走命令执行器)
  function writeCardCallbacks(dataRoot, card) {
    try {
      const p = join(dataRoot, '.qqbot', 'card-callbacks.json');
      mkdirSync(dirname(p), { recursive: true });
      let f = { version: 1, cards: [] };
      try { if (existsSync(p)) f = JSON.parse(readFileSync(p, 'utf8')) || f; } catch { f = { version: 1, cards: [] }; }
      const now = Date.now();
      const kept = (Array.isArray(f.cards) ? f.cards : []).filter(c => c && c.cardId !== card.cardId && (c.expireAt || 0) > now);
      kept.push(card);
      writeFileSync(p, JSON.stringify({ version: 1, cards: kept.slice(-200) }, null, 1), 'utf8');
    } catch { /* 写失败只影响按钮回调, 不阻断发卡 */ }
  }
  function buildCardKeyboardFromPairs(dataRoot, pairs, meta) {
    const list = (Array.isArray(pairs) ? pairs : []).filter(b => b && b.label).slice(0, 25);
    if (!list.length) return undefined;
    const cardId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const buttons = list.map((b, i) => ({
      id: 'b' + (i + 1),
      label: String(b.label).slice(0, 20),
      action: b.action === 'url' ? 'url' : (b.action === 'cmd' ? 'cmd' : 'text'),
      payload: String(b.payload == null ? '' : b.payload),
    }));
    const rows = buttons.map(b => ({
      buttons: [{
        id: b.id,
        render_data: { label: b.label, style: 1 },
        action: {
          type: b.action === 'url' ? 0 : 1, // 0=跳转 1=回调
          permission: { type: 2 },
          data: 'bpk:' + cardId + ':' + b.id,
          unsupport_tips: '请在支持的客户端点击',
        },
      }],
    }));
    writeCardCallbacks(dataRoot, {
      cardId,
      buttons,
      createdAt: Date.now(),
      expireAt: Date.now() + 7 * 24 * 3600 * 1000,
      scope: meta && meta.scope,
      targetId: meta && meta.targetId,
    });
    return { content: { rows } };
  }

  // ── 自定义 markdown 卡片发送(2026-09-10 主人实测: markdown 嵌网络图+按钮可渲染):
  //     接收 {ns?, gid | openid, markdown, keyboard?} → 群用 sendGroupCard / 私聊用 sendC2cCard;
  //     群发走 broadcast/create(type=markdown)。openid 支持为 2026-09-10 主人要求(卡片可选私聊目标)。
  route(ctx, 'POST', '/api/qqbot-settings/chat/send-card', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const gid = String(body.gid || '').trim();
    const openid = String(body.openid || '').trim();
    const md = String(body.markdown || '').trim();
    if (!gid && !openid) return writeJson(res, 400, { error: 'gid 或 openid 必填' });
    if (!md) return writeJson(res, 400, { error: 'markdown 必填' });
    if (md.length > 8000) return writeJson(res, 400, { error: 'markdown 过长(最多 8000 字符)' });
    try {
      const gc = await groupClientOf(String(body.ns || ''));
      if (!gc) return writeJson(res, 400, { error: '找不到该账号实例' });
      // 结构化按钮(新路径) → 生成回调表 + bpk: 键盘; 也兼容旧路径直接给 keyboard
      let kb = body.keyboard && body.keyboard.content && Array.isArray(body.keyboard.content.rows) ? body.keyboard : undefined;
      if (!kb && Array.isArray(body.cardButtons) && body.cardButtons.length) {
        kb = buildCardKeyboardFromPairs(gc.bot.cwd, body.cardButtons, { scope: openid ? 'c2c' : 'group', targetId: openid || gid });
      }
      const r = openid
        ? await gc.client.sendC2cCard(openid, md, kb)
        : await gc.client.sendGroupCard(gid, md, kb);
      audit(gc.bot.cwd, { ev: 'chat.send-card', ns: gc.bot.id, gid, openid, mdLen: md.length, kbRows: kb ? kb.content.rows.length : 0, cbButtons: Array.isArray(body.cardButtons) ? body.cardButtons.length : 0, ok: r.ok, code: r.ok ? undefined : (r.err && r.err.code) });
      writeJson(res, 200, r.ok
        ? { ok: true, msg: '✅ 卡片已发送' + (openid ? '(私聊)' : '(群)'), id: r.data && r.data.id }
        : { ok: false, err: r.err });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // ── botplay 事件独立文件存储(M4.3): GET 读 / POST 写, 均按 ns 取 dataRoot ──
  // ⚠️ 2026-09-10 修复: NSQ 参数是 URL 对象(内部调 u.searchParams.get), 原写法 NSQ(req.url)
  //    传了字符串 → "Cannot read properties of undefined (reading 'get')" 500。
  route(ctx, 'GET', '/api/qqbot-settings/group/botplay-events', async (req, res) => {
    const ns = NSQ(new URL(req.url ?? '/', 'http://x'));
    const bot = nsBot(ns);
    if (!bot || !bot.cwd) return writeJson(res, 400, { error: '找不到该账号实例' });
    const fromFile = readBotplayEventsFile(bot.cwd);
    let events = Array.isArray(fromFile.events) ? fromFile.events : (Array.isArray(fromFile) ? fromFile : []);
    // 文件缺失/空 → 迁移 settings 旧数据(botplay 事件曾存 settings.yaml, 2026-09-10 前)
    if (events.length === 0) {
      const legacy = botplayEventsFromSettings(bot.ns);
      if (Array.isArray(legacy) && legacy.length > 0) { writeBotplayEventsFile(bot.cwd, legacy); events = legacy; }
    }
    writeJson(res, 200, { ok: true, events, source: 'file' });
  });

  route(ctx, 'POST', '/api/qqbot-settings/group/botplay-events', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const ns = String(body.ns || 'im-qqbot').trim();
    const bot = nsBot(ns);
    if (!bot || !bot.cwd) return writeJson(res, 400, { error: '找不到该账号实例' });
    if (!Array.isArray(body.events)) return writeJson(res, 400, { error: 'events 必须为数组' });
    const okFile = writeBotplayEventsFile(bot.cwd, body.events);
    // settings 现值同步清空(2026-09-10: 事件已独立文件, settings 里残留旧数组会与新文件重复/歧义 → 置空)
    let okSettings = true;
    try {
      const cur = viewOf(ctx.settings, bot.ns);
      const curVal = (cur && cur.value) || {};
      if (curVal.botplayEvents !== undefined && Array.isArray(curVal.botplayEvents) && curVal.botplayEvents.length > 0) {
        const patch = Object.assign({}, curVal, { botplayEvents: [] });
        await ctx.settings.update(bot.ns, patch, (cur && cur.revision) || undefined);
      }
    } catch { okSettings = false; }
    audit(bot.cwd, { ev: 'botplay.events-save', ns: bot.ns, n: body.events.length, okFile, okSettings });
    writeJson(res, 200, { ok: okFile, msg: okFile ? '✅ 已保存(独立文件, live 热更已生效)' : '写入文件失败' });
  });

  // ── botplay 自定义事件(2026-10-05): 模块状态 / 热重载 / 看源码 ───────────
  // 自定义事件 = 事件 JSON 里带 `file`, 由 {dataRoot}/.qqbot-extensions/botplay/<file> 的 JS 模块驱动。
  // 面板要给主人看: 模块文件**完整路径**、是否存在、最后修改时间、加载错误摘要 → 走 GET status。
  // 「🔄 重载模块」走 reload: 只清插件内存里的模块缓存(下次发卡/点击重新 import),
  //   **不需要重启宿主**, 也不需要重启插件 —— 这是本功能"改完即生效"的关键。
  // 数据源: channel-tools 的 botplayExtStatus/reloadBotplayExt(只有插件侧才拿得到 controller)。
  // ── web 会话列表自动重排（2026-10-05 主人定）──────────────────────────
  //   需求：QQ 消息入站到某个 web 会话、且 LLM 真的产出了 ⇒ 把那个 web 会话在
  //   侧边栏列表里"上浮"：从列表头往下数 n 个仍是"热的"(对话间隔<10min)会话，
  //   就插到第 n+1 位；若第 1 个就冷掉了(n=0) ⇒ 直接插第 1 位。
  //   置顶(「进行中」)的会话不参与计数、位置也不动。
  //
  //   ⚠️ 分工：本端点只负责"告诉前端【哪个 dsh 会话刚刚活跃了】"——
  //      排序本身在浏览器端做（列表顺序是 browser-local 的 localStorage 状态，
  //      服务端改不了；DOM 那边由 client/qqbot-settings.js 改）。
  // ── web 会话列表自动重排（2026-10-05 主人定）────────────────────────────
  //   需求：QQ 消息入站到某个 web 会话、且 LLM 真的产出了 ⇒ 让那个 web 会话在
  //   侧边栏列表里"上浮"：从列表头往下数 n 个仍是"热的"（对话间隔 < 10min）的会话，
  //   就插到第 n+1 位；若第 1 个就冷掉了（n=0）⇒ 直接插第 1 位。
  //   置顶（列表里的「进行中」）不参与计数、位置也不动。
  //
  //   ⚠️ 分工：本端点只负责"告诉前端【哪个 dsh 会话刚刚活跃了】"。
  //      排序本身在浏览器端做 —— 列表顺序是 browser-local 的 localStorage 状态
  //      （dsh.workspace.view.v5），服务端改不了；由 client/qqbot-settings.js 改。
  // ── web 会话列表自动重排（2026-10-05 主人定）────────────────────────────
  //   需求：QQ 消息入站到某个 web 会话、且 LLM 真的产出了 ⇒ 让那个 web 会话在
  //   侧边栏列表里"上浮"：从列表头往下数 n 个仍是"热的"（对话间隔 < 10min）的会话，
  //   就插到第 n+1 位；若第 1 个就冷掉了（n=0）⇒ 直接插第 1 位。
  //   置顶（列表里的「进行中」）不参与计数、位置也不动。
  //
  //   ⚠️ 分工：侧边栏顺序是 browser-local 的（localStorage["dsh.workspace.view.v5"]），
  //      服务端改不了 ⇒ 本端点只负责【给数据】：
  //        · active   —— 哪个 dsh 会话"刚刚"被激活了（插件侧 QQ↔dsh 映射）
  //        · sessions —— 所有 dsh 会话的 { sessionId, at }（扫磁盘会话文件 mtime）
  //                     ⚠️ 这样浏览器端不必读 DOM、也不必解析"16小时"这种相对时间
  //        · ready    —— dsh 是否已就绪（没就绪前端不排序，见下）
  // ── web 会话列表自动重排（2026-10-05 主人定）────────────────────────────
  //   规则：QQ 消息入站到某个 web 会话、且 AI 真的产出了
  //         ⇒ 从侧边栏列表头往下数 n 个仍"热的"（对话间隔 < 10min）会话，
  //           把目标会话插到第 n+1 位；若第 1 个就冷掉（n=0）⇒ 直接插第 1 位。
  //           · 置顶（「进行中」）不参与计数、位置也不动。
  //
  //   ★ 事件驱动，不轮询（2026-10-05 主人要求）——
  //     判据："AI 真的产出了" = 该会话出现 assistant/message 事件。
  //     我们直接订阅宿主自己的 session/event（与出站层同一个事件源），
  //     命中就向订阅中的浏览器推一条 SSE；没人订阅 ⇒ 零开销、零扫描。
  //
  //   分工：侧边栏顺序是 browser-local 的 localStorage["dsh.workspace.view.v5"]，
  //         服务端改不了 ⇒ 这里只"通知"，排序在 client/qqbot-settings.js 里做。
  // ★ 全部走模块级单例 WS_HUB —— 跨 bot 实例共享（见文件顶部说明）
  const wsWatchers = WS_HUB.watchers;

  // ★ 测试端点 1：手动触发一次广播（不用等 QQ 消息，专供调试）
  route(ctx, 'POST', '/api/qqbot-settings/workspace/test-reorder', async (req, res) => {
    try {
      let body = {};
      try { body = await readJsonBody(req); } catch { body = {}; }
      const sid = body && typeof body.sessionId === 'string' ? body.sessionId : '';
      wsBroadcast(sid);
      writeJson(res, 200, { ok: true, watchers: wsWatchers.size, pushed: sid || '(空: 让前端自己挑一个)' });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ★ 测试端点 2：一眼看出「有没有浏览器在订阅、最后推了什么」
  route(ctx, 'GET', '/api/qqbot-settings/workspace/debug', async (req, res) => {
    try {
      writeJson(res, 200, { ok: true, watchers: WS_HUB.watchers.size, lastBroadcastAt: WS_HUB.last.at, lastSessionId: WS_HUB.last.sessionId, now: Date.now() });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // 订阅宿主会话事件：assistant/message = 这一轮 AI 真的说话了（判据见上）
  //   ⚠️ 只绑一次（全局单例），否则两个 bot 实例会各推一帧、前端重复处理
  if (!WS_HUB.bound) {
    WS_HUB.bound = true;
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'assistant/message') return;
        const sid = String((session && (session.id || session.sessionId)) || '');
        if (!sid) return;
        wsBroadcast(sid);
      } catch { /* 兜底：绝不影响主链 */ }
    });
  }

  // ★ SSE 端点：绕过 route() helper（它是一次性请求/响应，不适合长连接），直接注册
  //   ⚠️ 只注册一次（全局单例）—— 同 path 被两个 bot 实例各注册一次会互相覆盖，
  //      且 route() 的模块级去重管不到裸 register，正是 watchers 恒为 0 的根因。
  if (!WS_HUB.registered) {
    WS_HUB.registered = true;
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/qqbot-settings/workspace/watch',
      handler: (req, res) => {
        try {
          if (!isTrusted(req)) { res.writeHead(403); res.end(); return; }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          res.write(': connected\n\n');   // 立刻 flush，让浏览器认为连上了
          WS_HUB.watchers.add(res);
          const hb = setInterval(() => {
            try { res.write(': hb\n\n'); } catch { clearInterval(hb); WS_HUB.watchers.delete(res); }
          }, 25_000);
          req.on('close', () => { clearInterval(hb); WS_HUB.watchers.delete(res); });
        } catch { try { res.end(); } catch { /* ignore */ } }
      },
    }), 'qqbot-settings: workspace/watch');
  }

  // ── 辅助端点（前端收到 SSE 后调一次，拿"各会话最后活动时间"来算 n）──
  //   ⚠️ 只在这条路径上扫磁盘，且有 5 秒缓存 ⇒ 不再有定时扫描
  let wsSessionsCache = { at: 0, list: [] };
  function wsScanSessions() {
    const now = Date.now();
    if (now - wsSessionsCache.at < 5000) return wsSessionsCache.list;
    const out = [];
    try {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const root = home ? join(home, '.dsh', 'sessions') : '';
      if (root && existsSync(root)) {
        for (const wsDir of readdirSync(root)) {
          const wsPath = join(root, wsDir);
          let st1 = null;
          try { st1 = statSync(wsPath); } catch { continue; }
          if (!st1.isDirectory()) continue;
          for (const sid of readdirSync(wsPath)) {
            const sidPath = join(wsPath, sid);
            let newest = 0;
            try {
              for (const fn of readdirSync(sidPath)) {
                if (!/^session\.v\d+\.jsonl/.test(fn)) continue;
                try { const st = statSync(join(sidPath, fn)); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch { /* skip */ }
              }
            } catch { continue; }
            if (newest > 0) out.push({ sessionId: sid, at: Math.round(newest) });
          }
        }
      }
    } catch { /* 扫不动就空表 */ }
    wsSessionsCache = { at: now, list: out };
    return out;
  }

  route(ctx, 'GET', '/api/qqbot-settings/workspace/sessions', async (req, res) => {
    try {
      const list = wsScanSessions();
      writeJson(res, 200, { ok: true, ready: list.length > 0, sessions: list, at: Date.now() });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  route(ctx, 'GET', '/api/qqbot-settings/group/botplay-ext/status', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const ns = NSQ(u);
      const b2 = nsBot(ns);
      const dataRoot = (b2 && b2.cfg && typeof b2.cfg.dataRoot === 'string' && b2.cfg.dataRoot) ? b2.cfg.dataRoot : ((b2 && b2.cwd) || '');
      const dir = dataRoot ? join(dataRoot, '.qqbot-extensions', 'botplay') : '';
      let dirExists = false;
      try { dirExists = !!dir && existsSync(dir); } catch { dirExists = false; }
      // 目录实况(size; 插件侧状态里没有这个字段, 面板要显示"多大")
      const files = [];
      if (dirExists) {
        try {
          for (const f of readdirSync(dir)) {
            if (!/\.(mjs?|cjs)$/i.test(f)) continue;
            let mtime = 0; let size = 0;
            try { const st = statSync(join(dir, f)); mtime = Math.floor(st.mtimeMs); size = st.size; } catch { /* 单文件读不到就按 0 */ }
            files.push({ file: f, path: join(dir, f), mtime, size });
          }
        } catch { /* 目录读不了就空列表 */ }
      }
      let mods = [];
      let note = '';
      try {
        const mod = await import('@zaofan/dsh-qqbot/channel-tools');
        if (typeof mod.botplayExtStatus === 'function') mods = mod.botplayExtStatus(ns) || [];
        else note = '线上插件还是旧版本(需重启宿主加载新代码) —— 现在只能显示文件路径';
      } catch (e) { note = String((e && e.message) || e); }
      // 合并: 插件侧状态(带 hooks/加载错误) + 目录实况; 插件未就绪时退化成"只报路径"
      const merged = (mods.length ? mods : files).map((m) => {
        const hit = files.find((f) => f.file === m.file);
        return Object.assign({ hooks: [], error: '', name: '', loadedMtime: 0, exists: false, mtime: 0 }, m, {
          size: hit ? hit.size : 0,
          path: m.path || (hit ? hit.path : (dir ? join(dir, m.file) : m.file)),
          exists: typeof m.exists === 'boolean' ? m.exists : !!hit,
          mtime: m.mtime || (hit ? hit.mtime : 0),
        });
      });
      writeJson(res, 200, { ok: true, dir, dirExists, dataRoot, mods: merged, note });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // 「🔄 重载模块」: {ns?, file?}(file 空=全部模块) —— 热重载, 不重启宿主
  route(ctx, 'POST', '/api/qqbot-settings/group/botplay-ext/reload', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const ns = String((body && body.ns) || NS);
      const file = String((body && body.file) || '').trim();
      const mod = await import('@zaofan/dsh-qqbot/channel-tools');
      if (typeof mod.reloadBotplayExt !== 'function') {
        return writeJson(res, 500, { ok: false, error: '线上插件还是旧版本(需重启宿主加载新代码)' });
      }
      const r = mod.reloadBotplayExt(ns, file || undefined);
      const b2 = nsBot(ns);
      if (b2 && b2.cwd) audit(b2.cwd, { ev: 'botplay.ext-reload', ns, file: file || '(all)', ok: r.ok });
      writeJson(res, 200, r);
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // 「📄 查看源码」: 读模块文件原文(插件/宿主读不到时回落)
  route(ctx, 'GET', '/api/qqbot-settings/group/botplay-ext/source', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const ns = NSQ(u);
      const file = String(u.searchParams.get('file') || '').trim();
      if (!file) return writeJson(res, 400, { error: 'file 必填' });
      // 文件名安全校验(与插件侧 safeBotplayFileName 同款判据: 不许任何路径分隔符 → 防逃逸读任意文件)
      if (/[\\/]/.test(file) || file.includes('..') || !/^[A-Za-z0-9._@-]+$/.test(file)) {
        return writeJson(res, 400, { error: '文件名不合法' });
      }
      const b2 = nsBot(ns);
      const dataRoot = (b2 && b2.cfg && typeof b2.cfg.dataRoot === 'string' && b2.cfg.dataRoot) ? b2.cfg.dataRoot : ((b2 && b2.cwd) || '');
      if (!dataRoot) return writeJson(res, 400, { error: '找不到数据目录' });
      const p = join(dataRoot, '.qqbot-extensions', 'botplay', file);
      if (!existsSync(p)) return writeJson(res, 404, { error: '文件不存在: ' + p });
      const st = statSync(p);
      if (st.size > 512 * 1024) return writeJson(res, 400, { error: '文件过大(>512KB), 请直接用编辑器打开: ' + p });
      writeJson(res, 200, { ok: true, path: p, text: readFileSync(p, 'utf8') });
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  /**
   * 给 AI 的"官方接口文档"指引(2026-10-05 主人定的最终形态)。
   *
   * 为什么给**链接**而不是随包塞一份本地文档镜像(这段是踩过两轮后的结论, 别再改回去):
   *   ① 本地镜像 4.2MB / 191 页, 塞进 npm 包会把包体积从 ~2.1MB 抬到 ~6MB —— 为了一个
   *      "给 AI 看一眼"的功能不值当;
   *   ② 之前一版还写过"运行时按包根解析本地路径" —— 能跑, 但那等于把**开发机/本包**的
   *      文件布局变成功能依赖: 换个装法(link/软链)、文档没被 files 带上, 功能就静默失效;
   *   ③ 官方文档是**权威且持续更新**的, 而 AI 自己能联网读页面 —— 给链接既省体积也更新鲜。
   * ⚠️ 这里只放"最该看的 3 个": 总入口 + interaction_create(按钮回调事件) + 互动回调 API。
   *   全量清单让 AI 从总入口自己爬, 不在提示词里堆(堆了也是噪音, 还吃 token)。
   */
  function apiV2DocLinks() {
    return [
      '── 官方接口文档（需要细节时自行查阅）──',
      '· 总入口：https://bot.q.qq.com/wiki/develop/api-v2/',
      '· 按钮交互事件 interaction_create（用户点击按钮时触发，本功能的核心事件）：',
      '  https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html',
      '· 互动回调 API（PUT /interactions/{interaction_id}，回执 / 更新按钮状态用）：',
      '  https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html',
    ];
  }

  /**
   * 给 AI 的"如何注册成 botplay 自定义事件"契约说明(纯文案, 与 features/botplay-ext.ts 的契约一一对应)。
   * ⚠️ 改契约时**两处都要改**(这里 + botplay-ext.ts 的类型与注释), 否则 AI 会按旧契约写出跑不起来的模块。
   */
  /**
   * botplay 自定义事件的契约正文 —— **已搬到 docs/botplay-contract.md**（可版本管理，改契约不用动本文件）。
   *
   * 2026-10-05 拆分：原来近 90 行契约硬编码在这里的字符串数组里，改一句话要翻 4000 行，
   *   也没法给人直接看 ⇒ 改为读 md；动态部分用占位符，运行时替换：
   *     {{EXT_DIR}}      模块目录（数据根下）
   *     {{EVENTS_FILE}}  事件登记文件
   *     {{NS}}           账号实例 id
   *   md 里 <!-- 开头的行是给人看的注释，拼接时剔除。
   *   ⚠️ 读不到（旧包/文件缺失）不报错，回落成一句可操作提示，保证「让 AI 写」仍可用。
   */
  function botplayContractLines(extDir, ns, eventsFile) {
    const dir = extDir || '{dataRoot}/.qqbot-extensions/botplay'
    const evFile = eventsFile || '{dataRoot}/botplay-events.json'
    try {
      const p = join(dirname(fileURLToPath(import.meta.url)), 'docs', 'botplay-contract.md')
      const raw = readFileSync(p, 'utf8')
      const txt = raw
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith('<!--'))
        .join('\n')
        .replace(/\{\{EXT_DIR\}\}/g, dir)
        .replace(/\{\{EVENTS_FILE\}\}/g, evFile)
        .replace(/\{\{NS\}\}/g, String(ns || ''))
      const out = txt.split(/\n/)
      while (out.length && !out[out.length - 1].trim()) out.pop()
      if (out.length > 5) return out
    } catch { /* 读不到 → 回落 */ }
    return [
      '（契约文件 docs/botplay-contract.md 读取失败，请检查插件包是否完整）',
      `1) 模块文件放：${dir}/<文件名>.mjs（必须 .mjs/.js/.cjs）`,
      `4) 登记事件：在 ${evFile} 的 events 数组里加 { "id":"...", "name":"...", "file":"<文件名>.mjs" }`,
      '5) 改完在面板点「🔄 重载模块」即可生效（不用重启）。',
    ]
  }


  // ── 🤖「让 AI 写」自定义事件(2026-10-05 主人要求) ─────────────────────────
  // 面板输入需求 → 这里把「需求 + 接口文档索引 + 自定义事件契约 + 环境信息 + 要求」拼成一条消息,
  // 用**面板既有的"唤醒当前会话 AI"通道**(channel-tools.askAiToWriteBotplayEvent, 内部伪造一条
  // 用户消息直调 handleInbound —— 与「让ai写样例库」「定时任务到点」同一条路)发过去。
  // 为什么不新开渠道: 面板"代你发送/让ai写"已经是主人认可的交互姿势, 再开一条只会多一套要维护的语义。
  //
  // ⚠️ 两个诚实点(写进给 AI 的文案里, 免得它乱猜):
  //   ① 接口文档目录是**运行时按包根算出来的**(PKG_ROOT = 本文件所在目录), 不是写死的开发机路径 ——
  //      插件被别人 npm 装到任何 profile 下都对, 因为 docs/ 是随包发布的(见 package.json 的 files);
  //   ② appSecret 只报"已配置/未配置", 绝不把内容输出到会话里。
  route(ctx, 'POST', '/api/qqbot-settings/group/botplay-ext/let-ai-write', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const ns = String((body && body.ns) || NS);
      const scope = String((body && body.scope) || 'group') === 'c2c' ? 'c2c' : 'group';
      const peerId = String((body && body.peerId) || '');
      const reqText = String((body && body.requirement) || '').trim();
      if (!reqText) return writeJson(res, 400, { ok: false, error: '请先在输入框里写你要的事件需求' });
      if (reqText.length > 4000) return writeJson(res, 400, { ok: false, error: '需求太长了(最多 4000 字)' });
      if (!peerId) return writeJson(res, 400, { ok: false, error: '当前会话不是 QQ 群/私聊(顶栏「当前会话」未命中) —— 请先切到与 bot 的群或私聊会话' });

      const bot = nsBot(ns);
      if (!bot) return writeJson(res, 400, { ok: false, error: '找不到该账号实例' });
      const dataRoot = (bot.cfg && typeof bot.cfg.dataRoot === 'string' && bot.cfg.dataRoot) ? bot.cfg.dataRoot : (bot.cwd || '');
      const extDir = dataRoot ? join(dataRoot, '.qqbot-extensions', 'botplay') : '';
      const eventsFile = dataRoot ? join(dataRoot, 'botplay-events.json') : '';

      // ── 环境信息(从既有配置读; 读不到就照降级写法) ──
      // value 来源与 /read 一致: patch 基线 + 自有存储覆盖(**自有存储优先**, 就是用户在设置页存的那份)
      let value = {};
      try {
        const base = viewOf(ctx.settings, bot.ns) || {};
        const own = readOwnSettings(bot.ns);
        value = Object.assign({}, base.value || {}, own);
      } catch { value = {}; }
      const appId = String(value.appId || (bot.cfg && bot.cfg.appId) || '').trim();
      const hasSecret = !!String(value.appSecret || (bot.cfg && bot.cfg.appSecret) || '').trim();
      const owners = (value.groupAdmin && Array.isArray(value.groupAdmin.owners) ? value.groupAdmin.owners : [])
        .map((x) => String(x)).filter(Boolean);
      const masterOpenid = owners.length ? owners[0] : '';

      const prompt = [
        '【botplay 自定义事件 · 写作请求】',
        reqText,
        '',
        '── 参考资料 ──',
        ...apiV2DocLinks(),
        '',
        '── 如何注册成 botplay 事件 ──',
        ...botplayContractLines(extDir, ns, eventsFile),
        '',
        '── 环境信息 ──',
        `bot appId: ${appId || '未配置'}`,
        `主人 openid: ${masterOpenid || '未配置'}`,
        // appSecret 绝不输出内容, 只报状态(主人明确要求)
        `appSecret: ${hasSecret ? '已配置（位置：设置 → QQ 机器人）' : '未配置'}`,
        `数据根 dataRoot: ${dataRoot || '未配置'}`,
        `事件登记文件: ${eventsFile || '未配置'}`,
        `当前会话: ${scope === 'group' ? '群' : '私聊'} ${peerId}`,
        '',
        '── 要求 ──',
        `请按上面的契约写一个可直接用的自定义事件模块（写进 ${extDir || '{dataRoot}/.qqbot-extensions/botplay'}），并在 botplay-events.json 里登记对应事件（id/name/file）。`,
        '写完自己核对一遍语法；可以用 /botplay 事件id 在群里发卡试一下, 或让主人去面板点「🔄 重载模块」后再发卡。',
      ].join('\n');

      const mod = await import('@zaofan/dsh-qqbot/channel-tools');
      if (typeof mod.setBotplayWritePrompt !== 'function' || typeof mod.askAiToWriteBotplayEvent !== 'function') {
        return writeJson(res, 500, { ok: false, error: '线上插件还是旧版本(需重启宿主加载新代码)' });
      }
      // 接口是纯数据参数(函数不能跨模块实例传值), 所以先用 setter 把提示词递过去
      mod.setBotplayWritePrompt(prompt);
      const r = await mod.askAiToWriteBotplayEvent(ns, scope, peerId);
      if (bot.cwd) audit(bot.cwd, { ev: 'botplay.let-ai-write', ns, scope, peerId, reqLen: reqText.length, ok: r.ok });
      writeJson(res, 200, r);
    } catch (e) { writeJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  });

  // ── M3 群发任务队列(2026-09-10): 持久化状态机 draft→queued→sending→done, 二次确认, 可中止/撤回 ──
  // 数据: {dataRoot}/.qqbot/broadcast-tasks.json(broadcast.ts 管理); 推进由每次 list 请求驱动(串行, 天然限频)。
  // 路由: broadcast/create(草稿) → broadcast/confirm(二次确认后入队) → broadcast/list(推进+展示) →
  //       broadcast/cancel(中止) → broadcast/recall(撤回某目标已发消息)。
  async function broadcastMod() {
    return import('./dist/features/broadcast.js');
  }

  // 创建群发草稿 {ns?, type:'text'|'markdown', text, targets:[{scope,peerId,name?}]}
  route(ctx, 'POST', '/api/qqbot-settings/group/broadcast/create', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const text = String(body.text || '').trim();
    const targets = Array.isArray(body.targets) ? body.targets : [];
    // 卡片群发(2026-09-10 主人要求): type=card 时 text 为 markdown 正文, 另带 keyboard
    const wantCard = body.type === 'card';
    if (!text) return writeJson(res, 400, { error: wantCard ? 'markdown 必填' : 'text 必填' });
    if (text.length > (wantCard ? 8000 : 2000)) return writeJson(res, 400, { error: wantCard ? 'markdown 过长(最多 8000 字符)' : '文本过长(最多 2000 字符)' });
    // 卡片群发(2026-09-10 主人要求): type=card 时 text 为 markdown 正文, 另带 keyboard;
    // 优先用结构化 cardButtons 现生成(回调表+bpk: 键盘, 与 chat/send-card 同一套), 兼容直接给 keyboard
    let kb = wantCard && body.keyboard && body.keyboard.content && Array.isArray(body.keyboard.content.rows) ? body.keyboard : undefined;
    if (targets.length === 0) return writeJson(res, 400, { error: 'targets 至少一个(勾选群/私聊)' });
    if (targets.length > 200) return writeJson(res, 400, { error: '目标太多(最多 200)' });
    for (const t of targets) {
      if (!t || (t.scope !== 'group' && t.scope !== 'c2c') || !t.peerId) return writeJson(res, 400, { error: 'targets 每项需 scope(group|c2c)+peerId' });
    }
    try {
      const bot = nsBot(String(body.ns || ''));
      if (!bot) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      // 结构化按钮 → 现生成回调表 + bpk: 键盘(与 chat/send-card 同一套; 群发各目标共用这张表)
      if (wantCard && !kb && Array.isArray(body.cardButtons) && body.cardButtons.length) {
        kb = buildCardKeyboardFromPairs(bot.cwd, body.cardButtons, { scope: 'group', targetId: '' });
      }
      const bm = await broadcastMod();
      const task = bm.createTask(bot.cwd, {
        type: wantCard ? 'card' : (body.type === 'markdown' ? 'markdown' : 'text'),
        content: text,
        keyboard: kb,
        targets: targets.map((t) => ({ scope: t.scope, peerId: t.peerId, name: t.name ? String(t.name) : undefined })),
        created_by: 'dock',
      });
      audit(bot.cwd, { ev: 'group.broadcast.create', ns: bot.id, task_id: task.task_id, targets: targets.length, type: wantCard ? 'card' : 'text' });
      writeJson(res, 200, { ok: true, task });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 确认群发(二次确认后调用) {ns?, task_id}
  route(ctx, 'POST', '/api/qqbot-settings/group/broadcast/confirm', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const taskId = String(body.task_id || '');
    if (!taskId) return writeJson(res, 400, { error: 'task_id 必填' });
    try {
      const bot = nsBot(String(body.ns || ''));
      if (!bot) return writeJson(res, 400, { error: '找不到该账号实例' });
      const bm = await broadcastMod();
      const t = bm.confirmTask(bot.cwd, taskId);
      if (!t) return writeJson(res, 400, { error: '任务不存在' });
      if (t.state !== 'queued') return writeJson(res, 200, { ok: false, msg: `任务状态为 ${t.state}, 无法确认` });
      audit(bot.cwd, { ev: 'group.broadcast.confirm', ns: bot.id, task_id: taskId });
      writeJson(res, 200, { ok: true, task: t });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 🗂 目标分组读写(2026-09-12): GET=读(供 client 加载/迁移), POST=整体写回(供 client 保存)。
  // 同 path 两个 method 必须合并成一次 route 注册(webServer 按 path 唯一, 分开注册会让整插件 effect 失败→全接口 404)。
  route(ctx, ['GET', 'POST'], '/api/qqbot-settings/group/target-groups', async (req, res) => {
    try {
      if (req.method === 'GET') {
        const u = new URL(req.url ?? '/', 'http://x');
        const bot = nsBot(NSQ(u));
        if (!bot) return writeJson(res, 400, { error: '找不到该账号实例' });
        return writeJson(res, 200, { ok: true, groups: readTargetGroupsJson(bot.cwd) });
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
      const bot = nsBot(String(body.ns || ''));
      if (!bot) return writeJson(res, 400, { error: '找不到该账号实例' });
      const groups = Array.isArray(body.groups) ? body.groups : [];
      writeTargetGroupsJson(bot.cwd, groups);
      audit(bot.cwd, { ev: 'group.target-groups.save', ns: bot.id, n: groups.length });
      writeJson(res, 200, { ok: true, groups });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 群发任务列表(读时推进一个目标) {ns?}
  route(ctx, 'GET', '/api/qqbot-settings/group/broadcast/list', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(NSQ(u));
      if (!bot) return writeJson(res, 400, { error: '找不到该账号实例' });
      const bm = await broadcastMod();
      // 推进一步: 找第一个 queued/sending 的任务推进(串行限频)
      const gc = await groupClientOf(NSQ(u));
      if (gc) {
        const tasks = bm.listTasks(bot.cwd);
        const active = tasks.find((t) => t.state === 'queued' || t.state === 'sending');
        if (active) await bm.advanceTask(bot.cwd, active.task_id, gc.client);
      }
      const after = bm.listTasks(bot.cwd);
      writeJson(res, 200, { ok: true, tasks: after });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 中止群发 {ns?, task_id}
  route(ctx, 'POST', '/api/qqbot-settings/group/broadcast/cancel', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const taskId = String(body.task_id || '');
    if (!taskId) return writeJson(res, 400, { error: 'task_id 必填' });
    try {
      const bot = nsBot(String(body.ns || ''));
      if (!bot) return writeJson(res, 400, { error: '找不到该账号实例' });
      const bm = await broadcastMod();
      const t = bm.cancelTask(bot.cwd, taskId, 'dock');
      if (!t) return writeJson(res, 400, { error: '任务不存在' });
      audit(bot.cwd, { ev: 'group.broadcast.cancel', ns: bot.id, task_id: taskId });
      writeJson(res, 200, { ok: true, task: t });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 撤回群发中某目标已发的消息(2 分钟窗口) {ns?, task_id, peerId}
  route(ctx, 'POST', '/api/qqbot-settings/group/broadcast/recall', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const taskId = String(body.task_id || '');
    const peerId = String(body.peerId || '');
    if (!taskId || !peerId) return writeJson(res, 400, { error: 'task_id 与 peerId 必填' });
    try {
      const bot = nsBot(String(body.ns || ''));
      const gc = await groupClientOf(String(body.ns || ''));
      if (!bot || !gc) return writeJson(res, 400, { error: '找不到该账号实例' });
      const bm = await broadcastMod();
      const r = await bm.recallTaskMessage(bot.cwd, taskId, peerId, gc.client);
      audit(bot.cwd, { ev: 'group.broadcast.recall', ns: bot.id, task_id: taskId, peerId, ok: r.ok });
      writeJson(res, 200, r);
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });


  // 按"勾选目标"撤回最近一条广播消息(2026-09-12 主人要求): **不必知道 task_id** ——
  // 服务端自己在该目标的广播记录里找"最新的、已成功且带 message_id"的那条, 2 分钟窗口内撤回。
  // 存在意义: 主人只勾选了目标就该能撤, 不该被迫去任务列表里翻 task_id(那条路又长又容易看不见按钮)。
  route(ctx, 'POST', '/api/qqbot-settings/group/recall-last', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const targets = Array.isArray(body.targets) ? body.targets : [];
    if (targets.length === 0) return writeJson(res, 400, { error: 'targets 至少一个' });
    try {
      const bot = nsBot(String(body.ns || ''));
      const gc = await groupClientOf(String(body.ns || ''));
      if (!bot || !gc) return writeJson(res, 400, { error: '找不到该账号实例' });
      const bm = await broadcastMod();
      const tasks = bm.listTasks(bot.cwd).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const out = [];
      for (const t of targets) {
        const peerId = String((t && t.peerId) || '');
        if (!peerId) { out.push({ peerId: '', ok: false, err: '缺少 peerId' }); continue; }
        const hit = tasks.find((x) => x.results && x.results[peerId] && x.results[peerId].ok && x.results[peerId].message_id);
        if (!hit) { out.push({ peerId, ok: false, err: '该目标没有可撤回的广播消息(不是广播发的或没有 message_id)' }); continue; }
        const r = await bm.recallTaskMessage(bot.cwd, hit.task_id, peerId, gc.client);
        out.push({ peerId, ok: r.ok, err: r.err, message_id: r.message_id, task_id: hit.task_id });
        audit(bot.cwd, { ev: 'group.broadcast.recall-last', ns: bot.id, peerId, task_id: hit.task_id, ok: r.ok });
      }
      writeJson(res, 200, { ok: true, results: out });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });


  // ── 悬浮球「💬 聊天视图」(2026-09-07): 读某 QQ 会话最近的入站/出站消息, 只读不建会话 ──
  // 会话事件结构(宿主 dsh-session): {type, seq, time, data}; user/message 的 data=消息体根(data.content),
  // assistant/message 的 data={turn,step,message:{role,content,…}}。只收这两型:
  //   · user/message   — 群友/对方发言(左气泡)。滤 source.kind='plugin'(runtime context/系统注入)与
  //                      伪造系统通知(入群申请/定时, 内容无 [当前时间 头); 剥「[当前时间 …]」头、
  //                      QQ 入站「[昵称 (openid)]」外壳、<@openid> 提及(换成群成员昵称)、尾部 (@you)、
  //                      长附件 URL(折叠成 [图片] 等)。面板代发(「用户代你发送: 」)标 tag=面板代发。
  //   · assistant/message — 机器人回复(右气泡)。只取 content 里 type=text 块; 纯思考/纯工具步(无正文)跳过。
  // chunk/tool-call/tool-result/step/turn/request 等一律不取 → 天然滤掉流式与工具噪声。
  // 分页: 事件 seq 全序(含 chunk 等), 倒扫快进后只保留聊天两型, 每页默认 50 条升序返回 + hasMore。
  function chatTextOf(blocks) {
    if (!Array.isArray(blocks)) return '';
    const parts = [];
    for (const b of blocks) if (b && b.type === 'text' && typeof b.text === 'string' && b.text) parts.push(b.text);
    return parts.join('\n').trim();
  }
  // ── 入站"块标记"在 dock 聊天视图里的解析（2026-09-15 起标记改短, 见插件 src/transport/markers.ts）──
  //   新标记: [引]…[/引] [当前] [历史]…[/历史] + 时间行 "[2026-09-15 周二 11:06]"（不再带"当前时间"四字）
  //   老标记: [Quoted message begins]…[ends] [Current message] [Chat history begins]/[ends] + "[当前时间 …]"
  //   ⚠️ **两套都要认**: 老会话里的历史消息是渲染时解析的, 只认新标记会让旧记录显示成一堆裸标记。
  const RE_TIME_HEAD = /^\s*\[(?:\d{4}-\d{2}-\d{2}\s[^\]]*|当前时间[^\]]*)\]\s*\r?\n?/;
  const isTimeHeadLine = (s) => /^\[(?:\d{4}-\d{2}-\d{2}\s|当前时间)/.test(s);
  //   ⚠️ 标记行一律**大小写不敏感**(老英文标记会被写成小写), 且老结束标记 `[Chat history ends]` **没有斜杠**。
  const RE_HIST_BEGIN_LINE = /^\[(?:历史|Chat history begins)\]$/i;
  const RE_HIST_END_LINE = /^\[\/?(?:历史|Chat history ends)\]$/i;
  const RE_CURRENT_LINE = /^\[(?:当前|Current message)\]$/i;
  const RE_QUOTE_BEGIN = /\[(?:引|Quoted message begins)\]/i;
  const RE_QUOTE_END = /\[\/(?:引|Quoted message ends)\]/i;
  const RE_CURRENT_ANY = /\[(?:当前|Current message)\]\s*/gi;
  // 历史块标记(新旧), 出现在正文里就整段抹掉 —— 内容已由 chatSplitHistoryBlock 拆成独立气泡
  const RE_HIST_MARK_ANY = /\[(?:\/?历史|\/?(?:Chat history begins|Chat history ends))\]/gi;
  // 这些词是**标记**不是昵称: 误当发送者时气泡会显示"历史"/"引用"(头像也跟着取错首字)
  const RE_MARKER_WORD = /^\/?(?:历|历史|当前|引|引用|Quoted message(?: begins| ends)?|Current message|Chat history(?: begins| ends)?)$/i;
  // ⚠️ 2026-10-01 修(主人 dock 聊天页截图暴露):
  //   原实现拿**整段 body.trim()** 去套"整行 == [历史]"的正则 → 对
  //   "[历史]\n[昵称] …\n[/历史]\n[当前]\n…" 永远不命中 → 历史打包分支形同虚设, 后果三连:
  //     ① tagM 把第一个方括号 `[历史]` 当成发送者 → 气泡发送者显示"历史"(头像"历");
  //     ② `[/历史]` 原样留在末尾(前端只认 [当前]/[引]…[/引], 不认它);
  //     ③ `[昵称] [图片: D:\…\x.gif]` 整行当正文 → 裸文本 + **本机绝对路径外泄**。
  //   改为**逐行**判定(老英文标记在行内任意位置也算)。
  const hasHistoryBlock = (s) => String(s || '').split(/\r?\n/).some((line) => {
    const t = line.trim();
    return RE_HIST_BEGIN_LINE.test(t) || /\[Chat history begins\]/i.test(t);
  });
  function chatPeelTimeHead(text) {
    // QQ 入站文本头形如 "[2026-09-15 周二 11:06]\n\n"（老版是 "[当前时间 2026-09-05 周六 19:08]"）, 整体剥掉
    return String(text || '').replace(RE_TIME_HEAD, '');
  }
  function chatDisplayClean(text, nameByMid) {
    let s = String(text || '');
    // <@openid> 提及 → @昵称(群成员表有则换名, 否则 @短id)
    s = s.replace(/<@([A-Za-z0-9_-]{6,})>/g, (all, id) => {
      const nm = (nameByMid && nameByMid.get && nameByMid.get(id)) || '';
      return nm ? ('@' + nm) : ('@' + id.slice(0, 6));
    });
    // 行尾 (@you) 等点名标记剥掉(那是给 LLM 的, QQ 界面不显示)
    s = s.replace(/\s*\(@you\)\s*$/, '');
    return s.trim();
  }
  const QQ_MEDIA_RE = /(?:multimedia\.nt\.qq\.com\.cn|multimedia\.qq\.com|qpic\.cn|qlogo\.cn)/i;
  const QQ_URL_RE = /https?:\/\/[^\s\]\)）]+/g;
  // 从聊天文本抽离 QQ 媒体 URL(图/附件直显用), 附件描述行整行吞掉; 返回 {text, images}
  // 面板代发媒体标记 "[MEDIA:类型|来源]": 网络图直接当图; 本机路径图/音频/视频转成 raw-media 直出 URL
  function chatMediaSrcToImg(kind, src) {
    const k = String(kind || '')
      .replace(/图片|img/gi, 'image').replace(/视频|video/gi, 'video')
      .replace(/语音|音频|voice/gi, 'voice').replace(/文件|file/gi, 'file');
    const s = String(src || '').trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return { url: s, kind: k };
    if (k === 'image' || k === 'voice' || k === 'video') {
      return { url: '/api/qqbot-settings/chat/raw-media?p=' + encodeURIComponent(s), kind: k };
    }
    return null; // 本地文件类型不确定时不渲染, 保留文字
  }
  // 按扩展名判本机文件类型(整行本地路径的文本消息也能看图/播音频)
  function chatLocalExtKind(path) {
    const ext = String(path || '').split('?')[0].split('.').pop().toLowerCase();
    if (/^(jpe?g|png|gif|webp|bmp)$/.test(ext)) return 'image';
    if (/^(mp3|wav|ogg|opus|m4a|aac|amr|silk)$/.test(ext)) return 'voice';
    if (/^(mp4|webm|mov|m4v)$/.test(ext)) return 'video';
    return null;
  }
  // 来源短名(标注用): 路径/URL 尾段去 query
  function chatSrcShortName(src) {
    let s = String(src || '').trim();
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (i >= 0) s = s.slice(i + 1);
    return s.replace(/[?#].*$/, '') || src || '';
  }
  function chatLocalRawUrl(p) {
    return '/api/qqbot-settings/chat/raw-media?p=' + encodeURIComponent(p);
  }
  // ── 图片台账(兜底) ──────────────────────────────────────────────────────────
  // 格式与 dist/features/image-url-ledger.js 完全一致: `{表情包目录}/image-url-ledger.jsonl`,
  //   一行一条 {id,url,at}; 查表从后往前取最新的那条。上限 1000 条(写侧维护)。
  // ⚠️ 渲染链是同步的 → 这里自带一份**同步只读**实现(按 mtime+size 缓存), 不去 await 那个模块。
  const CHAT_LEDGER_NAME = 'image-url-ledger.jsonl';
  const chatLedgerCache = new Map();
  // `…\表情包\lib\candidate\x.jpg` → `…\表情包`(找不到 lib 段就退回上一级)
  function chatLedgerDirOf(imgPath) {
    const p = String(imgPath || '');
    const s = p.indexOf('\\') >= 0 ? '\\' : '/';
    const parts = p.split(/[\\/]/);
    const i = parts.lastIndexOf('lib');
    return i > 0 ? parts.slice(0, i).join(s) : dirname(p);
  }
  function chatLedgerIndex(dir) {
    const file = join(dir, CHAT_LEDGER_NAME);
    let key = 'missing';
    try { const st = statSync(file); key = st.mtimeMs + ':' + st.size; } catch (e) { /* 台账还没建 */ }
    const hit = chatLedgerCache.get(file);
    if (hit && hit.key === key) return hit.index;
    const index = new Map();
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const o = JSON.parse(s);
          if (o && o.id && o.url) index.set(String(o.id), String(o.url)); // 后出现的覆盖 = 最新链接
        } catch (e) { /* 坏行跳过 */ }
      }
    } catch (e) { /* 没有台账文件 */ }
    chatLedgerCache.set(file, { key, index });
    return index;
  }
  // 图片文件路径 → 台账里的 QQ 链接(查不到返回 '')
  function chatLedgerImageUrl(imgPath) {
    try {
      const id = chatSrcShortName(imgPath).replace(/\.[a-z0-9]{1,6}$/i, '');
      if (!id) return '';
      return chatLedgerIndex(chatLedgerDirOf(imgPath)).get(id) || '';
    } catch (e) { return ''; }
  }
  // 反向: QQ 链接 → { id, dir } —— 历史消息里那条链接以前被我们收进过图库, 现在还能对上号,
  //   就说明**本地有这张图** → 前端可以改走本地(sticker-img / raw-media), 不必依赖会过期的 rkey。
  function chatLedgerDirs() {
    const dirs = new Set();
    for (const k of chatLedgerCache.keys()) dirs.add(dirname(k));
    try { const dd = getStickerStore().dataDir; if (dd) dirs.add(String(dd)); } catch (e) { /* 图库不可用 */ }
    return [...dirs];
  }
  function chatLedgerOfUrl(url) {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return null;
    for (const dir of chatLedgerDirs()) {
      const idx = chatLedgerIndex(dir);
      for (const [id, link] of idx) if (link === u) return { id, dir };
    }
    return null;
  }
  // 图库 id → 同源缩略图接口(sticker-img 按 id 解析, 与所在层无关)
  function chatStickerImgUrl(id, stickerDir) {
    if (!id) return '';
    return '/api/qqbot-settings/sticker-img?id=' + encodeURIComponent(id)
      + (stickerDir ? '&dataDir=' + encodeURIComponent(stickerDir) : '');
  }
  // 图库里的真实路径: 文件名就是图库 id, 但**文件会搬层**(candidate→library→trash),
  //   消息里记的是"当时"的路径 → 这里问 store 拿当前路径(2026-09-13 主人实测的 [图加载失败] 就是这个)
  function chatStickerRealPath(imgPath) {
    try {
      const id = chatSrcShortName(imgPath).replace(/\.[a-z0-9]{1,6}$/i, '');
      if (!/^[0-9a-f]{6,}$/i.test(id)) return '';
      const dir = chatLedgerDirOf(imgPath);
      const store = getStickerStore(dir);
      if (!store || typeof store.get !== 'function' || !store.get(id)) return '';
      const p = typeof store.pathOf === 'function' ? store.pathOf(id) : '';
      return p && chatLocalFileExists(p) ? p : '';
    } catch (e) { return ''; }
  }
  function chatLocalFileExists(p) {
    try { return statSync(p).isFile(); } catch (e) { return false; }
  }
  // 附件行里的**本机目标**(2026-09-13 主人要求: dock 聊天界面图片要同时兼容 url 与本地路径/图库链接)
  //   背景: 入站消息的图片从 QQ 链接改成本地路径后(`- Image: 名 (1086×1448) → D:\…\a.jpg`),
  //   dock 里图片直接不显示了 —— 这里把本机目标转成同源直出 URL 给 <img> 用。
  //   支持三种: ① Windows 绝对路径 ② /api/qqbot-settings/... 本插件接口(含 sticker-img?id=)
  //   ③ 其它绝对路径(POSIX)。返回 { url, kind, name, fb } 或 null。
  //   顺序: ①图库查**当前真实路径**(搬层也能对上) ②文件不在 → 台账 QQ 链接 ③都不行 → 原路径(前端再兜)
  function chatLocalTargetOf(raw, hasVoiceCtx) {
    const l = String(raw || '');
    // 优先取 "→ " 之后到行尾(路径里可能有空格); 没有箭头就在行内找绝对路径
    const arrow = l.match(/→\s*([\s\S]+?)\s*$/);
    let cand = arrow ? arrow[1].trim() : '';
    if (!cand) {
      // 2026-10-01: `[图片: <本机路径>]` / `[File: <本机路径>]` 整行 —— 路径可能含空格,
      //   下面按空白截断的正则会切坏它, 所以先按"冒号后到右括号"整体取一次
      const br = l.match(/^\s*\[[^\]:：]+[:：]\s*([\s\S]+?)\s*\]\s*$/);
      if (br && /(?:[A-Za-z]:[\\/]|^\\\\|\/)/.test(br[1])) cand = br[1].trim();
    }
    if (!cand) {
      const m2 = l.match(/([A-Za-z]:[\\/][^\s]+)/);
      cand = m2 ? m2[1] : '';
    }
    if (!cand) return null;
    // ① 已经是本插件自己的接口路径 → 原样用(相对路径, 浏览器同源能取)
    if (/^\/api\/qqbot-settings\//i.test(cand)) {
      return { url: cand, kind: chatAttachmentKind(l, hasVoiceCtx, undefined) || 'image', name: chatSrcShortName(cand), fb: '' };
    }
    // ② 本机文件 → 先问图库拿**当前真实路径**(candidate→library 搬层后, 消息里那条路径已失效 ——
    //   主人实测的 [图加载失败] 就是这么来的), 文件真不在才退台账的 QQ 链接
    if (!/^[A-Za-z]:[\\/]/.test(cand) && !/^\\\\/.test(cand) && !cand.startsWith('/')) return null;
    const lk = chatLocalExtKind(cand) || chatAttachmentKind(l, hasVoiceCtx, undefined) || 'image';
    const realPath = chatStickerRealPath(cand);
    const usePath = realPath || cand;
    const alive = chatLocalFileExists(usePath);
    const qqUrl = chatLedgerImageUrl(cand) || chatLedgerImageUrl(usePath);
    const sid = (chatSrcShortName(cand).match(/^([0-9a-f]{6,})\.[a-z0-9]{1,6}$/i) || [])[1] || '';
    return {
      url: (!alive && qqUrl) ? qqUrl : chatLocalRawUrl(usePath),
      fb: alive ? (qqUrl || chatStickerImgUrl(sid, chatLedgerDirOf(usePath))) : '',
      kind: lk,
      name: chatSrcShortName(cand),
    };
  }
  // 附件行/URL 归属类型: 行内**显式类型标签**优先, 其次文件名/URL fname 扩展名, 最后行标签与上下文
  // ⚠️ 2026-09-10 根因修复(主人实测: "视频还是附件形式, 图片也变成附件了"):
  //   QQ 群聊里图片/视频的 content_type 实测可能是 `'file'`(不是 image/jpeg) —— 官方取值表:
  //   voice / image/jpeg|png|gif / video/mp4 / file(=群文件)。端上(media-kind.ts)已按
  //   MIME→扩展名→宽高→URL 特征(appid/orgfmt) 推断真实类型, 并以 `- Image: 名 → url` 注入 Layer 4。
  //   这里必须认这些**显式前缀**, 否则 `- File:` 会把图片/视频判成 📎 附件(图片不显示、视频不能播)。
  function chatAttachmentKind(line, hasVoiceCtx, defaultKind) {
    const l = String(line || '');
    // ① 显式类型标签(我方注入格式, 最权威)
    if (/^-\s*(?:Image|图片)\s*:/i.test(l) || /^\[(?:Image|图片)\s*:/i.test(l)) return 'image';
    if (/^-\s*(?:Video|视频)\s*:/i.test(l) || /^\[(?:Video|视频)\s*:/i.test(l)) return 'video';
    if (/^-\s*(?:Voice|语音|音频)\s*:/i.test(l) || /^\[(?:Voice|语音|音频)\s*:/i.test(l)) return 'voice';
    if (/^-\s*(?:File|文件)\s*:/i.test(l) || /^\[(?:File|文件)\s*:/i.test(l)) return 'file';
    // 从行内或 URL fname 参数取文件名
    let name = '';
    const fm = l.match(/fname=([^&\s]+)/);
    if (fm) { try { name = decodeURIComponent(fm[1]); } catch { name = fm[1]; } }
    const am = l.match(/\[Attachment:\s*([^\s\]]+)/i);
    if (am) name = am[1];
    const extM = name.match(/\.([a-z0-9]{2,5})$/i);
    const ext = extM ? extM[1].toLowerCase() : '';
    if (/^(ogg|amr|silk|mp3|wav|opus|m4a|aac)$/.test(ext) || /\[语音|\[音频|\[Voice message\]/i.test(l)) return 'voice';
    if (/^(jpe?g|png|gif|webp|bmp)$/.test(ext)) return 'image';
    if (/^(mp4|webm|mov|m4v)$/.test(ext)) return 'video';
    if (/^(zip|rar|7z|tar|gz|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|apk|exe|iso|json|md|html?|js|py|ts|xml)$/.test(ext)) return 'file';
    if (/\[文件:|\[File:|\[附件:|- File:|\bFile:/i.test(l)) return 'file';
    if (hasVoiceCtx) return 'voice';
    return defaultKind || 'image';
  }
  // 文件显示名: URL fname 参数解码优先, 否则路径尾名
  function chatFileDisplayName(u) {
    try { const q = new URL(u).searchParams.get('fname'); if (q) return decodeURIComponent(q); } catch { /* 继续 */ }
    return chatSrcShortName(u) || '文件';
  }
  function chatSplitMedia(text) {
    const images = [];
    const lines = String(text || '').split('\n');
    const out = [];
    // 语音消息上下文: 该条消息含 ASR/Voice message/语音标记 → 附件 URL 按音频渲染(可播放)
    const hasVoiceCtx = /- ASR:|\[Voice message\]|\[语音|\[音频|voice/i.test(String(text || ''));
    for (const line of lines) {
      const raw = line.trim();
      if (!raw) { out.push(''); continue; }
      // QQ 语音转文字: "- ASR: 内容" → 当消息正文保留
      if (/^- ASR:/i.test(raw)) { out.push(raw.replace(/^- ASR:\s*/i, '').trim()); continue; }
      // "[Voice message] 内容" → 剥壳当正文(与 ASR 重复时可留, dock 不丢文字)
      if (/^\[Voice message\]/i.test(raw)) { const vt = raw.replace(/^\[Voice message\]\s*/i, '').trim(); if (vt) out.push(vt); continue; }
      // 面板代发媒体标记(用户代发上下文格式): [MEDIA:图片|D:\…] / [MEDIA:图片|http…]
      const md = raw.match(/^\[MEDIA:([^\]|]+)\|([^\]]+)\]$/i);
      if (md) {
        const got = chatMediaSrcToImg(md[1], md[2]);
        const sn = chatSrcShortName(md[2]);
        if (got) {
          images.push({ url: got.url, kind: got.kind === 'image' ? 'image' : got.kind });
          const icon = got.kind === 'voice' ? '🎵' : got.kind === 'video' ? '🎬' : '📷';
          out.push(icon + ' ' + sn);
        } else {
          out.push('📎 ' + sn);
        }
        continue;
      }
      // 整行就是一个本机绝对路径(主人贴 <cwd>\a.jpg / a.mp3 文本) → 按扩展名转可看/可播
      const lp = raw.match(/^([A-Za-z]:[\\/].+)$/);
      if (lp) {
        const lk = chatLocalExtKind(lp[1]);
        if (lk) {
          const rp = chatStickerRealPath(lp[1]) || lp[1];  // 图库搬层也能对上当前路径
          const led = lk === 'image' ? chatLedgerImageUrl(lp[1]) : '';
          images.push({ url: chatLocalRawUrl(rp), kind: lk, fb: led });
          continue;
        }
      }
      // 附件描述行: "- Image: …" / "- Video: …" / "- Voice: …" / "- File: …" / "- Attachment URLs: …"
      //            / "[图片: …]" / "[视频: …]" / "[附件: …]" / "[Attachment: name -> …]" / Layer1 的英文标签行
      if (/^-\s*Attachment URLs:/i.test(raw) || /^-\s*(Image|Video|Voice|File)s?:/i.test(raw) || /^\[(图片|附件|文件|语音|视频|音频):/i.test(raw) || /^\[(Attachment|File|Image|Video):/i.test(raw)) {
        const urls = raw.match(QQ_URL_RE) || [];
        let got = 0;
        for (const u of urls) {
          const k = chatAttachmentKind(raw, hasVoiceCtx, undefined);
          // 图片/音频须是 QQ 媒体域; 文件(ftn.qq.com 等任意域)直接收
          // ⚠️ 图片带兜底: 这条链接以前被收进过图库 → 本地有文件, rkey 过期了也能显示(fb → sticker-img)
          const led = k === 'image' ? chatLedgerOfUrl(u) : null;
          const fb = led ? chatStickerImgUrl(led.id, led.dir) : '';
          if (k === 'file') { images.push({ url: u, kind: 'file', name: chatFileDisplayName(u) }); got++; }
          else if (QQ_MEDIA_RE.test(u)) { images.push({ url: u, kind: k, fb }); got++; }
        }
        if (!got) {
          // ⚠️ 2026-09-13 新增(主人实测: "web 界面出问题了/图片不显示了"): 目标可能是**本机路径**
          //   —— 图片入站改成给本地路径(`- Image: 名 (1086×1448) → D:\…\lib\candidate\x.jpg`)后,
          //   这里原来只认 http(s) URL, 于是图片被当成文本丢掉。现在转成同源直出 URL 正常显示。
          const lt = chatLocalTargetOf(raw, hasVoiceCtx);
          if (lt) {
            if (lt.kind === 'file') images.push({ url: lt.url, kind: 'file', name: lt.name || '文件', fb: lt.fb || '' });
            else images.push({ url: lt.url, kind: lt.kind, fb: lt.fb || '' });
            got += 1;
          }
        }
        if (!got) {
          // Layer 1 的英文描述行(`[Image: 名 800×600]` / `[Video: 名]` / `[File: 名 (1.2MB)]`)不含 URL,
          // 其媒体由 Layer 4 的 `- Image:/- Video:/- File:` 行承载 → 直接丢弃, 避免显示成
          // `📎 [Image: 名 800×600]` 这种丑文本(主人 2026-09-10 实测反馈)。
          if (/^\[(Image|Video|File):/i.test(raw)) continue;
          // 无 URL 的 File/附件描述行(如 "- File: a.zip (3.0MB)")→ 保留可读文本, 不给空占位
          const desc = raw
            .replace(/^-\s*File:\s*/i, '').replace(/^\[File:\s*/i, '')
            .replace(/^\[(图片|附件|文件|语音|视频|音频):\s*/i, '').trim().replace(/\]$/, '').trim();
          if (desc && !/^https?:/i.test(desc) && !/^Attachment\s*:/i.test(desc)) out.push('📎 ' + desc);
        }
        continue;
      }
      // 整行就是一个 QQ 媒体 URL(纯图片/音频消息体) → 当媒体(图片同样带本地兜底)
      const urls = raw.match(QQ_URL_RE) || [];
      if (urls.length === 1 && QQ_MEDIA_RE.test(raw) && raw === urls[0]) {
        const k1 = chatAttachmentKind(raw, hasVoiceCtx, 'image');
        const led1 = k1 === 'image' ? chatLedgerOfUrl(urls[0]) : null;
        images.push({ url: urls[0], kind: k1, fb: led1 ? chatStickerImgUrl(led1.id, led1.dir) : '' });
        continue;
      }
      // 普通行: 行内嵌的 QQ 媒体长 URL 抽走(防撑爆气泡), 其余保留
      if (urls.length) {
        let rest = raw;
        for (const u of urls) {
          if (QQ_MEDIA_RE.test(u)) {
            const k2 = chatAttachmentKind(raw, hasVoiceCtx, 'image');
            const led2 = k2 === 'image' ? chatLedgerOfUrl(u) : null;
            images.push({ url: u, kind: k2, fb: led2 ? chatStickerImgUrl(led2.id, led2.dir) : '' });
            rest = rest.split(u).join('');
          }
        }
        rest = rest.trim();
        if (rest) out.push(rest);
        continue;
      }
      out.push(raw);
    }
    // 去重保序
    // 去重: 同一 URL 在多行出现(描述行/标签行/Attachment 行)时保留最精确的类型
    // 权重: voice/video(扩展名实锤)=3 > image(图片扩展名)/file(标签/扩展名)=2 > 默认 image=1
    const kindW = (x) => {
      const k = typeof x === 'string' ? 'image' : ((x && x.kind) || 'image');
      if (k === 'voice' || k === 'video') return 3;
      if (k === 'file') return 2;
      return 2; // image(含默认)
    };
    const byUrl = new Map();
    for (const x of images) {
      const key = typeof x === 'string' ? x : (x && x.url);
      if (!key) continue;
      const prev = byUrl.get(key);
      if (!prev || kindW(x) >= kindW(prev)) byUrl.set(key, x);
    }
    const uniq = [...byUrl.values()];
    // 正文行去重(ASR 与 [Voice message] 常同文, 不重复显示)
    const rawLines = out.join('\n').split('\n');
    const textOut = rawLines.filter((l, i) => rawLines.indexOf(l) === i).join('\n').trim();
    return { text: textOut, images: uniq };
  }
  // 群延迟/冷却历史打包的分行器: [Chat history begins]…[Chat history ends] + [Current message]
  // 每行 "[昵称 (openid)] 内容" 开新气泡, 后续行并入该气泡; 系统提示段起截断(后面是给 LLM 的注入)
  function chatSplitHistoryBlock(body) {
    const out = [];
    let cur = null;
    // ⚠️ 2026-09-10 修复(主人实测: 当前消息的语音被挂到了上一条历史消息上):
    //   Layer 4 的媒体元数据行(`- Attachment URLs:` / `- File:` …)排在 `[Current message]` 之后、
    //   带昵称的当前消息之前 —— 原逻辑"无昵称行并入上一个气泡"会把它算到上一条历史消息头上。
    //   改为: 这类 `- ` 开头的元数据行先暂存(pendingMeta), 等下一个带昵称的消息出现时归属它
    //   (即"元数据行属于它下面那条消息"), 找不到归属时才丢弃。
    let pendingMeta = [];
    const flush = () => {
      if (cur) {
        const t = cur.lines.join('\n').trim();
        out.push({ sender: cur.sender, text: t });
      }
      cur = null;
    };
    for (const line of String(body || '').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      // ⚠️ 2026-10-01 修（主人实测："当前消息引用的消息显示给上一个人了"）：
      //   `[当前]` 是**分段点** —— 它之前属于历史（该收尾结算），之后的"引用块 + 正文"才是当前消息。
      //   原来这里直接 continue 不 flush，导致当前消息的 `[引]…[/引]` 被并进**上一条历史消息**里
      //   （于是界面上引用块挂在别人气泡上）。
      if (RE_CURRENT_LINE.test(s)) { flush(); continue; }
      if (RE_HIST_BEGIN_LINE.test(s) || RE_HIST_END_LINE.test(s) || isTimeHeadLine(s)) continue;
      if (/^\[系统提示\]/.test(s)) { flush(); return out; } // 系统注入段, 之后都不属于群聊内容
      // 媒体元数据行: 暂存, 等归属给下面那条带昵称的消息
      // (Layer 4 现输出 `- Image:/- Video:/- Voice:/- File:` 单数前缀, 此处一并覆盖)
      if (/^-\s*(Attachment URLs|Files?|Images?|ASR|Voices?|Videos?)\s*[:：]/i.test(s)) { pendingMeta.push(s); continue; }
      // 2026-09-12 适配(token 瘦身后历史行变成 "[昵称]"): id 段设为**可选**, 老格式 "[昵称 (openid)]" 仍认;
      // 同时排除含冒号的方括号(如 "[图片: url]"), 免得把附件标记当成发送者。
      const m = s.match(/^\[([^\]\n:]*?)(?:\s*\([A-Za-z0-9_-]{6,}\))?\](.*)$/);
      // ⚠️ 2026-10-01 修（主人实测：dock 聊天界面冒出个叫「引」的人发消息）：
      //   `[引]` / `[/引]` / `[引用]` 是**块标记**而不是昵称壳 —— 命中它们时不能开新气泡，
      //   要当普通行并入当前段（真昵称在后面几行，交给 chatPolishOne 去找）。
      //   与 chatPolishOne 的 RE_MARKER_WORD 同款防御，此处之前漏了。
      const isNick = m && m[1].trim() && !RE_MARKER_WORD.test(m[1].trim());
      if (isNick) {
        // ⚠️ 2026-10-01：当前消息的引用块会先形成一个 sender 为空的段 —— 紧随的 [昵称] 行要**接管**它
        //   （引用块 + 正文同属一条消息），否则引用块会独立成一个没有名字的气泡。
        if (cur && !cur.sender) {
          cur.sender = m[1].trim();
          cur.lines.push(...[m[2].trim(), ...pendingMeta].filter(Boolean));
        } else {
          flush();
          cur = { sender: m[1].trim(), lines: [m[2].trim(), ...pendingMeta].filter(Boolean) };
        }
        pendingMeta = [];
      }
      else { if (cur) cur.lines.push(...pendingMeta, s); else { flush(); cur = { sender: '', lines: [...pendingMeta, s] }; } pendingMeta = []; }
    }
    flush();
    return out;
  }
  // 单条/子条通用清洗: 去 [Current message] 标记、引用块折叠、提取昵称标签、剥 [系统提示]、
  // 去提及/@you、抽离 QQ 媒体 URL。返回 { sender, mm:{text,images} }
  function chatPolishOne(body, fallbackSender, nameByMid) {
    let sender = fallbackSender;
    let b = String(body || '');
    b = b.replace(RE_CURRENT_ANY, ' ');
    // 2026-10-01: 历史块标记(新旧)先抹掉 —— 内容已被 chatSplitHistoryBlock 拆成独立气泡,
    //   残留标记会被下面的 tagM 当发送者(气泡显示"历史"), 也会在末尾显示成裸文本
    b = b.replace(RE_HIST_MARK_ANY, ' ');
    // 2026-10-01: 引用块**不再折叠成 `[引用]`**(v0.8.0 的老做法) —— 前端 chatRenderText 本来就有
    //   `[引]…[/引]` 的引用气泡样式(左边框+灰底), 折叠后原文丢失、只剩一个裸方括号,
    //   还会被下面的昵称提取当成发送者(气泡显示"引用")。这里先"摘出来占位",
    //   等昵称壳剥完再原样放回; 超长截断(被引用的原文可能有几百字)。
    const quotes = [];
    b = b.replace(new RegExp(`${RE_QUOTE_BEGIN.source}\\s*([\\s\\S]*?)\\s*${RE_QUOTE_END.source}`, 'g'), (_all, inner) => {
      const q = String(inner || '').trim();
      quotes.push('[引]' + (q.length > 300 ? q.slice(0, 300) + '…' : q) + '[/引]');
      return '\u0000Q' + (quotes.length - 1) + '\u0000';
    });
    // 2026-09-12 适配: "[昵称]" 与 "[昵称 (openid)]" 都认; 排除含冒号的方括号(附件标记)
    // 2026-10-01: **标记词**(`[引]`/`[历史]`/`[当前]`…)不算昵称, 跳过它继续往后找真昵称
    const reTag = /\[([^\]\n:]*?)(?:\s*\([A-Za-z0-9_-]{6,}\))?\]/g;
    let tmm;
    while ((tmm = reTag.exec(b)) !== null) {
      const nm = tmm[1].trim();
      if (!nm || RE_MARKER_WORD.test(nm)) continue;
      sender = nm;
      b = b.replace(tmm[0], '');
      break;
    }
    if (quotes.length) b = b.replace(/\u0000Q(\d+)\u0000/g, (_all, i) => quotes[Number(i)] || '');
    const sysIdx = b.indexOf('[系统提示]');
    if (sysIdx >= 0) b = b.slice(0, sysIdx).replace(/\s*$/, '');
    const mm = chatSplitMedia(chatDisplayClean(b, nameByMid));
    return { sender, mm };
  }
  // 🔍 临时诊断已移除（2026-10-04）：
  //   原来会把含媒体标记的入站原文落盘到 ~/.dsh/qqbot-chat-raw.jsonl，
  //   注释里明明写着"主人验收通过后删除"，结果一直忘了删 —— 实测已经攒到 5.5 MB ✗
  //   核对 Layer1/Layer4 注入格式的需求早已过去，这里删掉，C 盘少一份垃圾。
  // 解码一条会话事件为聊天条目(群打包会展开成多条); 非聊天事件/噪声返回 null
  function chatDecodeEvent(ev, scope, nameByMid, fallbackSender) {
    if (!ev || typeof ev.type !== 'string') return null;
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
    const time = typeof ev.time === 'number' ? ev.time : 0;
    if (ev.type === 'user/message') {
      const src = data.source && typeof data.source === 'object' ? data.source : {};
      // ⚠️ 2026-10-01 修(主人截图: 整段 `<system-reminder>` 系统提示词漏进了 dock 聊天界面):
      //   `user/message` 在 dsh 会话里**不只承载真人发言** —— 插件/宿主的运行时注入也走它:
      //     · 固定通道规则 + 群守则 → source.kind `qqbot:group-rules`(session-manager 拼的 <system-reminder>)
      //     · QQ 审批提醒            → source.kind `plugin:qqbot-approval`
      //     · 上下文压缩检查点        → source.kind `compact-checkpoint`
      //     · 其它插件/扩展工具       → source.kind `plugin:<name>`
      //   原实现只挡了 `kind === 'plugin'`(还是会话格式 V4 已废弃的写法) → 以上全漏。
      //   真人发言的 kind 是 `user`; 这里按"插件自有 kind 前缀"黑名单 + 内容特征双保险。
      const srcKind = typeof src.kind === 'string' ? src.kind : '';
      if (srcKind === 'plugin' || srcKind.startsWith('plugin:') || srcKind.startsWith('qqbot:') || srcKind === 'compact-checkpoint') return null;
      const raw0 = chatTextOf(data.content);
      if (!raw0) return null;
      // 兜底: 运行时上下文(user-role 快照)一律包在 <system-reminder> 里 → 不是对方说的话, 不进聊天视图
      if (/^\s*<system-reminder>/.test(raw0)) return null;
      const raw = chatPeelTimeHead(raw0);
      const isRelay = /^用户代你发送: /.test(raw);
      // 后台任务/面板大文件完成通知([系统] 后台任务…)→ 显示为 bot 侧气泡并打来源标; 其余系统注入滤掉
      const isBg = /^\[系统\]\s*后台任务/.test(raw0);
      // 伪造/系统注入(无时间头且非 web 直聊): 入群申请/定时 → 滤(QQ 里并没有这句话)
      if (!isTimeHeadLine(raw0) && !src.rpcId) {
        if (/^\[(入群申请|定时|到点)/.test(raw0)) return null;
        if (/^\[系统\]/.test(raw0) && !isBg) return null;
      }
      const isWeb = !!src.rpcId; // web 直聊(同一会话, 主人手打)
      let sender = fallbackSender;
      let body = raw;
      if (isRelay) body = body.replace(/^用户代你发送:\s*/, '');
      if (isBg) body = body.replace(/^\[系统\]\s*/, '');
      // 群延迟/冷却历史打包: [历史]…[/历史] + [当前]（老标记 [Chat history begins]…[ends] + [Current message]）
      // 历史段里每条都是真实发生过的群消息 → 逐条拆成独立气泡(不裁不丢), 返回多条
      if (hasHistoryBlock(body)) {
        const parts = chatSplitHistoryBlock(body);
        const out = [];
        for (const p of parts) {
          const polished = chatPolishOne(p.text, p.sender || fallbackSender, nameByMid);
          if (!polished.mm.text && polished.mm.images.length === 0) continue;
          out.push({ seq: ev.seq, time, dir: 'in', sender: polished.sender || '', text: polished.mm.text, images: polished.mm.images, tag: '' });
        }
        return out.length ? out : null;
      }
      // 普通单条(去标记/剥昵称壳/剥系统提示/抽媒体)
      const polished = chatPolishOne(body, sender, nameByMid);
      sender = polished.sender;
      const mm = polished.mm;
      if (!mm.text && mm.images.length === 0) return null;
      // 面板代发/后台任务完成 = bot 侧事实 → 右气泡 + 来源标(面板代发 / 后台任务)
      return {
        seq: ev.seq, time,
        dir: (isRelay || isBg) ? 'out' : 'in',
        sender: isBg ? '' : (sender || ''),
        text: mm.text,
        images: mm.images,
        tag: isBg ? '后台任务' : (isRelay ? '面板代发' : (isWeb ? 'Web' : '')),
      };
    }
    if (ev.type === 'assistant/message') {
      const msg = data.message && typeof data.message === 'object' ? data.message : null;
      if (!msg) return null;
      const text0 = chatTextOf(msg.content);
      if (!text0) return null; // 纯思考/纯工具步(没对群友说话)跳过
      const text = chatDisplayClean(text0, nameByMid);
      const mm = chatSplitMedia(text);
      if (!mm.text && mm.images.length === 0) return null;
      return { seq: ev.seq, time, dir: 'out', sender: '', text: mm.text, images: mm.images, tag: '' };
    }
    return null;
  }
  // GET /chat/history?ns&scope&peerId&beforeSeq&limit —— 聊天视图数据源
  // [qqbot-mod] chat-log-source（2026-10-25 主人: 浮窗群聊拿不到最新几条）
  //   msg-content.jsonl 只记"被引用过的消息"，不是完整台账；
  //   完整台账在 .qqbot/msg-history/<scope>_<peerId>/YYYY-MM-DD.jsonl（含机器人自己发的）。
  const CHATLOG_JUNK = /^\[(记忆|设定|印象|旧识|别重复)[^\]]*\]\s*/g
  function chatLogDir(bot, scope, peerId) {
    try {
      const root = resolveMemoryRoot(bot)
      if (!root) return ''
      const sid = String(peerId || '').replace(/[^0-9A-Za-z_-]/g, '')
      if (!sid) return ''
      return join(root, '.qqbot', 'msg-history', String(scope) + '_' + sid)
    } catch { return '' }
  }
  function chatLogItems(bot, scope, peerId, limit) {
    const out = []
    try {
      const dir = chatLogDir(bot, scope, peerId)
      if (!dir || !existsSync(dir)) return out
      const want = Math.max(1, Math.min(400, Number(limit) || 80))
      const names = readdirSync(dir).filter(function (n) { return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) }).sort()
      const lines = []
      for (let i = names.length - 1; i >= 0 && lines.length < want * 3; i--) {
        try {
          const rows = readFileSync(join(dir, names[i]), 'utf8').split(String.fromCharCode(10))
          for (let j = rows.length - 1; j >= 0 && lines.length < want * 3; j--) {
            const ln = String(rows[j] || '').trim()
            if (ln) lines.push(ln)
          }
        } catch { /* 单个日期文件读不到就跳过 */ }
      }
      const seen = Object.create(null)
      for (const ln of lines) {
        let o = null
        try { o = JSON.parse(ln) } catch { continue }
        if (!o) continue
        const t = Number(o.t) || 0
        if (!t) continue
        let text = String(o.x == null ? '' : o.x)
        if (o.k === 'image') text = text || '[图片]'
        else if (o.k === 'video') text = text || '[视频]'
        else if (o.k === 'voice') text = text || '[语音]'
        else if (o.k === 'file') text = text || '[文件]'
        text = text.replace(CHATLOG_JUNK, '').trim()
        if (!text) continue
        const dir2 = (o.me || String(o.n || '') === '机器人') ? 'out' : 'in'
        const key = Math.floor(t / 1000) + '|' + dir2 + '|' + text.slice(0, 24)
        if (seen[key]) continue
        seen[key] = 1
        out.push({
          seq: 0,
          time: t,
          dir: dir2,
          // [qqbot-mod] tier-v2：带上发送者 id，聊天行才能一键加「特别关心」；昵称兜底但不把 openid 当名字用
          sid: String(o.s || ''),
          sender: (function (_n, _s, _out) {
              if (_out) return '小蓝'
              if (!_n || _n === _s || _n === '机器人' || /^[0-9A-Fa-f]{32}$/.test(_n)) return '群友'
              return _n
            })(String(o.n || ''), String(o.s || ''), dir2 === 'out'),
          text: text,
          images: [],
          tag: '',
          by: 'log',
          ms: 0,
          model: '',
        })
        if (out.length >= want) break
      }
    } catch { /* 台账读不到就当没有 */ }
    out.sort(function (a, b) { return (Number(a.time) || 0) - (Number(b.time) || 0) })
    return out
  }
  function mergeChatLog(items, extra, limit) {
    const byKey = Object.create(null)
    const all = []
    const add = function (it) {
      if (!it) return
      const k = Math.floor((Number(it.time) || 0) / 1000) + '|' + String(it.dir || '') + '|' + String(it.text || '').slice(0, 24)
      if (byKey[k]) return
      byKey[k] = 1
      all.push(it)
    }
    for (const it of (extra || [])) add(it)
    for (const it of (items || [])) add(it)
    all.sort(function (a, b) { return (Number(a.time) || 0) - (Number(b.time) || 0) })
    const cap = Math.max(1, Math.min(400, Number(limit) || 80))
    return all.length > cap ? all.slice(all.length - cap) : all
  }
  route(ctx, 'GET', '/api/qqbot-settings/chat/history', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const ns = String(u.searchParams.get('ns') || '').trim() || undefined;
      const scope = String(u.searchParams.get('scope') || '').trim();
      const peerId = String(u.searchParams.get('peerId') || '').trim();
      if (scope !== 'group' && scope !== 'c2c') return writeJson(res, 400, { error: 'scope 必须为 group|c2c' });
      if (!peerId) return writeJson(res, 400, { error: 'peerId 必填' });
      const limit = Math.max(1, Math.min(200, Math.round(Number(u.searchParams.get('limit'))) || 50));
      const _bStr = u.searchParams.get('beforeSeq');
      const bRaw = (_bStr === null || _bStr === '') ? NaN : Number(_bStr);   // 同理：空串/缺失不能当 0
      const beforeSeq = Number.isFinite(bRaw) && bRaw > 0 ? Math.floor(bRaw) : undefined;
      // 2026-10-01 新增 afterSeq：**往后取更新的消息**（dock 聊天页滚轮增量刷新用 ——
      //   只 append 新气泡，不重绘不闪、不跳滚动位置）。与 beforeSeq 互斥：给了 afterSeq 就正扫。
      // ⚠️ 2026-10-04 修复（主人实测：dock 聊天页永远只显示最旧那批，一直以为数据没加载）：
      //   Number(null) === 0！参数【不存在】时 searchParams.get() 返回 null，
      //   原来的 `aRaw >= 0` 于是成立 ⇒ afterSeq=0 ⇒ 走进【正扫】分支，
      //   从 seq=1 开始往前捞 ⇒ 捞到的全是最早的历史（表现：停在几天前，怎么刷新都一样）✗
      //   必须先判"参数是否真的存在"，缺失就送 NaN（→ undefined → 走倒扫）。
      const _aStr = u.searchParams.get('afterSeq');
      const aRaw = (_aStr === null || _aStr === '') ? NaN : Number(_aStr);
      const afterSeq = Number.isFinite(aRaw) && aRaw >= 0 ? Math.floor(aRaw) : undefined;
      let bot = nsBot(ns);
      const _chatLogOf = function () { try { return chatLogItems(bot, scope, peerId, 200) } catch { return [] } }
      if (!bot) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const reg = await import('./dist/features/session-registry.js');
      let rec = typeof reg.findRecordByPeerWeb === 'function'
        ? reg.findRecordByPeerWeb(String(ns || ''), scope, peerId) : undefined;
            // ⚠️ 2026-10-04 修复（主人实测：dock 聊天页只显示到几天前的最旧消息）：
      //   原实现兜底默认值硬编码 'im-qqbot'；多 bot 场景（主人在用 im-qqbot-2）会去查**另一个实例**，
      //   拿到那个实例里的过期会话记录 ⇒ 聊天停在很久以前（实际活跃会话在别的实例）。
      //   现在：按 ns 查不到就**遍历所有实例**，挑 seq 最大（= 最新）的那个。
      if ((!rec || !rec.agent) && typeof reg.listPeerRecordsWeb === 'function') {
        try {
          const cands = reg.listPeerRecordsWeb(scope, peerId) || [];
          if (cands.length) {
            cands.sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0));
            rec = cands[0];
            const b2 = nsBot(rec.ns);
            if (b2) bot = b2;
          }
        } catch { /* 兜底失败按原样走 */ }
      }
      if (!rec || !rec.agent) {
        // [qqbot-mod] chat-local-only：会话记录没了，但"她说过的话"还在日志里
      {
        const _lg1 = _chatLogOf()
        if (_lg1.length) return writeJson(res, 200, { ok: true, code: 'log-only', items: mergeChatLog([], _lg1, limit), hasMore: false, tailSeq: 0, msg: '会话记录已换/未就绪，已用本地消息台账补齐' })
        const only = chatLocalOnlyItems(bot, scope, peerId, limit)
        if (only.length) return writeJson(res, 200, { ok: true, code: 'local-only', items: mergeChatLog(only, _lg1 || [], limit), hasMore: false, msg: '只找到本地代答记录（会话记录已换/未就绪）' })
      }
      return writeJson(res, 200, { ok: true, code: 'no-session', items: [], hasMore: false, msg: '该目标暂无活跃会话' });
      }
      const agent = rec.agent;
      const sess = agent && (agent.session || (agent.ctx && agent.ctx.session));
      if (!sess || typeof sess.seq !== 'number') {
        {
        const _lg2 = _chatLogOf()
        if (_lg2.length) return writeJson(res, 200, { ok: true, code: 'log-only', items: mergeChatLog([], _lg2, limit), hasMore: false, tailSeq: 0, msg: '会话未就绪，已用本地消息台账补齐' })
        const only2 = chatLocalOnlyItems(bot, scope, peerId, limit)
        if (only2.length) return writeJson(res, 200, { ok: true, code: 'local-only', items: mergeChatLog(only2, _lg2 || [], limit), hasMore: false, msg: '只找到本地代答记录（会话未就绪）' })
      }
      return writeJson(res, 200, { ok: true, code: 'no-session', items: [], hasMore: false, msg: '会话未就绪' });
      }
      const snap = typeof sess.snapshotEvents === 'function' ? sess.snapshotEvents.bind(sess) : undefined;
      // 名字映射: c2c 用台账兜底 sender; group 读群成员表把 <@openid> 换成昵称
      const dataDir = join(bot.cwd, '表情包');
      const ledger = chatLedgerNames(dataDir);
      const nameByMid = new Map();
      if (scope === 'group') {
        try {
          const lm = await import('./dist/features/chat-ledger.js');
          const mems = (lm.readGroupMembers && lm.readGroupMembers(dataDir, peerId)) || [];
          for (const m of mems) if (m && m.mid && m.name) nameByMid.set(m.mid, m.name);
        } catch { /* 无成员表不阻断 */ }
      }
      const fallbackSender = scope === 'c2c' ? ((ledger.get('c2c:' + peerId) || {}).name || '') : '';
      // 尾部倒扫: 默认从最新一条事件 seq 往前; beforeSeq=加载更早(beforeSeq 之前的)
      let items = [];
      const STEP = 200;   // 2026-10-04: 500 → 200（主人实测大跨度区间取不到数据，小步更容易落进有效区）
      const diagScan = [];   // 🔍 临时诊断：每轮扫了哪个 seq 区间、拿到几条
        let reachedEnd = false;
      if (afterSeq !== undefined) {
        // ★ 正扫：从 afterSeq+1 扫到最新（升序）—— 只取"比前端已有的更新"的那批
        const top = Math.max(0, sess.seq - 1);
        let low = afterSeq + 1;
        while (low <= top && items.length < limit) {
          const hi = Math.min(top, low + STEP - 1);
          let evs = [];
          if (snap) { try { evs = snap(low, hi + 1) || []; } catch { evs = []; } }
          if (!evs.length) { const all = sess.events; if (Array.isArray(all) && all.length && all.length > low) evs = all.slice(low, hi + 1); }
          for (const ev of evs) {
            const got = chatDecodeEvent(ev, scope, nameByMid, fallbackSender);
            if (got) {
              if (Array.isArray(got)) { for (const g of got) items.push(g); }
              else items.push(got);
            }
            if (items.length >= limit) break;
          }
          low = hi + 1;
        }
        reachedEnd = low > top;
      } else {
      let high = beforeSeq !== undefined ? Math.max(0, beforeSeq - 1) : Math.max(0, sess.seq - 1);
      while (high >= 0 && items.length < limit) {
        const low = Math.max(0, high - STEP + 1);
        let evs = [];
        if (snap) { try { evs = snap(low, high + 1) || []; } catch { evs = []; } }
        // 🔍 2026-10-04 临时诊断：记录每一轮"扫了哪个 seq 区间、拿到几条"
        //   主人实测"只显示 9/21 最旧那批"，而单点探针 snap(seq-5,seq) 却能拿到最新 ⇒
        //   怀疑 snapshotEvents 对大跨度区间返回空。这里把每轮的实况记下来，一眼可辨。
        try {
          if (diagScan.length < 12) diagScan.push({ low, hi: high + 1, got: evs.length })
        } catch { /* ignore */ }
        if (!evs.length) { const all = sess.events; if (Array.isArray(all) && all.length && all.length > low) evs = all.slice(low, high + 1); }
        for (let i = evs.length - 1; i >= 0; i--) {
          const got = chatDecodeEvent(evs[i], scope, nameByMid, fallbackSender);
          if (got) {
            if (Array.isArray(got)) { for (const g of got) items.push(g); } // 群打包历史 → 多条
            else items.push(got);
          }
          if (items.length >= limit) { reachedEnd = !(i > 0 || low > 0); break; }
        }
        if (items.length >= limit) break;
        if (low === 0) { reachedEnd = true; break; }
        high = low - 1;
      }
      }
      // ⚠️ 2026-09-10 修复(主人实测"同一批次的历史消息会倒序"):
      //   原为 items.reverse() —— 倒扫时同一打包块([Chat history begins]…[Chat history ends])
      //   拆出的多条共用同一个 ev.seq, 块内本就是旧→新; 整体 reverse 会把"块内顺序"也翻反,
      //   表现为"整批之间顺序对、批内倒序"。
      //   改为: 按 seq 分块 → 块间倒序(旧→新), 块内保持原顺序。
      if (afterSeq === undefined) {
        const blocks = [];
        for (const it of items) {
          const last = blocks[blocks.length - 1];
          if (last && last.seq === it.seq) last.arr.push(it);
          else blocks.push({ seq: it.seq, arr: [it] });
        }
        blocks.reverse();
        items.length = 0;
        for (const b of blocks) for (const one of b.arr) items.push(one);
      }
      // QQ 媒体域的语音 URL → 经 /chat/voice-play 转 mp3 播放(浏览器解不了 SILK)
      for (const it of items) {
        if (!Array.isArray(it.images)) continue;
        for (const m of it.images) {
          if (m && typeof m === 'object' && m.kind === 'voice' && typeof m.url === 'string'
            && /^https?:/i.test(m.url) && QQ_MEDIA_RE.test(m.url)) {
            m.url = '/api/qqbot-settings/chat/voice-play?u=' + encodeURIComponent(m.url);
          }
        }
      }
      // 群图片/附件消息不带昵称壳 → 用之前最近一条有名字的群友文本消息推断发送者(只影响展示)
      {
        let prev = '';
        for (const it of items) {
          if (it.dir === 'in') {
            if (!it.sender && it.tag !== 'Web') it.sender = prev;
            if (it.text && it.tag !== 'Web') prev = it.sender;
          }
        }
      }
      // 🔍 2026-10-04 临时诊断（主人实测"聊天页只显示最旧的 9/21，刷新也一样"）：
      //   把"后端到底扫到了哪"直接回给前端，免得再靠猜。定位完可删。
      // 🔍 窗口探针：snapshotEvents 到底能往前回溯多少（主人实测单点可读、大跨度读空）
      let winProbe = null
      try {
        const _w = (n) => { try { return snap ? (snap(Math.max(0, sess.seq - n), sess.seq) || []).length : -1 } catch (e) { return -1 } }
        winProbe = { w100: _w(100), w500: _w(500), w2000: _w(2000), w5000: _w(5000) }
      } catch (e) { winProbe = String((e && e.message) || e) }
      let diag = {}
      try {
        const _all = Array.isArray(sess.events) ? sess.events : null
        let _probe = null
        try {
          const _a = snap ? (snap(Math.max(0, sess.seq - 5), sess.seq) || []) : []
          _probe = { len: _a.length, last3: _a.slice(-3).map((e) => (e && e.type) || '?') }
        } catch (e) { _probe = 'ERR ' + String((e && e.message) || e) }
        diag = {
          sessionId: rec && rec.sessionId ? String(rec.sessionId) : '',
          seq: sess.seq,
          eventsLen: _all ? _all.length : -1,
          snapProbe: _probe,
          query: { scope, peerId, beforeSeq: beforeSeq === undefined ? null : beforeSeq, afterSeq: afterSeq === undefined ? null : afterSeq, limit },
          got: items.length,
          firstText: items.length ? String(items[0].text || '').slice(0, 40) : '',
          lastText: items.length ? String(items[items.length - 1].text || '').slice(0, 40) : '',
          reachedEnd,
          scan: diagScan,
          win: winProbe,
        }
      } catch (e) { diag = { err: String((e && e.message) || e) } }
      // [qqbot-mod] chat-merge：把"本地代答说过的话"和"同一 peer 的其它会话"并进聊天页
      try {
        var _cmEol = String.fromCharCode(10)
        var _cmRoot = ""
        try { _cmRoot = resolveMemoryRoot(bot) } catch (_e0) { _cmRoot = "" }
        var _cmSeen = {}
        for (var _cmI = 0; _cmI < items.length; _cmI++) {
          var _cmIt = items[_cmI] || {}
          _cmSeen[String(Number(_cmIt.time) || 0) + "|" + String(_cmIt.text || "").slice(0, 24)] = 1
        }
        var _cmWant = (scope === "c2c" ? "c2c:" : "group:") + peerId
        // 1) 本地代答/死梗/跳过：她真的说过的话（云端的不加，session 快照里已有）
        if (_cmRoot) {
          try {
            var _cmLog = join(_cmRoot, ".qqbot", "local-answer-log.jsonl")
            if (existsSync(_cmLog)) {
              var _cmRows = readFileSync(_cmLog, "utf8").split(_cmEol)
              var _cmFrom = Math.max(0, _cmRows.length - 400)
              for (var _cmR = _cmFrom; _cmR < _cmRows.length; _cmR++) {
                var _cmLine = String(_cmRows[_cmR] || "").trim()
                if (!_cmLine) continue
                var _cmO = null
                try { _cmO = JSON.parse(_cmLine) } catch (_e1) { continue }
                if (!_cmO || !_cmO.reply) continue
                var _cmSc = String(_cmO.scope || "")
                if (_cmSc && _cmSc !== _cmWant && _cmSc.indexOf(peerId) < 0) continue
                var _cmT = Number(_cmO.ts) || 0
                var _cmK = String(_cmT) + "|" + String(_cmO.reply).slice(0, 24)
                if (_cmSeen[_cmK]) continue
                _cmSeen[_cmK] = 1
                items.push({ seq: 0, time: _cmT, dir: "out", sender: "", text: String(_cmO.reply), images: [], tag: "", by: String(_cmO.by || "local"), ms: Number(_cmO.ms) || 0, model: String(_cmO.model || "") })
              }
            }
          } catch (_e2) { /* 日志读不到不影响主流程 */ }
        }
        // 2) 同一个 peer 的其它会话（换过会话时，旧会话里的话也要能看见）
        try {
          var _cmCands = (typeof reg.listPeerRecordsWeb === "function") ? (reg.listPeerRecordsWeb(scope, peerId) || []) : []
          for (var _cmC = 0; _cmC < _cmCands.length; _cmC++) {
            var _cmRec = _cmCands[_cmC]
            if (!_cmRec || _cmRec === rec) continue
            if (rec && String(_cmRec.sessionId || "") === String(rec.sessionId || "")) continue
            var _cmEvs = null // [_cmAg] chat-merge2
            try {
              var _cmAg = _cmRec.agent
              var _cmS2 = _cmAg && (_cmAg.session || (_cmAg.ctx && _cmAg.ctx.session))
              if (_cmS2 && Array.isArray(_cmS2.events)) _cmEvs = _cmS2.events
            } catch (_e3) { _cmEvs = null }
            if (!_cmEvs) continue
            _cmEvs = _cmEvs.slice(Math.max(0, _cmEvs.length - 40))
            for (var _cmX = _cmEvs.length - 1; _cmX >= 0; _cmX--) {
              var _cmGot = null
              try { _cmGot = chatDecodeEvent(_cmEvs[_cmX], scope, nameByMid, fallbackSender) } catch (_e4) { _cmGot = null }
              if (!_cmGot) continue
              var _cmArr = Array.isArray(_cmGot) ? _cmGot : [_cmGot]
              for (var _cmY = 0; _cmY < _cmArr.length; _cmY++) {
                var _cmOne = _cmArr[_cmY]
                if (!_cmOne) continue
                var _cmT2 = Number(_cmOne.time) || 0
                var _cmK2 = String(_cmT2) + "|" + String(_cmOne.text || "").slice(0, 24)
                if (_cmSeen[_cmK2]) continue
                _cmSeen[_cmK2] = 1
                items.push(_cmOne)
              }
            }
          }
        } catch (_e5) { /* 其它会话读不到就算了 */ }
        items.sort(function (a, b) { return (Number(a.time) || 0) - (Number(b.time) || 0) })
        while (items.length > limit) items.shift()
        diag.merged = items.length
        try { diag.byCount = items.filter(function (x) { return !!x.by }).length } catch (_e6) { /* ignore */ }
      } catch (_e7) {
        try { diag.mergeErr = String((_e7 && _e7.message) || _e7) } catch (_e8) { /* ignore */ }
      }
      // [qqbot-mod] chat-inbound-log：并入插件自己的入站台账（跨会话、跨重启都在），补「聊天页看不到消息」的缺口
      try {
        const _mb = (function () { try { return join(resolveMemoryRoot(bot), '.qqbot', 'msg-content.jsonl'); } catch (_e) { return ''; } })();
        if (_mb && existsSync(_mb)) {
          const _want = String(scope) + ':' + String(peerId);
          const _stripInj = (s) => {
            let t = String(s || '');
            for (const tag of ['记忆', '设定']) {
              const open = '[' + tag + ']';
              const close = '[/' + tag + ']';
              let guard = 0;
              while (t.indexOf(open) >= 0 && guard < 6) {
                const a = t.indexOf(open);
                const b = t.indexOf(close, a);
                if (b < 0) { t = t.slice(0, a); break; }
                t = t.slice(0, a) + t.slice(b + close.length);
                guard += 1;
              }
            }
            const cut = t.indexOf('[别重复]');
            if (cut >= 0) {
              const nl = t.indexOf(String.fromCharCode(10), cut);
              t = t.slice(0, cut) + (nl >= 0 ? t.slice(nl) : '');
            }
            t = t.replace(/\n?\[(印象|旧识)\][^\n]*/g, '');
            return t.trim();
          };
          const _rows = readFileSync(_mb, 'utf8').split(String.fromCharCode(10)).filter(Boolean).slice(-4000);
          const _in = [];
          for (const line of _rows) {
            let o = null;
            try { o = JSON.parse(line); } catch { continue; }
            if (!o || String(o.p || '') !== _want) continue;
            const text = _stripInj(o.t);
            const imgs = Array.isArray(o.imgs) ? o.imgs.filter(Boolean) : [];
            if (!text && !imgs.length) continue;
            _in.push({
              seq: 0,
              time: Number(o.at) || 0,
              dir: 'in',
              sender: String(o.n || o.s || '群友'),
              text,
              images: imgs.map((x) => ({ url: String(x), kind: 'image' })),
              tag: '',
            });
          }
          if (_in.length) {
            const _seen = new Set();
            const _merged = [];
            for (const it of [...items, ..._in]) {
              const key = String(it.time) + '|' + String(it.dir) + '|' + String(it.text || '').slice(0, 40);
              if (_seen.has(key)) continue;
              _seen.add(key);
              _merged.push(it);
            }
            _merged.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
            items = _merged.slice(-limit);
            if (diag && typeof diag === 'object') diag.inboundLog = _in.length;
          }
        }
      } catch { /* 台账读失败不影响主路径 */ }
      // [qqbot-mod] chat-log-source：补上 msg-history 里的最新消息（按 秒+方向+前24字 去重）
      try { items = mergeChatLog(items, _chatLogOf(), limit) } catch (eM) {}
      writeJson(res, 200, { ok: true, items, hasMore: !reachedEnd, tailSeq: sess.seq, debug: diag });

    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 面板富媒体发送: dock 聊天输入框 bbcode [MEDIA:kind|src] → 以机器人身份向群/私聊发富媒体。
  // src = http(s) 网络图/文件, 或本机绝对路径(D:\xxx\a.jpg)。复用 agentCtx 的
  // qqChannel.sender.sendMedia(与通道 send_media 工具同一咽喉, 含表情包闸门/撤回记账)。
  let hostBgSeq = 0; // dock 面板大文件后台任务序号(与通道工具后台任务同款语义)
  route(ctx, 'POST', '/api/qqbot-settings/chat/media', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const scope = String(body.scope || '');
    const peerId = String(body.peerId || '').trim();
    const kind = String(body.kind || '');
    const url = String(body.url || '').trim();
    const localPath = String(body.localPath || '').trim();
    if (scope !== 'group' && scope !== 'c2c') return writeJson(res, 400, { error: 'scope 必须为 group|c2c' });
    if (!peerId) return writeJson(res, 400, { error: 'peerId 必填' });
    if (!['image', 'video', 'voice', 'file'].includes(kind)) return writeJson(res, 400, { error: 'kind 必须为 image|video|voice|file' });
    const isUrl = /^https?:\/\//i.test(url);
    if (!isUrl && !localPath) return writeJson(res, 400, { error: 'url(http 链接) 或 localPath(本机路径) 至少给一个' });
    if (localPath) {
      // 本机直读: 面板和宿主同机, 文件存在才发(防手误/路径注入)
      try {
        const st = statSync(localPath);
        if (!st.isFile()) return writeJson(res, 200, { ok: false, msg: '本地文件不存在或不是文件: ' + localPath });
        if (st.size <= 0) return writeJson(res, 200, { ok: false, msg: '本地文件为空(0 字节)' });
      } catch {
        return writeJson(res, 200, { ok: false, msg: '读不到本地文件: ' + localPath + '(确认路径存在)' });
      }
    }
    const ns = String(body.ns || 'im-qqbot').trim();
    const kindLbl = kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'voice' ? '语音' : '文件';
    try {
      const reg = await import('./dist/features/session-registry.js');
      const rec = typeof reg.findRecordByPeerWeb === 'function' ? reg.findRecordByPeerWeb(ns, scope, peerId) : undefined;
      if (!rec || !rec.agent) return writeJson(res, 200, { ok: false, msg: '该目标暂无活跃会话(让机器人先聊过几句)' });
      const aCtx = rec.agent && (rec.agent.ctx || (rec.agent).agentCtx);
      const ch = aCtx && typeof aCtx.get === 'function' ? aCtx.get('qqChannel') : undefined;
      const sm = ch && ch.sender && typeof ch.sender.sendMedia === 'function' ? ch.sender : undefined;
      if (!sm) return writeJson(res, 200, { ok: false, msg: '机器人通道未就绪(给该目标发条消息后再试)' });
      const srcDesc = localPath ? localPath : url.slice(0, 120);
      // 本地大文件(≥5MB): 后台异步发送(分片耗时), 立即返回; 完成/失败往会话写 [系统] 后台任务通知(dock 可见+来源标)
      let localSize = 0;
      if (localPath) { try { localSize = statSync(localPath).size; } catch { localSize = 0; } }
      const FILE_ASYNC_MIN = 5 * 1024 * 1024;
      if (localPath && localSize >= FILE_ASYNC_MIN) {
        const seq = ++hostBgSeq;
        const fname = localPath.split(/[\\/]/).pop() || 'file';
        const fnameClean = String(fname).split('?')[0];
        const doSend = () => sm.sendMedia({ scope, targetId: peerId }, kind, { localPath });
        void (async () => {
          let okNote = '成功';
          try {
            await doSend();
            if (body.insertContext === true) {
              try {
                const relayText = String(body.relayText || '').slice(0, 500) || localPath;
                await appendUserRelayToPeer(ns, scope, peerId, '[MEDIA:' + kindLbl + '|' + relayText + ']');
              } catch { /* 上下文写入失败不影响发送结果提示 */ }
            }
          } catch (e) {
            okNote = '失败: ' + String((e && e.message) || e).slice(0, 120);
            const bot2 = nsBot(ns || undefined);
            if (bot2 && bot2.cwd) audit(bot2.cwd, { ev: 'chat.media.bg', ns, scope, peerId, kind, src: srcDesc, ok: false, error: okNote });
          }
          await appendNoticeToPeer(ns, scope, peerId, '[系统] 后台任务 #' + seq + ' ' + (okNote === '成功' ? ('完成: 已发送 ' + fnameClean + '(' + Math.round(localSize / 1048576 * 10) / 10 + 'MB)。') : ('失败: ' + okNote)));
        })();
        const bot0 = nsBot(ns || undefined);
        if (bot0 && bot0.cwd) audit(bot0.cwd, { ev: 'chat.media.bg-start', ns, scope, peerId, kind, src: srcDesc, size: localSize });
        return writeJson(res, 200, { ok: true, msg: '📤 大文件已提交后台任务 #' + seq + '(' + Math.round(localSize / 1048576 * 10) / 10 + 'MB), 分片上传中… 完成后会有通知', id: undefined });
      }
      const r = await sm.sendMedia({ scope, targetId: peerId }, kind, localPath ? { localPath } : { url });
      const bot = nsBot(ns || undefined);
      if (bot && bot.cwd) audit(bot.cwd, { ev: 'chat.media', ns, scope, peerId, kind, src: srcDesc, ok: true });
      // 与文本发送一致: insertContext=true → 往该会话写「用户代你发送: …」模拟消息(web 流/dock 可见, 不唤醒不开回合)
      // 文本用 [MEDIA:类型|来源] 结构化 → dock 能渲染本地上传图, bot 上下文也知道发了哪个来源
      let ctxNote = '';
      if (body.insertContext === true) {
        const relayText = String(body.relayText || '').slice(0, 500);
        const inner = relayText || srcDesc || kindLbl;
        const why = await appendUserRelayToPeer(ns, scope, peerId, '[MEDIA:' + kindLbl + '|' + inner + ']').catch(() => 'failed');
        if (why) { if (bot && bot.cwd) audit(bot.cwd, { ev: 'chat.media.relay-skip', ns, reason: why }); ctxNote = ' (' + (WHY_MAP[why] || why) + ')'; }
        else ctxNote = ' (已记入上下文)';
      }
      writeJson(res, 200, { ok: true, msg: '已发送' + kindLbl + ' ✓' + ctxNote, id: r && r.id });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const bot = nsBot(ns || undefined);
      if (bot && bot.cwd) audit(bot.cwd, { ev: 'chat.media', ns, scope, peerId, kind, src: localPath || url.slice(0, 120), ok: false, error: msg });
      writeJson(res, 200, { ok: false, msg: '发送失败: ' + msg });
    }
  });

  // 面板文件选择器后端(小文件 base64 版): dock 旧客户端/小文件用, 落 dock-uploads。
  route(ctx, 'POST', '/api/qqbot-settings/chat/upload', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const bot = nsBot(String(body.ns || '').trim() || undefined);
    if (!bot || !bot.cwd) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
    const data = String(body.data || '');
    const m = data.match(/^data:([^;]+);base64,(.*)$/s) || data.match(/^base64:(.*)$/s);
    const b64 = m ? (m[2] || '') : data;
    if (!b64) return writeJson(res, 400, { error: 'data(base64) 必填' });
    let ext = String(body.ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!ext) ext = 'bin';
    if (ext.length > 6) return writeJson(res, 400, { error: '扩展名不合法' });
    try {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length <= 0) return writeJson(res, 200, { ok: false, msg: '空文件' });
      const dir = join(bot.cwd, '.qqbot', 'dock-uploads');
      mkdirSync(dir, { recursive: true });
      const name = 'up' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + ext;
      const target = join(dir, name);
      writeFileSync(target, buf);
      writeJson(res, 200, { ok: true, path: target });
    } catch (e) {
      writeJson(res, 500, { error: String((e && e.message) || e) });
    }
  });

  // 面板文件选择器后端(大文件流式版): dock 📎 选中的任意大小文件直接以 octet-stream body 上传,
  // 流式写盘(不占内存上限 readJsonBody 的 8MB), 落 cwd/.qqbot/dock-uploads → client 插 [MEDIA:kind|path]。
  // 参数走 query: ns(账号实例), ext(扩展名); body = 原始文件字节。
  route(ctx, 'POST', '/api/qqbot-settings/chat/upload-raw', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const bot = nsBot(String(u.searchParams.get('ns') || '').trim() || undefined);
      if (!bot || !bot.cwd) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      let ext = String(u.searchParams.get('ext') || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6);
      if (!ext) ext = 'bin';
      const dir = join(bot.cwd, '.qqbot', 'dock-uploads');
      mkdirSync(dir, { recursive: true });
      const name = 'up' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + ext;
      const target = join(dir, name);
      const ws = createWriteStream(target);
      const MAX = 300 * 1024 * 1024;
      let size = 0;
      let failed = null;
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX) { failed = 'too large(>300MB)'; break; }
          if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
        }
      } catch (e) {
        failed = String((e && e.message) || e);
      }
      await new Promise((r) => ws.end(r));
      if (failed || size <= 0) {
        try { rmSync(target, { force: true }); } catch { /* 忽略 */ }
        return writeJson(res, failed ? 413 : 400, { error: failed || '空文件' });
      }
      writeJson(res, 200, { ok: true, path: target, size });
    } catch (e) {
      writeJson(res, 500, { error: String((e && e.message) || e) });
    }
  });

  // dock 本地图片直出(渲染用户代发/本地上传图): 读本机文件回 bytes。
  // 仅本机同源可访问(route fence); <img> 不能跨域读取内容, 只作图片预览用。
  route(ctx, 'GET', '/api/qqbot-settings/chat/raw-media', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const p = String(u.searchParams.get('p') || '').trim();
      if (!p) return writeJson(res, 400, { error: 'p 必填' });
      const st = statSync(p);
      if (!st.isFile()) return writeJson(res, 404, { error: 'file not found' });
      if (st.size > 200 * 1024 * 1024) return writeJson(res, 413, { error: 'too large(>200MB)' });
      const ext = extname(p).slice(1).toLowerCase();
      const AUDIO = { ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', silk: 'audio/silk', webm: 'audio/webm' };
      const VIDEO = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
      const type = MIME[ext] || AUDIO[ext] || VIDEO[ext] || 'application/octet-stream';
      // 支持 Range(视频/音频拖动播放需要): bytes=a-b
      let start = 0;
      let end = st.size - 1;
      let status = 200;
      const range = req.headers && req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(String(range));
        if (m) {
          const s1 = m[1] === '' ? undefined : parseInt(m[1], 10);
          const e1 = m[2] === '' ? undefined : parseInt(m[2], 10);
          if (s1 !== undefined && s1 < st.size) start = s1;
          if (e1 !== undefined && e1 < st.size) end = e1;
          if (end < start) end = Math.min(start + 1024 * 1024, st.size - 1);
          status = 206;
        }
      }
      const len = end - start + 1;
      const fd = openSync(p, 'r');
      const buf = Buffer.alloc(len);
      try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
      const headers = {
        'content-type': type,
        'content-length': len,
        'cache-control': 'no-store',
        'accept-ranges': 'bytes',
      };
      if (status === 206) headers['content-range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      res.writeHead(status, headers);
      res.end(buf);
    } catch (e) {
      writeJson(res, 404, { error: String((e && e.message) || e) });
    }
  });

  // ★ 本机新增(2026-10-25): 小游戏会话管理（浮窗「🎮 游戏」卡）。
  //   GET 列活跃对局（读 tools/data/game-sessions.json，同 game-lib 的懒过期语义）；
  //   POST action=kill 按 key 强制收摊 / action=clear 全收。
  async function gameLibOf(root) {
    const p = join(root, '.qqbot-extensions', 'tools', 'lib', 'game-lib.mjs');
    return import('file:///' + p.split(String.fromCharCode(92)).join('/'));
  }
  route(ctx, 'GET', '/api/qqbot-settings/games', async (req, res) => {
    try {
      const root = resolveMemoryRoot(nsBot(NSQ(new URL(req.url ?? '/', 'http://x'))));
      if (!root) return writeJson(res, 200, { ok: false, error: '没有数据根', sessions: [] });
      const lib = await gameLibOf(root);
      const sessions = lib.listSessions(root).map((s) => ({
        key: s.key, id: s.id, kind: s.kind, kindTitle: lib.gameTitle(s.kind),
        startedAt: s.startedAt, lastAt: s.lastAt, idleMin: s.idleMin,
      }));
      return writeJson(res, 200, { ok: true, root, sessions, kinds: lib.gameKinds().map((k) => ({ id: k, title: lib.gameTitle(k) })), idleMinutes: lib.IDLE_MINUTES });
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: String((e && e.message) || e), sessions: [] });
    }
  });
  route(ctx, 'POST', '/api/qqbot-settings/games', async (req, res) => {
    try {
      const root = resolveMemoryRoot(nsBot(NSQ(new URL(req.url ?? '/', 'http://x'))));
      if (!root) return writeJson(res, 200, { ok: false, error: '没有数据根' });
      const body = await readJsonBody(req).catch(() => ({}));
      const lib = await gameLibOf(root);
      const action = String(body.action || '');
      if (action === 'kill') {
        const key = String(body.key || '');
        if (!key) return writeJson(res, 200, { ok: false, error: '缺 key' });
        const gone = lib.killSession(root, key);
        return writeJson(res, 200, { ok: gone, error: gone ? '' : '对局不存在（可能已超时自动收摊）' });
      }
      if (action === 'clear') {
        const all = lib.listSessions(root);
        let n = 0;
        for (const s of all) { if (lib.killSession(root, s.key)) n += 1; }
        return writeJson(res, 200, { ok: true, msg: `收了 ${n} 局` });
      }
      return writeJson(res, 200, { ok: false, error: '未知动作：' + action });
    } catch (e) {
      return writeJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // dock QQ 语音播放: 下载 SILK → 纯 JS(silk-wasm + lamejs-fixed)转 mp3 → 返回(带磁盘缓存)。
  // 零系统依赖(不依赖 ffmpeg/外部工具), 通用插件可直接打包; 浏览器播放 mp3 兼容性最好。
  route(ctx, 'GET', '/api/qqbot-settings/chat/voice-play', async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const src = String(u.searchParams.get('u') || '').trim();
      if (!/^https?:\/\//i.test(src) || !QQ_MEDIA_RE.test(src)) return writeJson(res, 400, { error: 'u 必须为 QQ 媒体 URL' });
      const bot = nsBot(undefined);
      const cacheDir = join((bot && bot.cwd) || homedir(), '.qqbot', 'voice-cache');
      mkdirSync(cacheDir, { recursive: true });
      const key = createHash('sha256').update(src).digest('hex');
      const cf = join(cacheDir, key + '.mp3');
      if (!existsSync(cf)) {
        const resp = await fetch(src, { headers: { 'user-agent': 'Mozilla/5.0' } });
        if (!resp.ok) return writeJson(res, 502, { error: '语音下载失败(HTTP ' + resp.status + ')' });
        const buf = Buffer.from(await resp.arrayBuffer());
        const mod = await import('./voice-convert.mjs');
        if (!mod.isSilk(buf)) return writeJson(res, 415, { error: '该语音非 SILK 格式(QQ 语音均为 SILK)' });
        const { mp3 } = await mod.silkToMp3(buf);
        try { writeFileSync(cf, mp3); } catch { /* 缓存失败不影响播放 */ }
      }
      const mp3 = readFileSync(cf);
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': mp3.length, 'cache-control': 'public, max-age=86400' });
      res.end(mp3);
    } catch (e) {
      writeJson(res, 500, { error: String((e && e.message) || e) });
    }
  });

const WHY_MAP = { busy: '目标会话回合活跃,已等待至回合结束仍超时(跳过注入)', 'no-session': '未找到该群/私聊的活跃会话', 'no-msg': '构造消息失败', failed: '写入失败' };

  // 安全闸(兜底用): 目标会话 LLM 回合活跃(turn/start 已开、turn/end 未闭合——覆盖思考中/流式输出/工具执行)
  // 时禁止外部往该会话插入任何消息(含模拟用户消息), 防止把正在生成的回合流搞乱(曾因此写坏会话)。
  // 与 QQ 插件入站逻辑(debounce.ts 的 turnActive 排队)一致: 活跃时【等待回合结束】再插入, 而非跳过。
  // ⚠️ 只作 waitTurnIdle 的兜底轮询: 它回看最近 3000 条事件找 turn/start..turn/end(曾用 400 太小,
  // 长回合流式/tool 事件一多就漏判"空闲"导致插进 tool_calls↔tool_result 中间, INVALID_REQUEST)。
  // 查不到则放行(append 自身有 reenter 兜底)。
  function sessionTurnActive(sess) {
    try {
      const seq = typeof sess?.seq === 'number' ? sess.seq : -1;
      if (seq <= 0 || typeof sess.snapshotEvents !== 'function') return false;
      const tail = sess.snapshotEvents(Math.max(0, seq - 3000), seq);
      let lastStart = -1;
      let lastEnd = -1;
      for (const ev of tail) {
        if (ev.type === 'turn/start') lastStart = ev.seq;
        else if (ev.type === 'turn/end') lastEnd = ev.seq;
      }
      return lastStart > lastEnd;
    } catch { return false; }
  }

  /**
   * 等目标会话 LLM 回合结束再返回。
   * 主路径: 宿主 agent.whenIdle()(权威: 空闲立即返回、回合活跃时等 turn/end —— 与入群通知
   * safeAppendUserMessage 同款)。⚠️ 不能先用 sessionTurnActive 当第一判断: 它只回看 400 条事件,
   * 长回合(流式/tool 事件多)时窗口内查不到 turn/start 会误判"空闲", 正是历史事故的漏网点。
   * 超时(60s, 防 turn/end 丢失卡死)或宿主无 whenIdle → 回落 800ms 轮询, 仍超时返回 false。
   */
  const TURN_WAIT_MS = 60_000;
  async function waitTurnIdle(agent, sess) {
    // ① 权威: whenIdle —— 回合空闲立即 resolve; 活跃时等 turn/end 后再 resolve
    if (agent && typeof agent.whenIdle === 'function') {
      let idle = false;
      try {
        await Promise.race([
          agent.whenIdle().then(() => { idle = true; }),
          new Promise((r) => setTimeout(r, TURN_WAIT_MS)),
        ]);
      } catch { /* whenIdle 异常按未空闲处理 */ }
      if (idle) return true;
    }
    // ② 兜底轮询: 与 QQ 入站 debounce 排队同款(800ms 重查, 等 turn/end), 超 60s 放弃
    if (sess && typeof sess.snapshotEvents === 'function') {
      const t0 = Date.now();
      for (;;) {
        if (!sessionTurnActive(sess)) return true;
        if (Date.now() - t0 >= TURN_WAIT_MS) return false;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    return true; // 无检测能力 → 放行(append 自身有 reenter 兜底)
  }

  // ── 线B(用户代发/后台通知 → 插入上下文)异步队列(2026-09-09) ──
  // 与 QQ 入站 debounce 排队同款语义: **先收下消息立即返回, 不阻塞任何 HTTP 请求/事件**,
  // 回合活跃时攒在 per-peer 队列里, 回合结束后(whenIdle/turnActive=false)再逐条 append。
  // 避免把 dock 发送请求挂在 waitTurnIdle 上 60s+(曾导致"第二条消息发不出去")。
  //
  // 性能护栏:
  //  - 队列按 peer 分 key, 单 peer 上限 RELAY_QUEUE_MAX(超限丢最老), 防止内存无限膨胀;
  //  - 队列空即删 key(不残留); drain 有 in-flight 去重, 同 key 不并发重复消费;
  //  - 等待靠 whenIdle 事件驱动(回合结束才 resolve, 不空转); 兜底 800ms 轮询只在无 whenIdle 时用;
  //  - waitTurnIdle 自身 60s 超时防 turn/end 丢失卡死, 超时该条放弃(不硬塞坏记录)。
  const RELAY_QUEUE_MAX = 200;
  const relayQueues = new Map(); // key = ns|scope|peerId → [{ ns, scope, peerId, kind:'relay'|'notice', text }]
  const relayDraining = new Set(); // 正在 drain 的 key(防同 key 并发重复消费)

  function relayQueueKey(ns, scope, peerId) { return ns + '|' + scope + '|' + peerId; }

  /** 入队一条待写上下文的消息(立即返回; 后台 drain 回合结束后落盘) */
  function enqueueRelayWrite(ns, scope, peerId, kind, text) {
    const key = relayQueueKey(ns, scope, peerId);
    let q = relayQueues.get(key);
    if (!q) { q = []; relayQueues.set(key, q); }
    if (q.length >= RELAY_QUEUE_MAX) q.shift(); // 防内存膨胀: 超限丢最老
    q.push({ ns, scope, peerId, kind, text });
    void drainRelayQueue(key);
  }

  /** 后台串行消费某 peer 的待写队列。
   *  - 单条 busy(回合卡死/超时): 保留队列并 break, 等下次入队再触发 drain 重试 —— 防整个队列
   *    逐条各等 60s 超时空挂; 回合只是暂时活跃(正常结束)时下条入队即重试成功。
   *  - 单条 fail(no-session / no-msg / append 异常): 丢弃该条, 继续下一条。 */
  async function drainRelayQueue(key) {
    if (relayDraining.has(key)) return;
    relayDraining.add(key);
    try {
      for (;;) {
        const q = relayQueues.get(key);
        const item = q && q[0];
        if (!item) { relayQueues.delete(key); break; } // 队列空 → 删 key, 不残留
        let st = 'fail';
        try {
          st = await appendOneRelayItem(item);
        } catch { st = 'fail'; }
        if (st === 'busy') break; // 回合长时间卡死: 保留剩余队列, 下条入队再重试(不空挂)
        q.shift();
        if (st === 'fail') {
          // 写失败(no-session / no-msg / append 异常): 不阻塞队列, 丢弃并继续
          try {
            const { bots } = parsePatch();
            const bot = bots.find((b) => b.id === item.ns);
            if (bot && bot.cwd) audit(bot.cwd, { ev: 'relay.drain-skip', ns: item.ns, scope: item.scope, peerId: item.peerId, kind: item.kind, reason: 'drain-failed' });
          } catch { /* audit 失败不阻断 */ }
        }
      }
    } finally {
      relayDraining.delete(key);
    }
  }

  /** 等回合结束 + 把单条消息 append 进会话(不唤醒、不开回合)。返回 'ok' | 'busy' | 'fail' */
  async function appendOneRelayItem({ ns, scope, peerId, kind, text }) {
    const reg = await import('./dist/features/session-registry.js');
    let rec = typeof reg.findRecordByPeerWeb === 'function' ? reg.findRecordByPeerWeb(ns, scope, peerId) : undefined;
    // 活跃表 miss(会话被 idle 回收/未建立)→ 与入群申请通知/定时任务同款: getOrCreate 恢复/重建会话(不开回合),
    // 保证 log 存在能 append(否则 findRecordByPeerWeb 永远 no-session, QQ 发出但 web 流无痕)。
    if (!rec && typeof reg.getOrCreateByPeerWeb === 'function') {
      try { rec = await reg.getOrCreateByPeerWeb(ns, scope, peerId, 'master'); } catch { /* 恢复失败按 no-session 走 */ }
    }
    if (!rec || !rec.agent) return 'fail';
    const agent = rec.agent;
    const sess = agent && (agent.session || (agent.ctx && agent.ctx.session));
    const appendFn = sess && typeof sess.append === 'function' ? sess.append.bind(sess) : undefined;
    if (!appendFn) return 'fail';
    // 🔒 等 LLM 回合结束(与 QQ 入站排队同款; 超时=busy 由 drain 保留重试)
    if (!(await waitTurnIdle(agent, sess))) return 'busy';
    if (kind === 'relay') {
      // 用户代发: 文本以「用户代你发送: 」开头(只进 web 流, QQ 收到干净原文); 主人下次真人消息
      // 开回合时该 user/message 作为历史被 deriveMessages 组装进上下文 → bot 自然看到"主人代我发了这句"。
      const llm = await import('@deepseek-ai/dsh-llm');
      const relayText = `用户代你发送: ${text}`;
      const msg = llm.createUserMessage
        ? llm.createUserMessage({ content: [{ type: 'text', text: relayText }], source: { kind: 'user' } })
        : undefined;
      if (!msg) return 'fail';
      // 与 agent-loop turn()/入群申请通知同款: user/message 的 data 就是消息体本身(不包 message 层)。
      appendFn('user/message', msg, { surfaceOp: 'append' });
    } else {
      // 后台任务结果通知(与通道工具 bgSend notifySession 同款形状: source kind user, 文本 [系统] 后台任务…)
      appendFn('user/message', {
        id: 'bg-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36),
        role: 'user',
        content: [{ type: 'text', text: String(text || '') }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' });
    }
    return 'ok';
  }

  // 线B 入口: 用户代发→插入上下文(入队即返回, 不阻塞请求)
  async function appendUserRelayToPeer(ns, scope, peerId, text) {
    enqueueRelayWrite(ns, scope, peerId, 'relay', text);
    return null; // 已入队; 实际写入由后台 drain 在回合结束后完成
  }

  // 后台任务结果通知写回会话(入队即返回, 不阻塞请求)
  async function appendNoticeToPeer(ns, scope, peerId, text) {
    enqueueRelayWrite(ns, scope, peerId, 'notice', text);
    return true;
  }

  // 入群申请红点汇总(悬浮球 dock 用): 遍历所有已配置实例, 返回各实例待审申请数(计数不上报明细)
  route(ctx, 'GET', '/api/qqbot-settings/group/join-summary', async (_req, res) => {
    try {
      const { bots } = parsePatch();
      const out = [];
      for (const bot of bots) {
        // ⚠️ 2026-09-28：凭据可能只在【自有存储】里（2026-09-24 起的保存策略），合并后再判断。
        bot.cfg = mergeOwnIntoCfg(bot.cfg || {}, bot.cfg?.settingsNs || bot.id);
        if (bot.disabled || !bot.cfg?.appId || !bot.cfg?.appSecret) continue;
        try {
          const ns = bot.id;
          const gc = await groupClientOf(ns);
          if (!gc) continue;
          const reg = readGroupsJson(bot.cwd);
          let pending = 0;
          for (const gid of Object.keys(reg)) {
            if (!gid) continue;
            try {
              const r = await gc.client.listJoinRequests(gid);
              if (r.ok && Array.isArray(r.data?.list)) pending += r.data.list.length;
            } catch { /* 单群失败不阻断 */ }
          }
          out.push({ ns, pending });
        } catch { /* 实例失败跳过 */ }
      }
      writeJson(res, 200, { ok: true, items: out });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // 绑定/登记群 {ns?, gid, name?}
  route(ctx, 'POST', '/api/qqbot-settings/group/bind', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const gid = String(body.gid || '').trim();
    if (!gid) return writeJson(res, 400, { error: 'gid 必填' });
    try {
      const bot = nsBot(String(body.ns || ''));
      if (!bot) return writeJson(res, 400, { error: '找不到该账号实例(请先在账号页配置 appId/appSecret)' });
      const reg = readGroupsJson(bot.cwd);
      reg[gid] = { name: String(body.name || '').trim(), lastAt: Date.now() };
      writeGroupsJson(bot.cwd, reg);
      audit(bot.cwd, { ev: 'group.bind', ns: bot.id, gid });
      writeJson(res, 200, { ok: true });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // ── 审批双通道: Web 浮层同源路由(读待办 / 点按钮结算) ──
  // 数据来自各实例 QqApprovalController(经 registerApprovalController 注册表),
  // 与 QQ 按钮卡片/文本码共用同一 pending —— 先到先得, 两端天然同步。
  route(ctx, 'GET', '/api/qqbot-settings/approval/pending', async (_req, res) => {
    try {
      const mod = await import('./dist/features/qq-approval.js');
      const list = typeof mod.listAllPendingWeb === 'function' ? mod.listAllPendingWeb() : [];
      writeJson(res, 200, { ok: true, pending: list });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });
  // {code, act:'allow'|'deny'}
  route(ctx, 'POST', '/api/qqbot-settings/approval/decide', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const code = String(body.code || '').toUpperCase();
    const act = String(body.act || '');
    if (!code || (act !== 'allow' && act !== 'deny')) return writeJson(res, 400, { error: 'code 与 act(allow|deny) 必填' });
    try {
      const mod = await import('./dist/features/qq-approval.js');
      const r = typeof mod.decideByWebAny === 'function' ? mod.decideByWebAny(code, act) : { ok: false, msg: '审批模块不可用' };
      writeJson(res, r.ok ? 200 : 404, r);
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // ── 提问双通道: Web 浮层同源路由(读待办问题 / 点选项结算) ──
  route(ctx, 'GET', '/api/qqbot-settings/questions/pending', async (_req, res) => {
    try {
      const mod = await import('./dist/features/qq-user-questions.js');
      const list = typeof mod.listAllPendingQuestionsWeb === 'function' ? mod.listAllPendingQuestionsWeb() : [];
      writeJson(res, 200, { ok: true, pending: list });
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });
  // {key, optIdx}
  route(ctx, 'POST', '/api/qqbot-settings/questions/decide', async (req, res) => {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
    const key = String(body.key || '');
    const optIdx = Number(body.optIdx);
    if (!key || !Number.isInteger(optIdx) || optIdx < 0) return writeJson(res, 400, { error: 'key 与 optIdx 必填' });
    try {
      const mod = await import('./dist/features/qq-user-questions.js');
      const r = typeof mod.decideQuestionByWebAny === 'function' ? mod.decideQuestionByWebAny(key, optIdx) : { ok: false, msg: '提问模块不可用' };
      writeJson(res, r.ok ? 200 : 404, r);
    } catch (e) { writeJson(res, 500, { error: String((e && e.message) || e) }); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 「QQ机器人扩展」面板数据源（2026-10-24 主人定）
  //
  // 两类扩展来源：
  //   ① 内置目录  {dataRoot}/.qqbot-extensions/{tools,commands,botplay,hooks,inbound,outbound}/
  //   ② 扩展包    {dataRoot}/extension-packs/{包名}/{同样六个子目录}/
  //      包名目录里可放 qqbot-pack.json：{ name, author, desc, version, homepage }
  //      没有清单也能用，只是面板里显示为「未命名扩展包」
  //
  // 为什么要扩展包：插件作者的扩展不该被迫塞进 .qqbot-extensions（那是用户自己的目录），
  // 放独立目录既能整包分发/更新，也能在面板里按作者分组显示。
  // ═══════════════════════════════════════════════════════════════════════════
  const EXT_KINDS = ['tools', 'commands', 'botplay', 'hooks', 'inbound', 'outbound'];

  /** 扫一个 kind 目录，返回文件清单（只扫根下直接子文件，与宿主扫描口径一致） */
  function scanExtKind(dir, dataRoot) {
    const out = [];
    let names = [];
    try { names = readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (!/\.(mjs|js|cjs)$/i.test(name)) continue;
      const full = join(dir, name);
      let st = null;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      // 读文件头，看有没有声明「设置页」（约定：文件里出现 qqbotSettingsPage 或 export const settingsPage）
      let hasSettings = false;
      let title = '';
      try {
        const head = readFileSync(full, 'utf8').slice(0, 4096);
        hasSettings = /qqbotSettingsPage|export\s+const\s+settingsPage/.test(head);
        const m = /qqbotSettingsPage[\s\S]{0,200}?title\s*:\s*['"]([^'"]+)['"]/.exec(head);
        if (m) title = m[1];
      } catch { /* 读不了就当没有 */ }
      out.push({
        __abs: full,   // 真实绝对路径，供 extensions 接口标 disabled
        name,
        id: name.replace(/\.(mjs|js|cjs)$/i, ''),
        size: st.size,
        mtime: st.mtimeMs,
        hasSettings,
        settingsTitle: title,
        disabled: false,   // 启停状态在 extensions 路由里统一补（scanExtKind 是顶层函数，拿不到闭包）
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * 把工作区路径归一成**绝对路径**（与 src/util/abs-path.ts 的 absCwdOf 同一套规则）。
   * 绝对路径原样返回，只给相对路径补前导 `/`。
   */
  function absCwd(p) {
    const raw = String(p == null ? '' : p).trim();
    if (!raw) return '';
    if (/^[A-Za-z]:[\\/]/.test(raw)) return raw;
    if (raw.startsWith('\\\\') || raw.startsWith('//')) return raw;
    if (raw.startsWith('/')) return raw;
    const s = raw.replace(/\\/g, '/');
    if (process.platform !== 'win32') return '/' + s;
    return raw;
  }

  /** 扫一个扩展根（含六个 kind 子目录），返回 { kinds:{tools:[...]}, total } */
  function scanExtRoot(root, dataRoot) {
    const kinds = {};
    let total = 0;
    for (const k of EXT_KINDS) {
      const list = scanExtKind(join(root, k));
      kinds[k] = list;
      total += list.length;
    }
    return { root, kinds, total };
  }

  /**
   * 某个工作区真实对应的 dataRoot（2026-10-24 补：尊重 bot 配置里的 dataRoot）
   *
   * 优先级（主人指出必须先看配置）：
   *   ① 该工作区 bot 显式配置的 cfg.dataRoot
   *   ② 该工作区 bot 配置的 cfg.cwd + 'dshqqbot'
   *   ③ 传入的 cwd + 'dshqqbot'
   *   ④ 首个未禁用 bot 的 dataRoot / cwd（= 老的 resolveContextlessDataRoot 行为）
   *
   * 返回 { dataRoot, source }，source 说明是哪一级命中的，便于面板上排查。
   */
  function resolveDataRootForWorkspace(cwdHint) {
    const hint = String(cwdHint || '').trim();
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    let bots = [];
    try { const parsed = parsePatch(); bots = (parsed && Array.isArray(parsed.bots)) ? parsed.bots : []; } catch { bots = []; }

    // ①/② 找「属于这个工作区」的 bot（先按 cwd 精确匹配）
    if (hint) {
      const target = norm(hint);
      for (const b of bots) {
        const cfg = (b && b.cfg) || {};
        const bcwd = norm(cfg.cwd);
        if (!bcwd || bcwd !== target) continue;
        if (cfg.dataRoot) return { dataRoot: String(cfg.dataRoot), source: 'bot.dataRoot' };
        return { dataRoot: join(absCwd(cfg.cwd) || String(cfg.cwd), 'dshqqbot'), source: 'bot.cwd' };
      }
    }

    // ③ 传入的 cwd（该工作区没绑 bot 时，扩展目录仍在它自己的 dshqqbot 下）
    if (hint) return { dataRoot: join(absCwd(hint) || hint, 'dshqqbot'), source: 'workspace' };

    // ④ 兜底：老的推断
    for (const b of bots) {
      const cfg = (b && b.cfg) || {};
      if (b && b.disabled) continue;
      if (cfg.dataRoot) return { dataRoot: String(cfg.dataRoot), source: 'default.bot' };
      if (cfg.cwd) return { dataRoot: join(String(cfg.cwd), 'dshqqbot'), source: 'default.bot' };
    }
    // [qqbot-mod] panel-v5 无 cwd 且 patch 里没配置时，仍优先 nsBot 的合并配置
    try {
      const b = nsBot('im-qqbot');
      if (b && b.cfg && b.cfg.dataRoot) return { dataRoot: String(b.cfg.dataRoot), source: 'bot.merged' };
    } catch { /* ignore */ }
    return { dataRoot: resolveContextlessDataRoot(), source: 'default' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 扩展自定义设置面板（2026-10-24）
  //
  // 契约：扩展文件里 export 一个 qqbotSettingsPage：
  //   export const qqbotSettingsPage = {
  //     title: '我的设置',
  //     schema: [
  //       { key: 'enabled', type: 'bool',   label: '启用' },
  //       { key: 'dirs',    type: 'list',   label: '目录列表' },
  //       { key: 'apiKey',  type: 'string', label: 'API Key', secret: true },
  //       { key: 'mode',    type: 'select', label: '模式', options: ['a','b'] },
  //     ],
  //   }
  //
  // 配置落盘：{dataRoot}/.qqbot-extensions/.state/ext-config/{扩展id}.json
  // 扩展自己在代码里可用 readExtConfig 的方式拿到（暂未内置 API，先读那个 json 即可）。
  // ═══════════════════════════════════════════════════════════════════════════

  /** 扩展配置文件路径 */
  function extConfigPath(dataRoot, extId) {
    const safe = String(extId || '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
    if (!safe) return '';
    return join(dataRoot, '.qqbot-extensions', '.state', 'ext-config', safe + '.json');
  }

  /** 读某个扩展的 qqbotSettingsPage 声明（动态 import 扩展文件，失败返回 null） */
  /**
   * 从扩展**源码**里解析 qqbotSettingsPage（2026-10-24，绕开宿主里 import 拿不到导出的问题）
   *
   * 为什么不 import：
   *   同一个 file:// URL 在 Node CLI 里 import 能拿到导出，但在 dsh 宿主进程里
   *   （插件模块内部再 await import 另一个 .mjs）拿不到 —— 机制不明，实测踩到。
   *   而 qqbotSettingsPage 只是个纯数据对象 { title, desc, schema:[...] }，
   *   完全没必要执行整个模块；直接抠源码更稳，也顺带避免执行第三方代码。
   *
   * 做法：定位 "export const qqbotSettingsPage = {" 然后做**括号配对**截取对象字面量，
   *       再用 new Function 求值（只执行这个字面量，不跑模块其余部分）。
   *       求值失败一律返回 null，绝不抛。
   */
  function parseSettingsPageFromSource(absFile) {
    let src = '';
    try { src = readFileSync(absFile, 'utf8'); } catch { return null; }

    // 找起点的几种写法：export const / const + 后续 export
    const patterns = [
      /export\s+(?:const|let|var)\s+qqbotSettingsPage\s*=\s*/,
      /(?:const|let|var)\s+qqbotSettingsPage\s*=\s*/,
    ];
    let start = -1;
    for (const re of patterns) {
      const m = re.exec(src);
      if (m) { start = m.index + m[0].length; break; }
    }
    if (start < 0) return null;
    if (src[start] !== '{') return null;

    // 括号配对（跳过字符串/模板/注释里的括号）
    let depth = 0;
    let i = start;
    let inStr = '';
    let inLineComment = false;
    let inBlockComment = false;
    let end = -1;
    while (i < src.length) {
      const ch = src[i];
      const nxt = src[i + 1];

      if (inLineComment) { if (ch === '\n') inLineComment = false; i++; continue; }
      if (inBlockComment) { if (ch === '*' && nxt === '/') { inBlockComment = false; i += 2; continue; } i++; continue; }
      if (inStr) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === inStr) inStr = '';
        i++; continue;
      }
      if (ch === '/' && nxt === '/') { inLineComment = true; i += 2; continue; }
      if (ch === '/' && nxt === '*') { inBlockComment = true; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
      i++;
    }
    if (end < 0) return null;

    const literal = src.slice(start, end);
    let page = null;
    try {
      // 只求值这个对象字面量；扩展本来就允许执行任意代码（handler），这里不引入新风险
      page = new Function('return (' + literal + ')')();
    } catch {
      return null;
    }
    if (!page || typeof page !== 'object') return null;
    return {
      title: String(page.title || ''),
      desc: String(page.desc || ''),
      schema: Array.isArray(page.schema) ? page.schema : [],
      _src: true,
    };
  }

  async function readExtSettingsPage(absFile) {
    // 诊断落盘（宿主进程里 import 扩展拿不到导出时用）
    const diag = (msg) => {
      try {
        const p = join(process.env.USERPROFILE || process.env.HOME || homedir(), 'qqbot-extpanel-diag.log');
        appendFileSync(p, new Date().toISOString() + ' ' + msg + '\n');
      } catch { /* ignore */ }
    };
    // ① 先走源码解析（最稳，不依赖宿主 import 行为）
    try {
      const parsed = parseSettingsPageFromSource(absFile);
      diag('source-parse ' + (parsed ? ('ok schemaLen=' + parsed.schema.length) : 'miss'));
      if (parsed && parsed.schema.length > 0) return parsed;
    } catch (e) {
      diag('source-parse ERROR ' + String((e && e.message) || e));
    }

    // ② 源码里没有 schema，再退回执行模块
    try {
      const url = pathToFileURL(absFile).href + '?v=' + Date.now();
      diag('import start abs=' + absFile + ' url=' + url.slice(0, 160));
      const mod = await import(url);
      const keys = mod && typeof mod === 'object' ? Object.keys(mod) : [];
      diag('import ok keys=[' + keys.join(',') + '] typeofDefault=' + typeof (mod && mod.default));
      const page = mod && (mod.qqbotSettingsPage || (mod.default && mod.default.qqbotSettingsPage));
      diag('page=' + (page ? ('object schemaLen=' + (Array.isArray(page.schema) ? page.schema.length : 'notArray')) : String(page)));
      if (!page || typeof page !== 'object') {
        // 文件里没有 qqbotSettingsPage：把实际导出键回传，前端能直接看出问题
        const keys = mod && typeof mod === 'object' ? Object.keys(mod) : [];
        return { title: '', desc: '', schema: [], _miss: true, _keys: keys };
      }
      return {
        title: String(page.title || ''),
        desc: String(page.desc || ''),
        schema: Array.isArray(page.schema) ? page.schema : [],
      };
    } catch (e) {
      diag('import ERROR: ' + String((e && e.stack) || e).slice(0, 500));
      return { title: '', desc: '', schema: [], _err: String((e && e.message) || e) };
    }
  }

  /**
   * GET /api/qqbot-settings/ext-panel?kind=&file=&cwd=
   *   读某个扩展的设置声明 + 当前值
   * POST /api/qqbot-settings/ext-panel
   *   body: { kind, file, cwd, values }
   *   写回配置
   */
  /**
   * 在「内置目录 + 所有扩展包」里找某个扩展文件（2026-10-24 修）
   *
   * 原实现只 join(dataRoot, '.qqbot-extensions', kind, file) —— 扩展包里的扩展根本找不到，
   * 面板点开会显示「没有声明配置项」（主人实测发现）。
   */
  function findExtFileInAnyRoot(dataRoot, kind, file) {
    const name = basename(String(file || ''));
    if (!name) return '';
    const roots = [join(dataRoot, '.qqbot-extensions', kind)];
    const packsRoot = join(dataRoot, 'extension-packs');
    let packs = [];
    try { packs = readdirSync(packsRoot); } catch { packs = []; }
    for (const p of packs) {
      const d = join(packsRoot, p, kind);
      try { if (statSync(d).isDirectory()) roots.push(d); } catch { /* 没这个 kind */ }
    }
    for (const dir of roots) {
      const abs = join(dir, name);
      try { if (statSync(abs).isFile()) return abs; } catch { /* 继续找 */ }
    }
    return '';
  }

  /**
   * 递归查找（兜底）：有些扩展可能放在更深层（如 tools/lib/ 下的辅助模块）
   */
  function findExtFileDeep(dataRoot, kind, file) {
    const name = basename(String(file || ''));
    if (!name) return '';
    const bases = [join(dataRoot, '.qqbot-extensions', kind), join(dataRoot, 'extension-packs')];
    function walk(dir, depth) {
      if (depth > 4) return '';
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isFile() && e.name === name) return full;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const r = walk(join(dir, e.name), depth + 1);
        if (r) return r;
      }
      return '';
    }
    for (const b of bases) {
      const r = walk(b, 0);
      if (r) return r;
    }
    return '';
  }

  route(ctx, ['GET', 'POST'], '/api/qqbot-settings/ext-panel', async (req, res) => {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      let kind = '';
      let file = '';
      let cwdParam = '';
      let values = null;

      if (req.method === 'GET') {
        kind = String(q.get('kind') || '').trim();
        file = String(q.get('file') || '').trim();
        cwdParam = String(q.get('cwd') || '').trim();
      } else {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
        kind = String(body.kind || '').trim();
        file = String(body.file || '').trim();
        cwdParam = String(body.cwd || '').trim();
        values = body.values && typeof body.values === 'object' ? body.values : {};
      }

      if (!kind || !file) return writeJson(res, 400, { error: 'kind 与 file 必填' });

      // 定位文件（只允许 EXT_KINDS 内的六类，防路径逃逸）
      const { dataRoot } = resolveDataRootForWorkspace(cwdParam);
      if (!dataRoot) return writeJson(res, 500, { error: '推不出 dataRoot' });
      // 内置目录 + 所有扩展包里找（扩展包的扩展不在 .qqbot-extensions 下）
      let abs = findExtFileInAnyRoot(dataRoot, kind, file);
      if (!abs) abs = findExtFileDeep(dataRoot, kind, file);
      if (!abs) {
        return writeJson(res, 404, { error: '扩展文件不存在：' + file + '（已在内置目录与 extension-packs 下查找）' });
      }

      const extId = String(file).replace(/\.(mjs|js|cjs)$/i, '');

      if (req.method === 'GET') {
        const page = await readExtSettingsPage(abs);
        // 当前值
        let current = {};
        const cfgPath = extConfigPath(dataRoot, extId);
        try { if (cfgPath && existsSync(cfgPath)) current = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { current = {}; }
        return writeJson(res, 200, {
          ok: true,
          extId,
          foundAt: abs,
          file: abs,
          page: page || { title: '', desc: '', schema: [] },
          values: current,
          configPath: cfgPath,
        });
      }

      // POST：写回
      const cfgPath = extConfigPath(dataRoot, extId);
      if (!cfgPath) return writeJson(res, 400, { error: 'extId 不合法' });
      try {
        mkdirSync(dirname(cfgPath), { recursive: true });
        writeFileSync(cfgPath, JSON.stringify(values, null, 2), 'utf8');
      } catch (e) {
        return writeJson(res, 500, { error: '写入失败: ' + String((e && e.message) || e) });
      }
      return writeJson(res, 200, { ok: true, configPath: cfgPath });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  /**
   * 工作区转义目录名 → 真实路径（与扩展 commands/会话列表.mjs 的 wsPath 同款规则）
   *   --D-newwenjianjia-aiwork-~9CB8~9C7C~5A18--  ⇒  D:\newwenjianjia\aiwork\鲸鱼娘
   *   '-' = 分隔符；'~XXXX' = 一个 UTF-16 码元；首段单字母 = 盘符
   */
  /**
   * `~/.dsh/sessions/{转义目录名}` → 工作区真实路径。
   *
   * 2026-10-24 修 issue #19：这里原来自己写了一遍解码（和 decodeSessionDirName 重复），
   * 而且有三个叠加缺陷：
   *   ① `segs.join(String.fromCharCode(92, 92))` —— 拼出了**两个**反斜杠字符；
   *   ② 分隔符写死反斜杠，POSIX 上直接坏；
   *   ③ 目录名转义时根部的 `/` 就丢了，还原后也没补。
   * 结果 Android/Linux 上还原成 `storage\\emulated\\0\\大肥鱼` —— 相对路径，
   * 扩展面板拿它去 readdirSync 必然落空，三块计数全 0。
   *
   * 现在直接复用 decodeSessionDirName（那边已经按盘符/POSIX 分支处理过）。
   */
  function wsPathFromDir(dir) {
    return decodeSessionDirName(String(dir || ''));
  }

  /**
   * 用 sessionId 反查它属于哪个工作区（DSH 把会话存在 ~/.dsh/sessions/{工作区转义}/{会话id}/）
   * 返回工作区真实路径；找不到返回 ''。
   */
  function resolveWorkspaceBySid(sid) {
    const id = String(sid || '').trim();
    if (!id) return '';
    const home = process.env.USERPROFILE || process.env.HOME || homedir();
    const root = join(home, '.dsh', 'sessions');
    let wsDirs = [];
    try { wsDirs = readdirSync(root); } catch { return ''; }
    // 会话目录名可能是纯 uuid，也可能带 'session-' 前缀，两种都认
    const candidates = [id, 'session-' + id];
    for (const ws of wsDirs) {
      if (!ws.startsWith('--')) continue;
      const wsDir = join(root, ws);
      let subs = [];
      try { subs = readdirSync(wsDir); } catch { continue; }
      for (const sub of subs) {
        if (candidates.includes(sub)) return wsPathFromDir(ws);
      }
    }
    return '';
  }

  /**
   * 扩展启停开关（2026-10-24）
   * POST /api/qqbot-settings/ext-toggle
   *   body: { cwd?, kind, file, enabled }
   *   写 {dataRoot}/.qqbot-extensions/.state/ext-disabled.json
   */
  route(ctx, 'POST', '/api/qqbot-settings/ext-toggle', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'bad body' });
      const kind = String(body.kind || '').trim();
      const file = String(body.file || '').trim();
      const enabled = body.enabled !== false;
      const cwdParam = String(body.cwd || '').trim();
      if (!kind || !file) return writeJson(res, 400, { error: 'kind 与 file 必填' });

      const { dataRoot } = resolveDataRootForWorkspace(cwdParam);
      if (!dataRoot) return writeJson(res, 500, { error: '推不出 dataRoot' });

      let abs = findExtFileInAnyRoot(dataRoot, kind, file);
      if (!abs) abs = findExtFileDeep(dataRoot, kind, file);
      if (!abs) return writeJson(res, 404, { error: '扩展文件不存在：' + file });

      const { readDisabledKeys, writeDisabledKeys, extDisabledKey } = await import('./dist/features/ext-packs.js');
      const key = extDisabledKey(dataRoot, abs);
      const set = readDisabledKeys(dataRoot);
      if (enabled) set.delete(key); else set.add(key);
      writeDisabledKeys(dataRoot, [...set]);

      // ★ 2026-10-24：立刻热重载，不用重启宿主
      //   ext-reload.ts 是项目里现成的重载注册表（middleware-setup 启动时注册了各 reloader），
      //   走它就不用自己碰 manager/闭包。工具（tools/）由 SessionManager.reloadAllChannelTools
      //   负责，这里够不到，所以 tools 的启停仍需 /tools-reload 或重启（回执里说明）。
      const reloaded = { commands: '', inbound: '', outbound: '', tools: '' };
      try {
        const mod = await import('./dist/features/ext-reload.js');
        if (typeof mod.reloadExtCommands === 'function') {
          const r = await mod.reloadExtCommands();
          reloaded.commands = (r && r.error) ? ('失败: ' + r.error) : ((r && r.names) ? r.names.length + ' 个' : 'ok');
        }
        if (typeof mod.reloadExtInbound === 'function') {
          const r = await mod.reloadExtInbound();
          reloaded.inbound = (r && r.error) ? ('失败: ' + r.error) : 'ok';
        }
        if (typeof mod.reloadExtOutbound === 'function') {
          const r = await mod.reloadExtOutbound();
          reloaded.outbound = (r && r.error) ? ('失败: ' + r.error) : 'ok';
        }
      } catch (e) {
        reloaded.error = String((e && e.message) || e);
      }

      // 工具注册表归 SessionManager，只能借 middleware-setup 登记在 globalThis 的 reloader
      try {
        const reg = globalThis.__qqbotReloaders;
        const fn = reg instanceof Map ? (reg.get(dataRoot) || [...reg.values()][0]) : undefined;
        if (typeof fn === 'function') {
          const summary = await fn();
          reloaded.tools = '已重载';
          reloaded.toolsSummary = String(summary || '').slice(0, 300);
        } else {
          reloaded.tools = '需 /tools-reload（没找到 reloader）';
        }
      } catch (e) {
        reloaded.tools = '失败: ' + String((e && e.message) || e);
      }

      writeJson(res, 200, { ok: true, key, enabled, disabled: [...set], reloaded });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 插件市场（2026-10-24）
  //
  // 索引仓库：zaofan-make/dsh-qqbot-plugins，根目录 index.json：
  //   {
  //     "version": 1,
  //     "updated": "2026-10-24",
  //     "plugins": [
  //       { "id":"demo-author", "name":"示例扩展包", "author":"做早饭", "version":"1.0.0",
  //         "description":"…", "homepage":"…", "repo":"zaofan-make/dsh-qqbot-plugins",
  //         "path":"packs/demo-author", "tags":["示例"], "kinds":["tools","commands"] }
  //     ]
  //   }
  //
  // 安装 = 用 GitHub API 递归拉 path 下所有文件，落到 {dataRoot}/extension-packs/{id}/
  //   （不用 zip：Node 没内置解压，tar 不认 zip；API 递归最稳，还能挑文件）
  // 卸载 = 删目录（先确认它在 extension-packs 下，防误删）
  // ═══════════════════════════════════════════════════════════════════════════

  // 索引地址：国内直连 raw.githubusercontent.com 常年不通（主人实测 fetch failed），
  // 所以按顺序试多个源，第一个成功的就用；回执里会带上用的是哪个。
  const MARKET_REPO = 'zaofan-make/dsh-qqbot-plugins';
  const MARKET_BRANCH = 'main';
  // 索引源顺序（2026-10-24 改）：**实时源优先**
  //   jsDelivr 对 @main 有缓存，刚合并的提交在它那儿看不到（实测面板一直只有 1 个插件，
  //   而 raw 上已经是 3 个）。所以索引不能把 jsDelivr 放第一位 ——
  //   它只留作最后的兜底（CDN 稳，但内容可能滞后）。
  //   注意：**插件文件**下载仍然用 jsDelivr（文件内容不变，缓存无害，且墙内稳定）。
  const MARKET_SOURCES = [
    'https://gh-proxy.com/https://raw.githubusercontent.com/' + MARKET_REPO + '/' + MARKET_BRANCH + '/index.json',
    'https://raw.githubusercontent.com/' + MARKET_REPO + '/' + MARKET_BRANCH + '/index.json',
    'https://ghproxy.net/https://raw.githubusercontent.com/' + MARKET_REPO + '/' + MARKET_BRANCH + '/index.json',
    'https://cdn.jsdelivr.net/gh/' + MARKET_REPO + '@' + MARKET_BRANCH + '/index.json',
  ];
  const MARKET_INDEX_URL = MARKET_SOURCES[0];   // 兼容旧引用（展示用）

  /** 依次试多个索引源，返回 { json, source } */
  async function fetchMarketIndex() {
    const errs = [];
    for (const url of MARKET_SOURCES) {
      try {
        const txt = await fetchText(url, 8000);
        const j = JSON.parse(txt);
        if (!Array.isArray(j.plugins)) j.plugins = [];
        return { json: j, source: url };
      } catch (e) {
        errs.push(url.split('/')[2] + ': ' + String((e && e.message) || e));
      }
    }
    throw new Error('所有索引源都失败 → ' + errs.join(' | '));
  }

  /**
   * jsDelivr 文件地址（2026-10-24）
   * 墙内 raw.githubusercontent.com / api.github.com / data.jsdelivr.com 都连不上，
   * 实测只有 cdn.jsdelivr.net 通 —— 文件内容也走它。
   */
  /**
   * 插件文件的多源候选（2026-10-25 修）
   *
   * 旧实现只用 cdn.jsdelivr.net，注释写"文件内容不变，缓存无害"——
   * 但作者发新版后 jsDelivr 的 @main 缓存还停在旧内容，于是：
   *   index.json 走 raw 拿到 version 1.0.5（新）
   *   文件走 jsDelivr 拿到 handler/parameters（旧，v1.0.4 之前的）
   * → 装出来的包"元数据是新的、代码是旧的"，工具直接不加载。
   *
   * 现在文件和索引用同一套顺序：实时源优先，jsDelivr 只做最后兜底。
   */
  function fileUrlCandidates(repo, branch, relPath) {
    const segs = String(relPath).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    const b = branch || 'main';
    const raw = repo + '/' + b + '/' + segs;
    return [
      'https://gh-proxy.com/https://raw.githubusercontent.com/' + raw,
      'https://raw.githubusercontent.com/' + raw,
      'https://ghproxy.net/https://raw.githubusercontent.com/' + raw,
      'https://cdn.jsdelivr.net/gh/' + repo + '@' + b + '/' + segs,
    ];
  }

  /** 兼容旧引用：取候选里的 jsDelivr 那条 */
  function jsdelivrFileUrl(repo, branch, relPath) {
    const segs = String(relPath).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    return 'https://cdn.jsdelivr.net/gh/' + repo + '@' + (branch || 'main') + '/' + segs;
  }

  /** 把 GitHub raw / API 下载链换成可用镜像（封面图等前端直接用） */
  function mirrorUrl(url) {
    if (!url) return url;
    const s = String(url);
    if (s.indexOf('raw.githubusercontent.com/') >= 0) {
      const tail = s.split('raw.githubusercontent.com/')[1];     // owner/repo/branch/path
      return 'https://cdn.jsdelivr.net/gh/' + tail;
    }
    return s;
  }

  /**
   * 市场代理配置（2026-10-24 主人要求）
   *
   * 背景：墙内 raw.githubusercontent.com / api.github.com / data.jsdelivr.com 全连不上，
   *   而 Node 原生 fetch **不读 HTTP_PROXY 环境变量**（Node 18+ 就这么设计的），
   *   面板里点了安装就是一句干巴巴的 "fetch failed"。
   *   这里给一个手动填代理的口子，填了就所有市场请求都走它。
   *
   * 落盘：{dataRoot}/.qqbot-extensions/.state/market-config.json
   *   { "proxy": "http://127.0.0.1:29290" }
   *
   * 实现：用 curl 子进程（Windows 10+ 自带 curl.exe；比手写 CONNECT 稳）。
   *   没配代理时仍走原生 fetch（大陆 CDN 如 cdn.jsdelivr.net 通常直连没问题）。
   */
  function marketConfigPath(dataRoot) {
    return join(dataRoot, '.qqbot-extensions', '.state', 'market-config.json');
  }

  function readMarketConfig(dataRoot) {
    try {
      const p = marketConfigPath(dataRoot);
      if (!existsSync(p)) return {};
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch { return {}; }
  }

  function writeMarketConfig(dataRoot, cfg) {
    try {
      const p = marketConfigPath(dataRoot);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
      return true;
    } catch { return false; }
  }

  /** 用 curl 走代理取文本（同步执行，简单可靠） */
  function curlText(url, proxy, timeoutMs) {
    // execFileSync 已在文件顶部 import（ESM 里不能用 require）
    const args = ['-sS', '--max-time', String(Math.ceil((timeoutMs || 15000) / 1000)), '-L'];
    if (proxy) args.push('-x', proxy);
    args.push('-H', 'User-Agent: dsh-qqbot-plugin-market', url);
    const out = execFileSync('curl', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    return out.toString('utf8');
  }

  /** 取 GitHub raw 文本（带超时与 UA，GitHub 要 UA） */
  async function fetchText(url, timeoutMs) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs || 12000);
    try {
      const r = await fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': 'dsh-qqbot-plugin-market', 'Accept': 'application/vnd.github+json' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally {
      clearTimeout(t);
    }
  }

  /** 取 GitHub API JSON */
  async function fetchJson(url, timeoutMs) {
    const txt = await fetchText(url, timeoutMs);
    return JSON.parse(txt);
  }

  /** 递归列出一个仓库子目录下的所有文件（GitHub contents API） */
  async function listRepoFiles(repo, dir, apiBase) {
    const out = [];
    const base = apiBase || 'https://api.github.com';
    async function walk(d, depth) {
      if (depth > 6) return;
      const items = await fetchJson(base + '/repos/' + repo + '/contents/' + encodeURI(d));
      if (!Array.isArray(items)) return;
      for (const it of items) {
        if (it.type === 'file' && it.download_url) out.push({ path: it.path, url: it.download_url, size: it.size || 0 });
        else if (it.type === 'dir') await walk(it.path, depth + 1);
      }
    }
    await walk(dir, 0);
    return out;
  }

  /**
   * GET /api/qqbot-settings/market?cwd=
   *   → { ok, index:{plugins:[…]}, installed:['demo-author'…], packsRoot, indexUrl }
   */
  route(ctx, 'GET', '/api/qqbot-settings/market', async (req, res) => {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const cwdParam = String(q.get('cwd') || '').trim();
      const { dataRoot } = resolveDataRootForWorkspace(cwdParam);
      if (!dataRoot) return writeJson(res, 500, { error: '推不出 dataRoot' });
      const packsRoot = join(dataRoot, 'extension-packs');
      const mcfg = readMarketConfig(dataRoot);
      const curProxy = String(mcfg.proxy || '');

      let index = { plugins: [] };
      let indexErr = '';
      let indexSource = '';
      try {
        const r = curProxy
          ? { json: JSON.parse(curlText(MARKET_SOURCES[0], curProxy, 15000)), source: MARKET_SOURCES[0] + '（走代理 ' + curProxy + '）' }
          : await fetchMarketIndex();
        index = r.json;
        indexSource = r.source;
        // 封面等图片地址换成镜像，否则前端在墙内显示不出来
        for (const p of index.plugins) if (p && p.cover) p.cover = mirrorUrl(p.cover);
      } catch (e) {
        indexErr = String((e && e.message) || e);
      }

      // installed 带上本地版本，前端才能判断「有没有新版可升」
      let installed = [];
      try {
        installed = readdirSync(packsRoot)
          .filter((n) => statSync(join(packsRoot, n)).isDirectory())
          .map((n) => {
            let version = '';
            try {
              const mf = join(packsRoot, n, 'qqbot-pack.json');
              if (existsSync(mf)) version = String(JSON.parse(readFileSync(mf, 'utf8')).version || '');
            } catch {}
            return { id: n, version };
          });
      } catch { installed = []; }

      writeJson(res, 200, { ok: true, index, indexErr, indexSource, proxy: curProxy, installed, packsRoot, indexUrl: MARKET_INDEX_URL + '（多源，实际用: ' + (indexSource || '无') + '）' });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  /**
   * POST /api/qqbot-settings/market/install
   *   body: { cwd?, id }
   *   按索引里的 repo/path 拉全部文件，写到 extension-packs/{id}/
   */
  /**
   * POST /api/qqbot-settings/market/config
   *   body: { cwd?, proxy }
   *   存市场配置（目前只有 proxy）
   */
  route(ctx, 'POST', '/api/qqbot-settings/market/config', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const cwdParam = String((body && body.cwd) || '').trim();
      const { dataRoot } = resolveDataRootForWorkspace(cwdParam);
      if (!dataRoot) return writeJson(res, 500, { error: '推不出 dataRoot' });
      const cfg = readMarketConfig(dataRoot);
      if (body && typeof body.proxy === 'string') cfg.proxy = body.proxy.trim();
      const ok = writeMarketConfig(dataRoot, cfg);
      writeJson(res, ok ? 200 : 500, { ok, config: cfg, path: marketConfigPath(dataRoot) });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  route(ctx, 'POST', '/api/qqbot-settings/market/install', async (req, res) => {
    try {
      const rawType = String((req.headers && req.headers['content-type']) || '');
      const body = await readJsonBody(req);
      const id = String((body && body.id) || '').trim();
      const cwdParam = String((body && body.cwd) || '').trim();
      if (!body || typeof body !== 'object') {
        return writeJson(res, 400, { stage: 'parse', error: '请求体解析失败（body 为空或不是 JSON）', contentType: rawType });
      }
      if (!id) {
        return writeJson(res, 400, { stage: 'id', error: 'id 必填', got: body });
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        return writeJson(res, 400, { stage: 'id-format', error: 'id 只允许字母数字-_', got: id });
      }

      const { dataRoot } = resolveDataRootForWorkspace(cwdParam);
      if (!dataRoot) return writeJson(res, 500, { error: '推不出 dataRoot' });

      // 拉索引找到这一条
      const idxR = await fetchMarketIndex();
      const idx = idxR.json;
      const item = (idx.plugins || []).find((p) => p && p.id === id);
      if (!item) return writeJson(res, 404, { error: '索引里没有这个插件: ' + id, indexSource: idxR.source, ids: (idx.plugins || []).map((x) => x && x.id) });
      if (!item.repo || !item.path) return writeJson(res, 400, { stage: 'repo-path', error: '索引条目缺 repo/path', item });

      // 文件清单来自索引的 files 字段 —— 不走 GitHub 目录 API（墙内连不上）。
      const list = Array.isArray(item.files) ? item.files : [];
      if (!list.length) {
        return writeJson(res, 400, {
          stage: 'files',
          error: '索引条目缺 files 清单',
          indexSource: idxR.source,
          itemKeys: Object.keys(item),
          item,
        });
      }

      const dest = join(dataRoot, 'extension-packs', id);
      mkdirSync(dest, { recursive: true });
      const branch = item.branch || 'main';
      const destNorm = dest.replace(/\\/g, '/');

      // 并发下载（原来串行 + 每个文件起一个 curl 进程，几 KB 也要好几秒）
      const mcfg2 = readMarketConfig(dataRoot);
      const px = String(mcfg2.proxy || '');
      const jobs = list.map(async (rel) => {
        const relPath = String(rel).replace(/^\.?\/+/, '');
        if (!relPath) return { ok: false, rel, err: '空路径' };
        const abs = join(dest, relPath);
        if (!abs.replace(/\\/g, '/').startsWith(destNorm + '/')) return { ok: false, rel, err: '路径越界' };
        try {
          mkdirSync(dirname(abs), { recursive: true });
          const urls = fileUrlCandidates(item.repo, branch, String(item.path) + '/' + relPath);
          let content = null;
          let lastErr = '';
          for (const u of urls) {
            try {
              content = px ? curlText(u, px, 20000) : await fetchText(u, 20000);
              break;
            } catch (e) {
              lastErr = String((e && e.message) || e);
            }
          }
          if (content == null) throw new Error('所有源都失败 → ' + lastErr);
          writeFileSync(abs, content, 'utf8');
          return { ok: true, rel };
        } catch (e) {
          return { ok: false, rel, err: String((e && e.message) || e) };
        }
      });
      const results = await Promise.all(jobs);
      let written = 0; const failed = [];
      for (const r of results) {
        if (r.ok) written++;
        else failed.push(r.rel + ': ' + (r.err || '未知'));
      }

      writeJson(res, 200, { ok: written > 0, written, total: files.length, failed, dest });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  /**
   * POST /api/qqbot-settings/market/remove
   *   body: { cwd?, id }
   */
  route(ctx, 'POST', '/api/qqbot-settings/market/remove', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const id = String((body && body.id) || '').trim();
      const cwdParam = String((body && body.cwd) || '').trim();
      if (!id) return writeJson(res, 400, { error: 'id 必填' });
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) return writeJson(res, 400, { error: 'id 只允许字母数字-_' });

      const { dataRoot } = resolveDataRootForWorkspace(cwdParam);
      if (!dataRoot) return writeJson(res, 500, { error: '推不出 dataRoot' });
      const packsRoot = join(dataRoot, 'extension-packs');
      const target = join(packsRoot, id);
      const norm = (p) => p.replace(/\\/g, '/');
      if (!norm(target).startsWith(norm(packsRoot) + '/')) return writeJson(res, 400, { error: '路径越界' });
      if (!existsSync(target)) return writeJson(res, 404, { error: '没装: ' + id });

      rmSync(target, { recursive: true, force: true });
      writeJson(res, 200, { ok: true, removed: target });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  route(ctx, 'GET', '/api/qqbot-settings/extensions', async (req, res) => {
    try {
      // ★ 2026-10-24 修：优先用 ?cwd=（当前会话的工作区），扩展目录跟着工作区走
      //   原先只用 resolveContextlessDataRoot()（=首个 bot 实例的 dataRoot），
      //   切换会话到别的工作区后面板还指向老工作区，主人实测发现。
      // 工作区来源优先级：?cwd= ＞ ?sid= 反查 ＞ 默认 dataRoot
      let cwdParam = '';
      let sidParam = '';
      try {
        const q = new URL(req.url, 'http://localhost').searchParams;
        cwdParam = String(q.get('cwd') || '').trim();
        sidParam = String(q.get('sid') || '').trim();
      } catch { /* ignore */ }
      let wsResolvedBy = cwdParam ? 'cwd' : '';
      if (!cwdParam && sidParam) {
        const bySid = resolveWorkspaceBySid(sidParam);
        if (bySid) { cwdParam = bySid; wsResolvedBy = 'sid'; }
      }
      // ★ 尊重 bot 配置里的 dataRoot（主人 2026-10-24 指出）
      const _dr = resolveDataRootForWorkspace(cwdParam);
      const dataRoot = _dr.dataRoot;
      if (!dataRoot) return writeJson(res, 200, { ok: false, error: '推不出 dataRoot（还没绑过机器人？）' });

      const builtinRoot = join(dataRoot, '.qqbot-extensions');
      const builtin = scanExtRoot(builtinRoot, dataRoot);

      // ① 内置目录
      const result = {
        ok: true,
        dataRoot,
        workspaceCwd: cwdParam || '',
        workspaceFrom: wsResolvedBy || 'default',
        dataRootFrom: _dr.source,
        builtinRoot,
        builtin,
        packsRoot: join(dataRoot, 'extension-packs'),
        packs: [],
      };

      // ② 扩展包：扫 packsRoot 下每个子目录
      const packsRoot = result.packsRoot;
      let packNames = [];
      try { packNames = readdirSync(packsRoot); } catch { packNames = []; }
      for (const name of packNames) {
        const dir = join(packsRoot, name);
        let st = null;
        try { st = statSync(dir); } catch { continue; }
        if (!st.isDirectory()) continue;

        // 清单文件（可选）
        let meta = {};
        for (const f of ['qqbot-pack.json', 'pack.json', 'package.json']) {
          const mf = join(dir, f);
          if (!existsSync(mf)) continue;
          try {
            const j = JSON.parse(readFileSync(mf, 'utf8'));
            meta = {
              name: j.name || j.displayName || '',
              author: j.author || (j.author && j.author.name) || '',
              desc: j.description || j.desc || '',
              version: j.version || '',
              homepage: j.homepage || j.repository || '',
            };
            break;
          } catch { /* 清单坏了就当没有 */ }
        }

        const scanned = scanExtRoot(dir, dataRoot);
        if (scanned.total === 0) continue;   // 空目录不显示
        result.packs.push({
          dirName: name,
          dir,
          meta,
          kinds: scanned.kinds,
          total: scanned.total,
        });
      }
      result.packs.sort((a, b) => a.dirName.localeCompare(b.dirName));

      // ③ 汇总：哪几个扩展声明了设置页
      const settingsPages = [];
      const collect = (list, from) => {
        for (const it of list) {
          if (it.hasSettings) settingsPages.push({ from, id: it.id, title: it.settingsTitle || it.id });
        }
      };
      for (const k of EXT_KINDS) collect(builtin.kinds[k], 'builtin');
      for (const p of result.packs) {
        for (const k of EXT_KINDS) collect(p.kinds[k], p.meta.name || p.dirName);
      }
      result.settingsPages = settingsPages;

      // ★ 2026-10-24：统一补启停状态（scanExtKind 是顶层函数，拿不到路由里的 disabledSet）
      let _ds = new Set();
      try {
        const m = await import('./dist/features/ext-packs.js');
        _ds = m.readDisabledKeys(dataRoot);
      } catch { /* 拿不到就当全启用 */ }
      const _root = String(dataRoot).split('\\').join('/').split('/').join('/');
      const _mark = (list) => {
        for (const it of list) {
          const abs = it.__abs || '';
          const rel = abs.split('\\').join('/').split('/').join('/');
          const key = rel.indexOf(_root + '/') === 0 ? rel.slice(_root.length + 1) : abs;
          it.disabled = _ds.has(key);
        }
      };
      for (const k of EXT_KINDS) _mark(builtin.kinds[k] || []);
      for (const pk of result.packs) for (const k of EXT_KINDS) _mark((pk.kinds && pk.kinds[k]) || []);


      writeJson(res, 200, result);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // ── 🚀 群发任务「后台自动推进」(2026-09-10 修: 原设计靠 client 每次 list 驱动, 页面不动就永久卡 queued) ──
  // 每隔 BC_TICK_MS 扫全部实例, 有 queued/sending 任务就推进一步(串行 → 天然限频); 单实例失败不影响其他实例。
  // 节流依据(**官方文档已核对**, 群发走的是"主动消息"):
  //   · 群聊: Bot 维度(发送方) 企业认证 60/qpm、未认证 30/qpm；单关系(同一个群) 20/qpm；每群每天最多接收 1000 条；接口 100 QPS
  //   · 单聊: Bot 维度 认证 10/qps、未认证 5/qps 且 30/qpm；单关系 20/qpm
  //   1500ms/条 ≈ 40 条/分钟 —— 跑满认证额度的 2/3, 给"被动回复/定时推送/其它主动消息"留余量。
  //   (原为 5000ms ≈ 12 条/分钟, 仅用掉 1/5 额度, 主人实测嫌慢)
  try {
    const BC_TICK_MS = 1500;
    let bcTickRunning = false; // 定时器自身防重入: 上一轮未跑完不叠加(2026-09-10)
    const bcTick = async () => {
      if (bcTickRunning) return;
      bcTickRunning = true;
      try {
      let bots = [];
      try { bots = parsePatch().bots || []; } catch { return; }
      for (const b of bots) {
        try {
          if (b.disabled) continue;
          const bot = nsBot(b.id);
          if (!bot || !bot.cwd) continue;
          const bm = await broadcastMod();
          const tasks = bm.listTasks(bot.cwd);
          const active = tasks.find((t) => t.state === 'queued' || t.state === 'sending');
          if (!active) continue;
          const gc = await groupClientOf(b.id);
          if (!gc) continue;
          await bm.advanceTask(bot.cwd, active.task_id, gc.client);
          audit(bot.cwd, { ev: 'group.broadcast.auto-advance', ns: b.id, task_id: active.task_id });
        } catch (e) {
          try {
            const bot2 = nsBot(b.id);
            if (bot2 && bot2.cwd) audit(bot2.cwd, { ev: 'group.broadcast.auto-advance-failed', ns: b.id, error: String((e && e.message) || e) });
          } catch { /* ignore */ }
        }
      }
      } finally { bcTickRunning = false; }
    };
    ctx.effect(() => {
      const timer = setInterval(() => { bcTick().catch(() => {}); }, BC_TICK_MS);
      timer.unref?.();
      return () => { try { clearInterval(timer); } catch { /* ignore */ } };
    }, 'qqbot-settings: 群发任务后台自动推进');
  } catch { /* 定时器失败不影响插件 */ }

}
