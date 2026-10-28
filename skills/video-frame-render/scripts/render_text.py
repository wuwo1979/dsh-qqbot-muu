# -*- coding: utf-8 -*-
"""render_text.py — 视频路子 B：文字排列组合成片（kinetic typography，2026-10-25）

不依赖 playwright/浏览器：纯 PIL 逐帧画文字动画，帧交 encode.py 走同一套
体检 → x264(bt709) → 数帧核对的编码规矩。适合金句、歌词、公告、快问快答。

用法：
    python render_text.py --script script.json --out out.mp4

script.json：
{
  "preset": "vertical",              // vertical=1080x1920 / horizontal=1920x1080 / 或 "size":[w,h]
  "fps": 30,
  "theme": { "bg": "#0b1020", "fg": "#eaf2ff", "accent": "#6ea8ff" },
  "lines": [
    { "text": "今天也是元气满满的一天", "hold": 1.6, "effect": "typewriter" },
    { "text": "所以！", "hold": 0.8,  "effect": "pop" },
    { "text": "把想做的事都做完",      "hold": 1.6, "effect": "slide" },
    { "text": "晚安~",                 "hold": 1.2, "effect": "wave" }
  ],
  "caption": "· 小蓝出品 ·"           // 可选，常驻底部小字
}

效果（可全局 effect 或逐行覆盖）：
  typewriter 打字机 / pop 逐字弹出 / slide 整行滑入 / wave 逐字波浪 / fade 淡入
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as C
import encode as E
from PIL import Image, ImageDraw, ImageFont

EFFECTS = ("typewriter", "pop", "slide", "wave", "fade")


def hex_rgb(s, fallback=(11, 16, 32)):
    try:
        s = str(s).lstrip("#")
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return fallback


def fit_font(font_path, text, max_w, max_h, start=96):
    """从 start 号往下试，直到整行塞进 max_w。"""
    size = start
    while size > 12:
        f = ImageFont.truetype(font_path, size)
        box = f.getbbox(text)
        if box[2] - box[0] <= max_w and box[3] - box[1] <= max_h:
            return f
        size -= 4
    return ImageFont.truetype(font_path, 12)


def draw_text_img(font, text, fg, accent, w, h, progress, effect):
    """把一行文字画到透明层上，返回 (img, offset_y)。progress: 0~1 出场进度。"""
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    box = font.getbbox(text)
    tw, th = box[2] - box[0], box[3] - box[1]
    x0, y0 = (w - tw) // 2, (h - th) // 2
    p = max(0.0, min(1.0, progress))
    ease = 1 - (1 - p) ** 3  # easeOutCubic

    if effect in ("typewriter", "pop"):
        n = max(1, int(math.ceil(len(text) * ease)))
        shown = text[:n] if effect == "typewriter" else text
        if effect == "pop":
            # 已出的字带一点放大回弹
            pass
        d.text((x0, y0), shown, font=font, fill=fg + (255,))
        if effect == "pop" and n < len(text):
            cur = font.getbbox(text[:n + 1]) if n < len(text) else box
            cx = x0 + (cur[2] - box[0])
            d.text((cx, y0), text[n], font=font, fill=accent + (255,))
    elif effect == "slide":
        dy = int((1 - ease) * h * 0.18)
        alpha = int(255 * ease)
        d.text((x0, y0 + dy), text, font=font, fill=fg + (alpha,))
    elif effect == "wave":
        # 逐字波浪：以 ease 控制波动展开
        cx = x0
        for i, ch in enumerate(text):
            cb = font.getbbox(ch)
            cw = cb[2] - cb[0]
            t = max(0.0, min(1.0, ease * len(text) - i))
            dy = int(math.sin(t * math.pi) * 18)
            col = accent if i % 2 else fg
            d.text((cx, y0 + dy), ch, font=font, fill=col + (255,))
            cx += cw
    else:  # fade
        alpha = int(255 * ease)
        d.text((x0, y0), text, font=font, fill=fg + (alpha,))
    return layer


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=0)
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args(argv)

    spec = C.load_json(args.script)
    preset = str(spec.get("preset") or "")
    if preset == "vertical":
        w, h = 1080, 1920
    elif preset == "horizontal":
        w, h = 1920, 1080
    else:
        size = spec.get("size") or [1280, 720]
        w, h = int(size[0]), int(size[1])
    fps = int(args.fps or spec.get("fps") or 30)
    theme = spec.get("theme") or {}
    bg = hex_rgb(theme.get("bg"), (11, 16, 32))
    fg = hex_rgb(theme.get("fg"), (234, 242, 255))
    accent = hex_rgb(theme.get("accent"), (110, 168, 255))
    lines = spec.get("lines") or []
    if not lines:
        C.die("no-lines", "script.json 里没有 lines")
    caption = str(spec.get("caption") or "")

    font_path = C.find_font(bold=True)
    cap_font_path = C.find_font(bold=False)

    # 预渲染：每行 → (出场帧序列, 停留帧数)
    segments = []
    for i, ln in enumerate(lines):
        text = str(ln.get("text") or "").strip()
        if not text:
            continue
        hold = float(ln.get("hold", 1.6))
        effect = str(ln.get("effect") or spec.get("effect") or "typewriter")
        if effect not in EFFECTS:
            effect = "typewriter"
        font = fit_font(font_path, text, int(w * 0.86), int(h * 0.5))
        appear_s = min(0.9, hold * 0.5)
        appear_n = max(2, int(appear_s * fps))
        hold_n = max(3, int(hold * fps) - appear_n)
        font_box = font.getbbox(text)
        fh = font_box[3] - font_box[1]
        oy = (h - fh) // 2 - font_box[1]
        segments.append((text, effect, font, appear_n, hold_n, oy))

    cap_font = ImageFont.truetype(cap_font_path, max(18, h // 60)) if caption else None

    total = sum(a + hld for (_, _, _, a, hld, _) in segments)
    work = C.work_dir("text-render")
    frames_dir = work / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for f in frames_dir.glob("*.png"):
        f.unlink()

    idx = 0
    for (text, effect, font, appear_n, hold_n, oy) in segments:
        for k in range(appear_n):
            img = Image.new("RGB", (w, h), bg)
            layer = draw_text_img(font, text, fg, accent, w, h, (k + 1) / appear_n, effect)
            img.paste(layer, (0, 0), layer)
            if cap_font:
                d = ImageDraw.Draw(img)
                cb = cap_font.getbbox(caption)
                d.text(((w - (cb[2] - cb[0])) // 2, h - int(h * 0.07)), caption,
                       font=cap_font, fill=accent + (0,) if False else accent)
            img.save(frames_dir / C.frame_name(idx), "PNG")
            idx += 1
        for _ in range(hold_n):
            img = Image.new("RGB", (w, h), bg)
            layer = draw_text_img(font, text, fg, accent, w, h, 1.0, effect)
            img.paste(layer, (0, 0), layer)
            if cap_font:
                d = ImageDraw.Draw(img)
                cb = cap_font.getbbox(caption)
                d.text(((w - (cb[2] - cb[0])) // 2, h - int(h * 0.07)), caption, font=cap_font, fill=accent)
            img.save(frames_dir / C.frame_name(idx), "PNG")
            idx += 1

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    E.encode(frames_dir, out, fps=fps, expect=idx)
    info = C.media_info(str(out))
    dur = info.get("duration_sec") or (idx / fps)
    print(json.dumps({
        "ok": True, "route": "text", "out": str(out).replace("\\", "/"),
        "frames": idx, "fps": fps, "duration": round(float(dur), 2),
        "bytes": out.stat().st_size,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
