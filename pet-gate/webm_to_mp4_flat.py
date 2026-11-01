#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""pet-gate 素材的 MP4 扁平版批量生成（给不支持 WebM/VP9 的设备兜底，如 iPhone）。

流程（Remotion 精简版 ffmpeg 没有 overlay 滤镜，只能走抽帧）：
  ① ffmpeg -c:v libvpx-vp9 强制解码抽 RGBA PNG（默认解码器读不到 VP9 alpha 附加轨）
  ② PIL 把每帧垫到浅蓝底色上合成
  ③ PNG 序列 → libx264 mp4（+faststart，手机边下边播）

用法：python webm_to_mp4_flat.py            # 全量（跳过已是最新）
      python webm_to_mp4_flat.py --force    # 强制重转
"""
import os
import subprocess
import sys
import tempfile

from PIL import Image

FFMPEG = os.path.join(os.environ.get("APPDATA", ""), "dsh-desktop", "harness", "data",
                      "dsh-remotion", "runtime", "node_modules", "@remotion",
                      "compositor-win32-x64-msvc", "ffmpeg.exe")
MEDIA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media")
BG = (234, 242, 255, 255)  # #EAF2FF，与页面卡片底色一致
FPS = 30


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def probe_frames(webm):
    """帧数（用包数近似：nb_read_frames 不准就数 PNG）"""
    return None


def convert(webm, mp4, force=False):
    if os.path.isfile(mp4) and not force and os.path.getmtime(mp4) >= os.path.getmtime(webm):
        return "skip"
    with tempfile.TemporaryDirectory(prefix="pgflat") as td:
        # ① 强制 libvpx 解码（不带 -c:v 会丢 alpha，还会花屏）
        r = run([FFMPEG, "-y", "-c:v", "libvpx-vp9", "-i", webm,
                 "-pix_fmt", "rgba", os.path.join(td, "f%04d.png")])
        frames = sorted(f for f in os.listdir(td) if f.endswith(".png"))
        if not frames:
            return f"decode-fail: {r.stderr[-160:]}"
        # ② 垫底合成
        for f in frames:
            p = os.path.join(td, f)
            im = Image.open(p).convert("RGBA")
            bg = Image.new("RGBA", im.size, BG)
            bg.alpha_composite(im)
            bg.convert("RGB").save(p)
        # ③ 编 mp4
        r2 = run([FFMPEG, "-y", "-framerate", str(FPS), "-i", os.path.join(td, "f%04d.png"),
                  "-c:v", "libx264", "-crf", "23", "-preset", "veryfast",
                  "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4])
        if not os.path.isfile(mp4) or os.path.getsize(mp4) < 10000:
            return f"encode-fail: {r2.stderr[-160:]}"
    return "ok"


def main():
    force = "--force" in sys.argv
    ok = skip = fail = 0
    for form in sorted(os.listdir(MEDIA)):
        d = os.path.join(MEDIA, form)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".webm"):
                continue
            webm = os.path.join(d, f)
            mp4 = webm[:-5] + ".mp4"
            res = convert(webm, mp4, force)
            if res == "skip":
                skip += 1
            elif res == "ok":
                ok += 1
                print(f"✔ {form}/{f[:-5]}.mp4 {os.path.getsize(mp4) // 1024}KB")
            else:
                fail += 1
                print(f"✘ {form}/{f}: {res}")
    print(f"\n完成：转码 {ok} / 跳过 {skip} / 失败 {fail}")


if __name__ == "__main__":
    main()
