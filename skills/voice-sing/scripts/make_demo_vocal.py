# -*- coding: utf-8 -*-
"""用 GSV（经适配层）念 8 句「啦啦」当人声轨，拼成 vocal.wav。

没有现成可拆的歌曲，就用这条真人声路线：TTS 出 6~8 句 → 拼接 → 变调排旋律 →
demucs 拆轨 → RVC 换声 → 混音。报告里要注明这是**链路验证**，不是真唱歌。
"""
import json
import sys
import urllib.request
from pathlib import Path

ADAPTER = "http://127.0.0.1:19884/v1/audio/speech"
OUT = Path(r"F:\qqbot\tmp\sing-demo2\lines")
LINES = [
    "啦，啦啦啦",
    "啊～啦啦",
    "啦啦 啦 啦",
    "嗯～啦",
    "啦啦啦啦",
    "啊 啦 啦",
    "啦～啊～",
    "啦啦 啦～",
]


def speak(text, idx):
    body = json.dumps({"model": "gsv", "input": text, "voice": "xiaolan_cute",
                       "response_format": "wav", "speed": 1.0}).encode("utf-8")
    req = urllib.request.Request(ADAPTER, data=body,
                                 headers={"Content-Type": "application/json"})
    dst = OUT / f"line{idx:02d}.wav"
    with urllib.request.urlopen(req, timeout=600) as r:
        meta = {k: v for k, v in r.headers.items() if k.lower().startswith("x-")}
        data = r.read()
    dst.write_bytes(data)
    print(f"[{idx}] {text} -> {len(data)}B  backend={meta.get('X-Backend')} "
          f"voice={meta.get('X-Voice')} speed={meta.get('X-Speed')} "
          f"pitch={meta.get('X-Pitch')} src={meta.get('X-Voice-Source')}", flush=True)
    return dst


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    files = [speak(t, i) for i, t in enumerate(LINES)]
    # 拼成一条 vocal.wav：每句之间插 0.25s 静音
    ff = r"F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
    import subprocess
    lst = OUT / "concat.txt"
    parts = []
    for f in files:
        parts.append(f"file '{f.as_posix()}'")
    lst.write_text("\n".join(parts), encoding="utf-8")
    out = OUT.parent / "vocal.wav"
    cp = subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat",
                         "-safe", "0", "-i", str(lst), "-ac", "1", "-ar", "44100",
                         "-c:a", "pcm_s16le", str(out)], capture_output=True)
    if cp.returncode != 0:
        print("concat FAIL", cp.stderr.decode("utf-8", "replace")[-500:])
        return 1
    print("vocal:", out, out.stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
