# -*- coding: utf-8 -*-
"""video-frame-render 公共层：ffmpeg 发现、媒体信息解析、帧命名与体检常量。

本文件被 check_env / render / encode / verify 共用。
所有外部命令都通过 run() 走，不做 shell=True（避免 PowerShell 引号吃掉参数）。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ---- 控制台编码：Windows 默认 cp936，调用方（pwsh）按 UTF-8 读会乱码 ----
# 实测：不修的话中文日志全变 ???；reconfigure 成 utf-8 后正常。
for _stream in (sys.stdout, sys.stderr):
    try:
        enc = (_stream.encoding or "").lower().replace("-", "")
        if enc not in ("utf8",):
            _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ---- 退出码（与 SKILL.md 一致，上层机器人据此分支） ----
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_WAIT_CONFIRM = 3
EXIT_ENV = 4
EXIT_FRAME_INTEGRITY = 6
EXIT_ENCODE = 8
EXIT_VERIFY = 9

# ---- 帧常量（唯一真源，别在别处硬编码） ----
FRAME_PATTERN = "n%05d.png"
MIN_FRAME_BYTES = 128


def frame_name(index: int) -> str:
    return FRAME_PATTERN % index


def frame_pattern(frames_dir) -> str:
    return str(Path(frames_dir) / FRAME_PATTERN)


def run(args, timeout=None):
    """跑外部命令，返回 CompletedProcess（text 模式，容错解码）。"""
    argv = [str(a) for a in args]
    try:
        return subprocess.run(argv, capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              timeout=timeout, shell=False)
    except FileNotFoundError as exc:
        raise RuntimeError(f"命令不存在: {argv[0]}") from exc


# ---------------- ffmpeg / ffprobe 发现 ----------------

def _imageio_ffmpeg():
    try:
        import imageio_ffmpeg  # noqa: PLC0415
    except Exception:
        return None
    try:
        p = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None
    return p if p and Path(p).is_file() else None


def _playwright_ffmpeg():
    roots = []
    if os.environ.get("LOCALAPPDATA"):
        roots.append(Path(os.environ["LOCALAPPDATA"]) / "ms-playwright")
    roots.append(Path.home() / "AppData" / "Local" / "ms-playwright")
    for root in roots:
        if not root.is_dir():
            continue
        for exe in sorted(root.glob("ffmpeg-*/*/ffmpeg*.exe")):
            if exe.is_file():
                return str(exe)
        for exe in sorted(root.glob("ffmpeg-*/ffmpeg*.exe")):
            if exe.is_file():
                return str(exe)
    return None


def _venv_ffmpegs():
    """本机实测：系统 python 没有 imageio_ffmpeg，但项目 venv 里有 7.1（带 libx264）。

    所以除了 in-process import，还要扫一下常见位置，否则会退到
    ms-playwright 那个**不含 libx264** 的精简 ffmpeg（报 Unrecognized option 'preset'）。
    """
    roots = [SKILL_ROOT.parent.parent]  # skills/video-frame-render -> 仓库根
    roots.append(Path.cwd())
    if os.environ.get("LOCALAPPDATA"):
        roots.append(Path(os.environ["LOCALAPPDATA"]) / "imageio" / "ffmpeg")
    found = []
    for root in roots:
        try:
            for exe in sorted(root.glob(".venv*/Lib/site-packages/"
                                        "imageio_ffmpeg/binaries/ffmpeg*.exe")):
                found.append(str(exe))
            for exe in sorted(root.glob("*imageio_ffmpeg*/binaries/ffmpeg*.exe")):
                found.append(str(exe))
        except OSError:
            continue
    if os.environ.get("LOCALAPPDATA"):
        try:
            found += [str(p) for p in sorted(
                (Path(os.environ["LOCALAPPDATA"]) / "imageio" / "ffmpeg")
                .glob("**/ffmpeg*.exe"))]
        except OSError:
            pass
    return [p for p in found if Path(p).is_file()]


def _has_x264(exe):
    """精简版 ffmpeg（ms-playwright）没有 libx264，必须先探再用。"""
    try:
        p = run([exe, "-hide_banner", "-encoders"], timeout=30)
    except Exception:
        return False
    return "libx264" in (p.stdout or "")


_CACHE = {}


def find_ffmpeg():
    """返回 (绝对路径, 来源标签)；找不到返回 (None, None)。

    顺序：VFR_FFMPEG 环境变量 -> imageio_ffmpeg(in-process) -> 本机 venv 里的
    imageio_ffmpeg -> PATH -> ms-playwright 内置（仅当它自带 libx264）。
    每个候选都探一次 libx264，第一个能编 H.264 的胜出（结果缓存）。
    """
    if "ffmpeg" in _CACHE:
        return _CACHE["ffmpeg"]
    cands = []
    env = os.environ.get("VFR_FFMPEG")
    if env:
        cands.append((env, "VFR_FFMPEG"))
    p = _imageio_ffmpeg()
    if p:
        cands.append((p, "imageio_ffmpeg"))
    for p in _venv_ffmpegs():
        cands.append((p, "venv/imageio_ffmpeg"))
    p = shutil.which("ffmpeg")
    if p:
        cands.append((p, "PATH"))
    p = _playwright_ffmpeg()
    if p:
        cands.append((p, "ms-playwright"))

    seen = set()
    first_any = None
    for exe, label in cands:
        key = os.path.normcase(str(exe))
        if key in seen or not Path(exe).is_file():
            continue
        seen.add(key)
        if first_any is None:
            first_any = (exe, label)
        if _has_x264(exe):
            _CACHE["ffmpeg"] = (exe, label)
            return _CACHE["ffmpeg"]
    # 没有带 libx264 的：返回第一个能跑的（上层会提示改用 webp/gif）
    _CACHE["ffmpeg"] = first_any or (None, None)
    return _CACHE["ffmpeg"]



def find_ffprobe():
    """本机通常没有 ffprobe（imageio_ffmpeg 只发 ffmpeg）。没有就返回 None。"""
    p = shutil.which("ffprobe")
    if p:
        return p
    side = Path(sys.executable).parent / "ffprobe.exe"
    return str(side) if side.is_file() else None


# ---------------- 媒体信息（无 ffprobe 也能读） ----------------

_DUR_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)")
_VIDEO_RE = re.compile(r"Stream #\d+:\d+.*?Video:\s*(\S+).*?,\s*(\d+)x(\d+)")
_PIXFMT_RE = re.compile(r"Video:\s*\S+.*?,\s*(yuv\w+|rgb\w+|gray\w*)(\([^)]*\))?")
_FPS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*fps")
_AUDIO_RE = re.compile(r"Stream #\d+:\d+.*?Audio:\s*(\S+)")


def media_info(path, ffmpeg=None):
    """解析 ffmpeg -i 的 stderr。返回 dict（缺项为 None）。"""
    ffmpeg = ffmpeg or find_ffmpeg()[0]
    if not ffmpeg:
        raise RuntimeError("找不到 ffmpeg，无法读取媒体信息")
    p = run([ffmpeg, "-hide_banner", "-i", str(path)])
    text = (p.stderr or "") + (p.stdout or "")
    info = {
        "path": str(path),
        "bytes": os.path.getsize(path) if os.path.isfile(path) else 0,
        "duration": None, "video_codec": None, "width": None, "height": None,
        "pix_fmt": None, "color_tags": None, "fps": None,
        "audio_codec": None, "has_audio": False, "raw_video_line": None,
    }
    m = _DUR_RE.search(text)
    if m:
        h, mi, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
        info["duration"] = h * 3600 + mi * 60 + s
    for line in text.splitlines():
        if "Video:" in line and "Stream #" in line and info["raw_video_line"] is None:
            info["raw_video_line"] = line.strip()
            mv = _VIDEO_RE.search(line)
            if mv:
                info["video_codec"] = mv.group(1).rstrip(",")
                info["width"] = int(mv.group(2))
                info["height"] = int(mv.group(3))
            mp = _PIXFMT_RE.search(line)
            if mp:
                info["pix_fmt"] = mp.group(1)
                info["color_tags"] = (mp.group(2) or "").strip("()") or None
            mf = _FPS_RE.search(line)
            if mf:
                info["fps"] = float(mf.group(1))
        if "Audio:" in line and "Stream #" in line:
            ma = _AUDIO_RE.search(line)
            if ma:
                info["has_audio"] = True
                info["audio_codec"] = ma.group(1).rstrip(",")
    return info


def color_ok(info):
    """色彩标签是否达标：必须 tv + bt709，且没有 unknown 混进来。

    实测：只给编码器加 -colorspace 等参数时，回读是 yuv420p(tv, bt709/unknown/unknown)；
    滤镜链里有 setparams 才是 yuv420p(tv, bt709, progressive)。
    """
    tags = (info.get("color_tags") or "").lower()
    if not tags:
        return False, "no color tags"
    if "unknown" in tags:
        return False, f"partial tags: {tags}"
    if "bt709" not in tags:
        return False, f"not bt709: {tags}"
    return True, tags


def count_video_frames(path, ffmpeg=None):
    """无 ffprobe 时数帧：解码到 null，抓 stderr 最后一处 frame= N。"""
    ffmpeg = ffmpeg or find_ffmpeg()[0]
    if not ffmpeg:
        raise RuntimeError("找不到 ffmpeg，无法数帧")
    p = run([ffmpeg, "-hide_banner", "-i", str(path),
             "-map", "0:v", "-f", "null", "-"])
    hits = re.findall(r"frame=\s*(\d+)", p.stderr or "")
    if not hits:
        return None
    return int(hits[-1])


def count_frames_on_disk(frames_dir):
    return len(sorted(Path(frames_dir).glob("n*.png")))


def bad_frames(frames_dir):
    """返回 (坏帧索引列表, 全部帧索引列表)。0 字节/半截 PNG 会让 ffmpeg 静默截断，必须先查。"""
    frames_dir = Path(frames_dir)
    paths = sorted(frames_dir.glob("n*.png"))
    bad, good = [], []
    for p in paths:
        try:
            idx = int(p.stem[1:])
        except ValueError:
            continue
        size = p.stat().st_size
        (good if size >= MIN_FRAME_BYTES else bad).append((idx, size))
    return [i for i, _ in bad], [i for i, _ in good]


# ---------------- 文件 / 预设 / 字体 ----------------

SKILL_ROOT = Path(__file__).resolve().parent.parent
PRESET_DIR = SKILL_ROOT / "presets"


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_preset(name):
    path = PRESET_DIR / f"{name}.json"
    if not path.is_file():
        raise SystemExit(f"preset 不存在: {path}")
    data = load_json(path)
    # 兼容 {"vertical": {...}} 与扁平写法
    return data.get(name, data)


FONT_CANDIDATES = {
    "bold": ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyhbd.ttf",
             "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/DengB.ttf"],
    "regular": ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyh.ttf",
                "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/Deng.ttf"],
}


def find_font(bold=True):
    for cand in FONT_CANDIDATES["bold" if bold else "regular"]:
        if Path(cand).is_file():
            return cand
    return None


def work_dir(tag="vfr"):
    """临时工作目录：绝不往仓库根写帧。"""
    return Path(tempfile.mkdtemp(prefix=f"{tag}_"))


def free_gb(path):
    try:
        return shutil.disk_usage(str(path)).free / (1024 ** 3)
    except OSError:
        return 0.0


def die(code, msg):
    print(f"[video-frame-render] {msg}", flush=True)
    raise SystemExit(code)


def human_bytes(n):
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GB"
