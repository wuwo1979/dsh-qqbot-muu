import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { PetAnim } from './PetAnim';

/**
 * 桌宠立绘动画模板（路子 D · Remotion）— Remotion 入口（必须含 registerRoot）
 * 组合 "PetAnim"：尺寸/时长由 inputProps 经 calculateMetadata 动态决定。
 * inputProps 见 render_remotion.mjs 顶部的 SPEC 注释。
 */
const RemotionRoot = () => (
  <Composition
    id="PetAnim"
    component={PetAnim}
    durationInFrames={90}
    fps={30}
    width={720}
    height={980}
    calculateMetadata={({ props }) => ({
      width: Number(props.width) || 720,
      height: Number(props.height) || 980,
      durationInFrames: Math.max(2, Math.round((Number(props.seconds) || 3) * (Number(props.fps) || 30))),
      fps: Number(props.fps) || 30,
    })}
    defaultProps={{
      image: '',
      poses: {},
      motion: 'idle-cute',
      width: 750,
      height: 1000,
      fps: 30,
      seconds: 3,
      shadow: true,
      bg: '',
    }}
  />
);

registerRoot(RemotionRoot);
