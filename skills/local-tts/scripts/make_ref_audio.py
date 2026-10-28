#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
造一段干净的参考音频给 GPT-SoVITS 做零样本克隆。
用 edge-tts（微软接口，本机实测可用）合成 —— 好处是**逐字文稿已知**，
prompt_text 能和音频完全对上，克隆质量才正常。

    python scripts/make_ref_audio.py
    python scripts/make_ref_audio.py --voice zh-CN-XiaoyiNeural --text "..." --name ref2

产物：F:\\qqbot\\.models\\tts-ref\\<name>.wav （32kHz 单声道）+ 同名 .txt（文稿）
"""
from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys

DEFAULT_TEXT = "今天的风很轻，适合说点悄悄话。你听，海边的潮水正在慢慢退下去。"
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
OUT_DIR = r"F:\qqbot\.models\tts-ref"
FFMPEG_CANDIDATES = [
    r"F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe",
]


def find_ffmpeg() -> str | None:
    try:
        import imageio_ffmpeg  # type: ignore

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:  # noqa: BLE001
        pass
    for p in FFMPEG_CANDIDATES:
        if os.path.isfile(p):
            return p
    import shutil

    return shutil.which("ffmpeg")


async def synth(text: str, voice: str, mp3_path: str) -> None:
    import edge_tts

    comm = edge_tts.Communicate(text, voice)
    await comm.save(mp3_path)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default=DEFAULT_TEXT)
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--name", default="ref_zh")
    ap.add_argument("--rate", default="-10%", help="稍微放慢，参考音频更稳")
    a = ap.parse_args(argv)

    os.makedirs(OUT_DIR, exist_ok=True)
    mp3 = os.path.join(OUT_DIR, a.name + ".mp3")
    wav = os.path.join(OUT_DIR, a.name + ".wav")
    txt = os.path.join(OUT_DIR, a.name + ".txt")

    # 文本要和最终音频逐字一致：把 --rate 拼进 SSML 不改字，只改语速
    import edge_tts

    async def run():
        comm = edge_tts.Communicate(a.text, a.voice, rate=a.rate)
        await comm.save(mp3)

    asyncio.run(run())
    print(f"mp3 {os.path.getsize(mp3)} B -> {mp3}")

    ff = find_ffmpeg()
    if not ff:
        print("没有 ffmpeg，无法转 wav", file=sys.stderr)
        return 2
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-i", mp3,
           "-ac", "1", "-ar", "32000", wav]
    r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if r.returncode != 0 or not os.path.isfile(wav):
        print(f"ffmpeg 转 wav 失败 rc={r.returncode}", file=sys.stderr)
        return 3
    with open(txt, "w", encoding="utf-8") as f:
        f.write(a.text + "\n")

    import wave

    with wave.open(wav) as w:
        secs = w.getnframes() / float(w.getframerate())
        rate = w.getframerate()
    print(f"wav {os.path.getsize(wav)} B / {secs:.2f}s / {rate}Hz -> {wav}")
    print(f"txt -> {txt}")
    print(f"prompt_text = {a.text}")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit(main())
