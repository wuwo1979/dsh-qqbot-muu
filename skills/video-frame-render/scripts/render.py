# -*- coding: utf-8 -*-
"""storyboard.json -> 帧序列 -> mp4/webp/gif。这是 skill 的唯一主入口。

用法（详见 SKILL.md）：
    python render.py --storyboard sb.json --dry-run
    python render.py --storyboard sb.json --stills 0,90,300 --out-dir tmp/prev
    python render.py --storyboard sb.json --out out.mp4 --audio bgm.m4a --yes
    python render.py --storyboard sb.json --format webp --out out.webp --yes

退出码：0 OK / 2 用法错 / 3 需确认 --yes / 4 环境缺失 /
       6 帧完整性失败 / 8 编码失败 / 9 自检失败
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image

import common as C
import timeline as T

TEMPLATES_OK = ("title", "bullet", "quote", "bignum", "caption")


# ---------------- storyboard 读取与校验 ----------------

def load_storyboard(path):
    sb = C.load_json(path)
    if not isinstance(sb, dict) or "scenes" not in sb:
        C.die(C.EXIT_USAGE, "storyboard 必须是 {scenes: [...]} 结构")
    scenes = sb["scenes"]
    if not isinstance(scenes, list) or not scenes:
        C.die(C.EXIT_USAGE, "scenes 不能为空")
    if len(scenes) > 12:
        C.die(C.EXIT_USAGE,
              f"scenes={len(scenes)} 太多（建议 ≤8，>12 请拆成多条片子）")
    for i, sc in enumerate(scenes):
        if "dur" not in sc:
            C.die(C.EXIT_USAGE, f"scenes[{i}] 缺 dur（秒）")
        if float(sc["dur"]) <= 0:
            C.die(C.EXIT_USAGE, f"scenes[{i}].dur 必须 > 0")
        tpl = sc.get("template", "title")
        if tpl not in TEMPLATES_OK:
            C.die(C.EXIT_USAGE,
                  f"scenes[{i}].template={tpl!r} 不合法，只能是 {TEMPLATES_OK}")
        if not sc.get("text"):
            C.die(C.EXIT_USAGE, f"scenes[{i}] 缺 text")
    return sb


def make_ctx(sb, preset_name=None, fps_override=None):
    name = preset_name or sb.get("preset") or "vertical"
    preset = C.load_preset(name)
    theme = T.resolve_theme(preset, sb.get("theme"))
    fps = int(fps_override or sb.get("fps") or 30)
    if fps not in (12, 15, 24, 25, 30, 50, 60):
        C.die(C.EXIT_USAGE, f"fps={fps} 不支持（12/15/24/25/30/50/60）")
    return T.Ctx(preset, theme, fps=fps), preset, fps


# ---------------- 渲染 ----------------

def render_frames(sb, ctx, frames_dir, start=0, end=None, quiet=False):
    frames_dir = Path(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)
    scenes = sb["scenes"]
    counts = T.scene_frame_counts(scenes, ctx.fps)
    bounds = T.scene_bounds(counts)
    end = sum(counts) if end is None else end
    subs = sb.get("subtitles") or []
    t_start = time.perf_counter()
    done = 0

    for idx, (s0, s1) in enumerate(bounds):
        lo, hi = max(start, s0), min(end, s1)
        if lo >= hi:
            continue
        scene = scenes[idx]
        for f in range(lo, hi):
            local = (f - s0) / float(ctx.fps)
            abs_t = f / float(ctx.fps)
            sub = T.subtitle_at(subs, abs_t)
            img = T.render_at(scene, local, ctx, subtitle=sub)
            img.convert("RGB").save(frames_dir / C.frame_name(f), "PNG",
                                    compress_level=6)
            done += 1
        if not quiet:
            el = time.perf_counter() - t_start
            print(f"  scene {idx + 1}/{len(scenes)} [{scene.get('template')}] "
                  f"frames {lo}-{hi - 1} ({done} 帧, {el:.1f}s)")
    return done


def render_stills(sb, ctx, frames, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    scenes = sb["scenes"]
    counts = T.scene_frame_counts(scenes, ctx.fps)
    bounds = T.scene_bounds(counts)
    total = sum(counts)
    subs = sb.get("subtitles") or []
    paths = []
    for f in frames:
        if not (0 <= f < total):
            C.die(C.EXIT_USAGE, f"帧号 {f} 越界（总帧数 {total}）")
        idx = next(i for i, (s0, s1) in enumerate(bounds) if s0 <= f < s1)
        scene = scenes[idx]
        s0, _ = bounds[idx]
        local = (f - s0) / float(ctx.fps)
        abs_t = f / float(ctx.fps)
        img = T.render_at(scene, local, ctx,
                          subtitle=T.subtitle_at(subs, abs_t))
        p = out_dir / f"still_{f:05d}.png"
        img.convert("RGB").save(p, "PNG")
        paths.append(str(p))
        print(f"  still {f} -> {p}")
    return paths


def check_and_repair(sb, ctx, frames_dir, total):
    """编码前帧体检：坏帧所在整屏重渲一次，仍坏则退出 6。"""
    bad, good = C.bad_frames(frames_dir)
    if not bad:
        print(f"[check] 帧体检 OK（{len(good)} 帧）")
        return
    print(f"[check] 发现坏帧 {len(bad)} 个（{'<128B 或 0 字节'}）：{bad[:10]}，整屏重渲")
    counts = T.scene_frame_counts(sb["scenes"], ctx.fps)
    bounds = T.scene_bounds(counts)
    dirty = {i for i, (s0, s1) in enumerate(bounds) if any(s0 <= b < s1 for b in bad)}
    for idx in sorted(dirty):
        s0, s1 = bounds[idx]
        render_frames(sb, ctx, frames_dir, start=s0, end=s1, quiet=True)
    bad2, good2 = C.bad_frames(frames_dir)
    if bad2:
        C.die(C.EXIT_FRAME_INTEGRITY,
              f"重渲后仍有坏帧 {len(bad2)} 个：{bad2[:10]}（磁盘满？被强杀？）")
    print(f"[check] 重渲后 OK（{good2} 帧）")


# ---------------- 无 ffmpeg 降级：动图 ----------------

def render_animation(sb, ctx, out_path, fmt, max_width, max_frames):
    """没有 ffmpeg 时的降级路径：Pillow 直接出动画 WebP/GIF。"""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    scenes = sb["scenes"]
    counts = T.scene_frame_counts(scenes, ctx.fps)
    bounds = T.scene_bounds(counts)
    total = sum(counts)
    if total > max_frames:
        C.die(C.EXIT_USAGE,
              f"{fmt} 降级模式最多 {max_frames} 帧（本次 {total} 帧）。"
              f"缩短时长、降 fps，或用 --max-frames 提高上限")
    subs = sb.get("subtitles") or []
    ratio = min(1.0, max_width / float(ctx.preset["w"]))
    size = (int(ctx.preset["w"] * ratio), int(ctx.preset["h"] * ratio))
    frames = []
    t0 = time.perf_counter()
    for f in range(total):
        idx = next(i for i, (s0, s1) in enumerate(bounds) if s0 <= f < s1)
        s0, _ = bounds[idx]
        img = T.render_at(scenes[idx], (f - s0) / float(ctx.fps), ctx,
                          subtitle=T.subtitle_at(subs, f / float(ctx.fps)))
        frames.append(img.convert("RGB").resize(size, Image.LANCZOS))
    dur = int(round(1000 / float(ctx.fps)))
    if fmt == "gif":
        frames[0].save(out_path, save_all=True, append_images=frames[1:],
                       duration=dur, loop=0, optimize=True)
    else:
        frames[0].save(out_path, save_all=True, append_images=frames[1:],
                       duration=dur, loop=0, quality=80, method=4)
    el = time.perf_counter() - t0
    print(f"[anim] {out_path} {len(frames)} 帧 {size[0]}x{size[1]} "
          f"{C.human_bytes(out_path.stat().st_size)} {el:.1f}s")
    return out_path


# ---------------- 并行（独立子进程，不用 Pool） ----------------

def spawn_workers(args, total, jobs, frames_dir):
    """按帧区间起独立子进程。不用 multiprocessing.Pool：沙箱会拒命名管道。"""
    import subprocess
    chunk = (total + jobs - 1) // jobs
    procs = []
    for k in range(jobs):
        a, b = k * chunk, min(total, (k + 1) * chunk)
        if a >= b:
            continue
        cmd = [sys.executable, str(Path(__file__).resolve()),
               "--storyboard", str(args.storyboard),
               "--_range", f"{a}:{b}", "--_frames-dir", str(frames_dir)]
        if args.preset:
            cmd += ["--preset", args.preset]
        if args.fps:
            cmd += ["--fps", str(args.fps)]
        procs.append(subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, text=True,
                                      encoding="utf-8", errors="replace"))
    for p in procs:
        out, _ = p.communicate()
        if p.returncode != 0:
            print(out[-1500:], file=sys.stderr)
            C.die(C.EXIT_ENCODE, f"子进程渲染失败 rc={p.returncode}")


# ---------------- CLI ----------------

def build_parser():
    ap = argparse.ArgumentParser(
        prog="render.py", description="分镜 JSON -> 逐帧渲染 -> mp4/webp/gif")
    ap.add_argument("--storyboard", required=True, help="storyboard.json 路径")
    ap.add_argument("--out", default=None, help="输出文件（.mp4/.webp/.gif）")
    ap.add_argument("--out-dir", default=None, help="--stills / --frames-only 的输出目录")
    ap.add_argument("--preset", default=None, choices=["vertical", "horizontal"],
                    help="画幅预设（缺省取 storyboard.preset）")
    ap.add_argument("--fps", type=int, default=None, help="覆盖 storyboard.fps")
    ap.add_argument("--audio", default=None, help="音轨文件")
    ap.add_argument("--format", default=None, choices=["mp4", "webp", "gif"],
                    help="输出格式（缺省看 --out 后缀，否则 mp4）")
    ap.add_argument("--stills", default=None, help="只渲几帧，如 0,90,300")
    ap.add_argument("--frames-only", action="store_true", help="只出帧不编码")
    ap.add_argument("--dry-run", action="store_true", help="只报代价，不落盘")
    ap.add_argument("--yes", action="store_true", help="确认执行（确认门）")
    ap.add_argument("--jobs", type=int, default=1, help="并行子进程数（默认 1）")
    ap.add_argument("--crf", type=int, default=20, help="x264 质量（越小越好）")
    ap.add_argument("--x264preset", default="medium",
                    choices=["veryfast", "faster", "fast", "medium", "slow"])
    ap.add_argument("--keep-frames", action="store_true", help="保留中间帧目录")
    ap.add_argument("--max-frames", type=int, default=150,
                    help="webp/gif 降级模式帧数上限")
    ap.add_argument("--max-width", type=int, default=540,
                    help="webp/gif 降级模式最大宽度")
    ap.add_argument("--quiet", action="store_true")
    # 内部：并行子进程用
    ap.add_argument("--_range", default=None, help=argparse.SUPPRESS)
    ap.add_argument("--_frames-dir", default=None, help=argparse.SUPPRESS)
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    sb = load_storyboard(args.storyboard)
    ctx, preset, fps = make_ctx(sb, args.preset, args.fps)
    counts = T.scene_frame_counts(sb["scenes"], fps)
    total = sum(counts)

    # --- 内部：并行工作进程 ---
    if args._range:
        a, b = (int(x) for x in args._range.split(":"))
        render_frames(sb, ctx, args._frames_dir, start=a, end=b,
                      quiet=args.quiet)
        return C.EXIT_OK

    # --- stills ---
    if args.stills:
        frames = [int(x) for x in args.stills.replace(" ", "").split(",") if x]
        out_dir = args.out_dir or "stills"
        paths = render_stills(sb, ctx, frames, out_dir)
        print(f"[stills] {len(paths)} 帧 -> {out_dir}")
        return C.EXIT_OK

    # --- dry-run / 确认门 ---
    est_total, est_render, est_encode, est_png, level = T.estimate(sb["scenes"], fps)
    if args.dry_run or not args.yes:
        print(f"preset={args.preset or sb.get('preset', 'vertical')} "
              f"{ctx.w}x{ctx.h} fps={fps} scenes={len(sb['scenes'])} "
              f"frames={est_total} dur={est_total / fps:.2f}s")
        for i, (sc, n) in enumerate(zip(sb["scenes"], counts)):
            print(f"  scene {i + 1}: {sc.get('template', 'title'):<7} "
                  f"dur={float(sc['dur']):.2f}s frames={n}")
        print(f"est_render={est_render:.1f}s est_encode={est_encode:.1f}s "
              f"est_png={C.human_bytes(est_png)} level={level} "
              f"disk_free={C.free_gb(Path.cwd()):.1f}GB")
        if args.dry_run and args.yes:
            return C.EXIT_OK
        if args.dry_run:
            print("[gate] --dry-run：以上为预估，未落盘。确认后加 --yes 真跑。")
            return C.EXIT_WAIT_CONFIRM
        print("[gate] 需要 --yes 确认才会真的渲染（或用 --dry-run 只看代价）。")
        return C.EXIT_WAIT_CONFIRM

    # --- 判定输出格式 ---
    fmt = args.format
    if not fmt:
        if args.out:
            fmt = Path(args.out).suffix.lower().lstrip(".") or "mp4"
            if fmt not in ("mp4", "webp", "gif"):
                fmt = "mp4"
        else:
            fmt = "mp4"
    if fmt in ("webp", "gif"):
        out = args.out or f"out.{fmt}"
        render_animation(sb, ctx, out, fmt, args.max_width, args.max_frames)
        return C.EXIT_OK

    if not args.out and not args.frames_only:
        C.die(C.EXIT_USAGE, "mp4 模式需要 --out out.mp4"
                            "（只要帧就加 --frames-only --out-dir 目录）")

    ffmpeg, source = C.find_ffmpeg()
    if not ffmpeg:
        C.die(C.EXIT_ENCODE,
              "找不到 ffmpeg。降级方案：加 --format webp 直接出动画 WebP，"
              "或 pip install imageio-ffmpeg")

    work = Path(args._frames_dir) if args._frames_dir else C.work_dir("vfr")
    if args._frames_dir:
        frames_dir = Path(args._frames_dir)
    elif args.frames_only and args.out_dir:
        frames_dir = Path(args.out_dir)
    else:
        frames_dir = work / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    print(f"[render] {ctx.w}x{ctx.h} fps={fps} frames={total} "
          f"ffmpeg={source} frames_dir={frames_dir}")

    t0 = time.perf_counter()
    if args.jobs and args.jobs > 1:
        print(f"[render] 并行 {args.jobs} 个独立子进程（不用 Pool：沙箱拦命名管道）")
        spawn_workers(args, total, args.jobs, frames_dir)
    else:
        render_frames(sb, ctx, frames_dir, quiet=args.quiet)
    el = time.perf_counter() - t0
    print(f"[render] 完成 {total} 帧，用时 {el:.2f}s（{el * 1000 / max(1, total):.1f} ms/帧）")

    check_and_repair(sb, ctx, frames_dir, total)

    if args.frames_only:
        print(f"[render] --frames-only：帧已留在 {frames_dir}（未删除）")
        return C.EXIT_OK

    import encode as E
    t1 = time.perf_counter()
    info = E.encode(frames_dir, args.out, fps=fps, audio=args.audio,
                    crf=args.crf, preset=args.x264preset, expect=total)
    el2 = time.perf_counter() - t1
    print(f"[encode] 完成 {C.human_bytes(info['bytes'])} "
          f"dur={info['duration']:.3f}s frames={info['frames']} "
          f"color={info['color_tags']} {el2:.2f}s")

    if not args.keep_frames:
        import shutil
        shutil.rmtree(work, ignore_errors=True)
        print(f"[clean] 已删除中间帧目录 {work}")
    else:
        print(f"[clean] --keep-frames：帧留在 {frames_dir}")

    print(f"[done] {args.out} | render {el:.2f}s + encode {el2:.2f}s "
          f"| {C.human_bytes(info['bytes'])} | {info['frames']} 帧")
    return C.EXIT_OK


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except KeyboardInterrupt:
        print("[render] 被中断", file=sys.stderr)
        raise SystemExit(130)
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
