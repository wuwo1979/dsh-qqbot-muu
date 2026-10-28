#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""make-icon.py —— 从抠好的立绘裁一张头像，铺品牌蓝底，输出 512×512 的 assets/icon.png。

用法：
  python qqbot-mod/scripts/make-icon.py --in tmp/whale-key/idle.png --out assets/icon.png
"""
from __future__ import annotations

import argparse
import os

from PIL import Image, ImageDraw, ImageFilter

SIZE = 512


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', default='assets/icon.png')
    ap.add_argument('--size', type=int, default=SIZE)
    ap.add_argument('--zoom', type=float, default=1.0, help='人像放大倍数')
    ap.add_argument('--radius', type=float, default=0.22, help='圆角占边长比例')
    args = ap.parse_args()

    n = args.size
    fig = Image.open(args.src).convert('RGBA')
    bb = fig.getbbox()
    fig = fig.crop(bb)
    w, h = fig.size

    # 头部区域：从顶部往下取约 46% 高度，横向以脸中线为准
    crop_h = int(h * 0.46 / args.zoom)
    crop_w = int(crop_h * 0.94)
    cx = w * 0.5
    x0 = int(max(0, min(w - crop_w, cx - crop_w / 2)))
    y0 = 0
    bust = fig.crop((x0, y0, x0 + crop_w, min(h, y0 + crop_h)))

    # 品牌蓝渐变底
    bg = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    g = Image.new('RGB', (1, n))
    for y in range(n):
        t = y / max(1, n - 1)
        g.putpixel((0, y), (int(27 + (77 - 27) * t), int(42 + (107 - 42) * t), int(107 + (254 - 107) * t)))
    bg.paste(g.resize((n, n)), (0, 0))
    # 顶部柔光
    glow = Image.new('L', (n, n), 0)
    ImageDraw.Draw(glow).ellipse([-n * 0.2, -n * 0.55, n * 1.2, n * 0.55], fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(n * 0.08))
    bg.paste(Image.new('RGBA', (n, n), (143, 214, 242, 255)), (0, 0), glow)

    # 人像：等比放大到画布 96%，底部对齐（露出半身）
    k = (n * 1.02) / bust.size[1]
    bw, bh = int(bust.size[0] * k), int(bust.size[1] * k)
    bust = bust.resize((bw, bh), Image.LANCZOS)
    bg.alpha_composite(bust, (int((n - bw) / 2), int(n - bh * 0.92)))

    out = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    out.paste(bg, (0, 0), rounded_mask(n, int(n * args.radius)))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
    out.save(args.out)
    print(f'  ✔ {args.out}  {n}×{n}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
