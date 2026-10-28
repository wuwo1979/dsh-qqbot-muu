#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""compose_char.py —— 把透明立绘贴到 SD 出的场景图上（换场景不换脸）。

为什么不用 img2img 派生：SD1.5 + Counterfeit 在 strength 0.5~0.7 之间要么保住
"海报构图"、要么把发色/服装改掉，逐屏换场景时身份必然漂移。合成路线把两件事
拆开：场景交给 SD 画，人物用固定的透明立绘，身份 100% 稳定。

用法：
  python compose_char.py --bg scene.png --pose pose/idle.png --out out.png \
      [--height-ratio 0.72] [--bottom 0.02] [--align center] [--shadow 0.35] [--flip]
"""
from __future__ import annotations

import argparse
import os

from PIL import Image, ImageFilter


def load_rgba(path: str) -> Image.Image:
    im = Image.open(path)
    return im.convert('RGBA')


def trim(im: Image.Image) -> Image.Image:
    bb = im.getbbox()
    return im.crop(bb) if bb else im


def soft_shadow(size, alpha=0.35, blur=18):
    w, h = size
    sh = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    # 椭圆地面阴影
    pad_w = int(w * 0.52)
    pad_h = max(8, int(h * 0.045))
    ell = Image.new('RGBA', (pad_w, pad_h), (0, 0, 0, 0))
    from PIL import ImageDraw
    ImageDraw.Draw(ell).ellipse([0, 0, pad_w - 1, pad_h - 1], fill=(0, 0, 0, int(255 * alpha)))
    ell = ell.filter(ImageFilter.GaussianBlur(blur))
    sh.alpha_composite(ell, (int((w - pad_w) / 2), int(h - pad_h * 0.6)))
    return sh


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--bg', required=True)
    ap.add_argument('--pose', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--height-ratio', type=float, default=0.72, help='人物占画面高度比例')
    ap.add_argument('--bottom', type=float, default=0.03, help='人物底部留白比例')
    ap.add_argument('--align', choices=['center', 'left', 'right'], default='center')
    ap.add_argument('--shadow', type=float, default=0.35, help='地面阴影不透明度，0 关闭')
    ap.add_argument('--flip', action='store_true')
    ap.add_argument('--glow', type=float, default=0.0, help='人物外发光（0~1），夜景可用')
    ap.add_argument('--dehalo', type=int, default=1, help='1=清掉抠图留的灰边（alpha 阈值 + 轻微收缩）')
    args = ap.parse_args()

    bg = load_rgba(args.bg)
    W, H = bg.size
    ch = trim(load_rgba(args.pose))
    if args.dehalo:
        # 抠图会在边缘留一圈半透明灰边，贴在浅色场景里很明显；
        # 这里把低 alpha 直接切掉、再对 alpha 做一圈最小滤波（只动 alpha，不动颜色）。
        r_, g_, b_, a_ = ch.split()
        a_ = a_.point(lambda v: 0 if v < 48 else min(255, int((v - 48) * 255 / 207)))
        a_ = a_.filter(ImageFilter.MinFilter(3))
        ch = Image.merge('RGBA', (r_, g_, b_, a_))
    if args.flip:
        ch = ch.transpose(Image.FLIP_LEFT_RIGHT)

    target_h = max(64, int(H * args.height_ratio))
    k = target_h / ch.size[1]
    ch = ch.resize((max(1, int(ch.size[0] * k)), target_h), Image.LANCZOS)

    bottom_pad = int(H * args.bottom)
    if args.align == 'center':
        x = int((W - ch.size[0]) / 2)
    elif args.align == 'left':
        x = int(W * 0.08)
    else:
        x = int(W - ch.size[0] - W * 0.08)
    y = H - bottom_pad - ch.size[1]

    out = bg.copy()
    if args.shadow > 0:
        sh = soft_shadow((W, H), alpha=args.shadow)
        out.alpha_composite(sh)
    if args.glow > 0:
        glow = ch.filter(ImageFilter.GaussianBlur(24))
        val = glow.split()[3].point(lambda a: int(a * args.glow))
        glow.putalpha(val)
        out.alpha_composite(glow, (x, y))
    out.alpha_composite(ch, (x, y))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
    out.convert('RGB').save(args.out, quality=95)
    print('ok', args.out, out.size)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
