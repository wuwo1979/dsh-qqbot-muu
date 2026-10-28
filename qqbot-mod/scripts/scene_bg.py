#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""scene_bg.py —— 程序化空镜背景 v2（永不出现第二个人）。

v2（2026-10-28）主人反馈"丑丑的背景"，这一版重点：
  · 多段斜向渐变代替呆板的垂直渐变（对角线构图更有画面感）
  · 大块柔和色斑（虚化 bokeh 色域）代替纯色底 —— 一眼不是"PPT 渐变"
  · 地面带（floor band）：底部 22% 压暗 + 轻微色差，立绘贴上去不再"飘着"
  · 薄雾景深层（远处更亮更糊，近处更实）+ 细颗粒质感
  · 配色整体向小蓝立绘的蓝白调靠拢（深海蓝/月白/暖灯三种情绪）

用法：
  python scene_bg.py --out bg.png --w 576 --h 1024 --kind sea|room|night|street|cafe [--seed 7]
"""
from __future__ import annotations

import argparse
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

# 每种场景 4~5 段渐变（上→下）+ 一层 bokeh 色斑色 + 光源色
PALETTES = {
    # 深海：接近立绘裙摆的深蓝，光柱从上洒下来
    'sea':    [(10, 46, 84), (14, 78, 118), (24, 108, 148), (56, 150, 178)],
    # 房间：暖木+米白，晚霞感
    'room':   [(52, 38, 32), (96, 70, 52), (150, 112, 78), (214, 176, 128)],
    # 夜空：深夜蓝+月白，星点
    'night':  [(8, 12, 34), (16, 26, 58), (34, 50, 96), (88, 112, 168)],
    # 街景：暮色青灰+霓虹暖
    'street': [(20, 22, 32), (36, 40, 58), (72, 70, 88), (150, 130, 116)],
    # 咖啡馆：暖棕+奶油
    'cafe':   [(38, 30, 26), (82, 60, 46), (140, 104, 74), (222, 184, 138)],
}
BOKEH = {
    'sea':    [(120, 200, 255), (90, 170, 230), (180, 230, 255)],
    'room':   [(255, 214, 160), (255, 190, 130), (255, 236, 200)],
    'night':  [(140, 170, 255), (100, 130, 220), (190, 210, 255)],
    'street': [(255, 160, 120), (120, 160, 255), (255, 220, 180)],
    'cafe':   [(255, 200, 140), (255, 226, 180), (220, 170, 120)],
}
LIGHT = {
    'sea': (190, 235, 255), 'room': (255, 224, 170), 'night': (170, 195, 255),
    'street': (255, 190, 150), 'cafe': (255, 216, 160),
}


def vgrad(size, colors):
    """竖向多段渐变（按行画，快）。"""
    w, h = size
    stops = len(colors)
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1) * (stops - 1)
        i = min(stops - 2, int(t))
        f = t - i
        c0, c1 = colors[i], colors[i + 1]
        c = tuple(int(c0[k] + (c1[k] - c0[k]) * f) for k in range(3))
        d.line([(0, y), (w, y)], fill=c)
    return img


def diag_grad(size, colors, angle_deg=18):
    """斜向多段渐变：先画竖向渐变再整体旋转裁剪（纯 C 路径，逐像素循环会卡几秒）。"""
    w, h = size
    ang = math.radians(angle_deg)
    w2 = int(w + abs(h * math.tan(ang))) + 4
    base = vgrad((w2, h), colors)
    base = base.rotate(angle_deg, resample=Image.BICUBIC, expand=False,
                       fillcolor=colors[0])
    left = (w2 - w) // 2
    return base.crop((left, 0, left + w, h))


def bokeh_blobs(img, colorset, rnd, n=9):
    """大块虚化色斑：模拟镜头景深里远处失焦的灯/水色，让背景一眼不是纯渐变。"""
    w, h = img.size
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(n):
        c = rnd.choice(colorset)
        r = rnd.randint(int(w * 0.12), int(w * 0.38))
        x = rnd.randint(-r, w)
        y = rnd.randint(int(-h * 0.1), int(h * 0.8))
        d.ellipse([x - r, y - r, x + r, y + r], fill=c + (rnd.randint(16, 34),))
    layer = layer.filter(ImageFilter.GaussianBlur(w * 0.06))
    img.alpha_composite(layer)


def floor_band(img, kind, rnd):
    """地面带：底部 22% 压暗 + 顶边一条柔和分界，立绘贴上去有『站在地上』的着落感。"""
    w, h = img.size
    fh = int(h * 0.22)
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    top = h - fh
    # 地面主色：场景色的暗部
    base = PALETTES[kind][1]
    for i in range(fh):
        t = i / max(1, fh - 1)
        a = int(70 + 90 * t)                      # 越往下越深
        c = tuple(int(base[k] * (0.55 + 0.25 * (1 - t))) for k in range(3))
        d.line([(0, top + i), (w, top + i)], fill=c + (a,))
    # 分界线：一条亮边（逆光感）
    d.line([(0, top), (w, top)], fill=LIGHT[kind] + (60,), width=2)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(3)))


def rays(img, color, n=5, seed=1):
    rnd = random.Random(seed)
    w, h = img.size
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(n):
        x = rnd.randint(-int(w * 0.3), int(w * 0.9))
        wid = rnd.randint(int(w * 0.06), int(w * 0.2))
        d.polygon([(x, -20), (x + wid, -20), (x + wid * 1.9, h), (x + wid * 0.9, h)],
                  fill=color + (rnd.randint(14, 30),))
    layer = layer.filter(ImageFilter.GaussianBlur(w * 0.025))
    img.alpha_composite(layer)


def bubbles(img, rnd, n=60, color=(255, 255, 255)):
    w, h = img.size
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(n):
        r = rnd.randint(1, max(2, int(w * 0.012)))
        x = rnd.randint(0, w)
        y = rnd.randint(0, h)
        d.ellipse([x - r, y - r, x + r, y + r], fill=color + (rnd.randint(20, 70),))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(0.6)))


def window(img, rnd):
    w, h = img.size
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, y0 = int(w * 0.12), int(h * 0.08)
    x1, y1 = int(w * 0.88), int(h * 0.4)
    d.rectangle([x0, y0, x1, y1], fill=(230, 214, 170, 46), outline=(255, 245, 220, 70), width=3)
    d.line([((x0 + x1) / 2, y0), ((x0 + x1) / 2, y1)], fill=(255, 245, 220, 60), width=2)
    d.line([(x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2)], fill=(255, 245, 220, 60), width=2)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(1.2)))


def grain(img, rnd, amount=7):
    """细颗粒：低分辨率噪点放大后低透明度叠加，杀掉数码渐变的'塑料感'。"""
    w, h = img.size
    sw, sh = max(2, w // 3), max(2, h // 3)
    noise = Image.new('L', (sw, sh))
    npx = noise.load()
    for y in range(sh):
        for x in range(sw):
            npx[x, y] = rnd.randint(128 - amount * 6, 128 + amount * 6)
    noise = noise.resize((w, h), Image.BICUBIC)
    blended = Image.blend(img.convert('RGB'), noise.convert('RGB'), 0.06)
    img.paste(blended.convert('RGBA'), (0, 0))


def vignette(img):
    w, h = img.size
    mask = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([-w * 0.25, -h * 0.15, w * 1.25, h * 1.15], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(w * 0.12))
    dark = Image.new('RGBA', (w, h), (0, 0, 0, 110))
    img.paste(dark, (0, 0), Image.eval(mask, lambda v: 255 - v))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--w', type=int, default=576)
    ap.add_argument('--h', type=int, default=1024)
    ap.add_argument('--kind', default='sea', choices=sorted(PALETTES.keys()))
    ap.add_argument('--seed', type=int, default=7)
    args = ap.parse_args()

    rnd = random.Random(args.seed)
    img = diag_grad((args.w, args.h), PALETTES[args.kind], angle_deg=14 + rnd.randint(-6, 10)).convert('RGBA')

    bokeh_blobs(img, BOKEH[args.kind], rnd, 9)
    if args.kind in ('sea', 'night'):
        rays(img, LIGHT[args.kind], 5, args.seed)
        bubbles(img, rnd, 70 if args.kind == 'sea' else 40)
    if args.kind in ('room', 'cafe', 'street'):
        window(img, rnd)
    if args.kind == 'night':
        d = ImageDraw.Draw(img)
        for _ in range(90):
            x, y = rnd.randint(0, args.w), rnd.randint(0, int(args.h * 0.55))
            d.point((x, y), fill=(255, 255, 255, rnd.randint(60, 160)))
    floor_band(img, args.kind, rnd)
    vignette(img)
    grain(img, rnd, 6)
    img = img.filter(ImageFilter.GaussianBlur(0.4))

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
    img.convert('RGB').save(args.out, quality=95)
    print('ok', args.out, img.size, args.kind)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
