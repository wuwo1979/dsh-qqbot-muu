#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""sing.py —— 「唱一首歌」的一键入口。

一条命令从歌名走到可发送的成品，产物固定落在 <out>/ 下：

    <out>/cover.mp3    最终成片（44.1kHz / 192k / 立体声）
    <out>/meta.json    台账：歌名、原曲链接（B 站）、音色、音高、时长、大小、生成时间
    <out>/work/        中间件（人声、伴奏、换声）

示例：
    F:\\qqbot\\.models\\voice-sing-venv\\Scripts\\python.exe scripts\\sing.py ^
        --song "茶花开了" --style child ^
        --out F:\\qqbot\\tmp\\sing\\chahuakaile

    # 已经有本地音频（不走在线取歌）
    ... sing.py --local F:\\qqbot\\tmp\\x\\song.m4a --style child --out ...

stdout 最后一行是 JSON（给上游解析）：{"ok":true,"audio":"...","meta":"...","song":"...","url":"..."}
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# 本机控制台默认 GBK，而 demo_pipeline 的日志里带 emoji（🌿 等），
# 直接 print 会 UnicodeEncodeError: 'gbk' codec can't encode character '\U0001f33f'
# 把整个脚本带崩（封面其实已经生成好了）。统一按 UTF-8 输出，掉字也不炸。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = Path(__file__).resolve().parent
QQBOT = HERE.parents[2]
VENV_PY = QQBOT / ".models" / "voice-sing-venv" / "Scripts" / "python.exe"
FFMPEG = QQBOT / ".venv-draw" / "Lib" / "site-packages" / "imageio_ffmpeg" / "binaries" / "ffmpeg-win-x86_64-v7.1.exe"

# 音色预设：名字 -> (pth, index, 默认半音)
# child = 童真：女声软糯音色 + 抬 4 个半音，接近小孩嗓子。
VOICES = {
    "luomi": (
        r"F:\qqbot\.models\rvc-voices\sucrose-luomi\sucrose_e100_s5400.pth",
        r"F:\qqbot\.models\rvc-voices\sucrose-luomi\added_IVF902_Flat_nprobe_1_sucrose_v2.index",
        0,
    ),
    "asa": (
        r"F:\qqbot\.models\rvc-voices\raiden-asa\ei_raiden_e110_s5060.pth",
        "",
        -2,
    ),
}
STYLES = {
    # style -> (voice, 额外半音)
    # 2026-11-09 四调：用户要「更童真、纯净清亮、少沙感」。
    # 童真靠两件事——音高抬一点 + 换声本身干净（干净靠 RVC 的 -ir/-fr，见 demo_pipeline）。
    # 半音取 3：2 偏大人、4 会发尖飘，3 是甜而不飘的位置。
    "child": ("luomi", 3),
    "normal": ("luomi", 0),
}


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd, timeout=5400, label="", log_file=None):
    """子进程统一出口。

    注意：本机的执行环境**不允许创建管道**（CreatePipe → WinError 5 拒绝访问），
    所以一律把 stdout/stderr 重定向到文件再读回来，不要用 capture_output。
    """
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    env.setdefault("OMP_NUM_THREADS", "1")
    env.setdefault("MKL_NUM_THREADS", "1")
    env.setdefault("HF_HOME", r"F:\qqbot\tmp\hf-cache")
    env.setdefault("TORCH_HOME", r"F:\qqbot\tmp\torch-home")
    if log_file is None:
        log_file = QQBOT / "tmp" / "sing-run.log"
    log_file = Path(log_file)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with open(log_file, "ab") as fh:
        fh.write(f"\n\n===== {' '.join(str(c) for c in cmd)[:600]} =====\n".encode("utf-8"))
        fh.flush()
        cp = subprocess.run([str(c) for c in cmd], env=env, stdin=subprocess.DEVNULL,
                            stdout=fh, stderr=subprocess.STDOUT, timeout=timeout)
    try:
        out = log_file.read_text(encoding="utf-8", errors="replace")
    except Exception:
        out = ""
    if label:
        log(f"  [{label}] rc={cp.returncode}")
        if cp.returncode != 0:
            log(out[-1200:])
    return cp.returncode, out


def slugify(s: str) -> str:
    s = re.sub(r"[\\/:*?\"<>|\s]+", "_", s.strip())
    return (s or "song")[:60]


PROBE_LOG = QQBOT / "tmp" / "sing-probe.log"


def probe_seconds(path: Path) -> float:
    PROBE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(PROBE_LOG, "wb") as fh:
        subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)],
                       stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT)
    text = PROBE_LOG.read_text(encoding="utf-8", errors="replace")
    for line in text.splitlines():
        if "Duration:" in line:
            hh, mm, ss = line.split("Duration:")[1].split(",")[0].strip().split(":")
            return int(hh) * 3600 + int(mm) * 60 + float(ss)
    return 0.0


def to_wav(src: Path, dst: Path, sr=44100, mono=True) -> bool:
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vn", "-ar", str(sr)]
    if mono:
        cmd += ["-ac", "1"]
    cmd += ["-c:a", "pcm_s16le", dst]
    cp = subprocess.run([str(c) for c in cmd], stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cp.returncode == 0 and dst.exists()


def trim(src: Path, dst: Path, seconds: int) -> bool:
    cp = subprocess.run([str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
                         "-i", str(src), "-t", str(seconds), "-c", "copy", str(dst)],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL)
    return cp.returncode == 0 and dst.exists()


def fetch(query: str, outdir: Path) -> tuple[Path | None, str]:
    """在线取一首歌，返回 (音频路径, 原曲链接)。"""
    if not (HERE / "fetch_song.py").exists():
        return None, ""
    rc, out = run([sys.executable, str(HERE / "fetch_song.py"),
                   "--search", query, "--out", str(outdir), "--pick", "1"],
                  timeout=600, label="fetch")
    src = None
    for name in ("song.m4a", "song.mp3", "song.wav", "song.mka"):
        p = outdir / name
        if p.exists() and p.stat().st_size > 1024:
            src = p
            break
    url = ""
    sj = outdir / "sources.json"
    if sj.exists():
        try:
            data = json.loads(sj.read_text(encoding="utf-8"))
            rec = data[0] if isinstance(data, list) and data else data
            if isinstance(rec, dict):
                srcrec = rec.get("source") if isinstance(rec.get("source"), dict) else rec
                url = (srcrec.get("url") or rec.get("url") or rec.get("shareUrl")
                       or srcrec.get("shareUrl") or "")
        except Exception:
            pass
    if not url:
        m = re.search(r"https://www\.bilibili\.com/video/BV[0-9A-Za-z]+", out)
        url = m.group(0) if m else ""
    return src, url


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", default="", help="歌名或搜索词（如 茶花开了）")
    ap.add_argument("--local", default="", help="本地音频路径，给了就不在线取歌")
    ap.add_argument("--style", default="child", choices=sorted(STYLES), help="音色风格")
    ap.add_argument("--voice", default="", help="覆盖音色：名字=pth[|index]")
    ap.add_argument("--pitch", type=int, default=None, help="覆盖半音")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--max-seconds", type=int, default=0, help="只做前 N 秒（试听/压测）")
    ap.add_argument("--skip-demucs", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    outdir = Path(args.out).resolve()
    work = outdir / "work"
    work.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    # ---- 0. 拿音频 ----
    url = ""
    if args.local:
        src = Path(args.local).resolve()
        if not src.exists():
            log(f"本地音频不存在: {src}")
            return 2
        log(f"[0/3] 用本地音频 {src.name} ({src.stat().st_size/1024:.0f}KB)")
    else:
        if not args.song:
            log("要么给 --song，要么给 --local")
            return 2
        log(f"[0/3] 在线取歌: {args.song}")
        src, url = fetch(args.song, work / "fetch")
        if not src:
            log("取歌失败（可能没登录/被限流/搜不到）")
            return 3
        log(f"  原曲: {src.name} ({src.stat().st_size/1024:.0f}KB) {url or '(无链接)'}")

    # ---- 1. 统一成 wav（顺带截断）----
    song_wav = work / "song.wav"
    if not to_wav(src, song_wav):
        log("转 wav 失败")
        return 4
    dur = probe_seconds(song_wav)
    if args.max_seconds and dur > args.max_seconds:
        cut = work / "song-cut.wav"
        if trim(song_wav, cut, args.max_seconds):
            song_wav = cut
            dur = probe_seconds(song_wav)
    log(f"  时长 {dur:.1f}s")

    # ---- 2. 音色 ----
    style_voice, style_shift = STYLES[args.style]
    if args.voice:
        name, rest = args.voice.split("=", 1)
        model, _, index = rest.partition("|")
        pitch = args.pitch if args.pitch is not None else 0
    else:
        model, index, base = VOICES[style_voice]
        pitch = args.pitch if args.pitch is not None else base + style_shift
        name = style_voice

    if args.dry_run:
        log(json.dumps({"ok": True, "dryRun": True, "song": args.song or str(args.local),
                        "voice": name, "pitch": pitch, "seconds": round(dur, 1),
                        "url": url}, ensure_ascii=False))
        return 0

    # ---- 3. 跑流水线 ----
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    cmd = [str(VENV_PY), str(HERE / "demo_pipeline.py"),
           "--song", str(song_wav),
           "--voice", f"{name}={model}" + (f"|{index}" if index else ""),
           "--pitch", f"{name}={pitch}",
           "--out-prefix", str(work / "cover"),
           "--workdir", str(work)]
    # 2026-11-09 五调：童真不再用固定半音。同一首歌原唱可能是童声（本来就高），
    # 再叠 +3 就尖得没法听——改成让 demo_pipeline 按原曲人声中位基频自动算，
    # 目标 380Hz（童声区），夹在 [-2, +4]，宁可不那么童也别尖。
    if args.style == "child" and args.pitch is None:
        cmd += ["--auto-pitch", "380", "--auto-lo", "-2", "--auto-hi", "4"]
    if args.skip_demucs:
        cmd.append("--skip-demucs")
    log(f"[1/3] 拆轨 + 换声（{name}，pitch={pitch:+d}）...")
    rc, out = run(cmd, label="pipeline")
    print(out, flush=True)
    made = work / f"cover-{name}.mp3"
    if rc != 0 or not made.exists():
        log(f"流水线失败，产物缺失: {made}")
        return 5

    # ---- 4. 收尾：落到 cover.mp3 ----
    final = outdir / "cover.mp3"
    shutil.copyfile(made, final)
    secs = probe_seconds(final)
    meta = {
        "ok": True,
        "song": args.song or Path(args.local).stem,
        "url": url,
        "voice": name,
        "pitch": pitch,
        "style": args.style,
        "seconds": round(secs, 2),
        "bytes": final.stat().st_size,
        "audio": str(final),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "elapsedSec": round(time.time() - t0, 1),
        "engine": "demucs+rvc",
    }
    (outdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
    log(f"[3/3] 成品 {final} ({secs:.1f}s, {meta['bytes']/1024:.0f}KB, 用时 {meta['elapsedSec']}s)")
    log(json.dumps(meta, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
