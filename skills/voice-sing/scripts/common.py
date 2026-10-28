"""voice-sing 公共工具：ffmpeg 定位、子进程、时长探测、日志。

设计约束（本机实测）：
  · 本机没有 ffprobe，时长只能从 `ffmpeg -i` 的 stderr 里抓 "Duration: HH:MM:SS.ss"。
  · 只依赖标准库，脚本之间可以直接互相 import（pipeline.py / split.py ... 都在同目录）。
  · Windows 控制台默认 GBK，中文 print 会炸，所以统一把 stdout/stderr 重设成 utf-8。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# 本机唯一可用 ffmpeg（无 ffprobe）
FFMPEG_KNOWN = r"F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"

_DUR_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)")


def reconfigure_io() -> None:
    """让中文在 Windows 控制台里不炸。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


def log(msg: str = "") -> None:
    print(msg, flush=True)


def find_ffmpeg() -> str:
    """按 环境变量 → 已知路径 → PATH 的顺序找 ffmpeg，找不到就抛带修复建议的异常。"""
    for cand in (
        os.environ.get("VOICE_SING_FFMPEG"),
        os.environ.get("FFMPEG_BIN"),
        FFMPEG_KNOWN,
    ):
        if cand and Path(cand).is_file():
            return str(Path(cand))
    which = shutil.which("ffmpeg")
    if which:
        return which
    raise RuntimeError(
        "找不到 ffmpeg。\n"
        f"期望路径: {FFMPEG_KNOWN}\n"
        "修复: 设置环境变量 VOICE_SING_FFMPEG=<ffmpeg.exe 绝对路径>，"
        "或者 pip install imageio-ffmpeg（会自带一个 ffmpeg）。"
    )


def find_ffprobe() -> str | None:
    """本机通常没有；有就用，没有就走 ffmpeg -i 兜底。"""
    for cand in (os.environ.get("FFPROBE_BIN"), str(Path(find_ffmpeg()).parent / "ffprobe.exe")):
        if cand and Path(cand).is_file():
            return cand
    return shutil.which("ffprobe")


def run(cmd: list[str], *, timeout: float = 3600, quiet: bool = True,
        env: dict | None = None) -> subprocess.CompletedProcess:
    """跑一个外部命令，返回 CompletedProcess（文本模式，utf-8 容错）。

    ⚠️ 2026-10-26 改：**不再用 capture_output(PIPE)**。在 DSH 的 Windows 沙箱里，
    python 开匿名管道会 EPERM / WinError 5（Node 侧同样），而且是静默的 ——
    taskkill / ffmpeg 看着跑了其实没跑。改成 stdout/stderr 各落一个临时文件再读回来，
    行为对调用方不变（还是 CompletedProcess，还是有 .stdout/.stderr），但抗沙箱。
    """
    import tempfile

    e = dict(os.environ)
    e.setdefault("PYTHONIOENCODING", "utf-8")
    if env:
        e.update(env)
    if not quiet:
        log("+ " + " ".join(f'"{c}"' if " " in str(c) else str(c) for c in cmd))
    fo, po = tempfile.mkstemp(prefix="vs-out-", suffix=".txt")
    fe, pe = tempfile.mkstemp(prefix="vs-err-", suffix=".txt")
    os.close(fo)
    os.close(fe)
    try:
        with open(po, "wb") as so, open(pe, "wb") as se:
            cp = subprocess.run(
                [str(c) for c in cmd],
                stdin=subprocess.DEVNULL, stdout=so, stderr=se,
                timeout=timeout, env=e,
            )
        out = Path(po).read_bytes().decode("utf-8", "replace")
        err = Path(pe).read_bytes().decode("utf-8", "replace")
        return subprocess.CompletedProcess([str(c) for c in cmd], cp.returncode, out, err)
    except FileNotFoundError as exc:
        raise RuntimeError(f"命令不存在: {cmd[0]} ({exc})") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"命令超时({timeout}s): {' '.join(map(str, cmd))}") from exc
    finally:
        for p in (po, pe):
            try:
                os.remove(p)
            except OSError:
                pass


def probe_duration(path: str | Path) -> float:
    """秒数。先 ffprobe，没有就解析 `ffmpeg -i` 的 stderr。"""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(str(path))
    ffprobe = find_ffprobe()
    if ffprobe:
        cp = run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                  "-of", "default=nw=1:nk=1", str(path)])
        try:
            return float(cp.stdout.strip())
        except ValueError:
            pass
    cp = run([find_ffmpeg(), "-hide_banner", "-i", str(path)])
    m = _DUR_RE.search(cp.stderr or "")
    if not m:
        raise RuntimeError(f"读不出时长（ffmpeg 输出里没有 Duration）: {path}")
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def file_size(path: str | Path) -> int:
    p = Path(path)
    return p.stat().st_size if p.is_file() else 0


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024.0
    return f"{n:.1f}GB"


class Step:
    """计时 + 字节数 + 报错原文，最后汇总成 JSON，方便写进报告当证据。"""

    def __init__(self) -> None:
        self.records: list[dict] = []
        self._t0 = 0.0
        self._name = ""

    def begin(self, name: str) -> None:
        self._name, self._t0 = name, time.perf_counter()
        log(f"[{name}] ...")

    def end(self, **info) -> None:
        dt = time.perf_counter() - self._t0
        rec = {"step": self._name, "seconds": round(dt, 2), **info}
        self.records.append(rec)
        bits = " ".join(f"{k}={v}" for k, v in info.items() if k in ("out", "bytes", "mode", "note"))
        log(f"[{self._name}] 完成 {dt:.2f}s {bits}".rstrip())

    def dump(self, path: str | Path | None = None) -> str:
        payload = json.dumps(self.records, ensure_ascii=False, indent=2)
        if path:
            Path(path).write_text(payload, encoding="utf-8")
        return payload


def torch_info() -> dict:
    """不 import 也先看包在不在，import 失败率太高（torch DLL 问题），用 find_spec。"""
    import importlib.util

    out = {}
    for mod in ("torch", "torchaudio", "onnxruntime", "demucs", "rvc_python",
                "librosa", "soundfile", "pydub", "faiss", "numpy", "scipy"):
        out[mod] = importlib.util.find_spec(mod) is not None
    return out


def add_common_args(p) -> None:
    p.add_argument("--ffmpeg", default=None, help="ffmpeg 绝对路径（默认用本机已知路径）")
    p.add_argument("--json", default=None, help="把计时/字节数写到这个 json 文件")
