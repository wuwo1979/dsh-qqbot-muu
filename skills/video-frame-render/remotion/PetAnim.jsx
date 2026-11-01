import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

/**
 * PetAnim v3（2026-10-31 主人拍板重做）—— 真动作，不是整图缩放摇晃。
 *
 * 上一版的病根：所有动作 = 一张静态立绘做 sin(scale/rotate/translate)，用户评价
 * 「只是单纯的图片放大和摇晃」。v3 用三件套做出「真的在做动作」：
 *   ① 姿势切换关键帧 —— v2 立绘有 5 个姿势（idle/wave/happy/point/talk，已抠透明），
 *      动作=按时间线换姿势（3 帧交叉淡入防跳变），剪影真的在变；
 *   ② 挤压拉伸（squash & stretch）—— 非等比 sx/sy：起跳拉长、落地压扁、待机呼吸
 *      体积守恒（sy 胀 sx 缩），这是动画十二法则里「可爱感」的核心；
 *   ③ 预备动作 + 跟随 —— 跳之前先下蹲蓄力，落地回弹，拎起后残留摆动衰减。
 *
 * inputProps（render_remotion.mjs 组装）：
 *   poses  {idle,wave,happy,point,talk} → public 里的路径（/pose-idle.png …）
 *   motion 动作 key（下方 MOTIONS）
 *   seconds/fps/width/height/shadow/bg 同旧版
 */

const POSES = ['stand', 'wave', 'cheer', 'talk', 'point', 'lift'];

// ── 小工具 ─────────────────────────────────────────────────────────────
const TAU = Math.PI * 2;
const sin01 = (t) => Math.sin(TAU * t);          // t 以「周期」为单位，0↔1 无缝循环
const clamp01 = (v) => Math.max(0, Math.min(1, v));
/** 姿势时间线：[{until: 帧号, pose}]，返回当前姿势 + 换姿势后的交叉淡入进度(0..1, 3帧) */
function poseState(seq, f) {
  let prev = seq[0].pose;
  let cur = seq[0].pose;
  let boundary = 0;
  for (const s of seq) {
    if (f < s.until) {
      cur = s.pose;
      break;
    }
    prev = s.pose;
    cur = s.pose;
    boundary = s.until;
  }
  // f 落在某个区间内：cur=区间姿势，fade 起点是该区间开始
  for (let i = 0; i < seq.length; i++) {
    const start = i === 0 ? 0 : seq[i - 1].until;
    const end = seq[i].until;
    if (f >= start && f < end) {
      cur = seq[i].pose;
      prev = i === 0 ? seq[i].pose : seq[i - 1].pose;
      boundary = start;
      break;
    }
  }
  const mix = clamp01((f - boundary) / 3); // 3 帧交叉淡入
  return { cur, prev, mix };
}

// ── 动作库 v3 ──────────────────────────────────────────────────────────
// 统一返回：{ seq, sx, sy, x, y, rotate, origin, loop, cycle, sparkle }
const MOTIONS = {
  // 待机：真静止（2026-10-31 主人拍板——「静止不动时也会放大缩小图片」是病，去掉
  // 呼吸缩放/重心摇晃，待机=一张站姿定格，活的东西交给其他动作）
  'idle-cute': ({ f, fps }) => {
    return {
      seq: [{ until: 1e9, pose: 'stand' }],
      sx: 1, sy: 1, x: 0, y: 0, rotate: 0,
      origin: '50% 95%', loop: true, cycle: 1 * fps,
    };
  },

  // 挥手：idle→wave 换姿势，手臂节奏用小幅转体表现，中途两个小跳（循环 3.4s）
  'wave-hello': ({ f, fps }) => {
    const T = 3.4 * fps;
    const t = (f % T) / T;
    const seq = [
      { until: 0.12 * T, pose: 'stand' },
      { until: 0.78 * T, pose: 'wave' },
      { until: 1e9, pose: 'stand' },
    ];
    const st = poseState(seq, f % T);
    const tw = (f % T) / (0.8 * fps);            // 手臂摆动周期 0.8s
    const rotate = st.cur === 'wave' ? 2.4 * Math.sin(TAU * (tw % 1)) : 0;
    // 两个小跳：0.9s 和 2.1s 处，抛物线 26px
    let hop = 0;
    for (const t0 of [0.27, 0.62]) {
      const u = (t - t0) / 0.12;
      if (u >= 0 && u <= 1) hop = Math.max(hop, Math.sin(Math.PI * u) * 26);
    }
    const landU = (t - 0.39) / 0.08;
    const landU2 = (t - 0.74) / 0.08;
    const squash = (landU >= 0 && landU <= 1) || (landU2 >= 0 && landU2 <= 1)
      ? 1 - 0.05 * Math.sin(Math.PI * ((landU >= 0 && landU <= 1) ? landU : landU2)) : 1;
    return {
      seq, rotate,
      sx: 1 / squash, sy: squash,
      x: 3 * Math.sin(TAU * t), y: -hop,
      origin: '50% 95%', loop: true, cycle: T,
    };
  },

  // 开心：下蹲蓄力→拉伸起跳（两次）→落地压扁→星星特效（一次性 3.0s）
  'happy-jump': ({ f, fps }) => {
    const T = 3.0 * fps;
    const seq = [
      { until: 0.1 * T, pose: 'stand' },
      { until: 0.72 * T, pose: 'cheer' },
      { until: 1e9, pose: 'stand' },
    ];
    const st = poseState(seq, f);
    const tt = f / T;
    let y = 0, sx = 1, sy = 1;
    const seg = (a, b) => clamp01((tt - a) / (b - a));
    if (tt < 0.1) {                              // 蓄力下蹲
      const u = seg(0, 0.1);
      sy = 1 - 0.09 * Math.sin(Math.PI * u);
      sx = 1 + 0.07 * Math.sin(Math.PI * u);
      y = 10 * Math.sin(Math.PI * u);
    } else if (tt < 0.28) {                      // 第一跳（高）
      const u = seg(0.1, 0.28);
      y = -Math.sin(Math.PI * u) * 95;
      const up = u < 0.35 ? 1 - u / 0.35 : 0;    // 起跳拉伸
      const dn = u > 0.8 ? (u - 0.8) / 0.2 : 0;  // 落地压扁
      sy = 1 + 0.11 * up - 0.1 * Math.sin(Math.PI * dn);
      sx = 1 - 0.08 * up + 0.09 * Math.sin(Math.PI * dn);
    } else if (tt < 0.48) {                      // 第二跳（矮，带一点歪头）
      const u = seg(0.28, 0.48);
      y = -Math.sin(Math.PI * u) * 55;
      const up = u < 0.3 ? 1 - u / 0.3 : 0;
      sy = 1 + 0.08 * up;
      sx = 1 - 0.06 * up;
    } else if (tt < 0.56) {                      // 落地回弹
      const u = seg(0.48, 0.56);
      sy = 1 - 0.07 * Math.sin(Math.PI * u);
      sx = 1 + 0.06 * Math.sin(Math.PI * u);
    }
    return {
      seq, sx, sy, x: 0, y, rotate: 0,
      origin: '50% 95%', loop: false,
      sparkle: f > 0.2 * T && f < 0.75 * T,
    };
  },

  // 说话：stand↔talk 每 0.3s 换一次（像在咿咿呀呀），每次换姿势头部一点（循环 1.8s）
  'talk-babble': ({ f, fps }) => {
    const T = 1.8 * fps;
    const tf = f % T;
    const step = Math.floor(tf / (0.3 * fps));
    const seq = [];
    for (let i = 0; i < 6; i++) seq.push({ until: (i + 1) * 0.3 * fps, pose: i % 2 === 0 ? 'talk' : 'stand' });
    seq.push({ until: 1e9, pose: 'stand' });
    const st = poseState(seq, tf);
    const swapU = (tf % (0.3 * fps)) / (0.3 * fps);
    const dip = 5 * Math.sin(Math.PI * clamp01(swapU * 2));
    return {
      seq,
      sx: 1 + 0.008 * Math.sin(TAU * swapU),
      sy: 1 - 0.008 * Math.sin(TAU * swapU),
      x: 0, y: -dip,
      rotate: 0.7 * Math.sin(TAU * (tf / T)),
      origin: '50% 95%', loop: true, cycle: T,
    };
  },

  // 指一指：point 姿势 + spring 前倾（x/rotate/scale 一起出去），停住时小幅呼吸（一次性 2.4s）
  'point-out': ({ f, fps }) => {
    const T = 2.4 * fps;
    const seq = [
      { until: 0.06 * T, pose: 'stand' },
      { until: 0.82 * T, pose: 'point' },
      { until: 1e9, pose: 'stand' },
    ];
    const st = poseState(seq, f);
    const s = spring({ frame: f - Math.round(0.05 * T), fps, config: { damping: 11, stiffness: 120 }, durationInFrames: 32 });
    const lean = f < 0.05 * T ? 0 : Math.sin(Math.min(1, s) * Math.PI) * 1.0;
    const breathe = f > 0.4 * T ? 1 + 0.008 * Math.sin(TAU * (f / (0.9 * fps))) : 1;
    return {
      seq,
      sx: (1 + 0.05 * lean) * breathe,
      sy: (1 + 0.02 * lean) * breathe,
      x: 18 * lean, y: 4 * lean,
      rotate: 2.2 * lean,
      origin: '50% 95%', loop: false,
    };
  },

  // 被拎起：拉长上升→悬空摆动衰减→偶发扑腾（一次性 2.8s）；原点在头顶（吊着的感觉）
  'lift-dangle': ({ f, fps }) => {
    const T = 2.8 * fps;
    const seq = [{ until: 1e9, pose: 'lift' }];
    const s = spring({ frame: f, fps, config: { damping: 15, stiffness: 80 }, durationInFrames: 45 });
    const y = interpolate(s, [0, 1], [0, -130]);
    const rise = clamp01(f / (0.4 * fps));
    const sy = 1 + 0.13 * (1 - rise);            // 起吊瞬间拉长
    const sx = 1 - 0.08 * (1 - rise);
    const decay = Math.exp(-f / (fps * 1.6));
    let swing = 5 * Math.sin(TAU * (f / (0.95 * fps))) * decay;
    for (const t0 of [1.1, 1.9]) {               // 扑腾：小短手快速晃两下
      const u = (f / fps - t0) / 0.25;
      if (u >= 0 && u <= 1) swing += 7 * Math.sin(TAU * u * 2) * Math.sin(Math.PI * u);
    }
    return {
      seq, sx, sy, x: 0, y,
      rotate: swing, origin: '50% 8%', loop: false,
    };
  },
};

const motionNames = Object.keys(MOTIONS).join(', ');

// ── 渲染主体 ───────────────────────────────────────────────────────────
const PetAnimMain = (props) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  // [pet-v3.1] 画布自适应：动作里的像素偏移按 1000 高画布调的，640×360 桌宠画布乘 U
  const U = (Number(height) || 360) / 1000;
  const motion = MOTIONS[props.motion] ? props.motion : 'idle-cute';
  const m0 = MOTIONS[motion]({ f: frame, fps });
  // 循环类动作取模保证首尾一致（无缝循环）
  const effF = m0.loop && m0.cycle ? (frame % m0.cycle) : frame;
  const m = effF === frame ? m0 : MOTIONS[motion]({ f: effF, fps });
  const { cur, prev, mix } = poseState(m.seq, effF);

  const poses = props.poses || {};
  const srcOf = (name) => {
    const p = poses[name];
    if (!p) return '';
    return /^https?:/.test(p) ? p : staticFile(p);
  };

  // 接地阴影：越浮高阴影越小越淡
  const lift = Math.max(0, -m.y);
  const shadowScale = 1 - 0.18 * (lift / 130);
  const shadowOpacity = 0.28 * (1 - 0.35 * (lift / 130));

  // 星星特效（开心）：头部周围 6 颗，spring 依次弹出
  const stars = [];
  if (m.sparkle) {
    const cfg = [
      { x: -180, y: -320, d: 0 }, { x: 170, y: -300, d: 5 }, { x: -230, y: -180, d: 10 },
      { x: 220, y: -160, d: 14 }, { x: -90, y: -380, d: 18 }, { x: 90, y: -390, d: 22 },
    ];
    for (const c of cfg) {
      const s = spring({ frame: frame - c.d, fps, config: { damping: 8, stiffness: 150 }, durationInFrames: 26 });
      const fade = 1 - clamp01((frame - c.d - 22) / 16);
      if (s <= 0 || fade <= 0) continue;
      stars.push(
        <div
          key={`${c.x},${c.y}`}
          style={{
            position: 'absolute', left: `calc(50% + ${c.x * U}px)`, top: `calc(50% + ${c.y * U}px)`,
            fontSize: 34 * U, color: '#8fe8ff',
            textShadow: '0 0 12px rgba(140,230,255,0.9)',
            transform: `scale(${s}) rotate(${s * 40}deg)`, opacity: fade,
          }}
        >✦</div>
      );
    }
  }

  return (
    <AbsoluteFill style={{ background: props.bg || 'transparent' }}>
      {props.shadow ? (
        <div
          style={{
            position: 'absolute', left: '50%', bottom: '2.5%',
            width: 330 * U * shadowScale, height: 46 * U * shadowScale,
            marginLeft: -165 * U * shadowScale, borderRadius: '50%',
            background: 'radial-gradient(ellipse at center, rgba(10,20,40,1) 0%, rgba(10,20,40,0) 70%)',
            opacity: Math.max(0.08, shadowOpacity),
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transform: `translate(${m.x * U}px, ${m.y * U}px) rotate(${m.rotate}deg) scale(${m.sx}, ${m.sy})`,
          transformOrigin: m.origin || '50% 88%',
        }}
      >
        <div
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            // [pet-v3.2] fit：整体安全缩放（锚在脚底）。举手类姿势几乎顶满画布时，
            // 动作的抬升/挤压会把角色推出框外 —— 缩小到留出动作余量，脚底位置不变。
            transform: `scale(${Number(props.fit) > 0 ? Number(props.fit) : 1})`,
            transformOrigin: '50% 100%',
          }}
        >
        {POSES.map((name) => {
          const src = srcOf(name);
          if (!src) return null;
          const op = name === cur ? mix : name === prev ? 1 - mix : 0;
          if (op <= 0) return null;
          return (
            <Img
              key={name}
              src={src}
              style={{ position: 'absolute', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', opacity: op }}
            />
          );
        })}
        {!poses.stand && !props.image ? (
          <div style={{ color: '#f66', fontSize: 40 }}>spec.poses 未填</div>
        ) : null}
        {stars}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const PetAnim = (props) => <PetAnimMain {...props} />;
export { MOTIONS, motionNames };
