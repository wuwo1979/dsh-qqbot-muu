# -*- coding: utf-8 -*-
"""narrate_footage.py —— 给录好的游戏/实拍视频配解说并发成片。

输入：
    --footage gameplay.mp4            录像素材（record_screen.py 产物或任何视频）
    --narration narration.txt         解说稿：空行分段，一段 = 一屏解说
    --voice xiaolan                   音色（profiles.json 里的键）
输出：
    <footage名>-narrated.mp4          配音+字幕烧录后的成片（B 站竖屏/横屏都行）

做法（全 ffmpeg + 本地 TTS 适配层，零云端）：
  1. 每段解说调 http://127.0.0.1:9881/v1/audio/speech（TTS 管家，后端没起会现场拉起）
  2. 按段把录屏均分成 N 段（或按 --cut 均分），逐段对齐音频长度：
     素材段比语音短就补最后一帧定格，长了就截断
  3. concat 全部片段 → 烧 SRT 字幕 → 输出
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import find_ffmpeg  # noqa: E402

TTS_URL = "http://127.0.0.1:9881/v1/audio/speech"


def tts(text: str, voice: str, out: Path, timeout: int = 300) -> None:
    payload = json.dumps({"input": text, "voice": voice, "response_format": "mp3"}).encode("utf-8")
    req = urllib.request.Request(TTS_URL, data=payload, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    if len(data) < 500:
        raise RuntimeError(f"TTS 返回过小（{len(data)}B）：{data[:120]!r}")
    out.write_bytes(data)


def probe_dur(exe: str, media: Path) -> float:
    r = subprocess.run([exe, "-hide_banner", "-i", str(media)], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr or "")
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def audio_dur(exe: str, mp3: Path) -> float:
    return probe_dur(exe, mp3)


def srt_time(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> int:
    ap = argparse.ArgumentParser(description="录屏 + TTS 解说 → 成片")
    ap.add_argument("--footage", required=True)
    ap.add_argument("--narration", required=True, help="解说稿 txt，空行分段")
    ap.add_argument("--out", default="")
    ap.add_argument("--voice", default="xiaolan")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--crf", type=int, default=23)
    a = ap.parse_args()

    exe, _src = find_ffmpeg()   # common.find_ffmpeg 返回 (路径, 来源)
    if not exe:
        print("ERR no-ffmpeg", flush=True)
        return 2
    footage = Path(a.footage).resolve()
    if not footage.exists():
        print(f"ERR footage-not-found {footage}", flush=True)
        return 2
    segs = [s.strip().replace("\n", " ") for s in
            re.split(r"\n\s*\n", Path(a.narration).read_text(encoding="utf-8")) if s.strip()]
    if not segs:
        print("ERR narration-empty", flush=True)
        return 2

    work = Path(tempfile.mkdtemp(prefix="narr-"))
    out = Path(a.out).resolve() if a.out else footage.with_name(footage.stem + "-narrated.mp4")
    print(f"narrating {len(segs)} segments -> {out}", flush=True)

    fdur = probe_dur(exe, footage)
    if fdur <= 0:
        print("ERR footage-duration-unknown", flush=True)
        return 3
    seg_len = fdur / len(segs)

    # 1) 每段 TTS + 声音时长 → 定每屏时长（max(均分, 语音)），录屏段循环/截断对齐
    parts = []
    srt_rows = []
    cursor = 0.0
    for i, seg in enumerate(segs):
        mp3 = work / f"tts-{i:02d}.mp3"
        tts(seg, a.voice, mp3)
        ad = audio_dur(exe, mp3)
        dur = max(seg_len, ad + 0.6)          # 语音说完留 0.6s 呼吸
        clip = work / f"seg-{i:02d}.mp4"
        # 素材段：从对应位置取 seg_len；不足 dur 就定格最后一帧补齐
        start = min(i * seg_len, max(0.0, fdur - seg_len))
        subprocess.run([exe, "-y", "-hide_banner", "-loglevel", "error",
                        "-ss", f"{start:.3f}", "-t", f"{min(seg_len, fdur):.3f}", "-i", str(footage),
                        "-vf", "tpad=stop_mode=clone:stop_duration=600",
                        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(a.crf),
                        "-t", f"{dur:.3f}", str(clip)], check=False, timeout=600)
        if not clip.exists():
            print(f"ERR segment-failed {i}", flush=True)
            return 4
        wav = work / f"tts-{i:02d}.wav"
        subprocess.run([exe, "-y", "-hide_banner", "-loglevel", "error", "-i", str(mp3),
                        "-ar", "48000", "-ac", "2", str(wav)], check=False, timeout=120)
        parts.append((clip, wav))
        srt_rows.append(f"{i+1}\n{srt_time(cursor)} --> {srt_time(cursor + min(ad, dur))}\n{seg}")
        cursor += dur
    (work / "sub.srt").write_text("\n\n".join(srt_rows) + "\n", encoding="utf-8")

    # 2) concat 视频 + 顺序拼音频 → 混流烧字幕
    lst = work / "list.txt"
    lst.write_text("".join(f"file '{p[0].as_posix()}'\n" for p in parts), encoding="utf-8")
    alst = work / "alist.txt"
    alst.write_text("".join(f"file '{p[1].as_posix()}'\n" for p in parts), encoding="utf-8")
    subprocess.run([exe, "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy",
                    str(work / "v.mp4")], check=False, timeout=600)
    subprocess.run([exe, "-y", "-hide_banner", "-loglevel", "error",
                    "-f", "concat", "-safe", "0", "-i", str(alst),
                    "-ar", "48000", "-ac", "2", str(work / "a.m4a")],
                   check=False, timeout=600)
    srt = (work / "sub.srt").as_posix().replace(":", r"\:")
    r = subprocess.run([exe, "-y", "-hide_banner", "-loglevel", "error",
                        "-i", str(work / "v.mp4"), "-i", str(work / "a.m4a"),
                        "-vf", f"subtitles='{srt}'",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", str(a.crf),
                        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
                        "-shortest", str(out)], check=False, timeout=1800)
    if r.returncode != 0 or not out.exists() or out.stat().st_size < 10000:
        print("ERR mux-failed", flush=True)
        return 5
    print(f"OK {out} {out.stat().st_size} bytes, {cursor:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
