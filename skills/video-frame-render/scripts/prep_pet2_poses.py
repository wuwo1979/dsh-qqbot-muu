#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prep_pet2_poses.py — pet2 生成姿势流水线（2026-10-31）

以 char-v2/pose-alpha/idle.png 为唯一基准（主人拍板：其他 4 张不认可，姿势全部由 idle 拓展）：
  生成图（1024×1536，棋盘格假透明）→ 洪泛抠底（复用 clean_and_align_pose.matte）
  → 按 idle 角色身高缩放（happy 双手举高会虚增身高，乘校正系数）
  → 脚底基线/下半身中心对齐 idle → 贴到 1680×2240 画布 → pose-render/
  → 输出六姿势拼图供人工复核。
"""
import importlib.util
import os

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('cap', os.path.join(HERE, 'clean_and_align_pose.py'))
cap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cap)

REPO = 'F:/qqbot'
GEN = os.path.join(REPO, 'tmp/pet-gen-v2')
REF = os.path.join(REPO, 'assets/char-v2/pose-alpha/idle.png')
OUT = os.path.join(REPO, 'assets/char-v2/pose-render')
SHEET = os.path.join(REPO, 'tmp/pet-v3/contact-pet2.jpg')

# 姿势 → 生成文件（ImageGen 时间戳命名）
GENS = {
    'wave': 'Edit_this_exact_character_imag_2026-10-31T15-29-17.png',
    'happy': 'Edit_this_exact_character_imag_2026-10-31T15-30-36.png',
    'talk': 'Edit_this_exact_character_imag_2026-10-31T15-30-52.png',
    'point': 'Edit_this_exact_character_imag_2026-10-31T15-31-16.png',
    'lift': 'Edit_this_exact_character_imag_2026-10-31T15-31-35.png',
}
# 双手举高会拉大 bbox 高度 → 缩放校正（否则身体变小）；复核后可调
SCALE_ADJ = {'happy': 1.0}

ALPHA_TH = 20


def unchecker(im):
    """生成图把「透明」画进了半透明布料（裙摆内部透出棋盘格）。
    从边框采样棋盘格灰格真实色调（~220），只重染「灰格±10」及棋盘格掩码膨胀区内的
    抗锯齿过渡像素（≤248），不碰更亮的布料本色、不碰深色线稿/头发。"""
    import numpy as np
    rgb = np.array(im.convert('RGB')).astype(int)
    H, W = rgb.shape[:2]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = mx - mn
    # 1) 边框采样棋盘格灰格：边角区域低饱和像素里取偏暗档
    border = np.zeros((H, W), bool)
    border[:40, :] = True; border[-40:, :] = True; border[:, :40] = True; border[:, -40:] = True
    bsel = border & (sat < 16) & (mn > 170)
    if bsel.sum() < 100:
        return im
    vals = mx[bsel]
    gray = int(np.percentile(vals, 25))  # 边框两色（白/灰）中偏暗一档
    # 2) 命中灰格 → 掩码；膨胀吃 AA 边缘
    core = (sat < 16) & (np.abs(mx - gray) <= 10)
    m = Image.frombytes('L', im.size, (core.astype(np.uint8) * 255)).filter(ImageFilter.MaxFilter(5))
    grow = np.array(m) > 0
    # 3) 替换范围：膨胀区内且亮度不高于 248（布料白 250+ 保留）、低饱和
    rep = grow & (sat < 18) & (mx < 248) & (mn > gray - 40)
    out = im.convert('RGBA').copy()
    px = np.array(out)
    px[rep, 0] = 251; px[rep, 1] = 251; px[rep, 2] = 252; px[rep, 3] = 255
    return Image.fromarray(px)


def lower_meta(arr):
    H, W = arr.shape[:2]
    a = arr[:, :, 3]
    lower = a[int(H * 0.55):, :]
    ys, xs = (lower > ALPHA_TH).nonzero()
    if not len(xs):
        return None, None, None
    return float(xs.mean()), int(ys.max()) + int(H * 0.55), a


def main():
    ref = Image.open(REF).convert('RGBA')
    RW, RH = ref.size
    ra = np.array(ref)
    rbb = ref.getchannel('A').getbbox()
    ref_h = rbb[3] - rbb[1]
    rcx, rbase, _ = lower_meta(ra)
    print(f'ref idle: canvas={ref.size} bbox={rbb} h={ref_h} cx={rcx:.0f} base={rbase}')

    os.makedirs(OUT, exist_ok=True)
    tiles = [('idle', ref)]

    for pose, fname in GENS.items():
        src = Image.open(os.path.join(GEN, fname))
        src = unchecker(src)  # 先把布料里的棋盘格染实
        mat = cap.matte(src)  # 洪泛抠棋盘格 + 抹右下水印 + 羽化
        bb = mat.getchannel('A').getbbox()
        if not bb:
            raise SystemExit(f'{pose}: 抠底后全透明')
        h = bb[3] - bb[1]
        scale = (ref_h / h) * SCALE_ADJ.get(pose, 1.0)
        crop = mat.crop(bb)
        nw, nh = max(1, round(crop.width * scale)), max(1, round(crop.height * scale))
        crop = crop.resize((nw, nh), Image.LANCZOS)

        arr = np.array(crop)
        cx, base, _ = lower_meta(arr)
        dx, dy = int(round(rcx - cx)), int(round(rbase - base))
        canvas = Image.new('RGBA', (RW, RH), (0, 0, 0, 0))
        canvas.alpha_composite(crop, (dx, dy))
        canvas.save(os.path.join(OUT, f'{pose}.png'))
        cov = (np.array(canvas)[:, :, 3] > ALPHA_TH).mean()
        print(f'{pose:6s} gen_h={h} scale={scale:.3f} shift=({dx:+d},{dy:+d}) cover={cov:.1%}')
        tiles.append((pose, canvas))

    # 拼图复核（浅底、等高并排）
    th = 560
    pads = []
    for name, im in tiles:
        w = round(im.width * th / im.height)
        t = im.resize((w, th), Image.LANCZOS)
        bg = Image.new('RGBA', (w + 8, th + 8), (228, 236, 246, 255))
        bg.alpha_composite(t, (4, 4))
        pads.append((name, bg))
    W = sum(p.width for _, p in pads)
    sheet = Image.new('RGB', (W, th + 8), (228, 236, 246))
    x = 0
    for name, p in pads:
        sheet.paste(p.convert('RGB'), (x, 0))
        x += p.width
    sheet.save(SHEET, quality=88)
    print(f'sheet: {SHEET}')


if __name__ == '__main__':
    main()
