# -*- coding: utf-8 -*-
"""record_screen.py —— 轻量游戏/屏幕录制（ffmpeg gdigrab，无需 OBS）。

用法：
    python record_screen.py --out F:/qqbot/tmp/gameplay.mp4 --seconds 60
    python record_screen.py --out clip.mp4 --window "原神" --fps 30
    python record_screen.py --out clip.mp4 --rect 0,0,1920,1080 --seconds 30

停止方式：
    --seconds 到时自动停；或 Ctrl+C；或往 <out>.stop 文件写任意内容（外部可控停）。

设计：
- 用系统里已有的 ffmpeg（common.find_ffmpeg 同款搜索路径），零额外依赖。
- gdigrab 抓屏幕（或 --window 抓指定窗口标题）。游戏全屏独占模式 gdigrab 抓不到，
  请让游戏跑 无边框窗口/窗口化。
- 音频：--mic 录麦克风回放混音需要 dshow 设备名，默认只录系统声音（--audio virtual-audio
  需装虚拟声卡）——默认不带音频，配解说交给 narrate_footage.py。
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import find_ffmpeg  # noqa: E402  （返回 (路径, 来源) 二元组）


def screen_size() -> tuple:
    try:
        import ctypes
        user32 = ctypes.windll.user32
        user32.SetProcessDPIAware()
        return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    except Exception:
        return 1920, 1080


def main() -> int:
    ap = argparse.ArgumentParser(description="轻量屏幕/游戏录制")
    ap.add_argument("--out", required=True, help="输出 mp4 路径")
    ap.add_argument("--seconds", type=float, default=60, help="录制时长（秒），0=直到 Ctrl+C 或 stop 文件")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--window", default="", help="按窗口标题抓取（推荐无边框窗口化的游戏）")
    ap.add_argument("--rect", default="", help="抓屏区域 x,y,w,h（默认全屏）")
    ap.add_argument("--crf", type=int, default=23)
    ap.add_argument("--preset", default="veryfast")
    a = ap.parse_args()

    exe, _src = find_ffmpeg()
    if not exe:
        print("ERR no-ffmpeg", flush=True)
        return 2
    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    stop_file = Path(str(out) + ".stop")

    src = ["-f", "gdigrab"]
    if a.window:
        src += ["-i", f"title={a.window}"]
    elif a.rect:
        x, y, w, h = (int(v) for v in a.rect.split(","))
        src += ["-offset_x", str(x), "-offset_y", str(y), "-video_size", f"{w}x{h}", "-i", "desktop"]
    else:
        w, h = screen_size()
        src += ["-video_size", f"{w}x{h}", "-framerate", str(a.fps), "-i", "desktop"]
    if not a.window:
        src += ["-framerate", str(a.fps)]

    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error"] + src + [
        "-c:v", "libx264", "-preset", a.preset, "-crf", str(a.crf),
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out),
    ]

    print(f"REC start -> {out}" + (f" ({a.seconds}s)" if a.seconds else " (until stop)"), flush=True)
    proc = subprocess_Popen(cmd)
    t0 = time.time()
    try:
        while proc.poll() is None:
            if a.seconds and (time.time() - t0) >= a.seconds:
                break
            if stop_file.exists():
                stop_file.unlink(missing_ok=True)
                print("REC stop-file seen", flush=True)
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("REC ctrl-c", flush=True)
    # Windows 上 ffmpeg 等待 stdin q；用 taskkill 兜底再优雅 terminate
    if proc.poll() is None:
        try:
            proc.terminate()          # ffmpeg 收 SIGTERM 会正常收尾 moov
            proc.wait(timeout=15)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    size = out.stat().st_size if out.exists() else 0
    print(f"REC done {out} {size} bytes {time.time()-t0:.0f}s", flush=True)
    return 0 if size > 4096 else 3


def subprocess_Popen(cmd):
    import subprocess
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.Popen(cmd, creationflags=flags, stdin=subprocess.DEVNULL)


if __name__ == "__main__":
    raise SystemExit(main())
