#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
align_char_poses.py — 多形态桌宠姿势归一（2026-10-31）

同一套立绘的各姿势（用户提供的成套图）通常身材一致、只有位置漂移：
  · 下半身水平中心（y>55% 区域的 alpha 质心，腿/裙摆，不随抬手变化）→ 对齐 x；
  · 脚底基线（下半身最低 alpha>20 像素）→ 对齐 y；
  · 只平移不缩放（成套图身材本就一致；缩放反而会让抬手姿势身体变小）。

用法：
  python align_char_poses.py --src assets/char-v2/pose-alpha --ref idle --out assets/char-v2/pose-render
"""
import argparse
import os

import numpy as np
from PIL import Image

ALPHA_TH = 20      # alpha 视为有内容的阈值
LOWER_FROM = 0.55  # 下半身起点（总高的比例）


def measure(arr):
    """返回 (下半身cx, 脚底y)（画布坐标）"""
    H, W = arr.shape[:2]
    a = arr[:, :, 3] if arr.shape[2] == 4 else np.full((H, W), 255, np.uint8)
    lower = a[int(H * LOWER_FROM):, :]
    ys, xs = (lower > ALPHA_TH).nonzero()
    if not len(xs):
        return None, None
    cx = float(xs.mean())
    base = int(ys.max()) + int(H * LOWER_FROM)
    return cx, base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--ref', default='idle')
    ap.add_argument('--out', required=True)
    ap.add_argument('--pad', type=int, default=0, help='输出画布四周额外留白(px)')
    a = ap.parse_args()

    names = sorted(f[:-4] for f in os.listdir(a.src) if f.endswith('.png'))
    if a.ref not in names:
        raise SystemExit(f'参考姿势 {a.ref} 不在 {names}')

    imgs = {}
    for n in names:
        im = Image.open(os.path.join(a.src, n + '.png')).convert('RGBA')
        imgs[n] = im

    rcx, rbase = measure(np.array(imgs[a.ref]))
    if rcx is None:
        raise SystemExit('参考图没有内容')

    W, H = imgs[a.ref].size
    os.makedirs(a.out, exist_ok=True)
    for n, im in imgs.items():
        cx, base = measure(np.array(im))
        dx, dy = int(round(rcx - cx)), int(round(rbase - base))
        canvas = Image.new('RGBA', (W + a.pad * 2, H + a.pad * 2), (0, 0, 0, 0))
        canvas.alpha_composite(im, (a.pad + dx, a.pad + dy))
        canvas.save(os.path.join(a.out, n + '.png'))
        print(f'{n:8s} shift=({dx:+d},{dy:+d}) -> {canvas.size}')
    print(f'ok: {a.out}（对齐基准 {a.ref}: cx={rcx:.0f} baseline={rbase}）')


if __name__ == '__main__':
    main()
