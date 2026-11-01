/**
 * lib/bili-ops.mjs — B 站账号自主运营核心
 *
 * 流程（2026-10-24 主人定）：
 *   AI 写脚本 → 出分镜图 → 逐段配音 → 字幕 → 拼 mp4 → 封面 → 草稿
 *   → 主人审核通过 → 自动上传投稿 / 自动发评论
 *
 * 约定：
 *  · 所有写操作都要过「主人校验（工具层）+ 审核状态 + 每日额度」三道闸；
 *  · 任何失败都落 records.jsonl，返回可读原因，不抛异常；
 *  · 产物全在 {dataRoot}/.qqbot/bili-ops/，不进仓库。
 */
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import * as B from './bili-api.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';
import { loadConfig as loadDrawConfig, draw, translatePrompt, stopServer as stopDrawServer } from './draw-core.mjs';
import { synthesize } from './tts-core.mjs';
import { synthesizeWarm } from './tts-polish.mjs';
import { writeScript, writeText, sanitizeTopic } from './script-writer.mjs';
import * as SFX from './sfx-lib.mjs';
import { planStoryboard } from './shot-planner.mjs';
import { drawGated } from './image-gate.mjs';
import * as TV from './text-video.mjs';

const DEFAULT_DATA_ROOT = 'F:/qqbot/dshqqbot';

// 评论/回复生成串行化：云端调用并发 1，避免一次刷出多条、也避免把 B 站接口打急
let _reviewTail = Promise.resolve();
function withReviewLock(fn) {
  const run = _reviewTail.then(fn, fn);
  _reviewTail = run.then(() => {}, () => {});
  return run;
}

export const DEFAULT_OPS_CONFIG = {
  enabled: true,
  /**
   * 出图与出视频是两条独立链路：
   *   · image.provider = local | cloud | auto（只管“画面素材从哪来”）
   *   · video.style    = text  | image | auto（text=本地文字动效，image=分镜图）
   *   · mode           = local-first | cloud-first（只决定 auto 往哪边倒）
   * media.* 保留旧键（provider/endpoint/角色锚点…），image.provider 为空时回落到它。
   */
  mode: 'local-first',
  image: { provider: 'auto' },
  publish: { mode: 'web', requireApproval: true, autoPublish: false, fallbackManual: true },
  llm: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    fallbackLocal: true,
    timeoutMs: 120000,
    temperature: 0.8,
    maxTokens: 2400,
  },
  video: {
    panels: 5,
    secondsPer: 5,
    burnSubtitle: true,
    motion: true,
    /** text=本地文字动效（默认，零成本）/ image=逐屏出图 / auto=按 mode 倒 */
    style: 'auto',
    /** 文字动效参数（720p 横向，24fps） */
    text: {
      width: 1280,
      height: 720,
      fps: 24,
      style: 'typewriter',
      accent: '#7fd7ff',
      bgImage: '',
    },
    sfx: true,
    /** 分镜规划：按节拍分配"文字屏/真图屏"、转场与音效；false = 退回旧的一屏一图 */
    planner: true,
    /** 一单最多几张真图（云端质量不可控，默认只花在开场和例证上） */
    maxImageShots: 2,
    /** 每屏出图最多试几次（含重 roll；质检不过就换角度再来） */
    imageAttempts: 3,
    /** 出图质检（清晰度/色彩/熵/色数/查重）：false = 画完直接用，不做体检 */
    imageGate: true,
    /** 质检评分达到多少就收工（0~1，越高越挑） */
    imageGoodEnough: 0.84,
    /** 右下角小蓝（程序化绘制，不是 AI 出图）：文字屏专用 */
    character: true,
    characterSize: 300,
    // 节奏：单屏不要拖太久；配音语速略快，剪起来才有“张力”
    shotMinSec: 2.4,
    shotMaxSec: 5.2,
    fadeSec: 0.22,
    // 视频配音走"温柔档"：比默认慢一点、低一点，配合 tts-polish 的分段呼吸
    ttsRate: '-4%',
    bgm: true,
    // 配音：留空 = 跟 voice-config.json 走（本地 GPT-SoVITS 的可爱音色），
    // 想给视频单独指定再在这里写（2026-10-27：以前默认写死 edge 的
    // zh-CN-XiaoxiaoNeural，导致成片永远是那个"成熟女声"，本地语音根本没被唤醒）。
    ttsVoice: '',
    ttsProvider: '',
    ttsEndpoint: '',
    ttsModel: '',
    tid: 21,
    copyright: 1,
  },
  /** 音效库：{dataRoot}/音效，空库会用 ffmpeg 现场合成 9 个语义音效兜底 */
  sfx: { enabled: true, gain: 0.35, maxPerPanel: 2, dir: '' },
  // B 站成片默认走云端出图（Pollinations，免费、无需 Key），失败才回退本地 SD1.5。
  // 云端图右下角有水印，成片前用 ffmpeg 裁掉底部 cropBottom 像素。
  media: {
    provider: 'cloud',
    endpoint: 'https://image.pollinations.ai/prompt/{prompt}?width={w}&height={h}&nologo=true&model=flux',
    characterPrompt:
      'a cute anime whale girl with long deep blue-purple wavy hair, white frilled headband with a blue bow, deep blue and white maid dress, whale tail, ',
    // [qqbot-mod] handdrawn 2026-10-31：主人反馈「SD 图算手绘但差点感觉」——cel shading+clean lineart
    //   是赛璐璐平涂，太干净。换成水彩质感+笔触+纸纹（实际生效值在 bili-ops-config.json，这里同步兜底）。
    stylePrompt: 'hand-drawn anime illustration, soft watercolor shading, visible brush strokes, sketchy warm linework, subtle paper grain, soft light, no 3D render, simple background, ',
    timeoutMs: 90000,
    width: 1024,
    height: 576,
    minGapMs: 12000,
    cropBottom: 28,
    // B 站成片只用云算力：默认不在云端失败时偷偷切本地 SD1.5
    fallbackLocal: false,
  },
  jianying: { mode: 'assets', draftDir: '' },
  // 评论审核：云端先写，本地只按主人建议改写；一次最多 2 条、并发 1
  review: { maxPerBatch: 2, concurrency: 1, cloudFirst: true, localFix: true },
  limits: { dailyVideos: 1, dailyComments: 5, dailyRenames: 1, dailyReplies: 10 },
  schedule: { enabled: false, times: ['10:30'], topics: [], notify: true },
  guard: { maxTopicChars: 200 },
};

// 成片/出图尺寸：默认横屏 1280×720（出图压到 768×432，6GB 卡跑满 720p 太慢/易爆）。
// 竖屏支持（2026-10-26）：B 站竖屏是 1080×1920，靠 applySize() 临时改成竖屏；出图 576×1024。
// 之所以用可变变量而不是传参：这几个尺寸被 renderJob 内部多个函数直接引用，传参要动十几处。
// 现在 review.concurrency = 1（串行出片），不会有交叉污染；将来要并发必须改成显式传参。
let QUALITY_W = 1280;
let QUALITY_H = 720;
let GEN_W = 768;
let GEN_H = 432;

// 统一色彩标签：B 站/播放器按 tv-range + bt709 解读，不写会被标成 yuvj420p(pc, bt470bg/unknown)
const COLOR_ARGS = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];

// 角色出图负向词：SD1.5 很容易把"蓝紫发"画成紫发，定妆照一紫整片都紫。
// 2026-10-28 补防微恐词组（主人反馈：渲染偶发诡异脸/多手指，看着发毛）：
// 手部畸形/多指/长脖子/诡异谷是 SD1.5 解剖翻车重灾区，全部压掉。
const CHARACTER_NEG = 'purple hair, violet hair, lavender hair, pink hair, magenta hair, blank background, monochrome, multiple girls, different character, text, watermark, picture frame, poster, wall, wood, wooden board, border, letterbox, black bars, mockup, framed picture, canvas border, bad hands, extra fingers, missing fingers, fused fingers, deformed hands, mutated limbs, extra limbs, long neck, distorted face, asymmetrical eyes, uncanny valley, creepy, horror, gore, blood, dark aura, scary face';

// ── 合成路线（2026-10-27）──────────────────────────────────────────────
// 只用 img2img 派生时，SD 在 strength 0.5~0.7 之间要么保住上一张的构图（画框、
// 海报、同一张脸），要么把发色/服装改掉；逐屏换场景时身份必然漂移，主人反馈
// "画面和话没关系、人物不像她"。合成路线把两件事拆开：场景让 SD 画（不带角色），
// 人物用固定透明立绘贴上去，身份 100% 稳定，场景也真的会跟着旁白变。
const POSE_DIR = 'F:/qqbot/assets/char/pose';
// 空镜用的负向词：本地 SD1.5 对 "no people" 不敏感，必须把人物词压低权重。
const CHAR_SCENE_NEG = CHARACTER_NEG + ', (1girl:1.8), (person:1.8), (human:1.6), face, eyes, hands, arms, portrait, sitting person';
const POSE_ORDER = ['idle', 'talk', 'wave', 'happy', 'point'];
const BEAT_POSE = { hook: 'wave', point: 'talk', turn: 'happy', proof: 'point', cta: 'wave' };

/** 这一屏用哪个立绘：优先 beat 映射，其次按屏序轮换，缺图就回退 idle。 */
function pickPose(shot, i) {
  const beat = String(shot?.beat || '');
  const want = BEAT_POSE[beat] || POSE_ORDER[i % POSE_ORDER.length];
  const cand = [want, 'idle', 'talk'].map((n) => join(POSE_DIR, n + '.png'));
  for (const p of cand) {
    try {
      if (statSync(p).size > 1000) return p;
    } catch { /* 试下一个 */ }
  }
  return '';
}

/** 程序化空镜：按画面描述挑一套配色（海/夜/街/咖啡馆/房间），确定性、永不出现人物。 */
async function sceneBg(prompt, outPath, o = {}) {
  const s = String(prompt || '').toLowerCase();
  const kind = /sea|water|underwater|ocean|deep|bubble|wave/.test(s) ? 'sea'
    : /night|star|moon|dark sky|starry/.test(s) ? 'night'
      : /street|city|road|rain|neon|crossing/.test(s) ? 'street'
        : /cafe|coffee|bar|restaurant|kitchen/.test(s) ? 'cafe'
          : 'room';
  const script = 'F:/qqbot/qqbot-mod/scripts/scene_bg.py';
  const py = o.pythonBin || 'F:/qqbot/.venv-draw/Scripts/python.exe';
  const r = await new Promise((resolve) => {
    try {
      const p = spawn(py, [script, '--out', outPath, '--w', String(o.width || 576), '--h', String(o.height || 1024),
        '--kind', kind, '--seed', String(o.seed || 7)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr?.on('data', (b) => { err += String(b); });
      p.on('error', (e) => resolve({ code: -1, err: e.message }));
      p.on('close', (code) => resolve({ code, err }));
    } catch (e) {
      resolve({ code: -1, err: e?.message || String(e) });
    }
  });
  if (r.code === 0 && existsSync(outPath)) return { ok: true, path: outPath, kind };
  return { ok: false, reason: 'scene:' + (r.err || r.code) };
}

/** 调 python 把立绘贴到场景图上。失败返回 {ok:false,reason}，调用方退回纯场景图。 */async function composeChar(bgPath, posePath, outPath, o = {}) {
  const script = 'F:/qqbot/qqbot-mod/scripts/compose_char.py';
  const py = o.pythonBin || 'F:/qqbot/.venv-draw/Scripts/python.exe';
  try {
    const args = [script, '--bg', bgPath, '--pose', posePath, '--out', outPath,
      '--height-ratio', String(o.heightRatio ?? 0.66),
      '--bottom', String(o.bottom ?? 0.03),
      '--align', String(o.align || 'center')];
    const r = await new Promise((resolve) => {
      try {
        const p = spawn(py, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        p.stderr?.on('data', (b) => { err += String(b); });
        p.on('error', (e) => resolve({ code: -1, err: e.message }));
        p.on('close', (code) => resolve({ code, err }));
      } catch (e) {
        resolve({ code: -1, err: e?.message || String(e) });
      }
    });
    if (r.code === 0 && existsSync(outPath)) return { ok: true, path: outPath };
    return { ok: false, reason: 'python:' + (r.err || r.code) };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/** 按方向切换成片/出图尺寸，返回上一组尺寸供 finally 还原。 */
export function applySize(orientation) {
  const v = String(orientation || '').toLowerCase();
  const vertical = v === 'vertical' || v === 'portrait' || v === 'shu' || v === '9:16';
  const prev = { QUALITY_W, QUALITY_H, GEN_W, GEN_H };
  QUALITY_W = vertical ? 1080 : 1280;
  QUALITY_H = vertical ? 1920 : 720;
  // [qqbot-mod] 2026-10-29 升分辨率：576→640 / 768→832，SD1.5 在 6GB 卡仍稳，清晰度 +20%
  GEN_W = vertical ? 640 : 832;
  GEN_H = vertical ? 1136 : 480;
  return { prev, vertical, size: { w: QUALITY_W, h: QUALITY_H, gw: GEN_W, gh: GEN_H } };
}

/** 还原 applySize 改过的尺寸。 */
export function restoreSize(prev) {
  if (!prev) return;
  QUALITY_W = prev.QUALITY_W;
  QUALITY_H = prev.QUALITY_H;
  GEN_W = prev.GEN_W;
  GEN_H = prev.GEN_H;
}

// ── 路径 / 配置 ───────────────────────────────────────────────────────

export function dataRootOf(env = {}) {
  const fromCaps = env?.caps?.dataRoot;
  if (fromCaps) return String(fromCaps);
  const fromEnv = String(process.env.QQBOT_MEMORY_DATA_ROOT || '').trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_DATA_ROOT;
}

export function opsConfigPath(dataRoot) {
  return join(String(dataRoot), '.qqbot-extensions', 'bili-ops-config.json');
}

export function paths(dataRoot) {
  // 产物默认放 {dataRoot}/.qqbot/bili-ops；可在 bili-ops-config.json 的
  // storage.root 指到别的盘（例如 F:/qqbot/data/bili-ops），避免 C 盘膨胀，
  // 也避开宿主对某些 .qqbot 子目录的写限制（ffmpeg 子进程会 EPERM）。
  let root = join(String(dataRoot), '.qqbot', 'bili-ops');
  try {
    const c = JSON.parse(readFileSync(opsConfigPath(dataRoot), 'utf8'));
    const custom = String(c?.storage?.root || '').trim();
    if (custom) root = custom;
  } catch {
    /* 用默认 */
  }
  return {
    root,
    jobs: join(root, 'jobs'),
    records: join(root, 'records.jsonl'),
    comments: join(root, 'comment-drafts.jsonl'),
    drafts: join(root, 'script-drafts.jsonl'),
    state: join(root, 'state.json'),
    quota: join(String(dataRoot), '.qqbot', 'bili-ops-quota.json'),
    secret: join(String(dataRoot), 'bili-ops-secret.json'),
    jianying: join(root, '剪映草稿'),
  };
}

/**
 * [qqbot-mod] dubbing-hint 2026-10-29：从选题/脚本文本里识别主人指定的配音引擎。
 *
 * 背景（主人实测抱怨）：工单里明写「最好能全程用 Index/Breeze 配音」，结果成片还是 GSV ——
 * 因为主模型常把这句留在 topic 正文里，忘了翻译成 plan 的 dubbing 参数。
 * 这里做兜底：显式参数永远优先；没传时扫文本提及。两者都没提 → ''（跟随全局）。
 * 同时提 Index 和 Breeze（如「Index/Breeze」）→ 取 index（情感最足，主人偏好）。
 */
export function detectDubbing(...texts) {
  const s = texts.filter(Boolean).join('\n').toLowerCase();
  if (/indextts|index[\s/／\-|·]?tts|(^|[^a-z])index(?![a-z])/.test(s)) return 'index';
  if (/breeze/.test(s)) return 'breeze';
  if (/gsv|gpt-?sovits/.test(s)) return 'gsv';
  return '';
}

/**
 * 音效库根目录（SFX 模块会自己在根下建「音效/」）。
 * 为什么需要：默认根是 {dataRoot}，但宿主的 F:/qqbot/dshqqbot 目录对「新建子目录」是拒绝的
 * （实测 New-Item 'F:\qqbot\dshqqbot\zztest-a' → 对路径访问被拒绝），于是
 *   音效库初始化失败：EPERM: operation not permitted, mkdir 'F:\qqbot\dshqqbot\音效\lib\builtin'
 * 整条链路没音效、每次出片都带一条 warning。这里先试 dataRoot，写不动就退到 storage.root
 * （storage.root 默认在可写盘，实测 F:/qqbot/data/bili-ops 可写）。
 */
export function sfxRootOf(dataRoot) {
  // 2026-10-27：之前先试 dataRoot，但 dshqqbot\音效 建得出目录、写 index.json 却 EPERM
  // （宿主对那个根的写限制），于是每单都报"音效库初始化失败"。改成先试 storage.root
  // （可写盘），dataRoot 只作兜底。
  const probe = (base) => {
    const p = join(String(base), '音效', 'lib', 'builtin');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(String(base), '音效', '.probe'), '1', 'utf8');
    return String(base);
  };
  try {
    return probe(paths(dataRoot).root);
  } catch {
    try {
      return probe(dataRoot);
    } catch {
      return String(dataRoot);
    }
  }
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadOpsConfig(dataRoot) {
  try {
    const raw = JSON.parse(readFileSync(opsConfigPath(dataRoot), 'utf8'));
    return deepMerge(DEFAULT_OPS_CONFIG, raw || {});
  } catch {
    return deepMerge(DEFAULT_OPS_CONFIG, {});
  }
}

export function saveOpsConfig(dataRoot, cfg) {
  try {
    mkdirSync(join(String(dataRoot), '.qqbot-extensions'), { recursive: true });
    // [qqbot-mod] atomic-write 2026-10-27：原子写
    writeJsonAtomic(opsConfigPath(dataRoot), cfg);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把配置解析成一份“这单怎么干”的计划（出图来源 / 视频形态）。
 * 纯函数，方便单测。
 */
export function resolvePlan(ops = {}) {
  const cfg = ops && typeof ops === 'object' ? ops : {};
  const endpoint = String(cfg.media?.endpoint || '').trim();
  const mode = String(cfg.mode || 'local-first').toLowerCase() === 'cloud-first' ? 'cloud-first' : 'local-first';

  const legacy = String(cfg.media?.provider || '').toLowerCase();
  let img = String(cfg.image?.provider || '').trim().toLowerCase();
  if (!img) img = legacy === 'cloud' ? 'cloud' : legacy === 'auto' ? 'auto' : 'local';
  if (!['local', 'cloud', 'auto'].includes(img)) img = 'auto';
  let imageProvider = img === 'auto' ? (mode === 'cloud-first' ? 'cloud' : 'local') : img;
  if (imageProvider === 'cloud' && !endpoint) imageProvider = 'local';

  let vs = String(cfg.video?.style || '').trim().toLowerCase();
  if (!['text', 'image', 'auto'].includes(vs)) vs = 'auto';
  const videoStyle = vs === 'auto' ? (mode === 'cloud-first' ? 'image' : 'text') : vs;
  return { mode, imageProvider, videoStyle, endpoint, cloudAvailable: !!endpoint };
}

/**
 * 成片配音参数：config 里没写就跟着 voice-config.json 走。
 * 这样主人换一次音色（面板试听/切引擎），视频配音也跟着换，不用两边各配一遍。
 * @returns {{provider:string, voice:string, endpoint:string, model:string}}
 */
export function resolveTts(dataRoot, ops = {}) {
  let vc = {};
  try {
    vc = JSON.parse(readFileSync(join(String(dataRoot), '.qqbot-extensions', 'voice-config.json'), 'utf8'));
  } catch { /* 没配置就走默认 */ }
  const v = ops.video || {};
  // [qqbot-mod] 2026-10-28 主人明确：视频配音不要用 edge，默认走本地最佳音色链路
  //   （voice-config provider=http + 适配层梯队降级，GSV 挂了自动划到下一档）
  const provider = String(v.ttsProvider || vc.provider || 'http').trim().toLowerCase();
  const voice = String(v.ttsVoice || vc.voice || 'xiaolan_cute').trim();
  const endpoint = String(v.ttsEndpoint || vc.endpoint || 'http://127.0.0.1:9881/v1/audio/speech').trim();
  const model = String(v.ttsModel || vc.model || (provider === 'http' ? 'gsv' : '')).trim();
  // [qqbot-mod] vram-soft 2026-10-28：成片配音是 IndexTTS-2.5 的主场（离线、不抢答），
  // 显存不够也得能起 —— 跟随 voice-config.json 的 vramSoft 开关。
  const vramSoft = vc.vramSoft === true || vc.vramSoft === 'true';
  return { provider, voice, endpoint, model, vramSoft };
}

export function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  return s.length <= 8 ? '***' : s.slice(0, 4) + '***' + s.slice(-4);
}

/** 读一行 key 文件：忽略空行/注释，去掉首尾引号 */
function readKeyLine(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    for (const line of raw.split(String.fromCharCode(10))) {
      const t = line.split(String.fromCharCode(13)).join('').trim();
      if (!t || t.startsWith('#')) continue;
      return t.split('"').join('').split("'").join('');
    }
  } catch {
    /* ignore */
  }
  return '';
}

/** Key 只从环境变量或本地 secret 文件读（不进仓库） */
export function readSecret(dataRoot) {
  const fromEnv = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (fromEnv) return { apiKey: fromEnv, from: 'env' };
  // 新的统一位置：<项目根>/secrets/deepseek.txt（dataRoot 通常是 <项目根>/dshqqbot）
  const flat = readKeyLine(join(String(dataRoot || ''), '..', 'secrets', 'deepseek.txt'));
  if (flat) return { apiKey: flat, from: 'secrets-file' };
  try {
    const j = JSON.parse(readFileSync(paths(dataRoot).secret, 'utf8'));
    const key = String(j?.apiKey || j?.deepseek?.apiKey || '').trim();
    if (key) return { apiKey: key, from: 'file' };
  } catch {
    /* ignore */
  }
  return { apiKey: '', from: '' };
}

function ensureDirs(dataRoot) {
  const p = paths(dataRoot);
  for (const d of [p.root, p.jobs]) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return p;
}

// ── 额度 ─────────────────────────────────────────────────────────────

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const QUOTA_KEY = { video: 'videos', comment: 'comments', rename: 'renames', reply: 'replies' };
const QUOTA_LIMIT = { video: 'dailyVideos', comment: 'dailyComments', rename: 'dailyRenames', reply: 'dailyReplies' };

function readQuota(dataRoot) {
  try {
    const j = JSON.parse(readFileSync(paths(dataRoot).quota, 'utf8'));
    if (j && j.date === localDay()) return j;
  } catch {
    /* ignore */
  }
  return { date: localDay(), videos: 0, comments: 0, renames: 0, replies: 0 };
}

export function checkQuota(dataRoot, kind, limits = {}) {
  const key = QUOTA_KEY[kind];
  const lim = Number(limits[QUOTA_LIMIT[kind]]);
  if (!key) return { ok: true };
  const q = readQuota(dataRoot);
  const used = Number(q[key]) || 0;
  if (Number.isFinite(lim) && lim >= 0 && used >= lim) {
    return { ok: false, error: `${kind} 今日额度已用完（${used}/${lim}）`, used, limit: lim };
  }
  return { ok: true, used, limit: Number.isFinite(lim) ? lim : null };
}

export function bumpQuota(dataRoot, kind) {
  const key = QUOTA_KEY[kind];
  if (!key) return readQuota(dataRoot);
  const q = readQuota(dataRoot);
  q[key] = (Number(q[key]) || 0) + 1;
  try {
    mkdirSync(join(String(dataRoot), '.qqbot'), { recursive: true });
    writeFileSync(paths(dataRoot).quota, JSON.stringify(q), 'utf8');
  } catch {
    /* ignore */
  }
  return q;
}

// ── 任务 ─────────────────────────────────────────────────────────────

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

export function newJobId() {
  return 'bb-' + stamp() + '-' + Math.random().toString(36).slice(2, 6);
}

export function newJob(dataRoot, opts = {}) {
  const p = ensureDirs(dataRoot);
  const id = opts.id || newJobId();
  const dir = join(p.jobs, id);
  try {
    mkdirSync(join(dir, 'panels'), { recursive: true });
    mkdirSync(join(dir, 'audio'), { recursive: true });
  } catch {
    /* ignore */
  }
  const job = {
    id,
    dataRoot: String(dataRoot),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'draft',
    topic: sanitizeTopic(opts.topic),
    style: String(opts.style || 'default'),
    title: '',
    desc: '',
    tags: [],
    panels: [],
    durationSec: 0,
    video: '',
    cover: '',
    srt: '',
    dir,
    llm: '',
    published: null,
    error: '',
  };
  saveJob(job);
  return job;
}

export function jobDir(dataRoot, id) {
  return join(paths(dataRoot).jobs, String(id));
}

export function saveJob(job) {
  try {
    job.updatedAt = Date.now();
    mkdirSync(job.dir, { recursive: true });
    writeFileSync(join(job.dir, 'meta.json'), JSON.stringify(job, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function getJob(dataRoot, id) {
  if (!id) return null;
  try {
    const dir = jobDir(dataRoot, id);
    const j = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    j.dir = dir;
    return j;
  } catch {
    return null;
  }
}

export function updateJob(dataRoot, id, patch = {}) {
  const j = getJob(dataRoot, id);
  if (!j) return null;
  Object.assign(j, patch);
  saveJob(j);
  return j;
}

export function listJobs(dataRoot, { limit = 20 } = {}) {
  const dir = paths(dataRoot).jobs;
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const j = getJob(dataRoot, n);
    if (j) out.push(j);
  }
  // [qqbot-mod] stalled-render sweep 2026-10-28：宿主重启/渲染进程被杀后，rendering 状态
  //   会永久卡住（历史任务里永远转圈、重试按钮不出现）。列表时把 updatedAt 超 30 分钟的
  //   rendering 任务标成 failed，浮窗就能对它重试。
  const now = Date.now();
  for (const j of out) {
    if (j.status === 'rendering' && now - Number(j.updatedAt || j.createdAt || 0) > 30 * 60 * 1000) {
      updateJob(dataRoot, j.id, { status: 'failed', stage: 'failed', error: '渲染中断（进程退出或宿主重启），点重试重新出片' });
      j.status = 'failed';
      j.error = '渲染中断（进程退出或宿主重启），点重试重新出片';
    }
  }
  out.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  return out.slice(0, Math.max(1, Number(limit) || 20));
}

/**
 * 一句话 → 成片（写脚本 → 分镜 → 出图/配音/字幕 → mp4）。
 * 浮窗「生成视频」和工具 plan 都走这里，保证"先有分镜再渲染"，不再出现
 * `任务没有分镜（先写脚本）` 这种半截任务（2026-10-27 修）。
 *
 * @param {string} dataRoot
 * @param {object} cfg  bili-ops 配置
 * @param {object} opt  { topic, style, panels, seconds, orientation, scriptJson, secret, meta }
 * @returns {Promise<{ok:boolean, jobId?:string, job?:object, error?:string, detail?:object, script?:object}>}
 */
export async function planAndRender(dataRoot, cfg = {}, opt = {}) {
  const topic = sanitizeTopic(opt.topic, cfg.guard?.maxTopicChars || 200);
  if (!topic) return { ok: false, error: '缺少选题（topic）' };
  const wantPanels = Math.max(2, Math.min(12, Number(opt.panels) || Number(cfg.video?.panels) || 5));

  // 先把任务建出来（status=scripting），浮窗立刻能看到"正在写分镜"，
  // 而不是等脚本写完才凭空冒出一个任务、失败时连记录都没有。
  const job = newJob(dataRoot, { id: opt.jobId || undefined, topic, style: opt.style || 'default' });
  job.title = topic.slice(0, 30);
  job.orientation = String(opt.orientation || cfg.video?.orientation || '').toLowerCase() === 'vertical'
    ? 'vertical' : 'horizontal';
  // [qqbot-mod] 2026-10-28：任务级配音引擎（opt.dubbing = gsv|breeze|index）。
  // [qqbot-mod] 2026-10-29：没显式传时，从选题/脚本里拈主人提及的引擎（Index/Breeze 兑底）。
  const dub = ['gsv', 'breeze', 'index'].includes(String(opt.dubbing || '').toLowerCase())
    ? String(opt.dubbing).toLowerCase()
    : detectDubbing(opt.topic, opt.scriptJson);
  if (dub) job.dubbing = dub;
  job.status = 'scripting';
  job.stage = 'script';
  saveJob(job);

  let script = null;
  // ① 首选：调用方（主模型）直接给脚本 —— 她在对话里就想好分镜了
  //    scriptJson 既接受 JSON 字符串（工具入参），也接受已解析好的对象（lib 直接调用）。
  const rawScript = typeof opt.scriptJson === 'string'
    ? opt.scriptJson.trim()
    : (opt.scriptJson && typeof opt.scriptJson === 'object' ? opt.scriptJson : '');
  if (rawScript) {
    try {
      const raw = typeof rawScript === 'string' ? JSON.parse(rawScript) : rawScript;
      const ps = Array.isArray(raw.panels) ? raw.panels : [];
      if (ps.length < 2 || ps.length > 12) throw new Error('panels 需要 2~12 屏');
      script = {
        ok: true,
        llm: String(opt.meta?.llm || 'agent'),
        title: String(raw.title || topic).slice(0, 80),
        desc: String(raw.desc || '').slice(0, 900),
        tags: (Array.isArray(raw.tags) ? raw.tags : []).map((x) => String(x).slice(0, 20)).slice(0, 8),
        panels: ps.map((p, i) => ({
          narration: String(p?.narration || p?.text || '').trim().slice(0, 200) || `第 ${i + 1} 屏`,
          imagePrompt: String(p?.imagePrompt || p?.image || p?.prompt || '').trim().slice(0, 500)
            || String(p?.narration || topic).slice(0, 200),
        })),
      };
    } catch (e) {
      const msg = 'scriptJson 不是合法脚本：' + (e instanceof Error ? e.message : String(e));
      updateJob(dataRoot, job.id, { status: 'failed', stage: 'failed', error: msg });
      return { ok: false, jobId: job.id, error: msg };
    }
  }

  // ② 否则让 script-writer 写（云端 → 本地 → 模板三级兜底，模板永远能出片）
  if (!script) {
    // [qqbot-mod] 2026-10-28 视频口播 skill：开场问好 + 汇报上期数据 + 汇报学习进展。
    //   briefing 备料（真数据+真事件）失败不挡出片 —— 静默降级为老结构。
    let briefing = '';
    try {
      const VB = await import('./video-briefing.mjs');
      const b = await VB.buildBriefing(dataRoot);
      if (b && b.ok && b.text) briefing = b.text;
    } catch { /* ignore */ }
    script = await writeScript(
      { topic, style: opt.style || 'default', panels: wantPanels, seconds: opt.seconds, briefing },
      cfg.llm,
      { dataRoot, apiKey: opt.secret?.apiKey }
    );
  }
  if (!script?.ok || !(script.panels || []).length) {
    const msg = script?.error || '脚本生成失败（没有分镜）';
    updateJob(dataRoot, job.id, { status: 'failed', stage: 'failed', error: msg });
    return { ok: false, jobId: job.id, error: msg };
  }

  job.title = script.title;
  job.desc = script.desc;
  job.tags = script.tags;
  job.llm = script.llm;
  job.panels = script.panels.map((p) => ({ narration: p.narration, imagePrompt: p.imagePrompt }));
  job.script = { llm: script.llm, panels: job.panels.length, at: Date.now() };
  job.status = 'rendering';
  job.stage = 'render';
  saveJob(job);

  const r = await renderJob(job, cfg, { dataRoot });
  if (!r.ok) {
    updateJob(dataRoot, job.id, { status: 'failed', stage: 'failed', error: String(r.error || '渲染失败') });
    return { ok: false, jobId: job.id, error: r.error || '渲染失败', detail: r.detail, script };
  }
  const done = r.job || job;
  const saved = updateJob(dataRoot, job.id, {
    status: 'awaiting_review',
    stage: 'done',
    durationSec: done.durationSec,
    video: done.video,
    cover: done.cover,
    srt: done.srt,
    panels: done.panels || job.panels,
    size: r.detail?.size,
    tts: r.detail?.tts,
    warnings: (r.detail?.warnings || []).slice(0, 8),
  }) || done;
  return { ok: true, jobId: job.id, job: saved, detail: r.detail, script };
}

// ── 记录 ─────────────────────────────────────────────────────────────

export function appendRecord(dataRoot, rec = {}) {
  try {
    const p = ensureDirs(dataRoot);
    const ts = Date.now();
    appendFileSync(p.records, JSON.stringify({ ts, at: new Date(ts).toISOString(), ...rec }) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 读操作记录（可检索；给“万一出事能查/能道歉”用）。
 * q 会在整条 JSON 里做不区分大小写的包含匹配，type/bvid/jobId 是精确/包含过滤。
 */
export function readRecords(dataRoot, { limit = 30, q = '', type = '', bvid = '', jobId = '', since = 0 } = {}) {
  try {
    const lines = readFileSync(paths(dataRoot).records, 'utf8').split(/\r?\n/).filter(Boolean);
    const ql = String(q || '').trim().toLowerCase();
    const rows = [];
    for (const l of lines) {
      let r = null;
      try { r = JSON.parse(l); } catch { continue; }
      if (!r) continue;
      if (type && String(r.type || '') !== String(type)) continue;
      if (bvid && !String(r.bvid || '').includes(String(bvid))) continue;
      if (jobId && !String(r.jobId || '').includes(String(jobId))) continue;
      if (since && Number(r.ts || 0) < Number(since)) continue;
      if (ql && !JSON.stringify(r).toLowerCase().includes(ql)) continue;
      rows.push(r);
    }
    return rows.slice(-Math.max(1, Number(limit) || 30)).reverse();
  } catch {
    return [];
  }
}

// ── SRT ──────────────────────────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0');
}

function srtTime(sec) {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(Math.min(999, ms)).padStart(3, '0')}`;
}

/** panels: [{ narration, start, end }]（秒） */
export function buildSrt(panels = []) {
  const rows = [];
  panels.forEach((p, i) => {
    const text = String(p?.narration || '').trim();
    if (!text) return;
    rows.push(`${rows.length + 1}\n${srtTime(p.start)} --> ${srtTime(p.end)}\n${text}`);
  });
  return rows.length ? rows.join('\n\n') + '\n' : '';
}

// ── ffmpeg ───────────────────────────────────────────────────────────

/** [qqbot-mod] 2026-10-29：用 ffmpeg 实测媒体时长（秒）——
 *  治「合成耗时被当成音频长度」的切声 bug。ffmpeg -i 不带输出会非零退出，
 *  但 Duration 在 stderr 里；照 runFfmpeg 的沙箱纪律（不管道）落盘再读。解析不了回 0。 */
function probeMediaSec(exe, file) {
  return new Promise((resolve) => {
    if (!exe || !file) return resolve(0);
    const logPath = join(tmpdir(), 'qqbot-ffdur-' + process.pid + '-' + Date.now() + '.log');
    let fd = -1;
    try { fd = openSync(logPath, 'w'); } catch { return resolve(0); }
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(logPath); } catch { /* ignore */ }
      resolve(v);
    };
    let p;
    try {
      p = spawn(exe, ['-hide_banner', '-i', file], { stdio: ['ignore', fd, fd] });
    } catch { finish(0); return; }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } finish(0); }, 15000);
    p.on('error', () => { clearTimeout(timer); finish(0); });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(readFileSync(logPath, 'utf8'));
        finish(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
      } catch { finish(0); }
    });
  });
}

function runFfmpeg(exe, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let done = false;
    // DSH 沙箱不允许子进程用管道 stdio，所以把 stderr 落到临时文件再读尾巴。
    const logPath = join(tmpdir(), 'qqbot-ffmpeg-' + process.pid + '-' + Date.now() + '.log');
    let logFd = -1;
    try {
      logFd = openSync(logPath, 'w');
    } catch {
      logFd = -1;
    }
    const tail = () => {
      try {
        const s = readFileSync(logPath, 'utf8');
        return s.slice(-500).replace(/\s+/g, ' ').trim();
      } catch {
        return '';
      }
    };
    const cleanup = () => {
      try {
        if (logFd >= 0) closeSync(logFd);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(logPath);
      } catch {
        /* ignore */
      }
    };
    const finish = (r) => {
      if (!done) {
        done = true;
        cleanup();
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(exe, args, {
        stdio: ['ignore', 'ignore', logFd >= 0 ? logFd : 'ignore'],
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, reason: 'spawn: ' + (e?.message || String(e)) });
    }
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      finish({ ok: false, reason: 'spawn: ' + (e?.message || String(e)) });
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      const err = code === 0 ? '' : tail();
      finish({ ok: code === 0, reason: code === 0 ? '' : 'exit-' + code + (err ? ': ' + err : '') });
    });
  });
}

/** 生成一段 CC0 风格的水下氛围底噪（无人声，循环用），只在第一次生成。 */
async function ensureBgm(dataRoot, exe) {
  const dir = join(paths(dataRoot).root, 'bgm');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const out = join(dir, 'underwater.m4a');
  if (existsSync(out)) return out;
  const r = await runFfmpeg(
    exe,
    [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=110:duration=90',
      '-f', 'lavfi', '-i', 'sine=frequency=164.81:duration=90',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=90:amplitude=0.06',
      '-filter_complex',
      '[0:a][1:a][2:a]amix=inputs=3:duration=longest,lowpass=f=480,tremolo=f=0.12:d=0.5,volume=0.35[a]',
      '-map', '[a]',
      '-c:a', 'aac',
      '-b:a', '96k',
      out,
    ],
    60000
  );
  return r.ok ? out : '';
}

/** 滤镜里的 Windows 路径要转义盘符冒号 */
function filterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function pickFont() {
  const cands = ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/simhei.ttf'];
  return cands.find((p) => existsSync(p)) || '';
}

async function coverFromImage(exe, src, out) {
  const r = await runFfmpeg(exe, [
    '-y',
    '-i', src,
    '-vf', `scale=${QUALITY_W}:${QUALITY_H}:force_original_aspect_ratio=decrease,pad=${QUALITY_W}:${QUALITY_H}:(ow-iw)/2:(oh-ih)/2:color=black`,
    '-q:v', '3',
    '-frames:v', '1',
    '-update', '1',
    out,
  ], 60000);
  if (r.ok) return true;
  try {
    writeFileSync(out.replace(/\.jpg$/i, '.png'), readFileSync(src));
  } catch {
    /* ignore */
  }
  return false;
}

let _lastCloudAt = 0;

/**
 * 给一屏挑音效：语义 → 音效库；每屏最多 maxPerPanel 个，绝不重复同一个文件。
 * @returns {Array<{path:string,atSec:number,gain:number,kind:string}>}
 */
export function pickSfxCues(dataRoot, seg, style, ops = {}) {
  const max = Math.max(0, Math.min(3, Number(ops.sfx?.maxPerPanel) || 2));
  if (!max) return [];
  const dur = Math.max(1, Number(seg?.dur) || 3);
  const base = Math.max(0.05, Math.min(1, Number(ops.sfx?.gain) || 0.35));
  const idx = Number(seg?.panel?.index) || 1;
  const out = [];
  const used = new Set();
  const add = (kind, at, gain, query) => {
    if (out.length >= max) return;
    const p = SFX.pick(dataRoot, kind, { seed: idx * 31 + out.length * 7, query });
    if (!p.path || used.has(p.path)) return;
    used.add(p.path);
    out.push({ path: p.path, kind, atSec: Math.max(0, Math.min(dur - 0.2, at)), gain: Number(gain) || base });
  };
  if (style === 'text') {
    add('typing', 0.05, base * 0.7);
    if (idx === 1) add('water', 0.15, base * 0.8);
  } else {
    add(idx === 1 ? 'water' : 'whoosh', 0.03, base);
  }
  const txt = String(seg?.panel?.narration || '');
  if (/成功|完成|搞定|好了|终于/.test(txt)) add('success', Math.max(0.4, dur * 0.55), base * 0.8);
  else if (/失败|错误|坏了|不行|翻车/.test(txt)) add('fail', Math.max(0.4, dur * 0.55), base * 0.8);
  else if (/[！!]/.test(txt)) add('impact', Math.max(0.3, dur * 0.5), base * 0.6);
  return out;
}

/**
 * 云端出图（Pollinations 等 GET 端点）。失败返回原因，由 renderJob 回退本地。
 * 端点支持 {prompt}/{w}/{h} 占位符。
 *
 * 实测：连续两次请求很容易被 402（免费额度/队列），所以这里做两件事：
 *   1) 全局最小间隔（默认 8 秒），别把请求打在同一个窗口里；
 *   2) 失败后换 model（flux→turbo）并退避重试（5s/15s）。
 */
async function cloudDraw(prompt, opts = {}, cfg = {}) {
  const media = (cfg && cfg.media) || {};
  const ep = String(media.endpoint || '').trim();
  if (!ep) return { ok: false, reason: 'cloud-endpoint 未配置' };
  // Pollinations 实测：1280x720 会超时，1024x576 稳定（约 5~9 秒）
  // 2026-10-27：改成尊重调用方传的 width/height（竖屏 576x1024 时原来被压成横屏）。
  const w = Math.max(64, Math.round(Number(opts.width) || Number(media.width) || 1024));
  const h = Math.max(64, Math.round(Number(opts.height) || Number(media.height) || 576));
  const out = String(opts.out || '').trim();
  if (!out) return { ok: false, reason: 'cloud-no-out' };

  const build = (model) => {
    let u = ep
      .replace(/\{prompt\}/g, encodeURIComponent(String(prompt || '')))
      .replace(/\{w\}/g, String(w))
      .replace(/\{h\}/g, String(h));
    if (/\bmodel=/.test(u)) u = u.replace(/\bmodel=[^&]*/g, 'model=' + encodeURIComponent(model));
    else u += (u.includes('?') ? '&' : '?') + 'model=' + encodeURIComponent(model);
    if (!/\bseed=/.test(u)) u += '&seed=' + String(Math.floor(Math.random() * 1e9));
    return u;
  };

  const started = Date.now();
  let last = '';
  const attempts = [
    { model: String(media.model || 'flux'), wait: 0 },
    { model: 'turbo', wait: 5000 },
    { model: String(media.model || 'flux'), wait: 15000 },
    { model: 'turbo', wait: 30000 },
  ];
  for (const at of attempts) {
    const gap = Math.max(0, Number(media.minGapMs) || 8000);
    const since = Date.now() - _lastCloudAt;
    if (gap > since) await new Promise((r) => setTimeout(r, gap - since));
    if (at.wait > 0) await new Promise((r) => setTimeout(r, at.wait));
    _lastCloudAt = Date.now();
    const url = build(at.model);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(5000, Number(media.timeoutMs) || 90000)) });
      if (!res.ok) {
        let body = '';
        try {
          body = String(await res.text()).slice(0, 160);
        } catch {
          /* ignore */
        }
        last = `cloud-http-${res.status}(${at.model})` + (body ? ':' + body.replace(/\s+/g, ' ') : '');
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 2000) {
          last = `cloud-too-small-${buf.length}(${at.model})`;
        } else {
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, buf);
          return { ok: true, path: out, bytes: buf.length, ms: Date.now() - started, provider: 'cloud', model: at.model };
        }
      }
    } catch (e) {
      last = `cloud:${e?.message || String(e)}(${at.model})`;
    }
  }
  return { ok: false, reason: last || 'cloud-failed' };
}

/**
 * 渲染成片。可用 deps 注入假实现（测试/降级）。
 * @returns {Promise<{ok:boolean, job?:object, error?:string, detail?:object}>}
 */
export async function renderJob(job, cfg = {}, deps = {}) {
  const dataRoot = deps.dataRoot || job.dataRoot || dataRootOf();
  const ops = deepMerge(DEFAULT_OPS_CONFIG, cfg || {});
  const drawCfg = deps.drawCfg || loadDrawConfig(dataRoot);
  const plan = resolvePlan(ops);
  const useCloud = plan.imageProvider === 'cloud';
  let videoStyle = plan.videoStyle;
  const drawFn = deps.draw || (useCloud ? ((p, o) => cloudDraw(p, o, ops)) : draw);
  // 锁脸必须走本地 img2img（云端 flux 不吃 init_image），所以单独留一个本地出图函数
  const localDraw = deps.draw || draw;
  // 默认走 synthesizeWarm：分段合成 + 句间呼吸 + ffmpeg 人声后处理，
  // 而不是整段丢给 edge-tts 一口气念完。
  const ttsFn = deps.tts || synthesizeWarm;
  const frameFn = deps.textFrames || TV.renderFrames;
  const exe = deps.ffmpeg || (await import('../tools/storyboard.mjs')).findFfmpeg();
  const detail = { panels: [], warnings: [], plan: { ...plan, videoStyle } };
  // 配音：跟 voice-config.json 走（主人换音色，成片配音一起换）
  const ttsCfg = resolveTts(dataRoot, ops);
  // [qqbot-mod] 2026-10-28：任务级配音引擎（job.dubbing = gsv|breeze|index）。
  //   工具/工单里指定了就覆盖全局配置——离线长片用 breeze/index（慢但效果好，
  //   反正不抢答），聊天短片用 gsv。同时把最终引擎回写进 detail.tts 供台账展示。
  // [qqbot-mod] dubbing-override 2026-10-29 主人拍板：「哪怕砍掉非必要占显存的东西，
  //   也一定要用 Index 生成」——主管型 LLM 经常怕超时自作主张传 gsv（bb-201438 实锤：
  //   预热链为空、直接 gsv）。现在 ops.video.dubbingOverride（默认 index）强制改判，
  //   预热梯队 index→breeze 兑底，gsv 只做最后保险。传 "off" 可关掉强制。
  const dubOverride = String((ops.video && ops.video.dubbingOverride) || 'index').toLowerCase();
  if (['index', 'breeze'].includes(dubOverride)) {
    if (job && job.dubbing !== dubOverride) detail.warnings.push(`配音引擎强制改判：${job.dubbing || '(未指定)'} → ${dubOverride}（dubbingOverride）`);
    if (job) job.dubbing = dubOverride;
    ttsCfg.model = dubOverride;
  } else if (job && job.dubbing) {
    ttsCfg.model = String(job.dubbing).toLowerCase();
  }
  detail.tts = ttsCfg;

  // [qqbot-mod] vram-evict 2026-10-31：index 门槛 5300MB，ollama 常驻 4~5GB 时 index
  //   起不来/被挤 → 每句都付一次 7~12min 冷启动（实测 23 字 977s）。整单配音前主动
  //   请 ollama 出显存，配合适配层 30min 空闲地板，16 句只付一次冷启动。
  if (ttsCfg.model === 'index' || ttsCfg.model === 'breeze') {
    try {
      const { evictOllamaVram } = await import('./tts-core.mjs');
      if (await evictOllamaVram()) detail.warnings.push('配音前已请 ollama 让出显存（给 ' + ttsCfg.model + ' 腾地方）');
    } catch { /* ignore */ }
  }

  // 尺寸：每单自己按 job.orientation 设一遍（缺省横屏 1280×720，竖屏 1080×1920）。
  // 串行出片，所以不需要还原；并发时必须改成传参。
  const sizeInfo = applySize(job.orientation || ops.video?.orientation);
  detail.size = sizeInfo.size;

  // 文字动效依赖 python + Pillow；不可用时别把整单搞挂，回退分镜图并如实记一条 warning。
  if (videoStyle === 'text') {
    const av = deps.textAvailable ? await deps.textAvailable(drawCfg) : await TV.available(drawCfg);
    if (!av.ok) {
      videoStyle = 'image';
      detail.plan.videoStyle = 'image';
      detail.warnings.push('文字动效不可用（' + (av.reason || '?') + '），本单回退分镜图');
    }
  }

  // 音效库：空库用 ffmpeg 合成 9 个语义音效；没 ffmpeg 就静音，不影响成片。
  const sfxOn = deps.sfxEnabled !== undefined ? !!deps.sfxEnabled : (ops.video?.sfx !== false && ops.sfx?.enabled !== false);
  const sfxRoot = sfxRootOf(dataRoot);
  let sfxReady = false;
  if (sfxOn && deps.ffmpeg !== '') {
    try {
      await SFX.ensureBuiltin(sfxRoot, { ffmpeg: exe });
      sfxReady = deps.sfxReady !== undefined ? !!deps.sfxReady : SFX.loadIndex(sfxRoot).items.length > 0;
      if (!sfxReady) detail.warnings.push('音效库是空的（没有 ffmpeg 合成兜底），成片不带音效');
    } catch (e) {
      detail.warnings.push('音效库初始化失败：' + (e?.message || String(e)));
    }
  }

  const script = {
    title: job.title,
    desc: job.desc,
    tags: job.tags || [],
    panels: (job.panels || []).map((p) => ({ narration: p.narration, imagePrompt: p.imagePrompt })),
  };
  if (!script.panels.length) {
    // [qqbot-mod] auto-script 2026-10-28：只有选题没有分镜的半截任务（如 DSH 工单直开渲染），
    //   不再直接报错——用 writeScript 补一份（云端→本地→模板三级兜底，模板永远能出片）。
    const topic = String(job.topic || job.title || '').trim();
    if (topic) {
      try {
        let briefing = '';
        try {
          const VB = await import('./video-briefing.mjs');
          const b = await VB.buildBriefing(job.dataRoot);
          if (b && b.ok && b.text) briefing = b.text;
        } catch { /* ignore */ }
        let apiKey = '';
        try { apiKey = String(readSecret(job.dataRoot)?.apiKey || ''); } catch { /* ignore */ }
        const s = await writeScript(
          { topic, style: job.style || 'default', panels: cfg.video?.panels || 6, seconds: job.durationSec || undefined, briefing },
          cfg.llm,
          { dataRoot: job.dataRoot, apiKey }
        );
        if (s && s.ok && Array.isArray(s.panels) && s.panels.length) {
          script.title = s.title || job.title || topic;
          script.desc = s.desc || '';
          script.tags = s.tags || [];
          script.panels = s.panels;
          updateJob(job.dataRoot, job.id, { title: script.title, desc: script.desc, tags: script.tags, panels: s.panels, llm: s.llm || 'template' });
        }
      } catch { /* 兜底失败照旧报错 */ }
    }
  }
  if (!script.panels.length) return { ok: false, error: '任务没有分镜（先写脚本）', detail };

  // [qqbot-mod] script-quality-gate 2026-10-29：文案质量闸。
  //   主人实锤 bb-20261029-132913-w11g：agent 硬凑「每屏≤26字」写出 7 屏 77 字、
  //   25 秒的电报体——选题里要求的功能介绍/学习汇报/数据/参考文献全没讲开。
  //   总字数低于时长下限的脚本自动用 writeScript 重写一次（原稿当参考），失败才放行原稿。
  {
    // [qqbot-mod] jargon-ban 2026-10-29 主人二连实锤（w11g 电报体、cuot「五步走：空镜出图、贴立绘」）：
    //   光有字数闸不够——模型会把 briefing 里的工程台账**原样念出来**，满嘴「出图/拼片/召回/
    //   向量/显存」，观众根本听不懂也没人想听。鲸鱼娘的口播里出现这些词 = 拒稿。
    const JARGON = ['显存', '显卡', '管线', '引擎', '召回', '向量', '倒排', '图谱', '索引', '数据库',
      '日志', '接口', '参数', '部署', 'API', 'GPU', '适配层', '拼片', '出图', '立绘', '分镜',
      '旁白', '缓存', '工单', '队列', '帧率', '编码', '渲染', '前端', '后端', '冷启动', '预处理',
      '上下文', '提示词', 'token', '语料', '权重', '本地模型']; // [script-skill 2026-10-30] 补漏 6 词
    const hits = (text) => JARGON.filter((w) => String(text || '').includes(w));
    const totalChars = script.panels.reduce((a, p) => a + String(p.narration || '').replace(/\s/g, '').length, 0);
    const MIN_CHARS = 240;   // ≈55 秒口播（约 4.3 字/秒）
    const jargonPanels = script.panels.filter((p) => hits(p.narration).length);
    const jargonAll = [...new Set(jargonPanels.flatMap((p) => hits(p.narration)))];
    // [qqbot-mod] echo-detect 2026-10-31：主人汇报——云端写稿 8 次 5 次把选题原样复读成旁白。
    //   检测：取选题每 8 字步长的 14 字窗口，任一窗口整段出现在 narration 里 = 复读屏。
    const topicText = String(job.topic || '').replace(/\s/g, '');
    const sample = [];
    if (topicText.length >= 14) {
      for (let st = 0; st + 14 <= topicText.length; st += 8) sample.push(topicText.slice(st, st + 14));
      if (sample[sample.length - 1].length < 14) sample.push(topicText.slice(-14));
    }
    const echoPanels = sample.length
      ? script.panels.filter((p) => sample.some((w) => String(p.narration || '').replace(/\s/g, '').includes(w)))
      : [];
    const needRewrite = totalChars < MIN_CHARS || jargonPanels.length >= 2 || jargonAll.length >= 3 || echoPanels.length >= 2;
    if (needRewrite) {
      if (totalChars < MIN_CHARS) detail.warnings.push(`文案过短（共 ${totalChars} 字 ≈ ${Math.round(totalChars / 4.3)} 秒，下限 ${MIN_CHARS}），自动扩写…`);
      if (jargonPanels.length) detail.warnings.push(`文案带技术黑话（${jargonAll.join('、')}，${jargonPanels.length} 屏命中），自动改写成生活化的故事…`);
      if (echoPanels.length >= 2) detail.warnings.push(`写稿复读选题原文（${echoPanels.length} 屏命中），自动重写…`);
      try {
        const topic = String(job.topic || script.title || '').trim();
        let apiKey = '';
        try { apiKey = String(readSecret(job.dataRoot)?.apiKey || ''); } catch { /* ignore */ }
        let briefing = '';
        try {
          const VB = await import('./video-briefing.mjs');
          const b = await VB.buildBriefing(job.dataRoot);
          if (b && b.ok && b.text) briefing = b.text;
        } catch { /* ignore */ }
        const feedback = [];
        if (totalChars < MIN_CHARS) feedback.push('这版原稿太短太空，只参考它提到的信息点，把每件事都讲具体（数字、例子、进展、感受）');
        if (echoPanels.length >= 2) feedback.push('这版原稿把选题原样抄进了旁白，严禁再犯——要用第一人称把选题里的事讲成你自己的故事，选题原文一个字都不许直接出现');
        if (jargonAll.length) feedback.push('这版原稿满嘴技术词（' + jargonAll.join('、') + '）——把每一处都翻译成生活说法：不说「显存挤不下」要说「家里桌子太小，只能先把玩具收进柜子」；不说「召回/数据库」要说「我把他说过的话都记在小本本上，一翻就能翻到」；工程的事只讲当时的场景和心情');
        // [qqbot-mod] script-skill 2026-10-30：原来 feedback+原稿全拼进 topic —— script-writer 的
        //   sanitizeTopic 只留前 200 字，整改要求和原稿信息点全被砍掉，扩写等于盲写
        //   （主人反复实锤「文案还是很差」的直接根因之一）。改走 briefing 通道（system 侧，无截断）。
        const refDraft = script.panels.map((x) => String(x.narration || '').trim()).join(' / ').slice(0, 400);
        const briefing2 = (briefing ? briefing + '\n\n' : '')
          + (feedback.length ? '# 上一稿整改要求（必须全部遵守）\n' + feedback.join('；') + '\n' : '')
          + (refDraft ? '# 上一稿旁白（只提炼它提到的信息点，写法不许抄它）\n' + refDraft : '');
        const s2 = await writeScript(
          {
            topic,
            style: job.style || 'default',
            panels: Math.max(Number(cfg.video?.panels) || 6, 12),
            seconds: job.durationSec || 60,
            briefing: briefing2,
          },
          cfg.llm,
          { dataRoot: job.dataRoot, apiKey }
        );
        if (s2 && s2.ok && Array.isArray(s2.panels) && s2.panels.length) {
          script.title = s2.title || script.title;
          script.desc = s2.desc || script.desc;
          script.tags = (s2.tags && s2.tags.length) ? s2.tags : script.tags;
          script.panels = s2.panels;
          updateJob(job.dataRoot, job.id, { title: script.title, desc: script.desc, tags: script.tags, panels: s2.panels });
          detail.warnings.push(`文案已自动改写（${s2.panels.length} 屏，llm=${s2.llm || 'template'}）`);
        } else {
          detail.warnings.push('文案自动改写没出稿，用原稿继续');
        }
      } catch (e) {
        detail.warnings.push('文案自动改写失败（用原稿继续）：' + (e?.message || String(e)));
      }
    }
  }

  // ── 分镜编排（纯函数）：节拍 / 形态 / 转场 / 音效 / 时长预算 ──
  // 旧行为（planner=false）等价于"一屏一张图、固定淡入"，保留给回滚。
  let shotPlan = null;
  let shots = script.panels.map((p, i) => ({
    index: i + 1,
    beat: 'point',
    narration: p.narration,
    imagePrompt: p.imagePrompt,
    mode: 'image',
    textStyle: '',
    transition: { type: 'dissolve', sec: Number(ops.video.fadeSec) || 0.22 },
    holdSec: Math.max(1, Number(ops.video.secondsPer) || 5),
    sfx: [],
  }));
  if (ops.video?.planner !== false) {
    try {
      const plan = planStoryboard(script, {
        imageProvider: useCloud ? 'cloud' : 'local',
        maxImageShots: Number(ops.video?.maxImageShots ?? (useCloud ? 2 : 1)),
        shotMinSec: ops.video?.shotMinSec,
        shotMaxSec: ops.video?.shotMaxSec,
        preferText: String(ops.video?.style || '').toLowerCase() === 'text',
      });
      if (plan.ok) {
        shotPlan = plan;
        shots = plan.shots;
        detail.plan.shots = { count: plan.meta.count, image: plan.meta.imageShots, text: plan.meta.textShots,
          totalSec: plan.meta.totalSec, beats: plan.meta.beats };
        for (const issue of plan.issues.slice(0, 4)) detail.warnings.push('分镜体检：' + issue);
      } else {
        detail.warnings.push('分镜编排失败（' + (plan.issues[0] || '?') + '），回退一屏一图');
      }
    } catch (e) {
      detail.warnings.push('分镜编排异常：' + (e?.message || String(e)));
    }
  }

  const panelsDir = join(job.dir, 'panels');
  const audioDir = join(job.dir, 'audio');
  mkdirSync(panelsDir, { recursive: true });
  mkdirSync(audioDir, { recursive: true });

  const font = ops.video.burnSubtitle ? pickFont() : '';

  // 2026-10-25：程序化 2D 小人（char-anim / whale_render）整条退役——几何图元拼出来的
  // 形象太丑，主人明确不要。文字屏不再叠角色，人物出场全靠 AI 定妆照 + img2img 锁脸。

  const secondsPer = Math.max(1, Number(ops.video.secondsPer) || 5);
  const segments = [];
  let cursor = 0;
  let lastImg = '';
  // 角色锚点：先用同一套外形描述生成一张“定妆照”，后面每屏用 img2img 从它出发，
  // 这样 6 屏不会各画一个不同的人（这是“AI 味/不像同一个人”的主因）。
  const cp = String(ops.media?.characterPrompt || '').trim();
  const sp = String(ops.media?.stylePrompt || '').trim();
  // 合成模式：只画场景，人物用透明立绘贴上去（见文件顶部 POSE_DIR 注释）。
  // 关掉的办法：bili-ops-config.json 里 video.charMode = "img2img"，或 video.charMode = "off"。
  const charMode = String(ops.video?.charMode || 'composite').toLowerCase();
  const composeMode = charMode === 'composite' && videoStyle === 'image';
  let anchorPath = '';
  // 2026-10-26 修：原来条件里有 `!useCloud`，而生产配置是 cloud-first ⇒ 定妆照一次都没跑过，
  // 云端每屏各画一个人，所以"不像她"。定妆照改用本地 SD 出（云端不吃 init_image），
  // 后面每屏再从它 img2img 派生；本地失败就退回云端。
  if (!composeMode && videoStyle === 'image' && ops.video?.characterLock !== false && cp) {
    try {
      const anchorPrompt = cp + ' full body, standing, front view, dark blue underwater background, soft light, 2D anime'
        + ', full bleed illustration, edge to edge, no frame, no border';
      const a = await localDraw(anchorPrompt, {
        width: GEN_W,
        height: GEN_H,
        steps: Number(ops.video?.characterSteps) || 24,
        negative: CHARACTER_NEG,
        out: join(panelsDir, '00-anchor.png'),
      }, drawCfg);
      if (a?.ok && a.path) anchorPath = a.path;
      else detail.warnings.push('角色定妆照失败（' + (a?.reason || '?') + '），后续不用 img2img');
    } catch (e) {
      detail.warnings.push('角色定妆照异常：' + (e?.message || String(e)));
    }
  }

  // 音效计划：一次算完整片（同一单内不重复同一文件），渲染时按屏取
  let cuePlan = [];
  if (sfxReady) {
    try {
      cuePlan = SFX.planCues(sfxRoot, shots, {
        gain: ops.sfx?.gain,
        maxPerPanel: ops.sfx?.maxPerPanel,
      });
    } catch (e) {
      detail.warnings.push('音效计划失败：' + (e?.message || String(e)));
    }
  }
  const usedHashes = [];   // 已成片的图 dHash：后面的屏不许再出同一张
  // [qqbot-mod] two-phase 2026-10-29：阶段 1（出图）的产出暂存，阶段 2 统一配音
  //  [qqbot-mod] sparse-fix 2026-10-29：imageScore/pose 以前直接写 detail.panels[i]，
  //   但那时数组还没 push —— 稀疏残骸排在 panel 前面（w11g 的 meta.panels[0]={"pose":...}
  //   垃圾 + README "undefined. [?s] undefined" 实锤），字幕错位、台账难看。改暂存数组。
  const imgByShot = [];
  const modes = [];
  const imgScores = [];
  const poseByShot = [];

  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    const p = { narration: shot.narration, imagePrompt: shot.imagePrompt };
    const idx = String(i + 1).padStart(2, '0');
    // 形态：全片强制文字/图片时以配置为准，否则听分镜编排的
    const shotMode = videoStyle === 'text' ? 'text' : (videoStyle === 'image' ? 'image' : (shot.mode || 'image'));

    // 1) 出图（只在 image 形态；text 形态留到配音后渲染文字帧）
    let imgPath = '';
    let frameDir = '';
    let frameFps = 0;
    if (shotMode === 'image') {
    let prompt = p.imagePrompt || p.narration;
    // 合成路线（2026-10-27 新增，默认开）：场景交给 SD 画（不带角色），
    // 人物用固定的透明立绘贴上去 —— 换场景不换脸，也不会出现"木框海报"那种构图。
    const posePath = composeMode ? pickPose(shot, i) : '';
    if (composeMode) {
      // 场景图必须是"空镜"：分镜里的 imagePrompt 经常写成"她坐在桌前写字"，
      // SD 会立刻画一个人（于是画面里出现一个巨人，我们的立绘反而像贴纸）。
      // 这里把描述人物的从句剔掉，只留环境，再补一句 environment only。
      const keep = String(prompt || '')
        .split(/[,，;；]/)
        .map((x) => x.trim())
        .filter((x) => x && !/(girl|woman|man|boy|character|people|person|human|she|her|his|chibi|whale girl|holding|wearing|sitting|standing|leaning|writing|reading|looking at|smiling|waving|pointing)/i.test(x));
      const kept = keep.join(', ');
      prompt = (sp ? sp + ' ' : '') + (kept.length >= 16 ? kept : String(prompt || ''))
        + ', background art, scenery, environment only, no people';
    } else if (cp || sp) {
      // 角色/画风锚点：DeepSeek 写的分镜经常忘记外形，逐屏漂移；这里统一补在最前面。
      prompt = (cp ? cp + ' ' : '') + (sp ? sp + ' ' : '') + prompt;
    }
    try {
      if (/[\u4e00-\u9fa5]/.test(prompt)) {
        const tr = await translatePrompt(prompt, drawCfg);
        if (tr.ok && tr.prompt) prompt = tr.prompt;
      }
    } catch {
      /* 用原文 */
    }
    let drew = null;
    try {
      const drawOpt = {
        width: GEN_W, height: GEN_H, out: join(panelsDir, idx + '.png'),
        initImage: anchorPath || undefined, strength: Number(ops.video?.characterStrength) || 0.5,
        // 有定妆照时补负向词，避免 img2img 把蓝发漂成紫发
        ...(anchorPath ? { negative: CHARACTER_NEG } : {}),
      };
      if (composeMode) {
        // 空镜：默认走 AI 画背景（2026-10-29 默认改 'ai' —— 主人实锤 procedural 的
        //   程序化渐变底「空旷得像 PPT」，是画质差的主要来源）；SD 不可用时才兑底程序化。
        drawOpt.negative = CHAR_SCENE_NEG;
        drawOpt.out = join(panelsDir, idx + '-bg.png');
        drawOpt.width = GEN_W;
        drawOpt.height = GEN_H;
        const sceneMode = String(ops.video?.sceneMode || 'ai').toLowerCase();
        if (sceneMode === 'ai') {
          try {
            const raw = join(panelsDir, idx + '-bg-raw.jpg');
            const c = await cloudDraw(prompt, { ...drawOpt, out: raw }, ops);
            if (c.ok && exe) {
              const fixed = join(panelsDir, idx + '-bg.png');
              const g = await runFfmpeg(exe, ['-y', '-i', raw, '-vf', `crop=iw:ih-${Math.round(GEN_H * 0.048)}:0:0,scale=${GEN_W}:${GEN_H}:flags=lanczos`, '-frames:v', '1', '-update', '1', fixed], 60000);
              drew = { ok: true, path: g.ok ? fixed : raw, provider: 'cloud-scene' };
            }
          } catch (e) {
            detail.warnings.push('第' + (i + 1) + '屏云端场景失败（' + (e?.message || String(e)) + '），改程序化背景');
          }
        } else {
          const bg = await sceneBg(prompt, join(panelsDir, idx + '-bg.png'), {
            pythonBin: drawCfg.pythonBin, width: GEN_W, height: GEN_H, seed: 11 + i * 7,
          });
          if (bg.ok) drew = { ok: true, path: bg.path, provider: 'procedural-scene' };
          else detail.warnings.push('第' + (i + 1) + '屏背景生成失败（' + (bg.reason || '?') + '），改本地出图');
        }
      }
      // 有定妆照时，这一屏必须用本地 img2img 才能保住脸（云端会丢 init_image）
      const panelDraw = (anchorPath && useCloud) ? localDraw : drawFn;
      const panelProvider = (anchorPath && useCloud) ? 'local-anchor' : (useCloud ? 'cloud' : 'local');
      if (composeMode && drew?.ok) {
        // 云端空镜已经拿到了，跳过本地出图（本地 SD 画场景容易又冒出一个人）
      } else if (deps.draw || ops.video?.imageGate === false) {
        // 测试注入 / 显式关质检：直接画
        drew = await panelDraw(prompt, drawOpt, drawCfg);
      } else {
        // 真正的出图：最多试 imageAttempts 次，每次过一遍清晰度/色彩/查重
        const attempts = Math.max(1, Math.min(4, Number(ops.video?.imageAttempts) || 3));
        const g = await drawGated(panelDraw, prompt, drawOpt, {
          attempts,
          goodEnough: Number(ops.video?.imageGoodEnough) || 0.84,
          baseline: usedHashes,
          gate: { pythonBin: drawCfg.pythonBin, outFile: join(panelsDir, 'gate-' + idx + '.json') },
          drawCfg,
        });
        if (g.ok) {
          drew = { ok: true, path: g.path, score: g.score, provider: panelProvider };
          imgScores[i] = g.score;
          if (g.score < 0.6) detail.warnings.push('第' + (i + 1) + '屏画面质量偏低（' + g.score + '），建议换图描述');
        } else {
          // 质检本身跑不起来（没 python/Pillow）→ 不能因为"检查失败"就丢掉图
          const fallback = (g.tried || []).find((t) => t.ok && t.path);
          if (fallback) {
            drew = { ok: true, path: fallback.path, provider: panelProvider };
            detail.warnings.push('第' + (i + 1) + '屏质检不可用，按原图使用（' + (g.reason || '?') + '）');
          } else {
            drew = { ok: false, reason: '质检未通过（' + attempts + ' 次）' };
            detail.warnings.push('第' + (i + 1) + '屏 ' + attempts + ' 次出图均未通过质检，改用文字动效');
          }
        }
      }
      if ((!drew || !drew.ok) && useCloud && ops.media?.fallbackLocal === true) {
        detail.warnings.push('第' + (i + 1) + '屏云端出图失败（' + (drew?.reason || '?') + '），回退本地');
        try {
          drew = await draw(prompt, { width: GEN_W, height: GEN_H, out: join(panelsDir, idx + '.png') }, drawCfg);
        } catch (e) {
          drew = { ok: false, reason: 'local:' + (e?.message || String(e)) };
        }
      }
      if (drew?.ok && drew.path) {
        imgPath = drew.path;
        // 合成路线：把透明立绘贴到场景图上（身份稳定 + 场景贴合旁白）
        if (composeMode && posePath) {
          const composed = join(panelsDir, idx + '.png');
          const cp2 = await composeChar(imgPath, posePath, composed, {
            pythonBin: drawCfg.pythonBin,
            heightRatio: Number(ops.video?.charHeightRatio) || 0.66,
            bottom: Number(ops.video?.charBottom) || 0.03,
            align: shot.align || (i % 2 === 0 ? 'center' : 'left'),
          });
          if (cp2.ok) {
            imgPath = composed;
            poseByShot[i] = posePath.split(/[\\/]/).pop();
          } else {
            detail.warnings.push('第' + (i + 1) + '屏立绘合成失败（' + (cp2.reason || '?') + '），用纯场景图');
          }
        }
        const cb = Math.max(0, Math.min(200, Number(ops.media?.cropBottom) || 0));
        if (drew.provider === 'cloud' && cb > 0 && exe) {
          const cropped = join(panelsDir, idx + '-crop.jpg');
          const c = await runFfmpeg(exe, ['-y', '-i', imgPath, '-vf', `crop=iw:ih-${cb}:0:0`, '-frames:v', '1', '-update', '1', cropped], 60000);
          if (c.ok) imgPath = cropped;
          else detail.warnings.push('第' + (i + 1) + '屏云端水印裁剪失败（' + (c.reason || '?') + '），用原图');
        }
        lastImg = imgPath;
      } else if (lastImg) {
        // 单屏云端失败（常见 402/503 限流）时，不要整片降级成单图；
        // 复用上一屏画面保持分镜结构，并在 warnings 里如实标注。
        const reuse = join(panelsDir, idx + '.png');
        try {
          copyFileSync(lastImg, reuse);
          imgPath = reuse;
          detail.warnings.push('第' + (i + 1) + '屏出图失败（' + (drew?.reason || '?') + '），复用上一屏画面');
        } catch (e) {
          detail.warnings.push('第' + (i + 1) + '屏出图失败且复用失败：' + (e?.message || String(e)));
        }
      } else {
        detail.warnings.push('第' + (i + 1) + '屏出图失败：' + (drew?.reason || '?'));
      }
    } catch (e) {
      detail.warnings.push('第' + (i + 1) + '屏出图异常：' + (e?.message || String(e)));
    }
    } // /image

    imgByShot.push(imgPath);
    modes.push(shotMode);
    detail.panels.push({
      index: i + 1, narration: p.narration, imagePrompt: p.imagePrompt,
      mode: shotMode, beat: shot.beat || '', image: imgPath,
      pose: poseByShot[i] || '',
      transition: shot.transition || null,
      imageScore: imgScores[i],
    });
    job.panels = detail.panels;
  } // ── 阶段 1 完：全部分镜图就位（two-phase 2026-10-29）──────────────

  // ── 阶段 1.5：还显存 ────────────────────────────────────────────────
  // 出图完第一件事是把 SD 服务停掉（sd_server 按需拉起，停了下次自动重拉），
  // 再把「非目标」的本地 TTS 后端停掉 —— breeze-server 常驻 4.8GB+ 也是
  // index 起不来的帮凶（10-29 实锤：SD 占卡时 free=354MB，15GB 权重靠共享
  // 显存分页 900s 都载不完 → 预热超时 → 滑 GSV）。
  if (ttsCfg.provider === 'http' && /^(index|breeze)$/i.test(String(ttsCfg.model || ''))) {
    const target = String(ttsCfg.model).toLowerCase();
    try {
      await stopDrawServer(drawCfg);
      detail.warnings.push('已停本地 SD 服务还显存（配音阶段不用卡）');
    } catch (e) {
      detail.warnings.push('停 SD 服务异常：' + (e?.message || String(e)));
    }
    try {
      const ab = String(ttsCfg.endpoint || '').replace(/\/v1\/.*$/, '').replace(/\/+$/, '');
      if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(ab)) {
        for (const other of ['gsv', 'breeze', 'index']) {
          if (other === target) continue;
          try {
            const rr = await fetch(ab + '/admin/stop-backend', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: other }), signal: AbortSignal.timeout(4000),
            });
            const j = await rr.json().catch(() => ({}));
            if (j && j.stopped) detail.warnings.push(`已停 ${other}（给 ${target} 让显存）`);
          } catch { /* 适配层不在就算了 */ }
        }
      }
    } catch (e) {
      detail.warnings.push('停闲置 TTS 后端异常：' + (e?.message || String(e)));
    }
  }

  // ── 阶段 1.6：预热目标引擎（梯队按离线出片偏好重排）─────────────────
  // 出片场景 index → breeze → gsv（适配层通用梯队 gsv 抢跑，是 10-29 滑档主因）。
  // 预热成功把 ttsCfg.model 固定在「真的热了的引擎」，后续配音全走它。
  if (ttsCfg.provider === 'http') {
    const want = String(ttsCfg.model || '').toLowerCase();
    const chain = /^(index|breeze)$/.test(want)
      ? [want, ...['index', 'breeze'].filter((x) => x !== want)]
      : [];
    for (const engName of chain) {
      const t0w = Date.now();
      try {
        const w = await synthesize('好。', {
          dataRoot, voice: ttsCfg.voice, provider: 'http', endpoint: ttsCfg.endpoint,
          model: engName, vramSoft: ttsCfg.vramSoft === true,
          strict: true,   // [qqbot-mod] strict-engine：预热必须真用目标引擎，不许被梯队降级骗过
          speak: false, jitter: false, keep: 0, timeoutMs: 900000,
        });
        if (w && w.ok) {
          if (ttsCfg.model !== engName) {
            ttsCfg.model = engName;
            detail.warnings.push(`已切换配音引擎 ${ttsCfg.model} → ${engName}`);
          }
          detail.warnings.push(`${engName} 预热完成（${Math.round((Date.now() - t0w) / 1000)}s），全片配音走 ${engName}`);
          break;
        }
        // [qqbot-mod] warmup-retry 2026-10-29：重启适配层后第一发可能撞上连接重置
        //   （bb-201438 疑似），失败隔 3s 重试一次再判死刑。
        const w2 = (w && w.ok) ? w : await new Promise((r) => setTimeout(r, 3000)).then(() => synthesize('好。', {
          dataRoot, voice: ttsCfg.voice, provider: 'http', endpoint: ttsCfg.endpoint,
          model: engName, vramSoft: ttsCfg.vramSoft === true,
          strict: true,
          speak: false, jitter: false, keep: 0, timeoutMs: 900000,
        })).catch((e2) => ({ ok: false, error: e2?.message || String(e2) }));
        if (w2 && w2.ok) {
          if (ttsCfg.model !== engName) {
            ttsCfg.model = engName;
            detail.warnings.push(`已切换配音引擎 ${ttsCfg.model} → ${engName}`);
          }
          detail.warnings.push(`${engName} 预热完成（重试后成功，共 ${Math.round((Date.now() - t0w) / 1000)}s），全片配音走 ${engName}`);
          break;
        }
        detail.warnings.push(`${engName} 预热失败（${String((w2 && w2.error) || (w && w.error) || '?').slice(0, 80)}），试下一梯队`);
      } catch (e) {
        detail.warnings.push(`${engName} 预热异常：${String(e?.message || e).slice(0, 80)}，试下一梯队`);
      }
    }
    // [qqbot-mod] 全梯队预热都失败：明确落到 gsv（秒出、必成），别让配音请求
    //   再去适配层走一遍冷启动 + 梯队（那会整单超时、每屏 5 分钟重试）。
    if (chain.length && !/^(index|breeze)$/.test(String(ttsCfg.model || '').toLowerCase())) {
      ttsCfg.model = 'gsv';
      detail.warnings.push('index/breeze 都没能热起来，本单配音改走 gsv（速度优先）');
    }
  }
  // [qqbot-mod] 2026-10-29：把实际用的引擎回写 job.dubbing —— meta/台账不能说谎
  if (job && ttsCfg.model && job.dubbing !== ttsCfg.model) job.dubbing = String(ttsCfg.model).toLowerCase();

  // ── 阶段 2：配音 + 文字帧 + 时间轴（SD 已停、引擎已热）──────────────
  cursor = 0;
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    const p = { narration: shot.narration, imagePrompt: shot.imagePrompt };
    const shotMode = modes[i];
    const imgPath = imgByShot[i];
    const idx = String(i + 1).padStart(2, '0');
    let frameDir = '';
    let frameFps = 0;
    let audioPath = '';
    let dur = secondsPer;
    try {
      // [qqbot-mod] tts-resilient 2026-10-29 主人要求「不要出现语音拼接失败」：
      //   以前单屏配音失败 = 该屏静音 → 后续时间轴全乱、听感断掉。
      //   现在三连保险：①同引擎重试一次（网络抖动）②换 gsv 单屏兜底（秒出必成）③真全败才静音+警告。
      const ttsOpts = (modelOverride) => ({
        outDir: audioDir,
        dataRoot,
        voice: ttsCfg.voice,
        rate: ops.video.ttsRate || '-4%',
        pitch: ops.video.ttsPitch || '-1Hz',
        provider: ttsCfg.provider,
        endpoint: ttsCfg.endpoint,
        model: modelOverride || ttsCfg.model,
        vramSoft: ttsCfg.vramSoft === true,
        speak: false,
        jitter: false,
        keep: 200,
        timeoutMs: 600000,
      });
      let r = null;
      try { r = await ttsFn(p.narration, ttsOpts()); } catch (e0) { r = { ok: false, error: e0?.message || String(e0) }; }
      if (!(r?.ok && r.path)) {
        await new Promise((res) => setTimeout(res, 2000));
        try { r = await ttsFn(p.narration, ttsOpts()); } catch (e1) { r = { ok: false, error: e1?.message || String(e1) }; }
        if (r?.ok && r.path) detail.warnings.push('第' + (i + 1) + '屏配音重试成功（首次失败：' + String(r.error || '').slice(0, 60) + '）');
      }
      if (!(r?.ok && r.path) && String(ttsCfg.model || '').toLowerCase() !== 'gsv') {
        detail.warnings.push('第' + (i + 1) + '屏 ' + ttsCfg.model + ' 两连败，本屏用 gsv 兜底（不留静音屏）');
        try { r = await ttsFn(p.narration, ttsOpts('gsv')); } catch (e2) { r = { ok: false, error: e2?.message || String(e2) }; }
      }
      if (r?.ok && r.path) {
        const dest = join(audioDir, idx + '.mp3');
        try {
          if (r.path !== dest) renameSync(r.path, dest);
          audioPath = dest;
        } catch {
          audioPath = r.path;
        }
        // [qqbot-mod] 2026-10-29 修「分镜切了配音没念完、后面全断」：
        //   以前 sec = r.ms/1000 —— r.ms 是**合成耗时**（网络往返）不是音频长度，
        //   合成越慢音频被算得越短 → 段视频比音频短 → 尾巴被截、听感断崖
        //   （bb-20261029-201438 实锤：09 屏音频 8.14s 被压到 6.30s）。
        //   现在 ffmpeg 实测音频时长，段长 = 音频 + 呼吸垫；shotMax 只做提示绝不截音频。
        const probed = await probeMediaSec(exe, audioPath);
        const sec = probed > 0 ? probed
          : (Number(r.ms) > 0 ? Number(r.ms) / 1000 : Math.max(2, p.narration.length / 4.2));
        const shotMin = Math.max(1.5, Number(ops.video.shotMinSec) || 2.4);
        const shotMax = Math.max(shotMin, Number(ops.video.shotMaxSec) || 5.2);
        dur = Math.max(shotMin, sec + 0.35);
        if (sec > shotMax) detail.warnings.push('第' + (i + 1) + '屏旁白 ' + sec.toFixed(1) + 's 超过单屏偏好 ' + shotMax + 's，本屏按音频实际长度放宽');
      } else {
        detail.warnings.push('第' + (i + 1) + '屏配音失败：' + (r?.error || '?'));
      }
    } catch (e) {
      detail.warnings.push('第' + (i + 1) + '屏配音异常：' + (e?.message || String(e)));
    }

    // 文字动效帧（text 形态）：用配音时长决定帧数，画面和声音天然对齐
    if (shotMode === 'text') {
      const tc = ops.video?.text || {};
      try {
        const fr = await frameFn({
          outDir: join(panelsDir, idx),
          text: p.narration,
          title: script.title,
          width: Number(tc.width) || QUALITY_W,
          height: Number(tc.height) || QUALITY_H,
          fps: Number(tc.fps) || 24,
          durationSec: dur,
          style: shot.textStyle || tc.style || 'typewriter',
          accent: tc.accent || '#7fd7ff',
          bgImage: String(tc.bgImage || '').trim(),
          seed: i + 1,
          pythonBin: drawCfg.pythonBin,
          textScript: drawCfg.textScript,
          card: imgPath || '',
          cardAt: 0.35,
          charOffset: cursor,
        });
        if (fr?.ok) {
          frameDir = fr.dir;
          frameFps = Number(fr.fps) || Number(tc.fps) || 24;
          imgByShot[i] = TV.firstFrame(frameDir);
        } else {
          detail.warnings.push('第' + (i + 1) + '屏文字帧渲染失败：' + (fr?.reason || '?'));
        }
      } catch (e) {
        detail.warnings.push('第' + (i + 1) + '屏文字帧异常：' + (e?.message || String(e)));
      }
    }

    const start = cursor;
    cursor += dur;
    const panel = detail.panels[i];
    panel.audio = audioPath;
    panel.start = start;
    panel.end = cursor;
    panel.seconds = dur;
    segments.push({ panel, imgPath: imgByShot[i], audioPath, dur, frameDir, frameFps });
  }

  // 3) 字幕（外挂，永远生成）
  let srtPath = '';
  try {
    srtPath = join(job.dir, 'sub.srt');
    writeFileSync(srtPath, buildSrt(detail.panels), 'utf8');
  } catch {
    detail.warnings.push('字幕写入失败');
  }

  // 4) 逐段拼 + concat
  let videoPath = '';
  if (!exe) {
    detail.warnings.push('没有 ffmpeg（imageio-ffmpeg 未安装）');
  } else {
    const segFiles = [];
    let allOk = true;
    for (const seg of segments) {
      const hasFrames = !!seg.frameDir;
      if (!hasFrames && !seg.imgPath) {
        allOk = false;
        break;
      }
      const segOut = join(job.dir, 'seg-' + String(seg.panel.index).padStart(2, '0') + '.mp4');
      // 静态图也有“镜头感”：轻微推近/拉远（Ken Burns），避免整片像 PPT。
      // 文字帧自己带动效，不再叠 zoompan（叠了会糊）。
      const motionOn = !(ops.video && ops.video.motion === false);
      const zoomIn = seg.panel.index % 2 === 1;
      // 推得更快一点，再交替拉远；比原来 0.0009 的“慢慢放大”更有压迫感。
      const zoomExpr = zoomIn
        ? "min(zoom+0.0018,1.14)"
        : "if(eq(on,1),1.14,max(1.0,zoom-0.0018))";
      const motionVf = hasFrames
        ? `scale=${QUALITY_W}:${QUALITY_H}:force_original_aspect_ratio=decrease,pad=${QUALITY_W}:${QUALITY_H}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`
        : motionOn
          ? `scale=${Math.round(QUALITY_W * 1.08)}:${Math.round(QUALITY_H * 1.08)}:force_original_aspect_ratio=increase,` +
            `zoompan=z='${zoomExpr}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${QUALITY_W}x${QUALITY_H}:fps=24,format=yuv420p`
          : `scale=${QUALITY_W}:${QUALITY_H}:force_original_aspect_ratio=decrease,pad=${QUALITY_W}:${QUALITY_H}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`;
      const trSec = seg.panel.transition ? Number(seg.panel.transition.sec) : NaN;
      const fade = Math.max(0.04, Math.min(0.5,
        Number.isFinite(trSec) ? trSec : (Number(ops.video.fadeSec) || 0.22)));
      const fadeVf =
        `fade=t=in:st=0:d=${fade.toFixed(2)},` +
        `fade=t=out:st=${Math.max(0, seg.dur - fade).toFixed(2)}:d=${fade.toFixed(2)}`;
      const baseVf = motionVf + ',' + fadeVf;
      let vf = baseVf;
      // 文字帧已经把手写旁白铺在画面上了，再烧一层字幕会重复
      if (font && !hasFrames) {
        const txtFile = join(job.dir, 'cap-' + String(seg.panel.index).padStart(2, '0') + '.txt');
        try {
          writeFileSync(txtFile, seg.panel.narration, 'utf8');
          vf =
            baseVf +
            ',drawtext=fontfile=\'' + filterPath(font) + '\':textfile=\'' + filterPath(txtFile) +
            '\':fontcolor=white:fontsize=32:line_spacing=6:box=1:boxcolor=black@0.45:boxborderw=14:x=(w-text_w)/2:y=h-text_h-56';
        } catch {
          /* 用无字幕 */
        }
      }

      const baseInputs = hasFrames
        ? ['-y', '-framerate', String(seg.frameFps || 24), '-i', join(seg.frameDir, '%04d.png')]
        : ['-y', '-loop', '1', '-i', seg.imgPath];
      // 音效：每屏 1~2 个语义音效（转场/打字/成功/失败…），混进本段音轨
      let cues = sfxReady ? (cuePlan.find((c) => c.index === seg.panel.index)?.cues || []) : [];
      if (!cues.length && sfxReady) cues = pickSfxCues(sfxRoot, seg, seg.panel.mode, ops);

      // [qqbot-mod] audio-pop 2026-10-31：分镜切换杂音根因——TTS 每段首尾波形非零，
      //   concat -c copy 直拼处波形跳变 = 咔哒声。每段音轨先 8ms 淡入 + 10ms 淡出再混/编码。
      const fadePad = 'afade=t=in:d=0.008,afade=t=out:st=' +
        Math.max(0, Number(seg.dur) - 0.01).toFixed(2) + ':d=0.01';

      const buildArgs = (filter) => {
        if (cues.length) {
          const inputs = [...baseInputs];
          if (seg.audioPath) inputs.push('-i', seg.audioPath);
          else inputs.push('-f', 'lavfi', '-t', Number(seg.dur).toFixed(2), '-i', 'anullsrc=r=44100:cl=stereo');
          let inputIdx = 2;
          const withIdx = cues.map((c) => ({ ...c, inputIndex: inputIdx++ }));
          for (const c of withIdx) inputs.push('-i', c.path);
          const chains = [`[0:v]${filter},setsar=1[v]`];
          if (seg.audioPath) {
            chains.push(`[1:a]${fadePad}[abase]`);
            var mix = SFX.buildSfxFilter(withIdx, { baseLabel: '[abase]' });
          } else {
            var mix = SFX.buildSfxFilter(withIdx, { baseLabel: '[1:a]' });
          }
          chains.push(...mix.chains);
          return [
            ...inputs,
            '-t', Number(seg.dur).toFixed(2),
            '-filter_complex', chains.join(';'),
            '-map', '[v]', '-map', mix.outLabel,
            '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...COLOR_ARGS,
            ...(hasFrames ? [] : ['-tune', 'stillimage']),
            '-c:a', 'aac', '-b:a', '128k',
            segOut,
          ];
        }
        return [
          ...baseInputs,
          ...(seg.audioPath ? ['-i', seg.audioPath] : []),
          '-t', Number(seg.dur).toFixed(2),
          '-vf', `${filter},setsar=1`,
          '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...COLOR_ARGS,
          ...(hasFrames ? [] : ['-tune', 'stillimage']),
          ...(seg.audioPath ? ['-af', fadePad, '-c:a', 'aac', '-b:a', '128k'] : []),
          segOut,
        ];
      };

      let r = await runFfmpeg(exe, buildArgs(vf));
      if (!r.ok && vf !== baseVf) {
        detail.warnings.push('第' + seg.panel.index + '屏字幕烧录失败，改用无字幕');
        r = await runFfmpeg(exe, buildArgs(baseVf));
      }
      if (!r.ok) {
        allOk = false;
        detail.warnings.push('第' + seg.panel.index + '屏合成失败：' + r.reason);
        break;
      }
      segFiles.push(segOut);
    }

    if (allOk && segFiles.length === segments.length && segFiles.length > 0) {
      const listFile = join(job.dir, 'segments.txt');
      const q = (p) => "'" + String(p).replace(/\\/g, '/').replace(/'/g, "''") + "'";
      writeFileSync(listFile, segFiles.map((f) => 'file ' + q(f)).join('\n'), 'utf8');
      videoPath = join(job.dir, 'video.mp4');
      const r = await runFfmpeg(exe, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', videoPath]);
      if (!r.ok) {
        detail.warnings.push('拼接成片失败：' + r.reason);
        videoPath = '';
      } else if (cfg.video.bgm !== false && segments.every((s) => s.audioPath)) {
        // 铺一层很轻的水下氛围底噪，避免“干念稿”。失败不影响成片。
        const bgm = await ensureBgm(dataRoot, exe);
        if (bgm) {
          const mixed = join(job.dir, 'video-bgm.mp4');
          const m = await runFfmpeg(exe, [
            '-y',
            '-i', videoPath,
            '-stream_loop', '-1', '-i', bgm,
            '-filter_complex',
            '[0:a]volume=1[a0];[1:a]volume=0.16[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[a]',
            '-map', '0:v', '-map', '[a]',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest',
            mixed,
          ]);
          if (m.ok) {
            try {
              renameSync(mixed, videoPath);
            } catch {
              /* 保留原片 */
            }
          } else {
            detail.warnings.push('底噪混音失败：' + m.reason);
          }
        }
      }
      try {
        rmSync(listFile, { force: true });
      } catch {
        /* ignore */
      }
    } else if (segments.some((s) => s.imgPath)) {
      // 部分失败：用第一张能用的图做兜底视频（至少可预览）
      const first = segments.find((s) => s.imgPath);
      videoPath = join(job.dir, 'video.mp4');
      const r = await runFfmpeg(exe, ['-y', '-loop', '1', '-i', first.imgPath, '-t', String(Math.max(3, cursor)), '-vf',
        `scale=${QUALITY_W}:${QUALITY_H}:force_original_aspect_ratio=decrease,pad=${QUALITY_W}:${QUALITY_H}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
        '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath]);
      if (!r.ok) videoPath = '';
      if (videoPath) detail.warnings.push('只有部分分镜可用，成片为单图兜底');
    }

    // 5) 封面
    const firstImg = segments.find((s) => s.imgPath)?.imgPath;
    if (firstImg) {
      const cover = join(job.dir, 'cover.jpg');
      if (await coverFromImage(exe, firstImg, cover)) job.cover = cover;
    }

    // [qqbot-mod] cleanup-mid 2026-10-31：主人要求「没用的中间产物及时清空」。
    //   成片+封面都成功后，清掉可重建的分段/临时文件；panels 里的最终出图保留
    //   （重渲染还要用，重出图要再花算力），只删 -bg-raw.jpg（crop 前的云端原图）。
    if (videoPath && job.cover) {
      let cleaned = 0;
      const rmOne = (p) => { try { const s = statSync(p); cleaned += s.size; rmSync(p, { force: true }); } catch { /* ignore */ } };
      try {
        for (const f of readdirSync(job.dir)) {
          if (/^seg-\d+\.mp4$/.test(f) || /^cap-\d+\.txt$/.test(f)) rmOne(join(job.dir, f));
        }
        const panelsDir = join(job.dir, 'panels');
        if (existsSync(panelsDir)) {
          for (const f of readdirSync(panelsDir)) {
            if (/-bg-raw\.jpg$/.test(f)) rmOne(join(panelsDir, f));
          }
        }
        if (cleaned > 0) detail.cleanup = { cleanedBytes: cleaned };
      } catch { /* 清理失败不影响成片 */ }
    }
  }

  Object.assign(job, {
    title: script.title,
    desc: script.desc,
    tags: script.tags,
    durationSec: Number(cursor.toFixed(1)),
    srt: srtPath,
    video: videoPath,
    mode: detail.plan,
    status: videoPath ? 'rendered' : 'failed',
    error: videoPath ? '' : detail.warnings[0] || '渲染失败',
  });
  saveJob(job);

  // 6) 剪映素材包 / 草稿
  try {
    writeJianyingAssets(job);
    if (String(ops.jianying?.mode || 'assets') === 'draft') writeJianyingDraft(job, ops);
  } catch (e) {
    detail.warnings.push('剪映导出失败：' + (e?.message || String(e)));
  }

  if (job.status !== 'rendered') return { ok: false, error: job.error, job, detail };
  updateJob(dataRoot, job.id, { status: 'awaiting_review' });
  job.status = 'awaiting_review';
  appendRecord(dataRoot, { type: 'render', jobId: job.id, title: job.title, durationSec: job.durationSec, warnings: detail.warnings.length });
  return { ok: true, job, detail };
}

/** 导入剪映用的素材包 */
export function writeJianyingAssets(job) {
  const body = [
    '剪映导入说明',
    '============',
    '1. 打开剪映 → 新建项目；',
    '2. 把 panels/ 里的图片按序号拖到时间线；',
    '3. 把 audio/ 里的 mp3 对到对应图片上；',
    '4. 需要字幕时导入 sub.srt（文本 → 导入字幕），或直接把 sub.srt 拖进时间线；',
    '5. 精修完导出，再走 B 站投稿。',
    '',
    '标题：' + (job.title || ''),
    '简介：' + (job.desc || ''),
    '标签：' + (job.tags || []).join(','),
    '',
    '分镜：',
    ...(job.panels || []).map((p) => `  ${p.index}. [${p.seconds?.toFixed?.(1) || '?'}s] ${p.narration}`),
  ].join('\n');
  const out = join(job.dir, 'README.txt');
  writeFileSync(out, body, 'utf8');
  return out;
}

/**
 * 可选：导出剪映草稿工程（best-effort，剪映版本不兼容时用素材包）。
 * 只写最小可用结构，失败不影响成片。
 */
export function writeJianyingDraft(job, cfg = {}) {
  const dataRoot = job.dataRoot || dataRootOf();
  const dir = String(cfg.jianying?.draftDir || '').trim() || join(paths(dataRoot).jianying, job.id);
  mkdirSync(dir, { recursive: true });
  const us = 1_000_000; // 剪映时间单位：微秒
  const videoSegs = [];
  const audioSegs = [];
  const textSegs = [];
  (job.panels || []).forEach((p) => {
    if (p.image) {
      videoSegs.push({
        id: 'v' + p.index,
        material_id: 'm' + p.index,
        target_timerange: { start: Math.round(p.start * us), duration: Math.round((p.end - p.start) * us) },
        source_timerange: { start: 0, duration: Math.round((p.end - p.start) * us) },
        speed: 1,
      });
    }
    if (p.audio) {
      audioSegs.push({
        id: 'a' + p.index,
        material_id: 'am' + p.index,
        target_timerange: { start: Math.round(p.start * us), duration: Math.round((p.end - p.start) * us) },
        source_timerange: { start: 0, duration: Math.round((p.end - p.start) * us) },
        speed: 1,
      });
    }
    if (p.narration) {
      textSegs.push({
        id: 't' + p.index,
        content: p.narration,
        target_timerange: { start: Math.round(p.start * us), duration: Math.round((p.end - p.start) * us) },
      });
    }
  });
  const draft = {
    version: 360000,
    canvas_config: { width: QUALITY_W, height: QUALITY_H, ratio: '16:9' },
    duration: Math.round((job.durationSec || 0) * us),
    materials: {
      videos: (job.panels || []).filter((p) => p.image).map((p) => ({ id: 'm' + p.index, path: String(p.image).replace(/\\/g, '/'), type: 'photo' })),
      audios: (job.panels || []).filter((p) => p.audio).map((p) => ({ id: 'am' + p.index, path: String(p.audio).replace(/\\/g, '/'), type: 'extract_music' })),
      texts: textSegs.map((t) => ({ id: t.id, content: t.content })),
    },
    tracks: [
      { type: 'video', segments: videoSegs },
      { type: 'audio', segments: audioSegs },
      { type: 'text', segments: textSegs },
    ],
  };
  writeFileSync(join(dir, 'draft_content.json'), JSON.stringify(draft, null, 2), 'utf8');
  writeFileSync(
    join(dir, 'draft_meta_info.json'),
    JSON.stringify({ draft_name: job.title || job.id, draft_fold_path: String(dir).replace(/\\/g, '/') }, null, 2),
    'utf8'
  );
  writeFileSync(join(dir, 'draft_agency_config.json'), JSON.stringify({}, null, 2), 'utf8');
  return dir;
}

// ── B 站写操作 ───────────────────────────────────────────────────────

const API = 'https://api.bilibili.com';
const MEMBER = 'https://member.bilibili.com';

async function postForm(url, cookie, body, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'user-agent': B.UA,
        referer: 'https://www.bilibili.com/',
        origin: 'https://www.bilibili.com',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: B.cookieHeader(cookie),
      },
      body: new URLSearchParams(body).toString(),
      signal: ctl.signal,
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, error: '返回不是 JSON（HTTP ' + res.status + '）' };
    if (Number(j.code) === -101 || Number(j.code) === -400) return { ok: false, needLogin: true, error: '登录已失效，请重新扫码' };
    if (Number(j.code) !== 0) return { ok: false, error: j.message || 'code ' + j.code };
    return { ok: true, data: j.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 改昵称（B 站限制：6 个月内只能改一次） */
export async function renameAccount(dataRoot, uname) {
  const name = String(uname || '').trim();
  if (!name) return { ok: false, error: '昵称不能为空' };
  if (name.length > 20) return { ok: false, error: '昵称过长（≤20 字）' };
  const c = B.loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  if (!c.cookies.bili_jct) return { ok: false, error: 'Cookie 缺 bili_jct（csrf）' };
  const r = await postForm(`${API}/x/member/web/update`, c.cookies, { uname: name, csrf: c.cookies.bili_jct });
  if (!r.ok) return r;
  appendRecord(dataRoot, { type: 'rename', name });
  return { ok: true, name };
}

/** 评论 / 楼中楼回复 */
export async function replyComment(dataRoot, { aid, oid, message, root, parent } = {}) {
  const target = aid || oid;
  const text = String(message || '').trim();
  if (!target) return { ok: false, error: '缺少 aid（或 oid）' };
  if (!text) return { ok: false, error: '评论内容为空' };
  if (text.length > 1000) return { ok: false, error: '评论过长（≤1000 字）' };
  const c = B.loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  if (!c.cookies.bili_jct) return { ok: false, error: 'Cookie 缺 bili_jct（csrf）' };
  const body = { oid: String(target), type: '1', message: text, csrf: c.cookies.bili_jct, plat: '1' };
  if (root) body.root = String(root);
  if (parent) body.parent = String(parent);
  const r = await postForm(`${API}/x/v2/reply/add`, c.cookies, body);
  if (!r.ok) return r;
  return { ok: true, rpid: r.data?.rpid_str || r.data?.rpid };
}

/**
 * 给指定的某条评论追加道歉，并可选挂一条动态。
 * 使用：之前发错/说错 -> 找到那条评论的 rpid -> 在这里追加回复 + 动态。
 */
export async function apologizeComment(dataRoot, {
  bvid, rpid, root, reason = '', message = '', alsoDynamic = true, dynamicText = '',
} = {}) {
  const target = String(bvid || '').trim();
  const replyTo = String(rpid || '').trim();
  if (!target) return { ok: false, error: '缺少 bvid' };
  if (!replyTo) return { ok: false, error: '缺少要道歉的评论 rpid' };
  const v = await B.video(dataRoot, { bvid: target });
  if (!v.ok) return { ok: false, error: v.error || '查不到这个视频', needLogin: v.needLogin };
  const why = String(reason || '之前的表述不合适').slice(0, 80);
  const text = String(message || `抱歉，我上一条评论说得不对（${why}）。已经改正，也谢谢你指出来。`).slice(0, 1000);
  const rp = await replyComment(dataRoot, {
    aid: v.video.aid,
    message: text,
    root: String(root || replyTo),
    parent: replyTo,
  });
  if (!rp.ok) {
    appendRecord(dataRoot, { type: 'apology-failed', bvid: target, rpid: replyTo, error: rp.error || 'reply-failed' });
    return { ok: false, error: rp.error || '追加评论失败', needLogin: rp.needLogin };
  }
  let dyn = null;
  if (alsoDynamic) {
    const dtext = String(dynamicText || `【道歉】关于 ${target} 评论区：${why}。已经在原评论下说明，之后会更谨慎。`).slice(0, 2000);
    dyn = await B.postDynamic(dataRoot, { content: dtext });
    appendRecord(dataRoot, {
      type: dyn.ok ? 'apology-dynamic' : 'apology-dynamic-failed',
      bvid: target, rpid: replyTo, text: dtext,
      dynamicId: dyn.dynamicId || '', error: dyn.ok ? '' : (dyn.error || ''),
    });
  }
  appendRecord(dataRoot, {
    type: 'apology', bvid: target, rpid: replyTo, root: String(root || replyTo),
    text, reason: why, replyRpid: rp.rpid || '', dynamicId: dyn?.dynamicId || '',
  });
  return {
    ok: true, bvid: target, rpid: replyTo, replyRpid: rp.rpid || '',
    text, dynamic: dyn, dynamicId: dyn?.dynamicId || '',
  };
}

/** 评论草稿（只生成，不发送） */
export async function draftComment(dataRoot, { bvid, message, intent, root = '', parent = '', user = '', source = '' } = {}, cfg = {}) {
  const topic = sanitizeTopic(intent || bvid);
  let text = String(message || '').trim();
  let llm = 'given';
  if (!text) {
    const secret = readSecret(dataRoot);
    const w = await withReviewLock(() =>
      writeText({ kind: 'comment', topic }, cfg, { dataRoot, apiKey: secret.apiKey }),
    );
    if (!w.ok) return { ok: false, error: w.error || '写评论失败', chain: w.chain };
    text = w.text;
    llm = w.llm;
  }
  const id = 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
  // [qqbot-mod] reply-thread 2026-10-27：草稿可携带楼中楼目标（root/parent）与来源评论者，
  //   审批通过后 replyComment 会带上 root/parent，变成真正的"回复某条评论"而不是顶层新评论
  const rec = { id, bvid: String(bvid || ''), text, llm, createdAt: Date.now(), status: 'pending',
    root: String(root || ''), parent: String(parent || ''), user: String(user || ''), source: String(source || '') };
  const p = ensureDirs(dataRoot);
  appendFileSync(p.comments, JSON.stringify(rec) + '\n', 'utf8');
  return { ok: true, draft: rec };
}

export function listCommentDrafts(dataRoot, { limit = 10 } = {}) {
  try {
    const rows = readFileSync(paths(dataRoot).comments, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.id);
    // 同一个 id 以最后一条为准（编辑/审核都是追加写，不改历史行）
    const map = new Map();
    for (const r of rows) map.set(r.id, r);
    return [...map.values()]
      .sort((a, b) => (Number(b.editedAt) || Number(b.createdAt) || 0) - (Number(a.editedAt) || Number(a.createdAt) || 0))
      .slice(0, Math.max(1, Number(limit) || 10));
  } catch {
    return [];
  }
}

// ── 文稿草稿箱（2026-10-28 主人需求）────────────────────────────────────
// 灵感随手记、反复改思路的地方：可以是几句话的选题灵感，也可以是整篇分镜文案，
// 改好了「转视频任务」一键进渲染管线。和评论草稿一样走 JSONL 追加写（last-wins），
// 台账不怕并发写坏；面板/工具（bili_ops action=draft）和宿主 API 三处共用。

function appendDraft(dataRoot, rec) {
  const p = ensureDirs(dataRoot);
  appendFileSync(p.drafts, JSON.stringify(rec) + '\n', 'utf8');
}

function loadDraftMap(dataRoot) {
  try {
    const rows = readFileSync(paths(dataRoot).drafts, 'utf8')
      .split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && x.id);
    const map = new Map();
    for (const r of rows) map.set(r.id, r);
    return map;
  } catch {
    return new Map();
  }
}

export function listScriptDrafts(dataRoot, { limit = 30, q = '' } = {}) {
  const kw = String(q || '').trim().toLowerCase();
  return [...loadDraftMap(dataRoot).values()]
    .filter((d) => d.status !== 'deleted')
    .filter((d) => !kw || (String(d.title || '') + String(d.text || '')).toLowerCase().includes(kw))
    .sort((a, b) => (Number(b.editedAt) || Number(b.createdAt) || 0) - (Number(a.editedAt) || Number(a.createdAt) || 0))
    .slice(0, Math.max(1, Number(limit) || 30));
}

export function getScriptDraft(dataRoot, id) {
  return loadDraftMap(dataRoot).get(String(id || '')) || null;
}

/** 新建/更新文稿草稿。id 省略=新建；给了 id=在原文稿上覆盖（更新也是追加写）。
 *  usedJobId：转成视频任务后回写，防止重复转。 */
export function saveScriptDraft(dataRoot, { id, title, text, tags, usedJobId } = {}) {
  const body = String(text || '').trim();
  if (!body && !usedJobId) return { ok: false, error: '草稿内容不能为空' };
  const prev = id ? loadDraftMap(dataRoot).get(String(id)) : null;
  if (id && !prev) return { ok: false, error: '找不到草稿 ' + id };
  if (prev && prev.status === 'deleted' && !usedJobId) return { ok: false, error: '这条草稿已删除，不能改' };
  const rec = {
    id: prev ? prev.id : ('d-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5)),
    title: String(title || prev?.title || (body.split(/\n|。/)[0] || '')).trim().slice(0, 80) || '未命名草稿',
    text: prev && !body ? prev.text : body.slice(0, 20000),
    tags: (Array.isArray(tags) ? tags : String(tags || (prev?.tags || []).join(',')).split(','))
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 8),
    status: 'active',
    createdAt: prev?.createdAt || Date.now(),
    editedAt: Date.now(),
    usedJobId: String(usedJobId || prev?.usedJobId || ''),
  };
  appendDraft(dataRoot, rec);
  return { ok: true, draft: rec };
}

export function deleteScriptDraft(dataRoot, id) {
  const d = loadDraftMap(dataRoot).get(String(id || ''));
  if (!d || d.status === 'deleted') return { ok: false, error: '找不到草稿 ' + id };
  appendDraft(dataRoot, { ...d, status: 'deleted', deletedAt: Date.now() });
  return { ok: true, id: d.id, msg: '已删除草稿 ' + d.id };
}

/** 主人修改评论草稿（只是改文字，不发送） */
export function updateCommentDraft(dataRoot, { id, text } = {}) {  const d = listCommentDrafts(dataRoot, { limit: 200 }).find((x) => x.id === String(id || ''));
  if (!d) return { ok: false, error: '找不到评论草稿' };
  if (d.status !== 'pending') return { ok: false, error: '该评论已处理过（' + d.status + '）' };
  const next = {
    ...d,
    text: String(text || '').trim().slice(0, 1000),
    editedAt: Date.now(),
    editedBy: 'owner',
  };
  if (!next.text) return { ok: false, error: '评论不能为空' };
  appendFileSync(paths(dataRoot).comments, JSON.stringify(next) + '\n', 'utf8');
  return { ok: true, draft: next };
}

/** 主人给“修改建议”：本地模型改写，不再花云端 token */
export async function reviseCommentDraft(dataRoot, { id, suggestion } = {}, cfg = {}) {
  const d = listCommentDrafts(dataRoot, { limit: 200 }).find((x) => x.id === String(id || ''));
  if (!d) return { ok: false, error: '找不到评论草稿' };
  if (d.status !== 'pending') return { ok: false, error: '该评论已处理过（' + d.status + '）' };
  const tip = String(suggestion || '').trim().slice(0, 300);
  if (!tip) return { ok: false, error: '缺少修改建议' };
  try {
    const llm = await import('./local-llm.mjs');
    const c = llm.loadConfig({ dataRoot });
    const r = await withReviewLock(() =>
      llm.chat({
        cfg: c,
        maxTokens: 220,
        temperature: 0.6,
        messages: [
          {
            role: 'system',
            content:
              '你是 B 站评论改写助手。保持第一人称、口语、像真人，不要客服腔，不要解释。' +
              '只输出改写后的评论正文，不要引号、不要标题。',
          },
          { role: 'user', content: `原评论：${d.text}\n修改建议：${tip}\n请按建议改写，60 字以内。` },
        ],
      }),
    );
    if (!r.ok || !r.text) return { ok: false, error: r.error || '本地模型没有返回', fallbackText: d.text };
    const next = updateCommentDraft(dataRoot, { id: d.id, text: r.text });
    return next.ok ? { ...next, via: 'local', ms: r.ms, model: r.model } : next;
  } catch (e) {
    return { ok: false, error: '本地改写失败：' + String((e && e.message) || e), fallbackText: d.text };
  }
}

/** 主人拒绝评论草稿 */
export function rejectCommentDraft(dataRoot, { id } = {}) {
  const d = listCommentDrafts(dataRoot, { limit: 200 }).find((x) => x.id === String(id || ''));
  if (!d) return { ok: false, error: '找不到评论草稿' };
  if (d.status !== 'pending') return { ok: false, error: '该评论已处理过（' + d.status + '）' };
  const next = { ...d, status: 'rejected', rejectedAt: Date.now() };
  appendFileSync(paths(dataRoot).comments, JSON.stringify(next) + '\n', 'utf8');
  appendRecord(dataRoot, { type: 'comment-rejected', bvid: d.bvid, draftId: d.id });
  return { ok: true, draft: next };
}

/** 审核通过后发评论 */
export async function approveComment(dataRoot, { bvid, draftId, aid } = {}, cfg = {}) {
  const drafts = listCommentDrafts(dataRoot, { limit: 50 });
  const d = draftId ? drafts.find((x) => x.id === draftId) : drafts.find((x) => x.bvid === String(bvid || ''));
  if (!d) return { ok: false, error: '找不到待审评论草稿' };
  if (d.status !== 'pending') return { ok: false, error: '该评论已处理过（' + d.status + '）' };
  const q = checkQuota(dataRoot, 'comment', cfg.limits || DEFAULT_OPS_CONFIG.limits);
  if (!q.ok) return q;
  const target = aid || bvid;
  let oid = target;
  if (!/^\d+$/.test(String(oid))) {
    const v = await B.video(dataRoot, { bvid: d.bvid });
    if (!v.ok) return v;
    oid = v.video.aid;
  }
  const r = await replyComment(dataRoot, { aid: oid, message: d.text, root: d.root, parent: d.parent || d.root });
  const p = ensureDirs(dataRoot);
  appendFileSync(p.comments, JSON.stringify({ ...d, status: r.ok ? 'sent' : 'failed', rpid: r.rpid, error: r.error, sentAt: Date.now() }) + '\n', 'utf8');
  if (r.ok) {
    bumpQuota(dataRoot, 'comment');
    appendRecord(dataRoot, { type: 'comment', bvid: d.bvid, text: d.text, rpid: r.rpid });
  } else {
    appendRecord(dataRoot, { type: 'comment-failed', bvid: d.bvid, error: r.error });
  }
  return r.ok ? { ok: true, rpid: r.rpid, text: d.text } : { ok: false, error: r.error, text: d.text };
}

/** 运营：拉数据 + 生成建议回复（不自动发） */
export async function engage(dataRoot, { bvid } = {}, cfg = {}) {
  const v = await B.video(dataRoot, { bvid });
  if (!v.ok) return v;
  const cs = await B.comments(dataRoot, { aid: v.video.aid, limit: 8 });
  const secret = readSecret(dataRoot);
  const suggestions = [];
  const maxBatch = Math.max(1, Math.min(5, Number(cfg?.review?.maxPerBatch) || 2));
  for (const c of (cs.ok ? cs.replies : []).slice(0, maxBatch)) {
    const w = await withReviewLock(() =>
      writeText({ kind: 'reply', topic: v.video.title, context: c.text }, cfg, { dataRoot, apiKey: secret.apiKey }),
    );
    suggestions.push({ rpid: c.rpid, user: c.user, comment: c.text, reply: w.ok ? w.text : '', llm: w.ok ? w.llm : '', error: w.ok ? '' : w.error });
  }
  const snap = { views: v.video.views, likes: v.video.likes, coins: v.video.coins };
  appendRecord(dataRoot, { type: 'engage', bvid, title: v.video.title, stats: snap, suggestions: suggestions.length });
  return { ok: true, video: { bvid, title: v.video.title, ...snap }, comments: suggestions.length, suggestions };
}

// ── 投稿 ─────────────────────────────────────────────────────────────

function decodeBiliError(j) {
  const code = Number(j?.code);
  const map = {
    '-101': '登录已失效，请重新扫码',
    '-400': '请求参数错误',
    '21001': '账号未登录',
    '21002': '账号被封禁',
    '21003': '投稿被拒绝',
    '21004': '标题或简介含违规内容',
    '21008': '分区不存在',
    '21012': '视频正在审核中',
    '21013': '视频时长不符合要求',
    '21014': '视频格式不支持',
    '21101': '稿件已存在',
  };
  return map[String(code)] || j?.message || ('code ' + code);
}

async function uploadVideoFile(dataRoot, filePath, filename) {
  const c = B.loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站', stage: 'cookie' };
  const size = statSync(filePath).size;
  // 2026-10 起 B 站 web 上传入口是 https://member.bilibili.com/preupload（不是 /x/vu/web/preupload，
  // 后者 404 返回 HTML，旧代码会误报「preupload 返回不是 JSON」）。
  // 参照 biliup 1.3.4 的真实流程（PyPI 上的源码）：
  //   1. GET /preupload?upcdn=…&probe_version=…&{name,size,r=upos,profile=ugcupos/bup}
  //   2. POST {endpoint}/{upos_uri}?uploads&output=json（带 X-Upos-Auth）→ upload_id
  //   3. 分片 PUT {url}?uploadId=&partNumber=&chunk=&chunks=&size=&start=&end=&total=
  //   4. POST {url}?name=&uploadId=&biz_id=&output=json&profile=ugcupos/bup，body {parts:[{partNumber,eTag:'etag'}]} → {"OK":1}
  //   5. add 用 videos[0].filename = upos_uri 的**文件名去扩展名**（不是带 bucket 的路径）
  const q = new URLSearchParams({
    upcdn: 'bda2',
    probe_version: '20221109',
    name: filename,
    size: String(size),
    r: 'upos',
    profile: 'ugcupos/bup',
  });
  let res;
  try {
    res = await fetch(`${MEMBER}/preupload?${q}`, {
      headers: {
        'user-agent': B.UA,
        referer: 'https://member.bilibili.com/platform/upload/video/frame',
        cookie: B.cookieHeader(c.cookies),
      },
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e), stage: 'preupload' };
  }
  const j = await res.json().catch(() => null);
  if (!j) return { ok: false, error: `preupload 返回不是 JSON（HTTP ${res.status}，接口可能又改了）`, stage: 'preupload' };
  if (Number(j.OK) !== 1 || !j.upos_uri) return { ok: false, error: decodeBiliError(j), stage: 'preupload', raw: j };
  const d = j;

  const endpoint = String(d.endpoint || '').trim();
  const host = endpoint.startsWith('//') ? 'https:' + endpoint : endpoint.replace(/^http:/, 'https:');
  const uriPath = String(d.upos_uri || '').replace(/^upos:\/\//, '');
  const putUrl = `${host}/${uriPath}`;
  const auth = String(d.auth || '');
  const chunkSize = Math.max(1024 * 1024, Number(d.chunk_size) || 4 * 1024 * 1024);
  const bizId = String(d.biz_id || '');

  // 2) 申请上传 id
  let uploadId = '';
  try {
    const r = await fetch(`${putUrl}?uploads&output=json`, {
      method: 'POST',
      headers: { 'user-agent': B.UA, 'x-upos-auth': auth, referer: 'https://member.bilibili.com/platform/upload/video/frame' },
    });
    const uj = await r.json().catch(() => null);
    uploadId = String(uj?.upload_id || '');
    if (!uploadId) return { ok: false, error: `申请上传 id 失败（HTTP ${r.status}）`, stage: 'uploads', raw: uj };
  } catch (e) {
    return { ok: false, error: `申请上传 id 出错：${e?.message || e}`, stage: 'uploads' };
  }

  // 3) 分片上传
  let buf;
  try {
    buf = readFileSync(filePath);
  } catch (e) {
    return { ok: false, error: e?.message || String(e), stage: 'read' };
  }
  const chunks = Math.max(1, Math.ceil(size / chunkSize));
  const parts = [];
  for (let i = 0; i < chunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(size, start + chunkSize);
    const slice = buf.subarray(start, end);
    const p = new URLSearchParams({
      uploadId,
      partNumber: String(i + 1),
      chunk: String(i),
      chunks: String(chunks),
      size: String(slice.length),
      start: String(start),
      end: String(end),
      total: String(size),
    });
    let okOnce = false;
    let lastErr = '';
    for (let t = 0; t < 3 && !okOnce; t++) {
      try {
        const r = await fetch(`${putUrl}?${p}`, {
          method: 'PUT',
          headers: {
            'user-agent': B.UA,
            'content-type': 'application/octet-stream',
            'x-upos-auth': auth,
            referer: 'https://member.bilibili.com/platform/upload/video/frame',
          },
          body: slice,
        });
        if (r.ok) okOnce = true;
        else lastErr = `HTTP ${r.status}`;
      } catch (e) {
        lastErr = e?.message || String(e);
      }
    }
    if (!okOnce) return { ok: false, error: `第 ${i + 1}/${chunks} 片上传失败：${lastErr}`, stage: 'upload' };
    parts.push({ partNumber: i + 1, eTag: 'etag' });
  }

  // 4) 合并
  const mp = new URLSearchParams({
    name: filename,
    uploadId,
    biz_id: bizId,
    output: 'json',
    profile: 'ugcupos/bup',
  });
  try {
    const r = await fetch(`${putUrl}?${mp}`, {
      method: 'POST',
      headers: {
        'user-agent': B.UA,
        'content-type': 'application/json',
        'x-upos-auth': auth,
        referer: 'https://member.bilibili.com/platform/upload/video/frame',
      },
      body: JSON.stringify({ parts }),
    });
    const mj = await r.json().catch(() => null);
    if (!mj || Number(mj.OK) !== 1) {
      return { ok: false, error: `合并分片失败（HTTP ${r.status}）：${JSON.stringify(mj).slice(0, 160)}`, stage: 'merge', raw: mj };
    }
  } catch (e) {
    return { ok: false, error: `合并分片出错：${e?.message || e}`, stage: 'merge' };
  }

  // 5) add 用的 filename：upos_uri 的 basename 去扩展名
  const base = String(uriPath).split('/').pop() || '';
  const addFilename = base.replace(/\.[A-Za-z0-9]+$/, '');
  return { ok: true, uposUri: String(d.upos_uri || ''), endpoint, bizId, size, chunks, addFilename };
}

async function uploadCover(dataRoot, coverPath) {
  try {
    const c = B.loadCookie(dataRoot);
    if (!c) return { ok: false, error: '未登录' };
    const isPng = /\.png$/i.test(coverPath);
    const buf = readFileSync(coverPath);
    const form = new FormData();
    form.append('cover', new Blob([buf], { type: isPng ? 'image/png' : 'image/jpeg' }), isPng ? 'cover.png' : 'cover.jpg');
    form.append('csrf', c.cookies.bili_jct);
    const res = await fetch(`${MEMBER}/x/vu/web/cover/up`, {
      method: 'POST',
      headers: { 'user-agent': B.UA, referer: 'https://member.bilibili.com/', cookie: B.cookieHeader(c.cookies) },
      body: form,
    });
    const j = await res.json().catch(() => null);
    if (!j) return { ok: false, error: '封面上传返回不是 JSON' };
    if (Number(j.code) !== 0 || !j.data?.url) return { ok: false, error: decodeBiliError(j) };
    return { ok: true, url: j.data.url };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function submitVideo(dataRoot, { title, desc, tags, coverUrl, uposUri, addFilename, tid, copyright }) {
  const c = B.loadCookie(dataRoot);
  if (!c) return { ok: false, needLogin: true, error: '还没登录 B 站' };
  if (!c.cookies.bili_jct) return { ok: false, error: 'Cookie 缺 bili_jct（csrf）' };
  // biliup 1.3.4 的写法：filename = upos_uri 的 basename 去扩展名；接口用 /x/vu/web/add（不是 add/v3）
  const fromUri = String(uposUri || '').split('/').pop().replace(/\.[A-Za-z0-9]+$/, '');
  const filename = String(addFilename || fromUri || '').trim();
  if (!filename) return { ok: false, error: '缺上传文件名（upos 返回里没有 upos_uri）' };
  const body = {
    title: String(title || '').slice(0, 80),
    copyright: Number(copyright) === 2 ? 2 : 1,
    tid: Number(tid) || 21,
    tag: (Array.isArray(tags) ? tags : []).join(',').slice(0, 200) || '知识科普',
    desc: String(desc || '').slice(0, 2000),
    source: '',
    cover: coverUrl || '',
    dynamic: '',
    interactive: 0,
    videos: [{ filename, title: String(title || '').slice(0, 80), desc: '', cid: null }],
  };
  const post = async (path) => {
    const res = await fetch(`${MEMBER}${path}?csrf=${encodeURIComponent(c.cookies.bili_jct)}`, {
      method: 'POST',
      headers: {
        'user-agent': B.UA,
        referer: 'https://member.bilibili.com/platform/upload/video/frame',
        origin: 'https://member.bilibili.com',
        'content-type': 'application/json',
        cookie: B.cookieHeader(c.cookies),
      },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    return { status: res.status, j };
  };
  try {
    // 先走 biliup 用的老入口；21015 之类再退回 add/v3
    let r = await post('/x/vu/web/add');
    if (!r.j) return { ok: false, error: `投稿返回不是 JSON（HTTP ${r.status}）` };
    if (Number(r.j.code) !== 0) {
      const r2 = await post('/x/vu/web/add/v3');
      if (r2.j && Number(r2.j.code) === 0) r = r2;
    }
    const j = r.j;
    if (Number(j.code) !== 0) return { ok: false, error: decodeBiliError(j), raw: j };
    return { ok: true, bvid: j.data?.bvid || '', aid: j.data?.aid || '', filename };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 发布任务：默认 web 投稿（需 approved）；manual 只返回成片包。
 */
export async function publishJob(dataRoot, jobId, { mode, force = false } = {}, cfg = {}) {
  const ops = deepMerge(DEFAULT_OPS_CONFIG, cfg || {});
  const job = getJob(dataRoot, jobId);
  if (!job) return { ok: false, error: '找不到任务 ' + jobId };
  if (!job.video) return { ok: false, error: '任务还没有成片（先 plan/渲染）' };

  const gateOpen = force || ops.publish.autoPublish === true || job.status === 'approved';
  const useMode = String(mode || ops.publish.mode || 'web');

  // manual 只是把本地产物交回给主人，不算写操作，不过审核闸
  if (useMode === 'manual') {
    appendRecord(dataRoot, { type: 'publish-manual', jobId: job.id, title: job.title });
    return {
      ok: true,
      mode: 'manual',
      jobId: job.id,
      video: job.video,
      cover: job.cover,
      srt: job.srt,
      dir: job.dir,
      pkg: join(job.dir, 'README.txt'),
      msg: '成片和素材包已就绪（人工上传模式）',
    };
  }

  if (ops.publish.requireApproval !== false && !gateOpen) {
    return { ok: false, error: '未审核，不能上传（先让主人 approve）', status: job.status };
  }
  const q = checkQuota(dataRoot, 'video', ops.limits);
  if (!q.ok) return q;

  const filename = `${job.id}.mp4`;
  const up = await uploadVideoFile(dataRoot, job.video, filename);
  if (!up.ok) {
    appendRecord(dataRoot, { type: 'publish-failed', jobId: job.id, stage: up.stage, error: up.error });
    if (ops.publish.fallbackManual) {
      updateJob(dataRoot, job.id, { status: 'awaiting_review', error: '投稿失败：' + up.error });
      return { ok: false, error: '投稿失败（' + up.stage + '）：' + up.error, fallback: 'manual', dir: job.dir };
    }
    return { ok: false, error: '投稿失败（' + up.stage + '）：' + up.error };
  }

  let coverUrl = '';
  if (job.cover) {
    const cv = await uploadCover(dataRoot, job.cover);
    coverUrl = cv.ok ? cv.url : '';
  }
  const sub = await submitVideo(dataRoot, {
    title: job.title,
    desc: job.desc,
    tags: job.tags,
    coverUrl,
    uposUri: up.uposUri,
    addFilename: up.addFilename,
    tid: ops.video.tid,
    copyright: ops.video.copyright,
  });
  if (!sub.ok) {
    appendRecord(dataRoot, { type: 'publish-failed', jobId: job.id, stage: 'submit', error: sub.error });
    if (ops.publish.fallbackManual) {
      updateJob(dataRoot, job.id, { status: 'awaiting_review', error: '投稿提交失败：' + sub.error });
      return { ok: false, error: '投稿提交失败：' + sub.error, fallback: 'manual', dir: job.dir };
    }
    return { ok: false, error: '投稿提交失败：' + sub.error };
  }

  bumpQuota(dataRoot, 'video');
  updateJob(dataRoot, job.id, { status: 'published', published: { bvid: sub.bvid, aid: sub.aid, at: Date.now() } });
  appendRecord(dataRoot, { type: 'publish', jobId: job.id, title: job.title, bvid: sub.bvid, aid: sub.aid });
  return { ok: true, mode: 'web', jobId: job.id, bvid: sub.bvid, aid: sub.aid, msg: '已投稿：BV' + String(sub.bvid || '').replace(/^BV/, '') };
}

/** 审核通过 → 自动上传（web） */
export async function approveJob(dataRoot, jobId, cfg = {}) {
  const job = getJob(dataRoot, jobId);
  if (!job) return { ok: false, error: '找不到任务 ' + jobId };
  if (job.status === 'published') return { ok: false, error: '这个任务已经发布过了' };
  updateJob(dataRoot, jobId, { status: 'approved' });
  const ops = deepMerge(DEFAULT_OPS_CONFIG, cfg || {});
  if (String(ops.publish.mode || 'web') === 'manual') {
    return { ok: true, mode: 'manual', msg: '已标记通过（人工上传模式，成片在 ' + job.dir + '）', dir: job.dir };
  }
  return publishJob(dataRoot, jobId, { mode: 'web' }, ops);
}
