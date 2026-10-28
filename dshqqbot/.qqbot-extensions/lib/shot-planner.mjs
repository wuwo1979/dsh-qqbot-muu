/**
 * shot-planner.mjs — 文案 → 分镜（可测的纯函数层）
 *
 * 为什么要把"分镜"从 renderJob 里拆出来：
 *   原来的链路是「模型给 N 段旁白 + 每段一句英文图描述」→ 直接开渲。
 *   问题不在渲染，在**编排**：
 *     · 旁白长度不齐（8 字一屏、90 字一屏），成片节奏像瘸腿；
 *     · 连续三屏同一机位/同一句图描述，出图必然"六张差不多"；
 *     · 转折、结论没有对应的转场和音效，5 屏看下来是一条直线。
 *   这里把它做成一层纯函数：给脚本，出**带节拍、带时长预算、带转场与音效提示**
 *   的分镜表。渲染层只负责照着执行，质量就不再靠模型当天心情。
 *
 * 节拍（beat）含义：
 *   hook  开场钩子（3~5s，必须最快出画面）
 *   point 论点（文字动效为主，信息密度高）
 *   turn  转折/反差（换镜头语言：冲击音效 + 硬切）
 *   proof 例证/画面（真图最值钱的位置）
 *   cta   收尾（淡出 + 提问）
 *
 * 产物是**证据齐全的可解释对象**：每屏为什么用文字、为什么用图、为什么这个
 * 转场，都写在 shot.why 里 —— 出问题能复盘，不用猜。
 */

export const TEXT_STYLES = ['typewriter', 'kinetic', 'pop', 'sweep', 'code', 'slide', 'fade', 'glitch',
  // 字形叙事（参考《文字游戏》）：以字代图 / 拆字 / 留白
  'stack', 'split', 'breathe'];

const BEAT_ORDER = ['hook', 'point', 'turn', 'proof', 'cta'];

const STYLE_BY_BEAT = {
  hook: ['kinetic', 'pop', 'typewriter'],
  point: ['typewriter', 'sweep', 'code'],
  turn: ['glitch', 'pop', 'kinetic'],
  proof: ['slide', 'sweep', 'fade'],
  cta: ['fade', 'slide', 'sweep'],
};

/** 转场：谁是"硬切"，谁是"软过渡" */
const TRANSITION_BY_BEAT = {
  hook: { type: 'cut', sec: 0 },
  point: { type: 'dissolve', sec: 0.28 },
  turn: { type: 'whip', sec: 0.16 },
  proof: { type: 'zoom', sec: 0.24 },
  cta: { type: 'fade', sec: 0.4 },
};

/** 中文语速：edge-tts zh-CN 略快语速下约 4.4 字/秒（含标点停顿） */
const CHARS_PER_SEC = 4.4;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 旁白估算时长（没有 TTS 结果时用；有 TTS 就以 TTS 为准） */
export function estimateSec(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s) return 0;
  const punct = (s.match(/[，。！？、；：,.!?;:]/g) || []).length;
  return Math.max(1.2, s.length / CHARS_PER_SEC + punct * 0.12);
}

/** 句子切分：长旁白按标点拆成"信息点"，一屏只讲一件事 */
export function splitSentences(text, maxChars = 42) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const parts = s.split(/(?<=[。！？!?；;])/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= maxChars) { out.push(p); continue; }
    // 还是太长：按逗号再切，最后按硬长度兜底
    const subs = p.split(/(?<=[，,、])/).map((x) => x.trim()).filter(Boolean);
    let buf = '';
    for (const sub of subs) {
      if (!buf) { buf = sub; continue; }
      if ((buf + sub).length <= maxChars) { buf += sub; continue; }
      out.push(buf);
      buf = sub;
    }
    if (buf) out.push(buf);
  }
  return out;
}

/** 视觉关键词（判断两屏画面是不是"同一张图"） */
export function visualKeys(prompt) {
  const s = String(prompt || '').toLowerCase();
  const words = s.match(/[a-z]{3,}/g) || [];
  const zh = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  return new Set([...words, ...zh]);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 节拍分配：先给首尾钉 hook/cta，中间按"信息推进"分配 turn/proof/point。
 * 5 屏以上必有 1 个 turn（没有反差的视频留不住人）和 1 个 proof。
 */
export function assignBeats(n) {
  const count = Math.max(2, Math.min(12, Math.round(num(n, 5))));
  const beats = new Array(count).fill('point');
  beats[0] = 'hook';
  if (count >= 3) beats[count - 1] = 'cta';
  if (count >= 4) beats[Math.max(1, Math.floor(count * 0.6))] = 'turn';
  if (count >= 5) beats[Math.max(1, Math.floor(count * 0.35))] = 'proof';
  if (count >= 7) beats[Math.max(2, Math.floor(count * 0.8))] = 'proof';
  return beats;
}

/**
 * 主入口：把脚本编成可执行分镜表。
 * @param {{title?:string, desc?:string, panels:Array<{narration:string,imagePrompt?:string}>}} script
 * @param {object} opts {
 *   imageProvider?: 'cloud'|'local',   // 决定"真图"值不值钱
 *   maxImageShots?: number,            // 一单最多几张真图（控成本/控质量）
 *   shotMinSec?, shotMaxSec?,
 *   preferText?: boolean               // 强制走文字动效（全片不用 AI 图）
 * }
 */
export function planStoryboard(script, opts = {}) {
  const panels = Array.isArray(script?.panels) ? script.panels.filter((p) => p && String(p.narration || '').trim()) : [];
  const issues = [];
  if (panels.length < 2) {
    return { ok: false, shots: [], issues: ['分镜少于 2 屏，无法编排'], meta: {} };
  }
  const imageProvider = String(opts.imageProvider || 'cloud');
  const preferText = opts.preferText === true;
  const shotMin = clamp(num(opts.shotMinSec, 2.4), 1.2, 8);
  const shotMax = Math.max(shotMin, clamp(num(opts.shotMaxSec, 5.2), 1.6, 12));
  const maxImages = Math.max(0, Math.min(panels.length, num(opts.maxImageShots, imageProvider === 'cloud' ? 2 : 1)));

  const beats = assignBeats(panels.length);
  const shots = [];
  let imagesUsed = 0;
  let lastMode = '';
  let lastKeys = new Set();
  let lastStyle = '';
  // 字形叙事要克制：一单最多用 2 屏，否则整片都在玩花样反而没节奏
  const glyphBudget = Math.max(0, Math.min(3, num(opts.glyphShots, 2)));
  let glyphUsed = 0;

  for (let i = 0; i < panels.length; i += 1) {
    const p = panels[i];
    const beat = beats[i];
    const narration = String(p.narration || '').replace(/\s+/g, ' ').trim();
    const est = estimateSec(narration);
    const bareText = narration.replace(/[，。！？、；：…—·「」『』（）《》"'s]/g, '');
    const why = [];

    // ① 形态：真图只花在"看得见"的位置（hook / proof），其余走文字动效。
    //    云端出图质量不可控 → 默认一单最多 2 张；本地 SD1.5 更差 → 默认 1 张。
    let mode = 'text';
    const tooShortForImage = bareText.length <= 6;
    const wantsImage = !preferText && !tooShortForImage
      && (beat === 'hook' || beat === 'proof') && imagesUsed < maxImages;
    if (wantsImage) {
      mode = 'image';
      imagesUsed += 1;
      why.push('节拍=' + beat + '，值得用真图');
    } else if (tooShortForImage && (beat === 'hook' || beat === 'proof')) {
      why.push('旁白仅 ' + bareText.length + ' 字，留白比配图更有力');
    } else if (!preferText && imagesUsed >= maxImages && (beat === 'hook' || beat === 'proof')) {
      why.push('真图额度已用完（' + maxImages + ' 张），改用文字动效');
    } else {
      why.push(preferText ? '全片文字动效（配置要求）' : '抽象信息点用文字更清楚');
    }

    // ② 画面重复检测：和上一屏画面关键词高度重叠 → 即使有额度也改文字，
    //    否则观众看到的是"同一张图放了两次"。
    const keys = visualKeys(p.imagePrompt || narration);
    if (mode === 'image' && shots.length && jaccard(keys, lastKeys) >= 0.55) {
      mode = 'text';
      imagesUsed -= 1;
      why.push('与上一屏画面高度重复，改文字动效');
    }

    // ③ 相邻不重样：连续两屏同一形态最容易"平"，交替能白拿节奏
    if (mode === lastMode && mode === 'text' && beat !== 'point') {
      why.push('与上一屏同为文字，靠转场/样式区分');
    }

    // ④ 文字样式：按节拍轮换，且不与上一屏相同
    let style = '';
    if (mode === 'text') {
      // 留白要字少（多了就不留白），拆字只看首字、正文小字排在下方，可以放宽
      const glyphLen = beat === 'turn' ? 24 : 14;
      const canGlyph = glyphUsed < glyphBudget && bareText.length <= glyphLen
        && (beat === 'hook' || beat === 'turn' || beat === 'cta');
      if (canGlyph) {
        // 留白适合开场抓人，拆字适合反差；都是"字少才有力"的招式
        style = beat === 'turn' ? 'split' : 'breathe';
        glyphUsed += 1;
        why.push('字形叙事：' + (style === 'split' ? '拆字冲击' : '留白大字'));
      } else {
        const pool = STYLE_BY_BEAT[beat] || STYLE_BY_BEAT.point;
        style = pool.find((s) => s !== lastStyle) || pool[0];
        if (String(p.imagePrompt || '').length > 60) style = style === 'code' ? 'typewriter' : style;
      }
    }

    // ⑤ 转场：节拍决定，但"文字→文字"不要用重转场（会晕）
    const tr = { ...(TRANSITION_BY_BEAT[beat] || TRANSITION_BY_BEAT.point) };
    if (mode === 'text' && lastMode === 'text' && tr.type === 'whip') tr.type = 'dissolve';
    if (i === 0) { tr.type = 'cut'; tr.sec = 0; }

    // ⑥ 时长预算：TTS 还没跑，先用估算；超出上限就提示该拆句
    let hold = clamp(est, shotMin, shotMax);
    if (est > shotMax + 0.6) {
      issues.push(`第 ${i + 1} 屏旁白约 ${est.toFixed(1)}s，超过单屏上限 ${shotMax}s —— 建议拆成两屏`);
    }
    if (est < 1.4) issues.push(`第 ${i + 1} 屏旁白过短（约 ${est.toFixed(1)}s），节奏会碎`);

    // ⑦ 音效提示（渲染层按需去音效库取；这里只给语义与时间点）
    const sfx = [];
    if (i === 0) sfx.push({ kind: 'ambient', at: 0, gain: 0.18 });
    if (tr.type === 'whip' || tr.type === 'cut') sfx.push({ kind: 'whoosh', at: 0.02, gain: 0.3 });
    if (beat === 'proof') sfx.push({ kind: 'pop', at: Math.min(0.5, hold * 0.2), gain: 0.22 });
    if (/成功|完成|搞定|终于|好了/.test(narration)) sfx.push({ kind: 'success', at: Math.max(0.4, hold * 0.6), gain: 0.26 });
    else if (/失败|错误|翻车|不行|坏了/.test(narration)) sfx.push({ kind: 'fail', at: Math.max(0.4, hold * 0.6), gain: 0.26 });
    else if (/[！!]|反而|其实|真相/.test(narration)) sfx.push({ kind: 'impact', at: Math.max(0.3, hold * 0.5), gain: 0.2 });

    shots.push({
      index: i + 1,
      beat,
      narration,
      imagePrompt: String(p.imagePrompt || '').trim(),
      mode,
      textStyle: style,
      transition: tr,
      estSec: Number(est.toFixed(2)),
      holdSec: Number(hold.toFixed(2)),
      sfx,
      why,
    });
    lastMode = mode;
    lastStyle = style;
    lastKeys = keys;
  }

  // ⑧ 全片体检
  const imageShots = shots.filter((s) => s.mode === 'image').length;
  const totalSec = shots.reduce((n, s) => n + s.holdSec, 0);
  if (imageShots === 0 && !preferText) issues.push('全片没有一张真图（额度或重复判定吃掉了），观感会像纯字幕');
  if (shots.length >= 3 && new Set(shots.map((s) => s.mode)).size === 1) issues.push('所有分镜同一形态，缺少视觉变化');
  if (totalSec > 90) issues.push(`预计 ${totalSec.toFixed(0)}s，超过 90s 的短视频完播率会明显下降`);
  const dup = findDuplicateShots(shots);
  if (dup.length) issues.push('有画面/文案重复的分镜：' + dup.join('、'));

  return {
    ok: true,
    shots,
    issues,
    meta: {
      count: shots.length,
      imageShots,
      textShots: shots.length - imageShots,
      totalSec: Number(totalSec.toFixed(1)),
      avgSec: Number((totalSec / shots.length).toFixed(1)),
      beats: shots.map((s) => s.beat),
      styles: shots.map((s) => s.textStyle).filter(Boolean),
      imageProvider,
    },
  };
}

/** 重复检测：旁白或图描述几乎一样的两屏（模型偶尔会写重） */
export function findDuplicateShots(shots) {
  const dup = [];
  for (let i = 0; i < shots.length; i += 1) {
    for (let j = i + 1; j < shots.length; j += 1) {
      const a = shots[i];
      const b = shots[j];
      const simN = jaccard(visualKeys(a.narration), visualKeys(b.narration));
      const simP = jaccard(visualKeys(a.imagePrompt), visualKeys(b.imagePrompt));
      if (simN >= 0.8 || (a.imagePrompt && simP >= 0.7)) dup.push(`${a.index}↔${b.index}`);
    }
  }
  return dup.slice(0, 4);
}

/** 给 renderJob 用的轻量适配：把分镜表拍平成它认识的结构 */
export function toRenderPanels(plan) {
  return (plan?.shots || []).map((s) => ({
    narration: s.narration,
    imagePrompt: s.imagePrompt,
    mode: s.mode,
    textStyle: s.textStyle,
    transition: s.transition,
    estSec: s.estSec,
    sfx: s.sfx,
    beat: s.beat,
  }));
}

export default { planStoryboard, assignBeats, splitSentences, estimateSec, visualKeys, findDuplicateShots, toRenderPanels, TEXT_STYLES };
