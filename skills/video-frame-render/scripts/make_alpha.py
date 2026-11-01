# -*- coding: utf-8 -*-
"""
make_alpha.py — v2 立绘白底 → 透明 PNG（2026-10-31）

为什么不用阈值直抠：立绘里有白色水手服/白袜/白发带，全局「接近白就透明」会把
衣服打出洞。白底是**从画面边缘连通**的区域，衣服的白被深色描边包住、不与边缘
连通 —— 所以从四边 BFS 泛洪，只把「与边缘连通的近白像素」判为背景。

用法：
  E:/Anaconda/python skills/video-frame-render/scripts/make_alpha.py \
      --src assets/char-v2/pose --dst assets/char-v2/pose-alpha [--tol 24]

输出：同名 .png（RGBA）。半透明边缘做白底去污（unpremultiply），避免深色
背景下出现白边。幂等：dst 已存在且比 src 新就跳过（--force 强制重做）。
"""
import argparse
import os
from collections import deque

from PIL import Image, ImageFilter


def extract_alpha(im, tol):
    """边缘泛洪判背景；返回 (RGBA 图, 背景像素数)"""
    im = im.convert('RGB')
    w, h = im.size
    px = im.load()

    def is_bglike(x, y):
        r, g, b = px[x, y]
        return r >= 255 - tol and g >= 255 - tol and b >= 255 - tol

    bg = bytearray(w * h)  # 1 = 背景
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_bglike(x, y) and not bg[y * w + x]:
                bg[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bglike(x, y) and not bg[y * w + x]:
                bg[y * w + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not bg[ny * w + nx] and is_bglike(nx, ny):
                bg[ny * w + nx] = 1
                q.append((nx, ny))

    alpha = Image.frombytes('L', (w, h), bytes(bytearray(0 if b else 255 for b in bg)))
    # 边缘 1px 羽化：alpha 模糊后只在原二值边界附近取中间值
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.1))
    out = im.convert('RGBA')
    apx = alpha.load()
    opx = out.load()
    n = sum(bg)
    for y in range(h):
        for x in range(w):
            a = apx[x, y]
            if a == 255:
                continue
            if a == 0:
                opx[x, y] = (0, 0, 0, 0)
                continue
            # 白底去污：c' = (c - (1-a)·255) / a
            r, g, b, _ = opx[x, y]
            af = a / 255.0
            r = max(0, min(255, int((r - (1 - af) * 255) / af)))
            g = max(0, min(255, int((g - (1 - af) * 255) / af)))
            b = max(0, min(255, int((b - (1 - af) * 255) / af)))
            opx[x, y] = (r, g, b, a)
    return out, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--dst', required=True)
    ap.add_argument('--tol', type=int, default=24)
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()
    os.makedirs(args.dst, exist_ok=True)
    for fn in sorted(os.listdir(args.src)):
        if not fn.lower().endswith(('.jpg', '.jpeg', '.png')):
            continue
        src_p = os.path.join(args.src, fn)
        dst_p = os.path.join(args.dst, os.path.splitext(fn)[0] + '.png')
        if not args.force and os.path.exists(dst_p):
            if os.path.getmtime(dst_p) >= os.path.getmtime(src_p):
                print('跳过（已是最新）:', dst_p)
                continue
        im = Image.open(src_p)
        out, nbg = extract_alpha(im, args.tol)
        out.save(dst_p)
        total = im.size[0] * im.size[1]
        print(f'{fn} → {dst_p}  背景 {nbg * 100 // total}%  尺寸 {im.size}')


if __name__ == '__main__':
    main()
