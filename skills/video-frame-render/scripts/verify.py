# -*- coding: utf-8 -*-
"""成片自检：不依赖人眼，也不依赖 ffprobe。

可独立运行：
    python verify.py --video tmp\\out.mp4
    python verify.py --video tmp\\out.mp4 --expect-frames 198 --fps 30 --sample 6
    python verify.py --video tmp\\out.mp4 --json

检查项：
1. 文件存在、字节数 > 1KB
2. 容器能解出视频流、分辨率、fps、时长（靠 `ffmpeg -i` 的 stderr 解析）
3. 色彩标签必须是 tv + bt709（缺 setparams 时会是 bt709/unknown/unknown）
4. 实际帧数（`-f null -` 数 frame= N）与 expecting 帧数一致
5. 时长 ≈ 帧数 / fps（容差 1 帧）
6. 抽 N 帧查黑屏/纯色（mean < 2 或 唯一色 < 400 判失败）

退出码：0 通过 / 9 不合格。
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as C

BLANK_MEAN = 2.0
BLANK_UNIQ = 400


def extract_samples(ffmpeg, video, count, out_dir):
    """均匀抽 count 帧到 PNG，返回路径列表（抽帧本身也能反证片子可解码）。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    total = C.count_video_frames(video, ffmpeg) or 0
    if total <= 0:
        return [], total
    step = max(1, total // max(1, count))
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
           "-i", str(video),
           "-vf", f"select='not(mod(n\\,{step}))',scale=270:-1",
           "-vsync", "0",
           str(out_dir / "s%03d.png")]
    p = C.run(cmd)
    if p.returncode != 0:
        return [], total
    return sorted(out_dir.glob("s*.png")), total


def analyse(samples):
    from PIL import Image, ImageStat
    bad = []
    stats = []
    for p in samples:
        im = Image.open(p).convert("RGB")
        st = ImageStat.Stat(im)
        mean = sum(st.mean) / 3.0
        uniq = len(im.getcolors(maxcolors=1 << 24) or [])
        stats.append({"file": p.name, "mean": round(mean, 2), "uniq": uniq})
        if mean < BLANK_MEAN or uniq < BLANK_UNIQ:
            bad.append(p.name)
    return stats, bad


def verify(video, expect_frames=None, fps=None, sample=4, quiet=False,
           as_json=False):
    ffmpeg, source = C.find_ffmpeg()
    if not ffmpeg:
        C.die(C.EXIT_ENV, "找不到 ffmpeg，无法自检")
    video = Path(video)
    if not video.is_file():
        C.die(C.EXIT_USAGE, f"文件不存在: {video}")
    size = video.stat().st_size
    if size < 1024:
        C.die(C.EXIT_VERIFY, f"成片只有 {size}B，肯定坏了")

    info = C.media_info(video, ffmpeg)
    info["bytes_human"] = C.human_bytes(size)
    info["ffmpeg_source"] = source
    problems = []

    if not info.get("duration"):
        problems.append("读不到 Duration（容器坏了？）")
    if not info.get("width"):
        problems.append("读不到视频流（不是有效视频？）")
    if fps and info.get("fps") and abs(info["fps"] - float(fps)) > 0.01:
        problems.append(f"fps {info['fps']} != 期望 {fps}")

    ok, tags = C.color_ok(info)
    info["color_ok"] = ok
    if not ok:
        problems.append(f"色彩标签不合格: {tags}（滤镜链要加 setparams）")

    frames = C.count_video_frames(video, ffmpeg)
    info["frames"] = frames
    if frames is None or frames <= 0:
        problems.append("数不到帧（解码失败）")
    if expect_frames and frames and frames != expect_frames:
        problems.append(f"帧数 {frames} != 期望 {expect_frames}"
                        f"（多半是 0 字节帧导致 image2 静默截断）")
    if frames and info.get("duration"):
        want = frames / float(fps or info.get("fps") or 30)
        info["duration_expected"] = round(want, 3)
        if abs(info["duration"] - want) > (1.0 / float(fps or info.get("fps") or 30)) + 0.05:
            problems.append(f"时长 {info['duration']:.3f}s 与 {frames} 帧不符"
                            f"（应 {want:.3f}s）")

    stats, bad = [], []
    if sample and frames:
        with tempfile.TemporaryDirectory(prefix="vfr_verify_") as td:
            samples, _ = extract_samples(ffmpeg, video, sample, td)
            if not samples:
                problems.append("抽帧失败（片子解不开）")
            else:
                stats, bad = analyse(samples)
                if bad:
                    problems.append(f"疑似黑屏/纯色帧: {bad}")

    info["samples"] = stats
    info["problems"] = problems
    info["ok"] = not problems

    if as_json:
        print(json.dumps(info, ensure_ascii=False, indent=2, default=str))
    elif not quiet:
        print(f"video      {video}  ({info['bytes_human']})")
        print(f"video      {info.get('width')}x{info.get('height')} "
              f"fps={info.get('fps')} frames={frames} "
              f"dur={info.get('duration')}s (期望 {info.get('duration_expected')}s)")
        print(f"audio      {info.get('audio_codec') or '无'}")
        print(f"color      {tags}  ok={ok}")
        for s in stats:
            print(f"sample     {s['file']} mean={s['mean']} uniq={s['uniq']}")
        if problems:
            for p in problems:
                print(f"[FAIL] {p}")
        else:
            print("[PASS] 全部检查通过")

    if problems:
        return C.EXIT_VERIFY, info
    return C.EXIT_OK, info


def main(argv=None):
    ap = argparse.ArgumentParser(description="成片自检（帧数/时长/色彩/黑屏）")
    ap.add_argument("--video", required=True)
    ap.add_argument("--expect-frames", type=int, default=None)
    ap.add_argument("--fps", type=float, default=None)
    ap.add_argument("--sample", type=int, default=4, help="抽几帧查黑屏（0=跳过）")
    ap.add_argument("--json", action="store_true", dest="as_json")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    code, _ = verify(a.video, expect_frames=a.expect_frames, fps=a.fps,
                     sample=a.sample, quiet=a.quiet, as_json=a.as_json)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
