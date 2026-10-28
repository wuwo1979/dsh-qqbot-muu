# -*- coding: utf-8 -*-
"""环境探测：一台新机器上手前先跑这个，别等渲到一半才发现没 libx264。

    python check_env.py
    python check_env.py --json

只读探测，不装任何东西、不改系统。缺什么会给出**具体的下一步命令**。
退出码：0 能出 mp4 / 3 只能出 webp-gif（降级）/ 4 什么都出不了。
"""
from __future__ import annotations

import argparse
import json
import platform
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as C


def probe_ffmpeg():
    out = {"found": False}
    exe, source = C.find_ffmpeg()
    if not exe:
        return out
    out.update({"found": True, "path": exe, "source": source})
    try:
        v = C.run([exe, "-hide_banner", "-version"], timeout=30)
        out["version"] = (v.stdout or "").splitlines()[0].strip()
    except Exception as exc:  # pragma: no cover
        out["version"] = f"<探测失败: {exc}>"
    try:
        enc = C.run([exe, "-hide_banner", "-encoders"], timeout=30)
        text = (enc.stdout or "")
        out["libx264"] = "libx264" in text
        out["aac"] = " aac " in text or "\taac " in text
    except Exception:
        out["libx264"] = False
        out["aac"] = False
    try:
        flt = C.run([exe, "-hide_banner", "-filters"], timeout=30)
        text = (flt.stdout or "")
        out["setparams"] = "setparams" in text
        out["loudnorm"] = "loudnorm" in text
    except Exception:
        out["setparams"] = out["loudnorm"] = False
    out["ffprobe"] = bool(C.find_ffprobe())
    return out


def probe_pillow():
    out = {"found": False}
    try:
        import PIL
        from PIL import Image, ImageDraw, ImageFont, ImageFilter
        out["found"] = True
        out["version"] = getattr(PIL, "__version__", "?")
        feats = []
        for fmt in ("WEBP", "GIF", "PNG"):
            try:
                Image.new("RGB", (8, 8)).save(
                    Path(C.work_dir("probe")) / f"t.{fmt.lower()}", fmt)
                feats.append(fmt)
            except Exception:
                pass
        out["formats"] = feats
        out["filters"] = [f for f in ("GaussianBlur", "BICUBIC")
                          if hasattr(ImageFilter, f) or hasattr(Image, f)]
    except Exception as exc:
        out["error"] = str(exc)
    return out


def probe_fonts():
    rows = []
    for bold in (True, False):
        p = C.find_font(bold)
        rows.append({"bold": bold, "path": p,
                     "ok": bool(p and Path(p).is_file())})
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description="video-frame-render 环境探测")
    ap.add_argument("--json", action="store_true", dest="as_json")
    a = ap.parse_args(argv)

    ff = probe_ffmpeg()
    pil = probe_pillow()
    fonts = probe_fonts()
    disk = C.free_gb(Path.cwd())
    py = platform.python_version()

    if a.as_json:
        print(json.dumps({"python": py, "ffmpeg": ff, "pillow": pil,
                          "fonts": fonts, "disk_free_gb": round(disk, 1)},
                         ensure_ascii=False, indent=2))
    else:
        print(f"python   {py}  ({sys.executable})")
        print(f"pillow   {pil.get('version') if pil['found'] else '缺失!'}"
              f"  格式={pil.get('formats')}")
        if ff["found"]:
            print(f"ffmpeg   {ff['source']} -> {ff['path']}")
            print(f"         {ff.get('version')}")
            print(f"         libx264={ff.get('libx264')} aac={ff.get('aac')} "
                  f"setparams={ff.get('setparams')} ffprobe={ff.get('ffprobe')}")
        else:
            print("ffmpeg   未找到（只能用 --format webp/gif 降级）")
        for f in fonts:
            print(f"font     bold={f['bold']} -> {f['path'] or '缺失'}")
        print(f"disk     {disk:.1f} GB 可用（1080p 3000 帧约需 0.7 GB）")

    blockers, hints = [], []
    if not pil["found"]:
        blockers.append("Pillow 缺失")
        hints.append("pip install pillow")
    if not any(f["ok"] for f in fonts):
        blockers.append("没有可用中文字体")
        hints.append("装一个 .ttc/.ttf 中文字体，或用 --font 指定")
    # 路子 C（render_art.py）需要 numpy；没有它 A/B 两条路照常能跑
    try:
        import numpy as _np  # noqa: F401
        print("numpy    -> 路子C(程序化画画) 可用")
    except Exception:
        print("numpy    -> 缺失：路子C(render_art.py) 不可用，A/B 不受影响")
        hints.append("想要路子C：pip install numpy")

    if ff["found"] and ff.get("libx264"):
        print("\n[结论] 可以出 mp4（libx264 可用）。")
        return C.EXIT_OK
    if ff["found"]:
        print("\n[结论] ffmpeg 存在但不含 libx264 —— 只能出 webp/gif。")
        hints.append("想要 mp4：pip install imageio-ffmpeg（自带完整 ffmpeg）")
        return C.EXIT_WAIT_CONFIRM
    print("\n[结论] 没有可用 ffmpeg —— 只能用 --format webp / --format gif。")
    hints.append("想要 mp4：pip install imageio-ffmpeg")
    for h in hints:
        print(f"  下一步: {h}")
    if blockers:
        for b in blockers:
            print(f"  [BLOCK] {b}")
        return C.EXIT_ENV
    return C.EXIT_WAIT_CONFIRM


if __name__ == "__main__":
    raise SystemExit(main())
