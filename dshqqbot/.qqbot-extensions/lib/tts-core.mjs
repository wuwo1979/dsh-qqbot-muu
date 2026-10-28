/**
 * tts-core.mjs — 小蓝的中文语音合成核心（edge-tts → mp3）
 *
 * 为什么是 mp3 而不是 silk：
 *   QQ 官方语音上传原生支持 .mp3 / .wav / .silk（@tencent-connect/qqbot-nodejs 的
 *   QQ_NATIVE_UPLOAD_FORMATS），所以 edge-tts 直接吐 mp3 就能发，不必装 ffmpeg 转码。
 *
 * 设计约束（沙箱实测）：
 *   · 本机子进程不能管道捕获 stdio（spawn 用 pipe 会 EPERM）→ 一律 stdio:'ignore'，
 *     不读 python 的 stdout/stderr，音频只从 write-media 落盘文件里拿；
 *     时长也只能靠 mp3 码率估算（edge-tts 默认 24kHz/48kbps mono）。
 *   · TTS 用在短句回复场景，不是朗读器 → 超过 300 字直接截断，不排队不切段。
 *   · 任何异常都不许抛到调用方（QQ 消息链路不能被语音拖死）→ 统一 {ok:false,error}。
 *
 * 为什么放在 .qqbot-extensions/lib：插件升级会覆盖 dist，扩展目录长期存活。
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, statSync, readdirSync, unlinkSync, writeFileSync, appendFileSync, openSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';

// ── 本地服务自启动（"tts-http: fetch failed" 的真凶是 9881 没人拉起）────────────
// 适配层是个普通 python 进程，起它的 shell 一退它就没了；插件这边每次合成前先探活，
// 探不到就直接 detached 起 python（adapter/server.py --manage），再等它 listening。
const TTS_START_WAIT_MS = 60000;
const TTS_DEFAULT_REPO = 'F:/qqbot';

function ttsServiceBase(endpoint) {
  try {
    const u = new URL(String(endpoint || ''));
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) return '';
    return u.origin;
  } catch {
    return '';
  }
}

async function probeTtsUp(base, ms = 1200) {
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(ms) });
    return r.ok || [400, 404, 405].includes(r.status);
  } catch {
    return false;
  }
}

/**
 * 端口探活（比 HTTP 探活靠谱）：适配层的 /health 会顺手探后端，
 * 冷启动时可能十几秒才回，用 HTTP 探活会误判"没起来"并把连接掐断
 * （日志里就是 ConnectionAbortedError 10053）。这里只连 TCP。
 */
function probeTcp(host, port, ms = 900) {
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch { /* ignore */ } res(v); } };
    let s;
    try {
      s = connect({ host, port: Number(port) });
    } catch {
      res(false);
      return;
    }
    s.setTimeout(ms, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

function ttsHostPort(base) {
  try {
    const u = new URL(base);
    const port = u.port || '9881';
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
  } catch {
    return { host: '127.0.0.1', port: '9881' };
  }
}

/** 找仓库根（含 skills/local-tts/adapter/server.py 的那层）。 */
function findRepoRoot(dir) {
  const cands = [];
  try {
    // dir = {dataRoot}/.qqbot/tts → 上溯 3 层是 dataRoot，再往上一级才是仓库根
    const dataRoot = dirname(dirname(dirname(dir)));
    cands.push(join(dataRoot, '..'), dataRoot);
  } catch {
    /* ignore */
  }
  cands.push(TTS_DEFAULT_REPO);
  for (const p of cands) {
    try {
      if (existsSync(join(p, 'skills', 'local-tts', 'adapter', 'server.py'))) return p;
    } catch {
      /* ignore */
    }
  }
  return '';
}

function findAdapterPython(repo) {
  const venv = join(repo, '.models', 'gpt-sovits', '.venv', 'Scripts', 'python.exe');
  try {
    if (existsSync(venv)) return venv;
  } catch {
    /* ignore */
  }
  return 'python';
}

/**
 * pythonw.exe —— 同一个解释器的 GUI 子系统版本。
 *
 * 2026-10-26 修「python 黑窗关不掉」：原来 detached + python.exe 起适配层，
 * detached 在 Windows 上等于 DETACHED_PROCESS，console 程序拿不到父控制台就会
 * **自己新建一个控制台窗口**，而 windowsHide 走的是 STARTF_USESHOWWINDOW(SW_HIDE)，
 * 对"新建控制台"这件事无效 —— 所以 windowsHide:true 也挡不住那个窗。
 * pythonw.exe 是 /SUBSYSTEM:WINDOWS，压根不会分配控制台，比 CREATE_NO_WINDOW 更彻底，
 * 而且它就是同一个 venv 里的 Python（不是新依赖）。
 */
function findAdapterPythonw(repo) {
  const py = findAdapterPython(repo);
  if (/python\.exe$/i.test(py)) {
    const pyw = py.replace(/python\.exe$/i, 'pythonw.exe');
    try {
      if (existsSync(pyw)) return pyw;
    } catch {
      /* ignore */
    }
  }
  return py;
}

/** Windows 上同名大小写两条环境变量会让子进程启动炸掉，这里只留大写那条。 */
function ttsCleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(https?_proxy|no_proxy|all_proxy)$/i.test(k) && k !== k.toUpperCase()) delete env[k];
  }
  return env;
}

/** 本地 endpoint：能连上 → true；连不上就拉服务，等一会儿再探。非本机 endpoint 一律 true。 */
async function ensureLocalTtsServer(endpoint, dir) {
  const base = ttsServiceBase(endpoint);
  if (!base) return true;
  const { host, port } = ttsHostPort(base);
  if (await probeTcp(host, port)) return true;
  const repo = findRepoRoot(dir);
  if (!repo) return false;
  const server = join(repo, 'skills', 'local-tts', 'adapter', 'server.py');
  const py = findAdapterPythonw(repo);   // pythonw：不会弹控制台（见 findAdapterPythonw 注释）
  const pidFile = join(dir, 'adapter.pid');   // {dataRoot}/.qqbot/tts/adapter.pid —— 浮窗「停止」靠它认人
  try {
    // 日志直接落盘（沙箱里不能管道抓 stdio，只能 stdio:'ignore' 或给 fd）
    let out = 'ignore';
    try {
      const logFile = join(repo, 'tmp', 'tts-adapter.log');
      try { mkdirSync(dirname(logFile), { recursive: true }); } catch { /* ignore */ }
      out = openSync(logFile, 'a');
    } catch { /* ignore */ }
    const c = spawn(py, [
      server, '--port', port, '--manage', '--idle-minutes', '3',
      '--breeze', 'http://127.0.0.1:7860', '--gsv', 'http://127.0.0.1:9880',
    ], {
      cwd: repo,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: ttsCleanEnv(),
    });
    c.on?.('error', () => { /* detached 起失败也不炸主流程 */ });
    // 落 PID：没有这个文件，用户只能去任务管理器里猜哪个 python 是"那个黑窗"
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(pidFile, String(c.pid || ''), 'utf8');
    } catch { /* ignore */ }
    c.unref();
  } catch {
    return false;
  }
  const t0 = Date.now();
  while (Date.now() - t0 < TTS_START_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 600));
    if (await probeTcp(host, port)) return true;
  }
  return false;
}

function logTtsFailure(dir, line) {
  try { appendFileSync(join(dir, 'failures.log'), line, 'utf8'); } catch { /* ignore */ }
}

/**
 * 让 ollama 把孩子从显存里挪出来（keep_alive:0）。
 * 6GB 的卡上 qwen2.5:7b 能占 4.2GB，正好把 GSV 需要的 3.4GB 堵死——
 * 这就是"声儿出不来"的另一半原因（不只是服务没起）。
 */
async function evictOllamaVram(host = 'http://127.0.0.1:11434') {
  try {
    const r = await fetch(host + '/api/ps', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    const models = Array.isArray(j.models) ? j.models : [];
    if (!models.length) return false;
    let n = 0;
    for (const m of models) {
      try {
        await fetch(host + '/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: m.name || m.model, keep_alive: 0 }),
          signal: AbortSignal.timeout(4000),
        });
        n += 1;
      } catch { /* 单个失败不算数 */ }
    }
    if (!n) return false;
    // 等它真把显存吐出来（keep_alive:0 是异步卸载，几百毫秒到几秒）
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r2) => setTimeout(r2, 700));
      try {
        const p = await fetch(host + '/api/ps', { signal: AbortSignal.timeout(1200) });
        const pj = await p.json();
        if (!Array.isArray(pj.models) || pj.models.length === 0) return true;
      } catch { /* 继续等 */ }
    }
    return true;
  } catch {
    return false;
  }
}

// ── 默认参数 ────────────────────────────────────────────────────────────
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';   // 温柔通用女声，比幼声少一点"每句往上挑"
const DEFAULT_RATE = '+2%';
const DEFAULT_PITCH = '+0Hz';
const DEFAULT_TIMEOUT = 20000;
const MAX_CHARS = 300;        // 短句上限，超出截断
const MIN_BYTES = 2000;       // 比这还小的 mp3 = 合成失败（空帧/只有头）
const BITRATE = 48000;        // edge-tts 默认 mp3 码率 bps，用来估算时长

const FALLBACK_PYTHON = 'E:\\Anaconda\\python.exe';

/** 写死的常用中文音色（不联网查，够用就行） */
const VOICES = [
  { id: 'zh-CN-XiaoyiNeural',   name: '晓伊',  tag: '女声·偏幼·可爱' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓',  tag: '女声·温柔·通用' },
  { id: 'zh-CN-YunxiNeural',    name: '云希',  tag: '男声·年轻·清爽' },
  { id: 'zh-CN-YunyangNeural',  name: '云扬',  tag: '男声·播音·稳重' },
  { id: 'zh-CN-XiaomoNeural',   name: '晓墨',  tag: '女声·清冷·叙事' },
  { id: 'zh-CN-YunxiaNeural',   name: '云夏',  tag: '男声·少年·元气' },
];

export function listVoices() {
  return VOICES.map((v) => ({ ...v }));
}

// ── python 解释器定位 ───────────────────────────────────────────────────
/** 绝对路径看文件在不在；裸命令名（python / python3）走 PATH 查找 */
function resolveExecutable(cmd) {
  if (!cmd) return null;
  try {
    if (isAbsolute(cmd) || /[\\/]/.test(cmd)) return existsSync(cmd) ? cmd : null;
    const dirs = String(process.env.PATH || '').split(';').filter(Boolean);
    const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean);
    for (const d of dirs) {
      for (const ext of ['', ...exts]) {
        const p = join(d, cmd + ext);
        if (existsSync(p)) return p;
      }
    }
  } catch { /* 权限/畸形 PATH 都当找不到 */ }
  return null;
}

/**
 * 依次尝试 QQBOT_PYTHON → E:\Anaconda\python.exe → python；都找不到就返回 'python' 交给系统。
 * 例外：显式传入的 override 原样使用（测试注入/特殊环境），不偷偷回退 ——
 * 否则"把 pythonBin 指到坏路径"这种失败路径永远测不出来。
 */
export function pythonBin(override) {
  if (override) return String(override);
  const cands = [
    process.env.QQBOT_PYTHON,
    FALLBACK_PYTHON,
    'python',
  ].filter(Boolean);
  for (const c of cands) {
    const hit = resolveExecutable(c);
    if (hit) return hit;
  }
  return 'python';
}

/** 能不能合成本质上取决于解释器在不在（edge_tts 由 python 自己 import） */
export function isAvailable() {
  try {
    return Boolean(resolveExecutable(pythonBin()));
  } catch {
    return false;
  }
}

// ── 文本清理 ────────────────────────────────────────────────────────────
/** 去掉会破坏命令行/读音的字符：换行、各种引号、控制符；压空白；截断 300 字 */
export function cleanText(text) {
  let t = String(text ?? '');
  t = t.replace(/[\r\n\t]+/g, ' ');
  // 引号/反引号/重音符号：文案里常见（人设里的「」保留，只清 ASCII 引号和波浪引号）
  t = t.replace(/["'`´＂＇]+/g, '');
  // 控制字符（0x00-0x1F、0x7F）
  t = t.replace(/[\u0000-\u001f\u007f]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  let truncated = false;
  if (t.length > MAX_CHARS) {
    t = t.slice(0, MAX_CHARS);
    truncated = true;
  }
  return { text: t, truncated };
}

// ── 口语化（去"念稿感"的第一道）──────────────────────────────────────────
/**
 * 把"屏幕上好看"的文字改成"念出来好听"的文字。
 *
 * 合成感的三大来源（实测听感）：
 *   ① 书面标点太规整 —— 连续的「！！！」「？？？」「。。。」念出来很机械；折叠成一个。
 *   ② 符号被逐字念 —— `~` `_` `#` `|` `*` 以及 markdown 会被念成怪音或者停顿错位。
 *   ③ 句尾没有气口 —— 逗号/句号太密时整句一口气念完，像播报。
 *
 * 所以这里做的都是**只改朗读文本、不改她发出去的文字**：
 *   去 markdown/括号注释、折叠标点、`~`→`～`（edge-tts 认这个读轻声）、
 *   数字串中间加顿号（"123"念成"一、二、三"更像人）、长句逗号处补半角空格（换气）。
 *
 * @param {string} text
 * @returns {string}
 */
export function speechify(text) {
  let t = String(text ?? '');

  // 1) 结构化的东西一律不念
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');            // markdown 图
  t = t.replace(/\[rf:[^\]]*\]/gi, ' ');                  // 引用短号
  t = t.replace(/\[MEDIA:[^\]]*\]/gi, ' ');               // 媒体标记
  t = t.replace(/\[(记忆|设定|别重复)\][^\n]*/g, ' ');
  t = t.replace(/<@[^>]*>/g, ' ');
  t = t.replace(/<qqbot-at-everyone\s*\/?>/gi, ' ');
  t = t.replace(/https?:\/\/\S+/gi, ' ');                  // 网址念出来没人听得懂
  t = t.replace(/[*_`#>|]/g, ' ');                         // 残留 markdown 符号
  t = t.replace(/[（(【\[]([^）)】\]]{0,20}?)[）)】\]]/g, (m, inner) => (
    // 短括号注释多半是动作/补充说明，念出来很怪；纯中文且 ≤8 字则保留内容
    inner && inner.length <= 8 && /^[\u4e00-\u9fa5，、]+$/.test(inner) ? `，${inner}，` : ' '
  ));

  // 2) 标点折叠：重复标点只留一个，问号感叹号保留（情绪），句号连串收成一个
  t = t.replace(/([！？!?])\1+/g, '$1');
  t = t.replace(/([。.])\1+/g, '$1');
  t = t.replace(/[，,]{2,}/g, '，');
  t = t.replace(/…{2,}/g, '…');

  // 3) 波浪号：原来读轻声拖腔，但 edge 容易把句尾挑上去；句中改逗号，句尾改句号
  t = t.replace(/[~〜～]+(?=$|[。！？!?…])/g, '。');
  t = t.replace(/[~〜～]+/g, '，');
  // 3b) 清理波浪号转换产生的「，。」「好耶 ，」这类别扭停顿
  t = t.replace(/[，,]\s*([。！？!?…])/g, '$1');
  t = t.replace(/\s+([，,。！？!?…])/g, '$1');

  // 4) 数字串加顿号：「2026」→「2、0、2、6」；但 1~4 位的普通数字（价格/年龄）不要拆
  t = t.replace(/\d{5,}/g, (d) => d.split('').join('、'));

  // 5) 换气：长句在逗号后补一个空格，念起来有停顿，不像连珠炮
  t = t.replace(/，(?=[^，]{6,})/g, '， ');

  // 6) 收尾：句末若没有标点，补一个句号（否则拖音很怪）
  t = t.trim();
  if (t && !/[。！？!?～…]$/.test(t)) t += '。';
  t = t.replace(/\s+/g, ' ').trim();
  // 6b) 全部清洗完再收一次：去「，。」「，，」和标点前空格
  t = t.replace(/[，,]\s*([。！？!?…])/g, '$1');
  t = t.replace(/\s+([，,。！？!?…])/g, '$1');
  t = t.replace(/[，,]{2,}/g, '，');
  return t;
}

/**
 * 语气尾巴：偶尔在句末加一个软语气词，把"播报音"变成"人在说话"。
 * 只在**没有**标点结尾时加，且概率可控（默认 0.3）；加的是极短的"嗯/啊/嘛/哦/呀"。
 */
const TAILS = ['嗯', '啊', '哦'];
export function addTail(text, prob = 0.1, rand = Math.random) {
  const t = String(text ?? '').trim();
  if (!t) return t;
  if (rand() > prob) return t;
  if (/[～…。！？!?]\s*$/.test(t)) return t;
  const tail = TAILS[Math.floor(rand() * TAILS.length) % TAILS.length] || '嗯';
  return t + '，' + tail + '。';
}

// ── 韵律抖动（去"每句同调"的第二道）───────────────────────────────────
/**
 * 每句都用一模一样的 rate/pitch 是"合成感"最刺耳的地方 —— 真人说话每句的
 * 语速和音高都在飘。这里给每次合成加一点随机偏移：
 *   rate  ±rateJitter 个百分点（默认 4 ⇒ +8% 会变成 +4%…+12%）
 *   pitch ±pitchJitter Hz（默认 6 ⇒ +10Hz 会变成 +4Hz…+16Hz）
 * 抖动是**确定性可关**的：jitter=0 时原样返回，测试才好断言。
 */
export function jitterProsody(rate, pitch, opts = {}, rand = Math.random) {
  const rj = Number.isFinite(Number(opts.rateJitter)) ? Number(opts.rateJitter) : 1;
  const pj = Number.isFinite(Number(opts.pitchJitter)) ? Number(opts.pitchJitter) : 1;
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  let r = num(String(rate || '').replace(/[%+]/g, ''), 2);
  let p = num(String(pitch || '').replace(/[Hhz+]/g, ''), 0);
  if (Number.isFinite(rj) && rj > 0) r += Math.round((rand() * 2 - 1) * rj);
  if (Number.isFinite(pj) && pj > 0) p += Math.round((rand() * 2 - 1) * pj);
  const rateOut = (r >= 0 ? '+' : '') + r + '%';
  const pitchOut = (p >= 0 ? '+' : '') + p + 'Hz';
  return { rate: rateOut, pitch: pitchOut, r, p };
}

// ── 路径 / 清理 ─────────────────────────────────────────────────────────
export function ttsDir(opts = {}) {
  if (opts.outDir) return String(opts.outDir);
  const root = opts.dataRoot || process.env.QQBOT_MEMORY_DATA_ROOT || process.cwd();
  return join(String(root), '.qqbot', 'tts');
}

/** 只留最近 keep 个 mp3，按 mtime 从新到旧 */
function pruneOld(dir, keep) {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.mp3'))
      .map((f) => {
        const p = join(dir, f);
        let mtime = 0;
        try { mtime = statSync(p).mtimeMs; } catch { /* 刚被删了就算了 */ }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(keep)) {
      try { unlinkSync(f.p); } catch { /* 占用/已删，跳过 */ }
    }
  } catch { /* 清理失败绝不影响本次合成 */ }
}

function newOutPath(dir) {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return join(dir, `tts-${stamp}-${rand}.mp3`);
}

// ── 核心：合成 ──────────────────────────────────────────────────────────
/**
 * @param {string} text 要念的中文
 * @param {object} opts { outDir, dataRoot, voice, rate, pitch, timeoutMs, keep, pythonOverride }
 * @returns {Promise<{ok:true,path:string,ms:number,voice:string,bytes:number,ms_est:number,truncated:boolean}
 *                  | {ok:false,error:string}>}
 */
export async function synthesize(text, opts = {}) {
  const started = Date.now();
  try {
    const voice = opts.voice || DEFAULT_VOICE;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT;
    const keep = Number(opts.keep) > 0 ? Number(opts.keep) : 30;

    // ★ 去合成感三步：先口语化（speechify）→ 再抖韵律（jitterProsody）→ 偶尔加语气尾巴
    const raw = String(text ?? '');
    const said = opts.speak === false ? raw : speechify(raw);
    const tailed = opts.speak === false ? said : addTail(said, Number.isFinite(Number(opts.tailProb)) ? Number(opts.tailProb) : 0.1);
    const { text: say, truncated } = cleanText(tailed);
    if (!say) return { ok: false, error: 'empty text' };

    const prosody = jitterProsody(opts.rate || DEFAULT_RATE, opts.pitch || DEFAULT_PITCH, {
      rateJitter: opts.rateJitter,
      pitchJitter: opts.pitchJitter,
    });
    const rate = opts.jitter === false ? (opts.rate || DEFAULT_RATE) : prosody.rate;
    const pitch = opts.jitter === false ? (opts.pitch || DEFAULT_PITCH) : prosody.pitch;

    const dir = ttsDir(opts);
    try { mkdirSync(dir, { recursive: true }); } catch (e) {
      return { ok: false, error: 'mkdir failed: ' + (e && e.message) };
    }
    const outPath = newOutPath(dir);
    const provider = String(opts.provider || process.env.QQBOT_TTS_PROVIDER || 'edge').toLowerCase();

    // 本地大模型 TTS（CosyVoice2 / IndexTTS2 / GPT-SoVITS 等）通常起一个 HTTP 服务。
    // 约定兼容 OpenAI /v1/audio/speech：POST {model,input,voice,response_format} → 音频字节。
    // 这样换模型只改 voice-config.json 的 provider/endpoint，不用改代码。
    if (provider === 'http' || provider === 'openai' || provider === 'local-http') {
      const endpoint = String(
        opts.endpoint || process.env.QQBOT_TTS_ENDPOINT || 'http://127.0.0.1:9880/v1/audio/speech',
      ).trim();
      const body = {
        model: String(opts.model || process.env.QQBOT_TTS_MODEL || 'cosyvoice2'),
        input: say,
        voice: String(opts.voice || '中文女'),
        response_format: 'mp3',
        speed: Number(opts.speed) > 0 ? Number(opts.speed) : 1,
      };
      // 本地适配层现在是"管家"：后端不在就现场拉起（GSV 冷启动 ≈30s、Breeze 可能几分钟），
      // 第一条请求会把启动时间算进去。HTTP 分支超时保底 240s，配置里可以更大但不能更小。
      const httpTimeout = Math.max(timeoutMs, 240000);
      // 先确服务在：9881 没起来时 fetch 只会给一句 "fetch failed"，群里看到的就是那句
      const _up = await ensureLocalTtsServer(endpoint, dir);
      if (!_up) {
        const msg = 'tts-http: 本地语音服务没起来（' + endpoint + ' 连不上）';
        logTtsFailure(dir, `[${new Date().toISOString()}] provider=http endpoint=${endpoint} why=service-down\n`);
        return { ok: false, error: msg + '｜先跑 skills\\local-tts\\scripts\\start-services.ps1（-Backend adapter），或看 tmp\\tts-adapter.log 与 .qqbot/tts/failures.log' };
      }
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(opts.apiKey || process.env.QQBOT_TTS_KEY
              ? { authorization: 'Bearer ' + String(opts.apiKey || process.env.QQBOT_TTS_KEY) }
              : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(httpTimeout),
        });
      } catch (e) {
        const why = 'tts-http: ' + (e?.message || String(e));
        logTtsFailure(dir, `[${new Date().toISOString()}] provider=http endpoint=${endpoint} chars=${say.length} why=${String(why).replace(/\s+/g, ' ').slice(0, 160)}\n`);
        return { ok: false, error: why };
      }
      if (!res.ok) {
        let t = '';
        try {
          t = String(await res.text()).slice(0, 200);
        } catch {
          /* ignore */
        }
        // 显存被聊天模型吃掉时（ollama 常驻 4~5GB / 6GB 卡），让 ollama 先让位再重试一次。
        // 它下次聊天会自己重新加载，代价几秒；语音则能立刻出声。
        if (/显存|vram|不够|out of memory/i.test(t) && (await evictOllamaVram())) {
          try {
            const r2 = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(opts.apiKey || process.env.QQBOT_TTS_KEY
                  ? { authorization: 'Bearer ' + String(opts.apiKey || process.env.QQBOT_TTS_KEY) }
                  : {}),
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(httpTimeout),
            });
            if (r2.ok) {
              const b2 = Buffer.from(await r2.arrayBuffer());
              if (b2.length >= MIN_BYTES) {
                try {
                  writeFileSync(outPath, b2);
                  return {
                    ok: true, path: outPath, bytes: b2.length, provider: 'http',
                    voice: body.voice, via: 'evict-ollama-retry',
                  };
                } catch { /* 落到下面统一报错 */ }
              }
            }
          } catch { /* ignore */ }
        }
        logTtsFailure(dir, `[${new Date().toISOString()}] provider=http endpoint=${endpoint} status=${res.status} why=${t.replace(/\s+/g, ' ').slice(0, 160)}\n`);
        // 本地卡实在腾不出来（6GB 卡上浏览器+QQ+桌面端就占掉 3GB 多）→ 先用在线语音顶上，
        // 保证"说话"这件事不失败；本地模型等显存空出来的那次自然就用了。
        const vramShort = /显存|vram|不够|out of memory/i.test(t);
        if (vramShort && !opts._noEdgeFallback) {
          const fb = await synthesize(raw, {
            ...opts, provider: 'edge', voice: opts.edgeVoice || DEFAULT_VOICE,
            _noEdgeFallback: true, tailProb: 0,
          });
          if (fb && fb.ok) {
            logTtsFailure(dir, `[${new Date().toISOString()}] local-vram-short → 已回退在线语音 voice=${fb.voice || ''} bytes=${fb.bytes || 0}\n`);
            return { ...fb, via: 'edge-fallback', note: '本地显存不够，先用在线语音顶一下' };
          }
        }
        return { ok: false, error: 'tts-http ' + res.status + (t ? ': ' + t.replace(/\s+/g, ' ') : '') };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_BYTES) return { ok: false, error: 'tts-http too small: ' + buf.length };
      try {
        writeFileSync(outPath, buf);
      } catch (e) {
        return { ok: false, error: 'tts-http write: ' + (e?.message || String(e)) };
      }
      pruneOld(dir, keep);
      return {
        ok: true,
        path: outPath,
        ms: Math.round((buf.length / (BITRATE / 8)) * 1000),
        voice: body.voice,
        provider: 'http',
        rate,
        pitch,
        said: say.slice(0, 120),
        bytes: buf.length,
        ms_elapsed: Date.now() - started,
        truncated,
      };
    }

    const bin = pythonBin(opts.pythonOverride || opts.python);

    // 注意必须用 `--flag=value` 而不是 `--flag value`：argparse 会把以 `-` 开头的
    // 值（比如 --rate "-6%"、--pitch "-1Hz"）当成新的选项名，直接报
    // "argument --rate: expected one argument" 并 exit 2。用等号形式才安全。
    const args = [
      '-m', 'edge_tts',
      `--text=${say}`,
      `--voice=${voice}`,
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      `--write-media=${outPath}`,
    ];

    // 关键：stdio 全 ignore。管道捕获在本机会 EPERM，且我们也不需要 edge-tts 的输出。
    // edge 偶尔会 exit 2 且 0 字节（限流/瞬时抖动），重试一次再判失败。
    let res = null;
    let bytes = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      res = await new Promise((resolve) => {
        let child;
        let settled = false;
        let timer = null;
        const done = (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } };

        try {
          child = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
        } catch (e) {
          return done({ code: null, signal: null, error: 'spawn threw: ' + (e && e.message) });
        }

        child.on('error', (e) => done({ code: null, signal: null, error: 'spawn error: ' + (e && e.code || e && e.message) }));
        child.on('close', (code, signal) => done({ code, signal, error: null }));

        timer = setTimeout(() => {
          try { child.kill(); } catch { /* 已经死了 */ }
          done({ code: null, signal: 'TIMEOUT', error: 'timeout after ' + timeoutMs + 'ms' });
        }, timeoutMs);
        if (timer.unref) timer.unref();
      });

      // 落盘校验优先于退出码：edge-tts 有时退出码非 0 但音频已完整写出
      try { bytes = statSync(outPath).size; } catch { bytes = 0; }
      if (bytes >= MIN_BYTES) break;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }

    if (bytes >= MIN_BYTES) {
      pruneOld(dir, keep);
      const ms = Math.round((bytes / (BITRATE / 8)) * 1000);
      return {
        ok: true,
        path: outPath,
        ms,
        voice,
        rate,
        pitch,
        said: say.slice(0, 120),
        bytes,
        ms_elapsed: Date.now() - started,
        truncated,
      };
    }

    // 失败：把可能写了一半的残片删掉，别留下脏文件；但先记一条失败日志，
    // 否则 edge-tts 静默失败时磁盘上什么都不留，用户只看到"没声音/0MB"。
    const why = res.error
      || (res.signal ? 'killed by ' + res.signal : `exit ${res.code}, only ${bytes} bytes`)
      || 'no audio produced';
    try {
      const logPath = join(dir, 'failures.log');
      const line = `[${new Date().toISOString()}] voice=${voice} rate=${rate} pitch=${pitch} `
        + `bytes=${bytes} code=${res.code} signal=${res.signal || '-'} why=${why.replace(/\s+/g, ' ').slice(0, 200)}\n`;
      appendFileSync(logPath, line, 'utf8');
    } catch { /* 日志写不了也不能挡住主流程 */ }
    try { unlinkSync(outPath); } catch { /* 没生成 */ }
    return {
      ok: false,
      error: bytes === 0
        ? `${why}｜edge-tts 一个字节都没产出（断网/限流/解释器缺 edge_tts），详见 .qqbot/tts/failures.log；想彻底离线就把 voice-config.json 的 provider 改成 http 指向本地模型`
        : why,
      bytes,
      log: join(dir, 'failures.log'),
    };
  } catch (e) {
    return { ok: false, error: 'unexpected: ' + (e && e.message ? e.message : String(e)) };
  }
}

export default {
  synthesize, pythonBin, isAvailable, listVoices, cleanText, ttsDir, speechify, addTail, jitterProsody,
  // 2026-10-26: 浮窗「本地语音服务 启动/停止」复用同一套拉起逻辑（pythonw + pid 落盘），
  // 免得 host 里再抄一份 spawn 参数、两边慢慢跑偏。
  ensureLocalTtsServer, findRepoRoot, findAdapterPythonw, probeTcp, ttsServiceBase,
};
