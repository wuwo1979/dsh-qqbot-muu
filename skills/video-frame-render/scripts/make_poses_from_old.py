# -*- coding: utf-8 -*-
"""
make_poses_from_old.py — 从旧桌宠 webm 抽帧 → 统一姿势包（2026-10-31 形象重修）

主人批评 v2 等身立绘「根本都不是一个女孩」——正确基准是**旧桌宠 webm 里的
Q 版女仆小蓝**（用户认可的形象）。旧 webm 的姿势本来就各不相同（挥手举臂/
开心带特效/捂嘴/指人/悬空），只是动画幅度做成了整图摇晃。本脚本：
  ① 每个 webm 抽第 0 帧（呼吸/缩放相位起点，scale≈1，姿势最标准）；
  ② 按 alpha bbox 裁出人物；
  ③ 按「脚底基线」对齐贴到统一 640×360 透明画布（与旧桌宠画布一致，
     桌宠显示尺寸不变、渲染零放大零糊化）。

用法：E:/Anaconda/python skills/video-frame-render/scripts/make_poses_from_old.py
输出：assets/char-pet/pose/{stand,wave,cheer,talk,point,lift}.png + preview.jpg
"""
import os
import subprocess
from PIL import Image, ImageFilter

FF = os.path.expandvars(r'%APPDATA%\dsh-desktop\harness\data\dsh-remotion\runtime\node_modules\@remotion\compositor-win32-x64-msvc\ffmpeg.exe')
SRC = r'F:\qqbot\assets\pet-xiaolan-backup\20261031'
DST = r'F:\qqbot\assets\char-pet\pose'
W, H = 640, 360
GROUND = 344          # 脚底基线（旧版待机帧人物脚底位置）
# 动作文件 → 姿势名（姿势语义与 PetAnim v3 对齐）
MAP = {
    '小蓝-待机': 'stand',
    '小蓝-挥手': 'wave',
    '小蓝-开心': 'cheer',
    '小蓝-说话': 'talk',
    '小蓝-指': 'point',
    '小蓝-被拎起': 'lift',
}


def extract_frame(webm, n=0):
    # VP9+alpha 必须 -c:v libvpx-vp9 -pix_fmt rgba（机器上其他三把 ffmpeg 都丢 alpha）
    out = webm + '.frame.png'
    subprocess.run([FF, '-y', '-c:v', 'libvpx-vp9', '-i', webm, '-frames:v', str(n + 1), '-pix_fmt', 'rgba', out],
                   capture_output=True, timeout=120)
    return out if os.path.exists(out) else None


def crop_alpha(im):
    """按 alpha>8 的 bbox 裁人物，返回 (裁剪图, bbox)"""
    a = im.split()[3]
    bbox = a.point(lambda v: 255 if v > 8 else 0).getbbox()
    return im.crop(bbox), bbox


def main():
    os.makedirs(DST, exist_ok=True)
    results = {}
    for src_name, pose in MAP.items():
        webm = os.path.join(SRC, src_name + '.webm')
        fr = extract_frame(webm)
        assert fr, f'抽帧失败: {src_name}'
        im = Image.open(fr).convert('RGBA')
        # 画面整体可能带半透明残底：alpha<8 清零
        a = im.split()[3].point(lambda v: 0 if v < 8 else v)
        im.putalpha(a)
        person, bbox = crop_alpha(im)
        results[pose] = person
        print(f'{src_name} → {pose}.png  人物 {person.size[0]}x{person.size[1]}  bbox={bbox}')
        os.remove(fr)

    # 脚底基线对齐：脚底=max(底线)（lift 除外——它是悬空姿势，脚底按站立的基线放，人物自然悬空）
    for pose, person in results.items():
        canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        # 水平居中；垂直=人物底边贴 GROUND（lift 悬空姿势抬高 14px 更像被拎着）
        x = (W - person.size[0]) // 2
        y = GROUND - person.size[1] + (0 if pose != 'lift' else 14)
        # wave/cheer 举起的手可能超出画布顶 → 若 y<0 则整体下移贴底但不裁切
        y = max(0, y)
        canvas.alpha_composite(person, (x, y))
        out = os.path.join(DST, f'{pose}.png')
        canvas.save(out)
        print(f'  → {out}')

    # 目检拼图：6 姿势上深底
    grid = Image.new('RGB', (320 * 3, 180 * 2), (35, 55, 105))
    poses = ['stand', 'wave', 'cheer', 'talk', 'point', 'lift']
    for i, pose in enumerate(poses):
        im = Image.open(os.path.join(DST, f'{pose}.png')).convert('RGBA').resize((320, 180))
        bg = Image.new('RGBA', (320, 180), (35, 55, 105, 255))
        bg.alpha_composite(im)
        grid.paste(bg.convert('RGB'), ((i % 3) * 320, (i // 3) * 180))
    grid.save(os.path.join(DST, 'preview.jpg'), quality=90)
    print('preview.jpg 已出')


if __name__ == '__main__':
    main()
