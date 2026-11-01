#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
clean_and_align_pose.py — 生图姿势图清洗 + 对齐（2026-10-31）

问题：ImageGen 的 background=transparent 实际画成「棋盘格贴图」（RGB 无 alpha），
     右下角还有生图水印。

流程：
  1) 水印矩形先抹成背景色；
  2) 从四边 BFS 洪泛填充识别背景（棋盘格亮灰/白，低饱和高亮度），角色深色描边自然挡住
     —— 内部白色裙摆被线稿包住不会被误抠；
  3) alpha 羽化 1px 防白边；
  4) 裁 alpha bbox → 按 stand.png 的角色身高缩放 → 脚底基线对齐、水平对齐 stand 角色
     中心 → 贴回与 stand.png 同尺寸画布（姿势切换才不跳）。

用法： python clean_and_align_pose.py --src gen.png --ref stand.png --dst wave.png
"""
import argparse
from collections import deque

from PIL import Image, ImageFilter


def is_bg(px):
    """背景判据：亮（>185）且低饱和（max-min<20）。棋盘格两色都满足；描边/彩身处不满足。"""
    r, g, b = px[0], px[1], px[2]
    return min(r, g, b) > 185 and (max(r, g, b) - min(r, g, b)) < 20


def matte(src):
    im = src.convert('RGBA').copy()
    W, H = im.size
    px = im.load()
    # 0) 水印区（右下角）先抹白，让洪泛把它吃掉
    for y in range(int(H * 0.92), H):
        for x in range(int(W * 0.80), W):
            r, g, b, a = px[x, y]
            px[x, y] = (255, 255, 255, 255)
    # 1) BFS 洪泛
    bg = bytearray(W * H)
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if is_bg(px[x, y]) and not bg[y * W + x]:
                bg[y * W + x] = 1
                q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            if is_bg(px[x, y]) and not bg[y * W + x]:
                bg[y * W + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < W and 0 <= ny < H and not bg[ny * W + nx] and is_bg(px[nx, ny]):
                bg[ny * W + nx] = 1
                q.append((nx, ny))
    mask = Image.frombytes('L', (W, H), bytes(255 - v * 255 for v in bg))
    # 2) 羽化 1px
    mask = mask.filter(ImageFilter.GaussianBlur(1.0))
    im.putalpha(mask)
    return im


def bbox_of(im):
    return im.getchannel('A').getbbox()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--ref', required=True)
    ap.add_argument('--dst', required=True)
    a = ap.parse_args()

    src = matte(Image.open(a.src))
    ref = Image.open(a.ref).convert('RGBA')

    sb, rb = bbox_of(src), bbox_of(ref)
    if not sb:
        raise SystemExit('src 抠完后全透明，洪泛判据太狠了')
    if not rb:
        raise SystemExit('ref 没有内容')

    canvas_w, canvas_h = ref.size
    ref_h = rb[3] - rb[1]
    src_crop = src.crop(sb)
    scale = ref_h / (sb[3] - sb[1])
    new_size = (max(1, round(src_crop.width * scale)), max(1, round(src_crop.height * scale)))
    src_crop = src_crop.resize(new_size, Image.LANCZOS)

    # 脚底对齐 ref 基线；水平对齐 ref 角色中心
    cx = (rb[0] + rb[2]) // 2
    paste_x = cx - new_size[0] // 2
    paste_y = rb[3] - new_size[1]

    canvas = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    canvas.alpha_composite(src_crop, (paste_x, paste_y))
    canvas.save(a.dst)
    print(f'ok: {a.dst} canvas={canvas.size} scale={scale:.3f} baseline={rb[3]}')


if __name__ == '__main__':
    main()
