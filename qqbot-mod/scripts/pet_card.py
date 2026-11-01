#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pet_card.py — 小蓝形象卡（一张竖版 PNG，手机/电脑都能直接看）

主人 2026-10-31：「其它人（管理员或群友）也能看到小蓝的形象，在手机上或电脑上，
要轻量的那种」。不架服务、不开公网端口 —— 只生成一张 1080×1920 的图，
她用现成的 qq_send 发到群/私聊，谁点开都能看到（QQ 会自己压图）。

构成：深海蓝渐变底 + 气泡 + 立绘（assets/char/pose/*.png）+ 一句状态字 + 落款。
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"]


def load_font(paths, size):
    for p in paths:
        try:
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def gradient(w, h, top=(8, 19, 31), mid=(16, 54, 80), bottom=(5, 14, 22)):
    small = Image.new("RGB", (1, h))
    px = small.load()
    for y in range(h):
        t = y / max(1, h - 1)
        if t < 0.55:
            k = t / 0.55
            col = tuple(int(top[i] + (mid[i] - top[i]) * k) for i in range(3))
        else:
            k = (t - 0.55) / 0.45
            col = tuple(int(mid[i] + (bottom[i] - mid[i]) * k) for i in range(3))
        px[0, y] = col
    return small.resize((w, h)).convert("RGBA")


def bubbles(base, w, h, seed=7):
    """淡淡的深海气泡：只加氛围，不抢立绘"""
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rnd = seed
    for _ in range(26):
        rnd = (rnd * 1103515245 + 12345) & 0x7fffffff
        x = int((rnd >> 8) % w)
        rnd = (rnd * 1103515245 + 12345) & 0x7fffffff
        y = int((rnd >> 8) % h)
        rnd = (rnd * 1103515245 + 12345) & 0x7fffffff
        r = 6 + int((rnd >> 8) % 34)
        a = 12 + int((rnd >> 12) % 26)
        d.ellipse([x - r, y - r, x + r, y + r], outline=(150, 220, 255, a), width=2)
    return Image.alpha_composite(base, layer.filter(ImageFilter.GaussianBlur(1.2)))


def wrap(draw, text, font, maxw):
    lines, cur = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        if draw.textlength(cur + ch, font=font) <= maxw:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines[:4]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--pose", default="")
    ap.add_argument("--text", default="")
    ap.add_argument("--title", default="小蓝")
    ap.add_argument("--w", type=int, default=1080)
    ap.add_argument("--h", type=int, default=1920)
    ap.add_argument("--accent", default="#7fd7ff")
    a = ap.parse_args()

    w = max(640, min(2160, a.w))
    h = max(640, min(3840, a.h))
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    base = gradient(w, h)
    base = bubbles(base, w, h)

    # 立绘：底边贴着字幕区上沿，留出落款空间
    pose_path = a.pose
    if not pose_path:
        cand = os.path.join(root, "assets", "char", "pose", "idle.png")
        pose_path = cand if os.path.exists(cand) else ""
    char_bottom = int(h * 0.82)
    if pose_path and os.path.exists(pose_path):
        try:
            ch = Image.open(pose_path).convert("RGBA")
            maxw = int(w * 0.84)
            maxh = int(h * 0.68)
            k = min(maxw / ch.width, maxh / ch.height)
            ch = ch.resize((max(1, int(ch.width * k)), max(1, int(ch.height * k)), ), Image.LANCZOS)
            # 脚下的柔光阴影
            sh = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            sd = ImageDraw.Draw(sh)
            cx = w // 2
            rx, ry = int(ch.width * 0.42), int(h * 0.028)
            sd.ellipse([cx - rx, char_bottom - ry, cx + rx, char_bottom + ry], fill=(3, 12, 20, 150))
            sh = sh.filter(ImageFilter.GaussianBlur(18))
            base = Image.alpha_composite(base, sh)
            base.alpha_composite(ch, (cx - ch.width // 2, char_bottom - ch.height))
        except Exception as e:
            sys.stderr.write("pose-failed: %s\n" % e)

    d = ImageDraw.Draw(base)
    accent = a.accent

    # 落款
    f_small = load_font(FONTS, max(22, int(w * 0.026)))
    d.text((int(w * 0.06), int(h * 0.045)), "%s · 深海鲸鱼娘" % a.title, font=f_small, fill=(176, 205, 232, 200))

    # 状态字：半透明圆角条，最多 4 行
    text = (a.text or "").strip()
    if text:
        f_big = load_font(FONTS, max(30, int(w * 0.055)))
        probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
        lines = wrap(probe, text, f_big, int(w * 0.82))
        line_h = int(f_big.size * 1.55) if hasattr(f_big, "size") else int(w * 0.055 * 1.55)
        pad_x, pad_y = int(w * 0.05), int(w * 0.032)
        box_w = int(w * 0.9)
        box_h = line_h * len(lines) + pad_y * 2
        x0 = (w - box_w) // 2
        y0 = int(h * 0.955) - box_h
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=int(w * 0.032),
                             fill=(6, 22, 34, 190), outline=(127, 215, 255, 70), width=2)
        base = Image.alpha_composite(base, layer)
        d = ImageDraw.Draw(base)
        for i, ln in enumerate(lines):
            d.text((x0 + pad_x, y0 + pad_y + i * line_h), ln, font=f_big, fill=(233, 243, 252, 245))
        # 左侧一道强调色短线
        d.rounded_rectangle([x0 + int(w * 0.012), y0 + pad_y, x0 + int(w * 0.012) + 6, y0 + box_h - pad_y],
                            radius=3, fill=(127, 215, 255, 200))

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    base.convert("RGB").save(a.out, "PNG", optimize=True)
    with open(os.path.join(os.path.dirname(os.path.abspath(a.out)), "result.json"), "w", encoding="utf-8") as f:
        json.dump({"ok": True, "path": a.out.replace("\\", "/"), "w": w, "h": h, "text": text}, f, ensure_ascii=False)
    print("ok")


if __name__ == "__main__":
    main()
