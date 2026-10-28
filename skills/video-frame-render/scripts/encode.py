# -*- coding: utf-8 -*-
"""编码封装：帧体检 -> ffmpeg -> 数帧核对 -> 媒体自检。

可独立运行：
    python encode.py --frames tmp\\frames --fps 30 --out out.mp4 [--audio a.wav] [--expect 180]

三条硬规矩（都是本机实测踩出来的）：
1. 编码前按字节体检：0 字节/半截 PNG 会让 image2 解复用**静默截断**且 ffmpeg 退出码 0。
2. 色彩标签：只给编码器 -colorspace 等参数，回读仍是 bt709/unknown/unknown；
   必须同时在**滤镜链**里 setparams 一遍。
3. 编码后数帧核对：没有 ffprobe 时用 `-f null -` 抓 frame= N，对不上就报错。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as C


def color_args():
    return ["-colorspace", "bt709", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-color_range", "tv"]


def setparams_filter():
    """滤镜链里的色彩声明：少了它，回读只有 color_space 是 bt709。"""
    return ("setparams=color_primaries=bt709:color_trc=bt709:"
            "colorspace=bt709:range=tv")


def gop_args(fps):
    return ["-g", str(int(fps)), "-keyint_min", str(max(1, int(fps) // 2)),
            "-sc_threshold", "0"]


def check_frames(frames_dir, expect=None):
    """返回 (bad_indices, good_count, missing_indices)。"""
    frames_dir = Path(frames_dir)
    bad, good = C.bad_frames(frames_dir)
    missing = []
    if expect:
        present = set(good)
        missing = [i for i in range(expect) if i not in present]
    return bad, len(good), missing


def build_cmd(ffmpeg, frames_dir, out_path, fps, audio=None, crf=20,
              preset="medium", audio_bitrate="192k", audio_short=None):
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
           "-framerate", str(fps),
           "-i", C.frame_pattern(frames_dir)]
    if audio:
        # 音轨输入必须紧跟在图像输入后面：放到输出选项后面会被当成「输入选项」，
        # ffmpeg 会报 Error parsing options for input file ... Invalid argument。
        cmd += ["-i", str(audio)]
    cmd += ["-vf", setparams_filter(),
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-tune", "animation", "-pix_fmt", "yuv420p"]
    cmd += gop_args(fps)
    cmd += color_args()
    if audio:
        if audio_short:
            # 音轨短于画面：补静音，避免 -shortest 把画面截断
            cmd += ["-af", "apad"]
        cmd += ["-c:a", "aac", "-b:a", audio_bitrate, "-ar", "48000"]
        cmd += ["-shortest"]
    cmd += ["-movflags", "+faststart", str(out_path)]
    return cmd


def encode(frames_dir, out_path, fps=30, audio=None, crf=20, preset="medium",
           expect=None, verbose=True):
    """帧目录 -> mp4。返回 info dict；失败抛 SystemExit(C.EXIT_*)。"""
    ffmpeg, source = C.find_ffmpeg()
    if not ffmpeg:
        C.die(C.EXIT_ENCODE,
              "找不到 ffmpeg（imageio_ffmpeg / ms-playwright / PATH 都没有）。\n"
              "  pip install imageio-ffmpeg   或   把 ffmpeg.exe 放进 PATH")
    frames_dir = Path(frames_dir)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    bad, good, missing = check_frames(frames_dir, expect)
    if bad or missing:
        C.die(C.EXIT_FRAME_INTEGRITY,
              f"帧体检失败: 坏帧 {bad[:8]}{'...' if len(bad) > 8 else ''} "
              f"缺帧 {missing[:8]}{'...' if len(missing) > 8 else ''} "
              f"(好帧 {good})")

    audio_short = False
    if audio:
        ai = C.media_info(audio, ffmpeg)
        need = good / float(fps)
        if ai.get("duration") and ai["duration"] < need - 1.0 / fps:
            audio_short = True
            if verbose:
                print(f"[encode] 音轨 {ai['duration']:.2f}s 短于画面 {need:.2f}s，补静音")

    cmd = build_cmd(ffmpeg, frames_dir, out_path, fps, audio=audio, crf=crf,
                    preset=preset, audio_short=audio_short)
    p = C.run(cmd)
    if p.returncode != 0:
        print((p.stderr or "")[-2000:], file=sys.stderr)
        C.die(C.EXIT_ENCODE, f"ffmpeg 编码失败 rc={p.returncode}")

    info = C.media_info(out_path, ffmpeg)
    got = C.count_video_frames(out_path, ffmpeg)
    ok, tags = C.color_ok(info)
    info.update({"frames": got, "expected": good, "color_ok": ok,
                 "color_tags": tags, "ffmpeg": ffmpeg, "source": source,
                 "audio_short_padded": audio_short})
    if verbose:
        print(f"[encode] ffmpeg={source} out={out_path} "
              f"{info['bytes']}B dur={info['duration']}s frames={got}/{good} "
              f"color={tags}")
    if got is None or got != good:
        C.die(C.EXIT_VERIFY,
              f"数帧核对失败: 成片 {got} 帧 != 帧目录 {good} 帧 "
              f"（0 字节帧或断号会让 ffmpeg 静默截断）")
    if not ok:
        C.die(C.EXIT_VERIFY, f"色彩标签不合格: {tags}（滤镜链缺 setparams？）")
    return info


def main(argv=None):
    ap = argparse.ArgumentParser(description="帧序列 -> mp4（含体检与核对）")
    ap.add_argument("--frames", required=True, help="帧目录（n00000.png ...）")
    ap.add_argument("--out", required=True, help="输出 mp4")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--expect", type=int, default=None, help="期望帧数（缺省=盘上帧数）")
    ap.add_argument("--audio", default=None, help="音轨文件（wav/m4a/mp3）")
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument("--preset", default="medium",
                    choices=["veryfast", "faster", "fast", "medium", "slow"])
    a = ap.parse_args(argv)
    info = encode(a.frames, a.out, fps=a.fps, audio=a.audio, crf=a.crf,
                  preset=a.preset, expect=a.expect)
    print(f"[encode] OK frames={info['frames']} dur={info['duration']:.3f}s "
          f"bytes={info['bytes']} color={info['color_tags']}")
    return C.EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
