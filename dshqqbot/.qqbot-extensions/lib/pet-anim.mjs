/**
 * lib/pet-anim.mjs — 桌宠多形态底座：xiaolan(女仆立绘) / classic(原版少女) / de(de娘) / MuU大肥鱼
 *                     （2026-11-01 主人拍板：三种形象都要能上桌面，v2 双形态升级为四形态）
 *
 * 调 dsh-pet 插件挂在宿主 webServer 上的本地 API：
 *   POST /dsh-pet-7340/anim?pet=<id>&surface=<web|desktop|both|any>&token=<t>  body {"name":"动画名"}
 *     → {ok:true, playbackId} / {ok:false, reason, message}（HTTP 恒 200，语义看 body）
 *   POST /dsh-pet-7340/pet-display?token=<t>  body {"id":"<petId>","display":"none|web|desktop|both"}
 *     → 写回对应配置层文件并 syncDesktop（自动重启 helper），无需重启 harness
 *   GET  /dsh-pet-7340/config?token=<t> → 聚合后的成品配置（pets[].display 可探当前形态）
 *
 * 双形态规矩（主人 2026-10-31 定）：
 *   · 同一时刻桌面只显示一只 —— 两只 display 互斥，switchForm 负责修正；
 *   · 动作语义**跟随当前形态**（语义映射：挥手/开心/说话/指一指/拎起来/待机 + 随机）；
 *   · 保持零 token：切到大肥鱼时顺手把 main 的 whisperEnabled 关掉（碎碎念要烧钱）。
 *
 * token：harness 每次重启轮换，落在 harness.log 的「dsh web: http://…/?token=…」行里。
 * 这里惰性读日志尾部 + 缓存（按 mtime 失效），401/403 时强制刷新重试一次。
 * 硬约束：零模型调用、不碰 LLM、失败也不抛异常，只返回 {ok:false}。
 */

import { openSync, readSync, closeSync, statSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── 形态注册表 ─────────────────────────────────────────────────────────
// anims：语义动作表（浮窗按钮直接映射；旧「群口令+固定文案」链路已废弃，2026-10-31 主人拍板）。
// randomPool：「逗逗她」随机池。
export const FORMS = {
  xiaolan: {
    id: 'xiaolan',
    label: '小蓝',
    emoji: '🐋',
    anims: [
      { name: '小蓝-挥手', label: '挥手' },
      { name: '小蓝-开心', label: '开心' },
      { name: '小蓝-说话', label: '说话' },
      { name: '小蓝-指', label: '指一指' },
      { name: '小蓝-被拎起', label: '拎起来' },
      { name: '小蓝-待机', label: '待机' },
    ],
    randomPool: ['小蓝-挥手', '小蓝-开心', '小蓝-说话', '小蓝-指', '小蓝-被拎起'],
  },
  classic: {
    id: 'classic', // dsh-pet 条目「小蓝·原版」，素材在 classic-animation/
    label: '小蓝·原版',
    emoji: '🧜',
    anims: [
      { name: '小蓝-挥手', label: '挥手' },
      { name: '小蓝-开心', label: '开心' },
      { name: '小蓝-说话', label: '说话' },
      { name: '小蓝-指', label: '指一指' },
      { name: '小蓝-被拎起', label: '拎起来' },
      { name: '小蓝-待机', label: '待机' },
    ],
  },
  de: {
    id: 'de', // dsh-pet 条目「de娘」，素材在 de-animation/（姿势补齐后扩 anims）
    label: 'de娘',
    emoji: '🌀',
    anims: [
      { name: 'de娘-开心', label: '开心' },
      { name: 'de娘-待机', label: '待机' },
    ],
  },
  muu: {
    id: 'main', // dsh-pet 内置条目「MuU」（普通大肥鱼），素材在插件包 assets/webm/
    label: '大肥鱼',
    emoji: '🐟',
    anims: [
      { name: '点击回应-元气挥手', label: '挥手' },
      { name: '点击回应-开心跃动', label: '开心' },
      { name: '悠闲哼歌', label: '说话' },
      { name: '点击回应-傲娇生气', label: '指一指' },
      { name: '被鼠标拖拽悬空反馈', label: '拎起来' },
      { name: '待机呼吸休闲', label: '待机' },
    ],
    randomPool: [
      { name: '写代码' },
      { name: '吃Token' },
      { name: '蓝鲸现世' },
      { name: '优雅女仆舞' },
      { name: '轻快摇摆舞' },
      { name: '可爱宅舞' },
      { name: '超大伸懒腰' },
      { name: '原地专心玩魔方' },
      { name: '三球抛接' },
      { name: '撸猫' },
    ],
  },
};

export const FORM_IDS = Object.keys(FORMS);
/** 小蓝随机池 = 语义动作表去掉待机 */
FORMS.xiaolan.randomPool = FORMS.xiaolan.anims.filter((a) => a.name !== '小蓝-待机');
/** 兼容旧引用：xiaolan 的动作清单 */
export const PET_ANIMS = FORMS.xiaolan.anims;
export const PET_ID = 'xiaolan';

// ── 第三方右键菜单（dsh-pet 官方扩展点，2026-10-31 主人要求「加一个切换形象」）────────
// 注册：POST {BASE}/menu/item {owner, labels}（整体覆盖；桌宿进程重启即清空 → 丢册自动重注册）
// 点击：渲染端 POST {BASE}/menu/click → 我们 GET {BASE}/menu/events?owner=… 长轮询取走（读取即消费）
// 条目出现在桌宠右键「更多」分支下（桌面 helper 与浏览器网页两端都会显示）。
export const MENU_OWNER = 'QQ机器人扩展';
const MENU_LABELS = [
  { label: '🐋 变小蓝', target: 'xiaolan' },
  { label: '🧜 变原版小蓝', target: 'classic' },
  { label: '🌀 变de娘', target: 'de' },
  { label: '🐟 变大肥鱼', target: 'muu' },
];
let _menuLoopStarted = false;

async function registerPetMenu() {
  try {
    const r = await dshFetchRetry('menu/item', {
      method: 'POST',
      body: { owner: MENU_OWNER, labels: MENU_LABELS.map((x) => x.label) },
    });
    return !!(r && r.json && r.json.ok);
  } catch { return false; }
}

/** 菜单点击消费循环：长轮询（waitMs=10s）→ 命中 label 就 switchForm。
 *  失败退避 30s；桌宿重启导致 unknown-owner 会自动重注册。绝不抛异常、不烧 token。 */
async function petMenuLoop() {
  let registered = false;
  for (;;) {
    let waitMs = 1500;
    try {
      if (!registered) {
        registered = await registerPetMenu();
        if (!registered) waitMs = 30000;
      } else {
        const r = await dshFetchRetry(`menu/events?owner=${encodeURIComponent(MENU_OWNER)}&waitMs=10000`).catch(() => null);
        const j = r && r.json;
        if (j && j.ok && j.events) {
          for (const hit of MENU_LABELS) {
            if (j.events[hit.label]) {
              try {
                const sw = await switchForm(hit.target);
                console.log(`[pet-anim] 右键菜单切换形态 → ${hit.target}: ${sw && sw.ok ? 'ok' : JSON.stringify(sw).slice(0, 120)}`);
              } catch { /* 单次切换失败不影响循环 */ }
            }
          }
        } else if (j && j.ok === false && j.reason === 'unknown-owner') {
          registered = false; // 桌宿重启过菜单注册表被清：下一拍重注册
        } else if (!j) {
          waitMs = 30000; // 探不到端点（桌宿没起/日志没就绪）：慢退避
        }
      }
    } catch { waitMs = 30000; }
    await new Promise((r2) => setTimeout(r2, waitMs));
  }
}

/** 挂载时调用（幂等）：启动菜单注册+点击消费后台循环 */
export function ensurePetMenu() {
  if (_menuLoopStarted) return;
  _menuLoopStarted = true;
  petMenuLoop().catch(() => { _menuLoopStarted = false; });
}

/** harness.log 位置：DSH_HOME/../logs/harness.log */
function harnessLogPath() {
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim())
    || join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness');
  return join(home, '..', 'logs', 'harness.log');
}

let _ep = null; // {port, token, mtimeMs, at}

/** 从日志尾部惰性解析最新一次启动的端口+token；force=true 无视 mtime 缓存 */
function readWebEndpoint(force = false) {
  try {
    const p = harnessLogPath();
    let st;
    try { st = statSync(p); } catch { return null; }
    const mtimeMs = Math.floor(st.mtimeMs);
    if (!force && _ep && _ep.mtimeMs === mtimeMs) return _ep;
    const len = st.size;
    const start = Math.max(0, len - 256 * 1024); // 尾部 256KB 足够覆盖最近几次启动行
    const buf = Buffer.alloc(len - start);
    const fd = openSync(p, 'r');
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    const re = /dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/g;
    let m, hit = null;
    while ((m = re.exec(buf.toString('utf8')))) hit = { port: m[1], token: m[2] };
    if (!hit) return null;
    _ep = { ...hit, mtimeMs, at: Date.now() };
    return _ep;
  } catch { return null; }
}

async function dshFetch(pathname, { method = 'GET', body = null, ep } = {}) {
  const url = `http://127.0.0.1:${ep.port}/dsh-pet-7340/${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(ep.token)}`;
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, json };
}

/** 带一次 token 轮换重试的请求 */
async function dshFetchRetry(pathname, opts = {}) {
  let ep = readWebEndpoint();
  if (!ep) return { status: 0, json: null, reason: 'no-endpoint', message: 'harness.log 里没找到 dsh web 端点（桌宿没启动？）' };
  let res = await dshFetch(pathname, { ...opts, ep });
  if (res.status === 401 || res.status === 403) {
    ep = readWebEndpoint(true);
    if (!ep) return { status: 0, json: null, reason: 'no-endpoint', message: 'token 刷新失败' };
    res = await dshFetch(pathname, { ...opts, ep });
  }
  return res;
}

// ── 当前形态探测（真源 = dsh-pet 配置里的 display） ────────────────────
let _formCache = { at: 0, form: null };

/** display 是否含「桌面/网页可见」 */
function isDisplayed(display) {
  return display === 'desktop' || display === 'both';
}

/** 当前形态：xiaolan | muu | mixed（两只都可见，待修正）| null（探不到） */
export async function currentForm({ force = false } = {}) {
  const now = Date.now();
  if (!force && _formCache.form && now - _formCache.at < 5000) return _formCache.form;
  const res = await dshFetchRetry('config');
  const j = res?.json;
  // /config 返回 { main:{pets:[{id,display,…}]}, xiaolan:{pets:[…]} }（按条目 key 组织）
  const pets = j && typeof j === 'object'
    ? Object.values(j).flatMap((e) => (e && Array.isArray(e.pets)) ? e.pets : [])
    : null;
  if (!pets || !pets.length) {
    // 探不到就保留上次结论（启动默认小蓝）
    const fb = _formCache.form || 'xiaolan';
    _formCache = { at: now, form: fb };
    return fb;
  }
  const shown = FORM_IDS.filter((fid) =>
    pets.some((p) => p && p.id === FORMS[fid].id && isDisplayed(String(p.display)))
  );
  let form;
  if (shown.length > 1) form = 'mixed';       // 异常态：多只都在
  else if (shown.length === 1) form = shown[0];
  else form = _formCache.form || 'xiaolan';      // 都隐藏 → 维持上次
  _formCache = { at: now, form };
  return form;
}

function formOf(formId) {
  return FORMS[formId] || null;
}

// ── 形态偏好持久化（重启 harness 后自动回归用户最后选的形态） ──────────
const PREF_PATH = () => join(import.meta.dirname, '.pet-form.json');

/** 记下用户最后选的形态（switchForm 成功时自动写） */
export function saveFormPreference(formId) {
  try {
    if (FORMS[formId]) writeFileSync(PREF_PATH(), JSON.stringify({ form: formId, at: Date.now() }), 'utf8');
  } catch { /* 写不掉就下次再问 dsh-pet 真源 */ }
}

/** 读形态偏好；没有则 null */
export function loadFormPreference() {
  try {
    const j = JSON.parse(readFileSync(PREF_PATH(), 'utf8'));
    return FORMS[j.form] ? j.form : null;
  } catch { return null; }
}

/** 当前形态的语义动作表（探不到形态时回落 xiaolan） */
export async function currentAnims() {
  const form = (await currentForm()) || 'xiaolan';
  return formOf(form)?.anims || FORMS.xiaolan.anims;
}

// ── 形态切换（display 互斥 + 关掉肥鱼的碎碎念保零 token） ───────────────
const MAIN_CONFIG = () => {
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim())
    || join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness');
  return join(home, 'dsh-pet', 'main-config.jsonc');
};

/** 把 main-config.jsonc 里 main 条目的 whisperEnabled 关成 false（字符串级精准替换，保注释） */
function silenceMuuWhisper() {
  try {
    const p = MAIN_CONFIG();
    const src = readFileSync(p, 'utf8');
    // 只在还没关的情况下替换（文件里仅 main 条目一处 "whisperEnabled": true）
    const next = src.replace(/("whisperEnabled"\s*:\s*)true/g, '$1false');
    if (next !== src) writeFileSync(p, next, 'utf8');
  } catch { /* 关不掉也不阻塞切换；顶多肥鱼碎碎念费点 token，下次切换再补 */ }
}

/**
 * 切换形态：目标→both、当前→none（display 互斥，杜绝两形态混用/抖动）。
 * dsh-pet 的 /pet-display 会把改动写回配置层文件并 syncDesktop（helper 自动重启换角）。
 * @returns {Promise<{ok:true, form:string, label:string, changed:string[]}
 *                  |{ok:false, reason:string, message:string}>}
 */
export async function switchForm(target) {
  const t = String(target || '').trim();
  if (!FORMS[t]) {
    return { ok: false, reason: 'unknown-form', message: `不认识的形态: ${t}（可选：${FORM_IDS.join('/')}）` };
  }
  const cur = (await currentForm({ force: true })) || 'xiaolan';
  if (cur === t) {
    return { ok: true, form: t, label: FORMS[t].label, changed: [], message: `当前已经是${FORMS[t].label}形态` };
  }
  const changed = [];
  // 1) 目标上场（先上后下，保证任一时刻至少逻辑上有一只在）
  const up = await dshFetchRetry('pet-display', { method: 'POST', body: { id: FORMS[t].id, display: 'both' } });
  if (up.status !== 200 || !up.json || up.json.ok === false) {
    return { ok: false, reason: (up.json && up.json.reason) || `http-${up.status}`, message: (up.json && up.json.message) || `${FORMS[t].label} 上场失败` };
  }
  changed.push(`${FORMS[t].id}:both`);
  // 2) 旧形态下场（mixed 修正 / 常规切换都覆盖；已是 none 也没关系，幂等）
  if (cur !== 'mixed' && FORMS[cur]) {
    const down = await dshFetchRetry('pet-display', { method: 'POST', body: { id: FORMS[cur].id, display: 'none' } });
    if (down.status === 200 && down.json && down.json.ok !== false) changed.push(`${FORMS[cur].id}:none`);
  } else if (cur === 'mixed') {
    // 两只都可见的异常态：把除目标外的全部下场
    for (const fid of FORM_IDS) {
      if (fid === t) continue;
      const down = await dshFetchRetry('pet-display', { method: 'POST', body: { id: FORMS[fid].id, display: 'none' } });
      if (down.status === 200 && down.json && down.json.ok !== false) changed.push(`${FORMS[fid].id}:none`);
    }
  }
  // 3) 零 token 纪律：肥鱼条目的碎碎念必须关（写在 main-config.jsonc）
  if (t === 'muu') silenceMuuWhisper();
  _formCache = { at: Date.now(), form: t };
  saveFormPreference(t); // 偏好落盘：重启 harness 后 hooks 启动自校正用
  return { ok: true, form: t, label: FORMS[t].label, changed };
}

// ── 动作触发（跟随当前形态） ───────────────────────────────────────────
/**
 * 触发一个动画；form 缺省 = 当前形态。name 必须属于该形态的动作表 ∪ 随机池。
 * @returns {Promise<{ok:true, playbackId:string}|{ok:false, reason:string, message:string}>}
 */
export async function petAnim(name, { form = null, surface = 'any' } = {}) {
  name = String(name || '');
  const fid = form || (await currentForm()) || 'xiaolan';
  const f = formOf(fid);
  if (!f) return { ok: false, reason: 'unknown-form', message: `不认识的形态: ${fid}` };
  const known = new Set([...f.anims.map((a) => a.name), ...f.randomPool.map((a) => a.name || a)]);
  if (!known.has(name)) {
    return { ok: false, reason: 'unknown-anim', message: `${f.label}不会这个动作: ${name}` };
  }
  let ep = readWebEndpoint();
  if (!ep) return { ok: false, reason: 'no-endpoint', message: 'harness.log 里没找到 dsh web 端点（桌宿没启动？）' };
  const call = async (ep2) => {
    const url = `http://127.0.0.1:${ep2.port}/dsh-pet-7340/anim?pet=${encodeURIComponent(f.id)}&surface=${encodeURIComponent(surface)}&token=${encodeURIComponent(ep2.token)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(5000),
    });
    let body = null;
    try { body = await r.json(); } catch { /* ignore */ }
    return { status: r.status, body };
  };
  let res = await call(ep);
  if (res.status === 401 || res.status === 403) {
    ep = readWebEndpoint(true); // token 轮换过 → 强刷重试一次
    if (!ep) return { ok: false, reason: 'no-endpoint', message: 'token 刷新失败' };
    res = await call(ep);
  }
  if (res.status === 200 && res.body && res.body.ok) return { ok: true, playbackId: res.body.playbackId };
  return {
    ok: false,
    reason: (res.body && res.body.reason) || `http-${res.status}`,
    message: (res.body && res.body.message) || String(res.status),
  };
}

/** 随机挑一个动作（当前形态；不含待机语义） */
export async function randomAnim(form = null) {
  const fid = form || (await currentForm()) || 'xiaolan';
  const f = formOf(fid) || FORMS.xiaolan;
  return f.randomPool[Math.floor(Math.random() * f.randomPool.length)];
}

/** 按 label 或动画名在【当前形态】里找动作（找不到回 null） */
export async function animByLabel(label, form = null) {
  const fid = form || (await currentForm()) || 'xiaolan';
  const f = formOf(fid) || FORMS.xiaolan;
  return f.anims.find((a) => a.name === label || a.label === label) || null;
}

// ── 桌宠显隐总开关（2026-11-01 主人要求：浮窗陪玩页加「开启/关闭」按钮）──────
/** 探测桌宠当前是否可见（任一已知形态 display 含桌面/网页 = 开）。探不到回 null。 */
export async function petVisibility() {
  try {
    const res = await dshFetchRetry('config');
    const j = res?.json;
    const pets = j && typeof j === 'object'
      ? Object.values(j).flatMap((e) => (e && Array.isArray(e.pets)) ? e.pets : [])
      : null;
    if (!pets || !pets.length) return null;
    const known = new Set(Object.values(FORMS).map((f) => f.id));
    return pets.some((p) => p && known.has(p.id) && isDisplayed(String(p.display)));
  } catch { return null; }
}

/** 关闭桌宠：所有已知形态全部隐藏（display:none）。 */
export async function hideAllPets() {
  const off = [];
  for (const fid of FORM_IDS) {
    try {
      const r = await dshFetchRetry('pet-display', { method: 'POST', body: { id: FORMS[fid].id, display: 'none' } });
      if (r.status === 200 && r.json && r.json.ok !== false) off.push(FORMS[fid].id);
    } catch { /* 单个失败继续关下一个 */ }
  }
  _formCache = { at: Date.now(), form: 'hidden' };
  return { ok: off.length > 0, off };
}

/** 开启桌宠：回归用户最后选的形态（偏好落盘），没有偏好默认小蓝。 */
export async function showPet() {
  const pref = loadFormPreference() || 'xiaolan';
  return switchForm(pref);
}

// ── 对外小工具（P2 群动画 / P3 网页桌宠用） ────────────────────────────
/** 暴露 web 端点（port+token）给 hooks 做媒体代理；force=true 强刷 token。勿把 token 写进任何响应体 */
export function webEndpoint(force = false) {
  return readWebEndpoint(force);
}

const DSH_HOME = () => (process.env.DSH_HOME && process.env.DSH_HOME.trim())
  || join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness');

const XIAOLAN_DIR = () => join(DSH_HOME(), 'dsh-pet', 'pet', 'xiaolan-animation');

let _muuDir = null;
/** 动画 webm 的本地源文件路径（小蓝在 harness 下、大肥鱼在插件包 assets/webm/；找不到回 null） */
export function animSourcePath(name) {
  try {
    name = String(name || '');
    if (!name) return null;
    if (name.startsWith('小蓝-')) {
      const p = join(XIAOLAN_DIR(), `${name}.webm`);
      return existsSync(p) ? p : null;
    }
    if (_muuDir) {
      const p = join(_muuDir, `${name}.webm`);
      if (existsSync(p)) return p;
    }
    // 插件版本目录会随升级换 → 重新探一遍 live 目录
    const live = join(DSH_HOME(), 'profiles', '.generations', 'live');
    for (const e of readdirSync(live)) {
      if (!e.startsWith('dsh-pet+')) continue;
      const dir = join(live, e, 'node_modules', 'dsh-pet', 'assets', 'webm');
      const p = join(dir, `${name}.webm`);
      if (existsSync(p)) { _muuDir = dir; return p; }
    }
    return null;
  } catch { return null; }
}

/** 测试钩子：清空缓存状态 */
export function _testReset() {
  _ep = null;
  _formCache = { at: 0, form: null };
}
