# -*- coding: utf-8 -*-
"""
webm_to_gif.py — 桌宠 webm → 透明 GIF（2026-10-31 v2 品红抠洞法）

v2 原因：FASTOCTREE 直接量化 RGBA 后存 GIF，transparency 索引不会写进文件（黑底）。
v2 做法（经典可靠）：
  ① ffmpeg（-c:v libvpx-vp9 -pix_fmt rgba）解 PNG 序列——唯一保 alpha 的解码路；
  ② 每帧 alpha>=128 为不透明，其余涂品红 (255,0,255)（蓝白色画面里不存在品红）；
  ③ 所有帧拼条共享量化（MEDIANCUT），调色板里找到品红索引 → transparency=t；
  ④ save(transparency=t, disposal=2)。半透明边缘并到实色/透明（GIF 只有 1bit 透明，硬边正常）。

用法：E:/Anaconda/python skills/video-frame-render/scripts/webm_to_gif.py --src <webm> --dst <gif>
"""
import argparse
import glob
import os
import shutil
import subprocess

from PIL import Image

FF = os.path.expandvars(r'%APPDATA%\dsh-desktop\harness\data\dsh-remotion\runtime\node_modules\@remotion\compositor-win32-x64-msvc\ffmpeg.exe')
MAGENTA = (255, 0, 255)


def decode_frames(webm, tmp):
    r = subprocess.run([FF, '-y', '-c:v', 'libvpx-vp9', '-i', webm, '-pix_fmt', 'rgba',
                        os.path.join(tmp, 'f%04d.png')], capture_output=True, timeout=180)
    frames = sorted(glob.glob(os.path.join(tmp, 'f*.png')))
    if not frames:
        raise RuntimeError('解码无输出: ' + r.stderr.decode('utf-8', 'ignore')[-200:])
    return frames


def to_rgb_with_hole(im):
    """RGBA → RGB：alpha>=128 保留原色，其余涂品红"""
    a = im.getchannel('A').point(lambda v: 255 if v >= 120 else 0)
    rgb = Image.new('RGB', im.size, MAGENTA)
    rgb.paste(im.convert('RGB'), (0, 0), a)
    return rgb


def convert(webm, gif, width=360, fps=12, colors=128):
    tmp = gif + '.frames'
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    try:
        frames = decode_frames(webm, tmp)
        src_fps = 30
        step = max(1, round(src_fps / fps))
        picked = frames[::step]
        # 统一缩放 + 抠洞成 RGB
        rgb_frames = []
        for f in picked:
            im = Image.open(f).convert('RGBA')
            if im.size[0] != width:
                im = im.resize((width, round(im.size[1] * width / im.size[0])), Image.LANCZOS)
            rgb_frames.append(to_rgb_with_hole(im))
        # 拼条共享量化
        w, h = rgb_frames[0].size
        strip = Image.new('RGB', (w * len(rgb_frames), h), MAGENTA)
        for i, f in enumerate(rgb_frames):
            strip.paste(f, (i * w, 0))
        q = strip.quantize(colors=colors, method=Image.MEDIANCUT)
        # 找品红索引 → transparency
        pal = q.getpalette() or []
        t_idx = None
        for i in range(len(pal) // 3):
            if tuple(pal[i * 3:i * 3 + 3]) == MAGENTA:
                t_idx = i
                break
        outs = [f.quantize(palette=q, dither=Image.NONE) for f in rgb_frames]
        dur = round(1000 / fps)
        outs[0].save(gif, save_all=True, append_images=outs[1:],
                     duration=dur, loop=0, transparency=t_idx, disposal=2)
        return os.path.getsize(gif)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--dst', required=True)
    ap.add_argument('--width', type=int, default=360)
    ap.add_argument('--fps', type=int, default=12)
    args = ap.parse_args()
    size = convert(args.src, args.dst, args.width, args.fps)
    print(f'{args.dst}  {size // 1024}KB')


if __name__ == '__main__':
    main()
