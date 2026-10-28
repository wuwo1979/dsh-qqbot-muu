#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
text_render.py — 文字动效视频逐帧渲染（给 lib/text-video.mjs 用）

为什么用 PIL 而不是 ffmpeg drawtext：
    打字机、逐行浮现、代码框、进度条这类效果用 drawtext 拼滤镜很难维护，
    而 PIL 每帧画一遍逻辑直白，720p 一帧 20~40ms，5 秒 120 帧约 4 秒。

产物：
    <outdir>/0001.png … 000N.png
    <outdir>/result.json  {"ok":true,"frames":N,"w":1280,"h":720,"fps":24,...}

风格（style）：
    typewriter 打字机（默认）      fade 整块淡入        slide 上浮
    code       代码框              kinetic 逐字弹入（字距延迟）
    pop        逐行弹出            sweep 扫色（跟读高亮）
    glitch     故障抖动（转场/反差点用）

叠加物（都可省略）：
    --char-dir  任意 RGBA 帧目录 → 右下角小吉祥物（2026-10-25 起内置角色已退役，
                仅保留通用叠加能力，帧目录由外部自备）
    --card      一张图卡（AI 分镜图）→ 到点从右侧滑入，压在文字下方

跑法（参数都能省略）：
    python text_render.py --out DIR --text "第一句" --duration 4.2 --style kinetic
"""
import argparse
import json
import math
import os
import random
import sys
import traceback

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/simhei.ttf"]
MONO_FONTS = ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"]

RESAMPLE = getattr(Image, "Resampling", Image).LANCZOS


def load_font(paths, size):
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    try:
        return ImageFont.load_default()
    except Exception:
        return None


def hex_rgb(s):
    s = str(s or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        s = "7fd7ff"
    try:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return (127, 215, 255)


def ease_out(x):
    x = max(0.0, min(1.0, x))
    return 1.0 - (1.0 - x) ** 3


def wrap(text, font, maxw, probe):
    lines = []
    for para in str(text or "").split("\n"):
        if not para.strip():
            lines.append("")
            continue
        cur = ""
        for ch in para:
            try:
                width = probe.textlength(cur + ch, font=font)
            except Exception:
                width = len(cur + ch) * 10
            if width <= maxw or not cur:
                cur += ch
            else:
                lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
    return lines


def base_background(w, h, seed, accent, bg_image):
    """背景只算一次：渐变 / 星空 / 扫描线；有背景图就用图（模糊 + 压暗）。"""
    if bg_image and os.path.isfile(bg_image):
        try:
            src = Image.open(bg_image).convert("RGB")
            sw, sh = src.size
            scale = max(w / float(sw), h / float(sh))
            nw, nh = max(w, int(sw * scale + 0.5)), max(h, int(sh * scale + 0.5))
            src = src.resize((nw, nh), RESAMPLE)
            src = src.crop(((nw - w) // 2, (nh - h) // 2, (nw - w) // 2 + w, (nh - h) // 2 + h))
            src = src.filter(ImageFilter.GaussianBlur(radius=5))
            shade = Image.new("RGB", (w, h), (7, 11, 24))
            return Image.blend(src, shade, 0.62)
        except Exception as e:
            sys.stderr.write("[text-render] bg failed: %r\n" % (e,))

    img = Image.new("RGB", (w, h), (8, 12, 26))
    d = ImageDraw.Draw(img)
    top = (8, 12, 26)
    bottom = (20, 16, 48)
    for y in range(h):
        p = y / float(max(1, h - 1))
        col = tuple(int(top[i] + (bottom[i] - top[i]) * p) for i in range(3))
        d.line([(0, y), (w, y)], fill=col)
    rng = random.Random(int(seed) or 1)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for _ in range(max(24, (w * h) // 26000)):
        x = rng.randint(0, max(0, w - 1))
        y = rng.randint(0, max(0, h - 1))
        r = rng.choice([1, 1, 1, 2])
        a = rng.randint(28, 110)
        gd.ellipse([x - r, y - r, x + r, y + r], fill=accent + (a,))
    # 水波纹：几条很淡的横向弧线
    for k in range(5):
        yy = int(h * (0.18 + 0.16 * k))
        gd.arc([-w * 0.2, yy, w * 1.2, yy + h * 0.16], 190, 350, fill=accent + (26,), width=2)
    glow = glow.filter(ImageFilter.GaussianBlur(radius=1.2))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")

    # 扫描线：压在最后，制造“屏幕/代码”质感
    scan = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scan)
    for y in range(0, h, 4):
        sd.line([(0, y), (w, y)], fill=(0, 0, 0, 16))
    return Image.alpha_composite(img.convert("RGBA"), scan).convert("RGB")


def draw_chrome(d, font_small, w, h, title, accent, prog):
    """顶栏标题 + 底部进度条（每帧都画，很便宜）。"""
    if title:
        d.rounded_rectangle([int(w * 0.06), int(h * 0.055), int(w * 0.06) + 6, int(h * 0.055) + int(h * 0.032)],
                            radius=2, fill=accent + (210,))
        d.text((int(w * 0.06) + 16, int(h * 0.053)), str(title), font=font_small, fill=(190, 206, 235, 220))
    y = int(h * 0.92)
    x0, x1 = int(w * 0.08), int(w * 0.92)
    d.line([(x0, y), (x1, y)], fill=(90, 105, 140, 90), width=2)
    d.line([(x0, y), (x0 + max(1, int((x1 - x0) * prog)), y)], fill=accent + (200,), width=3)


# ── 逐字动效（kinetic / pop / sweep / glitch）────────────────────────────
KINETIC_STYLES = ("kinetic", "pop", "sweep", "glitch")


def lerp_color(a, b, k):
    k = max(0.0, min(1.0, k))
    return tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))


def paint_kinetic(d, style, layout, font, accent, t, prog, alpha, offy, total_chars, probe):
    """逐字画。四种风格共用一套布局，只是"每个字什么时候、以什么姿态出现"不同。

    为什么逐字而不是整行：中文一行 20 字，整行淡入像是"字幕文件"，逐字出现才有
    "有人在说"的错觉。逐字延迟（stagger）就是节奏本身。
    """
    white = (238, 244, 255)
    dim = (110, 120, 140)

    if style == "sweep":
        # 跟读高亮：已经"读到"的字是白的，还没读到的暗一点，中间一条 accent 光标
        read = int(round(total_chars * max(0.0, min(1.0, prog / 0.86))))
        for line in layout:
            for (ch, x, y, gi) in line:
                col = white if gi < read else dim
                d.text((x, y + offy), ch, font=font, fill=col + (alpha,))
        # 扫过位置的竖线
        for line in layout:
            if not line:
                continue
            if read <= line[-1][3]:
                for (ch, x, y, gi) in line:
                    if gi == read:
                        d.rectangle([x, y + 2, x + max(3, int(font.size * 0.12)), y + font.size + 4],
                                    fill=accent + (220,))
                        break
                break
        return None

    if style == "glitch":
        # 故障：常规白字 + 周期性 RGB 分离的幽灵字（只抖 3~4 帧，别一直抖）
        cycle = t % 1.15
        jitter = 0
        if cycle < 0.13:
            jitter = 9.0 * math.sin(cycle * 90)
        for line in layout:
            for (ch, x, y, gi) in line:
                if jitter:
                    d.text((x - jitter, y + offy), ch, font=font, fill=accent + (150,))
                    d.text((x + jitter, y + offy), ch, font=font, fill=(255, 120, 150, 130))
                d.text((x, y + offy), ch, font=font, fill=white + (alpha,))
        return None

    if style == "pop":
        # 逐行弹出：每行延迟 0.14s，先放大一点再落位（用 y 位移代替缩放，PIL 里更快）
        per_line = 0.14
        for li, line in enumerate(layout):
            k = ease_local(max(0.0, min(1.0, (prog - li * per_line) / 0.22)))
            if k <= 0:
                continue
            dy = int((1.0 - k) * 18)
            col = lerp_color(accent, white, k)
            for (ch, x, y, gi) in line:
                d.text((x, y + offy + dy), ch, font=font, fill=col + (int(alpha * k),))
        return None

    # kinetic：逐字弹入，先 accent 后转白，带 14px 上浮
    per_char = 0.055
    for line in layout:
        for (ch, x, y, gi) in line:
            k = ease_local(max(0.0, min(1.0, (prog * 1.5 - gi * per_char) / 0.3)))
            if k <= 0:
                continue
            dy = int((1.0 - k) * 14)
            col = lerp_color(accent, white, min(1.0, k * 1.6))
            d.text((x, y + offy + dy), ch, font=font, fill=col + (int(alpha * k),))
    # 最后一个"正在写"的字后面加一条细光标
    if prog < 0.92:
        last = None
        for line in layout:
            for item in line:
                if item[3] <= int(total_chars * min(1.0, prog * 1.5)):
                    last = item
        if last:
            d.rectangle([last[1] + font.size, last[2] + offy + 4, last[1] + font.size + 6,
                         last[2] + offy + font.size], fill=accent + (200,))
    return None


# ── 《文字游戏》式字形叙事 ──────────────────────────────────────────────
# 参考 Team9 的三招，都能用 PIL 精确画出来：
#   以字代图 —— 汉字按网格堆成轮廓，字块本身就是像素
#   重新象形 —— 拆字后部件独立运动，合拢才成字
#   留白呼吸 —— 黑屏只留几个字，靠节奏而不是靠元素堆信息
# 字块用 11×11 的 Zpix 像素字体，才有"方块字"的颗粒感。

GLYPH_STYLES = ("stack", "split", "breathe")

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PIXEL_FONTS = [os.path.join(_ROOT, "assets", "fonts", "zpix.ttf")]

_GLYPH_PUNCT = "，。！？、；：…—·「」『』（）《》〈〉“”‘’ \n\r\t"


def _glyph_chars(text):
    out = [c for c in str(text) if c not in _GLYPH_PUNCT]
    return out or ["字"]


def _in_shape(kind, u, v):
    """归一化坐标 (u,v) ∈ [0,1]² 判断是否落在目标形状里。"""
    if kind == "wave":
        cy = 0.5 + 0.16 * math.sin(u * math.pi * 2 * 1.15)
        return abs(v - cy) < 0.13
    if kind == "mountain":
        ridge = 0.76 - 0.42 * abs(math.sin(u * math.pi * 1.6))
        return 0.2 < v < ridge
    if kind == "whale":                      # 呼应 DeepSeek 的蓝鲸
        body = ((u - 0.44) / 0.28) ** 2 + ((v - 0.52) / 0.19) ** 2
        if body <= 1.0:
            return True
        if 0.66 < u < 0.93:
            return abs(v - 0.5) < (u - 0.66) * 0.62
        return False
    return (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.215


def _paint_stack(overlay, text, w, h, accent, t, prog, shape, seed, safe=None):
    """以字代图：字块按网格铺满一个形状，从中心向外逐个点亮。"""
    chars = _glyph_chars(text)
    fs = max(11, int(h * 0.042))
    f = load_font(PIXEL_FONTS + FONTS, fs)
    cell = int(round(fs * 1.20))
    sl, sr = safe if safe else (0, w)
    gw, gh = int((sr - sl) * 0.92), int(h * 0.76)
    cols, rows = max(8, gw // cell), max(6, gh // cell)
    ox, oy = sl + ((sr - sl) - cols * cell) // 2, (h - rows * cell) // 2

    rnd = random.Random(int(seed or 0) * 131 + 7)
    cells = []
    for r in range(rows):
        for c in range(cols):
            u, v = (c + 0.5) / cols, (r + 0.5) / rows
            if not _in_shape(shape, u, v):
                continue
            d2 = (u - 0.5) ** 2 + (v - 0.5) ** 2
            cells.append((d2 + rnd.random() * 0.06, c, r))
    if not cells:
        return overlay
    cells.sort(key=lambda x: x[0])
    total = len(cells)

    k = min(1.0, max(0.0, prog) / 0.62)
    lit = int(round(total * ease_local(k)))
    breathe = 0.86 + 0.14 * math.sin(t * math.pi * 2 / 3.6)

    d = ImageDraw.Draw(overlay)
    for idx, (_, c, r) in enumerate(cells):
        ch = chars[idx % len(chars)]
        pos = (ox + c * cell, oy + r * cell)
        if idx < lit:
            if lit - idx <= 4:               # 刚点亮：高亮，带一点余温
                color = accent + (255,)
            else:
                color = (186, 204, 234, int(210 * breathe))
        else:                                 # 未点亮：留作底纹，不抢戏
            color = (96, 116, 150, 78)
        try:
            d.text(pos, ch, font=f, fill=color)
        except Exception:
            pass
    return overlay


def _tint(img, color):
    solid = Image.new("RGBA", img.size, color)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(solid, (0, 0), img)
    return out


def _paint_split(overlay, text, w, h, accent, t, prog, safe=None):
    """重新象形：把首字拆成两半，部件从两侧飞入、合拢成字，然后正文淡入。"""
    raw = str(text).strip()
    if not raw:
        return overlay
    head = raw[0]
    # 正文必须是完整句子：只用 raw[1:] 会读成"万米以下"，语义断了
    body = raw
    sl, sr = safe if safe else (0, w)

    fs = int(min(h * 0.40, (sr - sl) * 0.42))
    f = load_font(FONTS, fs)
    tmp = Image.new("RGBA", (fs * 2, fs * 2), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((fs * 0.35, fs * 0.32), head, font=f, fill=(255, 255, 255, 255))
    bb = tmp.getbbox()
    if not bb:
        return overlay
    glyph = tmp.crop(bb)
    gw, gh = glyph.size

    # 上下结构就上下拆，否则左右拆
    vertical = gh > gw * 1.18
    k = ease_local(min(1.0, max(0.0, prog) / 0.50))
    sep = 1.0 - k
    cx, cy = sl + (sr - sl) // 2, int(h * 0.46)

    if vertical:
        a = glyph.crop((0, 0, gw, gh // 2))
        b = glyph.crop((0, gh // 2, gw, gh))
        off = int(sep * h * 0.11)
        pa = (cx - gw // 2, cy - gh // 2 - off)
        pb = (cx - gw // 2, cy - gh // 2 + gh // 2 + off)
    else:
        a = glyph.crop((0, 0, gw // 2, gh))
        b = glyph.crop((gw // 2, 0, gw, gh))
        off = int(sep * h * 0.13)
        pa = (cx - gw // 2 - off, cy - gh // 2)
        pb = (cx - gw // 2 + gw // 2 + off, cy - gh // 2)

    # 合拢瞬间给一点亮色冲击
    hot = accent if sep < 0.06 else (208, 222, 246, 255)
    overlay.alpha_composite(_tint(a, hot[:3] + (255,)), (int(pa[0]), int(pa[1])))
    overlay.alpha_composite(_tint(b, hot[:3] + (255,)), (int(pb[0]), int(pb[1])))

    if body and prog > 0.55:
        al = int(255 * min(1.0, (prog - 0.55) / 0.25))
        f2 = load_font(FONTS, max(16, int(h * 0.046)))
        d = ImageDraw.Draw(overlay)
        try:
            blines = wrap(body, f2, sr - sl, d)
            for bi, bl in enumerate(blines):
                bw = d.textlength(bl, font=f2)
                d.text(
                    (sl + ((sr - sl) - bw) / 2, h * 0.74 + bi * int(h * 0.058)),
                    bl, font=f2, fill=(226, 234, 250, al),
                )
        except Exception:
            pass
    return overlay


def _paint_breathe(overlay, text, w, h, accent, t, prog, seed, safe=None):
    """留白呼吸：极简排版，逐字浮现，明暗与字距缓慢呼吸。"""
    # 留白的精髓是"字少、字大"：只取前 8 个字，字距拉到 1.75 倍
    chars = _glyph_chars(text)[:8]
    if not chars:
        return overlay
    sl, sr = safe if safe else (0, w)
    fs = int(h * 0.115)
    max_w = (sr - sl) * 0.96
    # 呼吸会把字距拉到 1.10 倍：必须按**峰值**算宽度，否则字距一张开整行就溢出安全区，
    # 居中后左端会跑到角色安全区外面（实测 x0 从 127 掉到 89）。
    if fs * 1.75 * 1.10 * len(chars) > max_w:
        fs = max(18, int(max_w / (len(chars) * 1.75 * 1.10)))
    f = load_font(PIXEL_FONTS + FONTS, fs)
    gap = fs * 1.75
    spread = gap * (1.0 + 0.10 * math.sin(t * math.pi * 2 / 6.5))
    total_w = spread * len(chars)
    x0 = max(sl, sl + ((sr - sl) - total_w) / 2)
    y = h * 0.44
    breath = 0.5 + 0.5 * math.sin(t * math.pi * 2 / 4.2)
    alpha = int(118 + 112 * breath)

    d = ImageDraw.Draw(overlay)
    for i, ch in enumerate(chars):
        at = 0.10 + i * (0.46 / max(1, len(chars)))
        k = min(1.0, max(0.0, (prog - at) / 0.22))
        if k <= 0:
            continue
        a = int(alpha * ease_local(k))
        d.text((x0 + i * spread, y), ch, font=f, fill=(234, 240, 255, a))
    return overlay


def _paint_glyph(overlay, style, text, w, h, accent, t, prog, shape="circle", seed=0, safe=None):
    if style == "stack":
        _paint_stack(overlay, text, w, h, accent, t, prog, shape, seed, safe)
    elif style == "split":
        _paint_split(overlay, text, w, h, accent, t, prog, safe)
    elif style == "breathe":
        _paint_breathe(overlay, text, w, h, accent, t, prog, seed, safe)
    return overlay


def ease_local(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def paste_card(frame, card, dt, w, h, accent):
    """AI 图卡：从右侧滑入，圆角 + 细边，压在文字下方不抢主体。"""
    k = ease_local(min(1.0, dt / 0.45))
    cw = int(w * 0.34)
    ch = int(cw * card.size[1] / max(1, card.size[0]))
    ch = min(ch, int(h * 0.42))
    cw = int(ch * card.size[0] / max(1, card.size[1]))
    thumb = card.resize((max(8, cw), max(8, ch)), RESAMPLE)
    # 圆角蒙版
    mask = Image.new("L", (thumb.size[0], thumb.size[1]), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, thumb.size[0] - 1, thumb.size[1] - 1], radius=16, fill=255)
    # 放右上：右下角留给鲸鱼娘，两个叠加物不能互相压
    x = int(w - cw - w * 0.06 - (1 - k) * (cw + 40))
    y = int(h * 0.10)
    layer = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    layer.paste(thumb, (x, y), mask)
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([x, y, x + cw - 1, y + ch - 1], radius=16, outline=accent + (140,), width=2)
    return Image.alpha_composite(frame, layer)


def paste_char(frame, char_img, w, h, size):
    """鲸鱼娘：右下角，按画布高度等比缩放；底部对齐，留一点呼吸位。"""
    cw = max(80, int(size))
    ch = int(cw * char_img.size[1] / max(1, char_img.size[0]))
    im = char_img.resize((cw, ch), RESAMPLE)
    x = int(w - cw - w * 0.02)
    y = int(h - ch - h * 0.02)
    layer = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    layer.paste(im, (x, y), im)
    return Image.alpha_composite(frame, layer)


def render(args):
    w = max(320, min(1920, int(args.w or 1280)))
    h = max(320, min(1920, int(args.h or 720)))
    fps = max(8, min(60, int(args.fps or 24)))
    duration = max(0.8, min(30.0, float(args.duration or 4.0)))
    style = str(args.style or "typewriter").strip().lower()
    if style not in ("typewriter", "fade", "slide", "code", "kinetic", "pop", "sweep", "glitch") + GLYPH_STYLES:
        style = "typewriter"
    accent = hex_rgb(args.accent)
    text = args.text if args.text is not None else ""
    if args.text_file and os.path.isfile(args.text_file):
        with open(args.text_file, "r", encoding="utf-8") as f:
            text = f.read()
    text = str(text).strip()
    if not text:
        raise ValueError("text 为空")

    os.makedirs(args.out, exist_ok=True)
    for name in os.listdir(args.out):
        if name.lower().endswith(".png"):
            try:
                os.remove(os.path.join(args.out, name))
            except Exception:
                pass

    big = load_font(MONO_FONTS if style == "code" else FONTS, max(18, int(h * (0.05 if style != "code" else 0.042))))
    small = load_font(FONTS, max(12, int(h * 0.024)))
    probe_img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    probe = ImageDraw.Draw(probe_img)

    # 角色站在右下角，文字必须给它让位：按角色实际左边界算安全区，
    # 否则长句右端会被角色头部压住（"把沉"被挡掉就是这个问题）。
    char_size = max(80, int(args.char_size or 300))
    char_on = bool(args.char_dir) and os.path.isdir(args.char_dir)
    if char_on:
        char_left = w - char_size - int(w * 0.02)
        safe_l = int(w * 0.085)
        safe_r = max(safe_l + int(w * 0.34), char_left - int(w * 0.030))
    else:
        safe_l, safe_r = int(w * 0.085), int(w * 0.915)
    span = max(120, safe_r - safe_l)

    maxw = int(span * (0.98 if style == "code" else 0.96))
    lines = wrap(text, big, maxw, probe)
    line_h = int(h * (0.072 if style != "code" else 0.062))
    block_h = line_h * max(1, len(lines))
    y0 = int((h - block_h) / 2) - int(h * 0.02)

    bg = base_background(w, h, args.seed, accent, args.bg)
    frames = max(1, int(round(duration * fps)))

    # 逐字布局（kinetic/pop/sweep/glitch 用）：静态文本只算一次
    layout = []
    char_offset = 0
    for li, line in enumerate(lines):
        try:
            tw_line = probe.textlength(line, font=big)
        except Exception:
            tw_line = len(line) * h * 0.05
        x0 = safe_l if style == "code" else safe_l + int((span - tw_line) / 2)
        chars = []
        for ci, ch in enumerate(line):
            try:
                cx = x0 + probe.textlength(line[:ci], font=big)
            except Exception:
                cx = x0 + ci * int(h * 0.05)
            chars.append((ch, int(cx), y0 + li * line_h, char_offset + ci))
        layout.append(chars)
        char_offset += len(line)

    card = None
    card_at = 0.0
    if args.card and os.path.isfile(args.card):
        try:
            card = Image.open(args.card).convert("RGB")
        except Exception as e:
            sys.stderr.write("[text-render] card failed: %r\n" % (e,))
    try:
        card_at = max(0.0, float(args.card_at or 0.0))
    except Exception:
        card_at = 0.0

    char_frames = []
    char_fps = fps
    if args.char_dir and os.path.isdir(args.char_dir):
        names = sorted([f for f in os.listdir(args.char_dir) if f.lower().endswith(".png")])
        for n in names:
            try:
                char_frames.append(Image.open(os.path.join(args.char_dir, n)).convert("RGBA"))
            except Exception:
                pass
        rj = os.path.join(args.char_dir, "result.json")
        if os.path.isfile(rj):
            try:
                with open(rj, "r", encoding="utf-8") as f:
                    char_fps = int(json.load(f).get("fps") or fps)
            except Exception:
                pass

    box = None
    if style == "code":
        pad = int(w * 0.05)
        box = (safe_l, y0 - pad, safe_r, y0 + block_h + pad)
        lines = (["\u276f " + lines[0]] + ["  " + x for x in lines[1:]]) if lines else ["\u276f "]
    total_chars = sum(len(x) for x in lines) or 1

    for i in range(frames):
        t = i / float(fps)
        prog = min(1.0, t / duration)
        frame = bg.copy().convert("RGBA")
        overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(overlay)

        if box:
            d.rounded_rectangle(box, radius=14, fill=(6, 10, 22, 190), outline=accent + (90,), width=2)

        alpha = 255
        offy = 0
        if style == "fade":
            alpha = int(255 * min(1.0, prog / 0.22))
            if prog > 0.86:
                alpha = int(alpha * max(0.0, (1.0 - prog) / 0.14))
        elif style == "slide":
            k = ease_out(min(1.0, prog / 0.4))
            alpha = int(255 * k)
            offy = int((1.0 - k) * h * 0.06)
            if prog > 0.88:
                alpha = int(alpha * max(0.0, (1.0 - prog) / 0.12))

        # 打字进度（typewriter / code）：0.72 时长内打完
        tp = min(1.0, prog / 0.72) if style in ("typewriter", "code") else 1.0
        reveal = int(round(total_chars * ease_out(tp))) if style in ("typewriter", "code") else total_chars

        used = 0
        cursor_pos = None
        if style in GLYPH_STYLES:
            # 《文字游戏》式：直接画整帧，不复用上面的行式 layout
            overlay = _paint_glyph(overlay, style, text, w, h, accent, t, prog,
                                   shape=str(getattr(args, 'glyph_shape', 'circle') or 'circle'),
                                   seed=args.seed, safe=(safe_l, safe_r))
        elif style in KINETIC_STYLES:
            cursor_pos = paint_kinetic(d, style, layout, font=big, accent=accent, t=t, prog=prog,
                                       alpha=alpha, offy=offy, total_chars=total_chars, probe=probe)
        else:
            for li, line in enumerate(lines):
                take = max(0, min(len(line), reveal - used))
                used += len(line)
                if take <= 0 and reveal <= 0:
                    break
                y = y0 + li * line_h + offy
                part = line[:take] if reveal < total_chars else line
                color = accent + (alpha,) if style == "code" else (238, 244, 255, alpha)
                # 逐行绘制这里必须也用安全区居中——曾经在这里又按整幅宽度算了一遍
                # （(w - 行宽)/2），把上面的安全区整个覆盖掉，长句照样压到角色身上。
                try:
                    x = safe_l if style == "code" else safe_l + int((span - probe.textlength(line, font=big)) / 2)
                    d.text((x, y), part, font=big, fill=color)
                except Exception:
                    d.text((safe_l, y), part, font=big, fill=color)
                if reveal < total_chars and used >= reveal:
                    try:
                        x = safe_l if style == "code" else safe_l + int((span - probe.textlength(line, font=big)) / 2)
                        cursor_pos = (x + int(probe.textlength(part, font=big)) + 3, y)
                    except Exception:
                        cursor_pos = (safe_l, y)
                    break

        if cursor_pos and (int(t * 3) % 2 == 0):
            fs = int(h * (0.05 if style != "code" else 0.042))
            d.rectangle([cursor_pos[0], cursor_pos[1] + 2, cursor_pos[0] + max(3, fs // 3),
                         cursor_pos[1] + fs + 2], fill=accent + (220,))

        draw_chrome(d, small, w, h, args.title, accent, prog)
        frame = Image.alpha_composite(frame, overlay)

        # ── 叠加：AI 图卡（到点滑入，压在文字下方）──
        if card and t >= card_at:
            frame = paste_card(frame, card, t - card_at, w, h, accent)

        # ── 叠加：鲸鱼娘（右下角，逐帧跟着说话/挥手）──
        if char_frames:
            # 用**全片时间**取帧：每屏都用屏内时间的话，每屏都会从角色动画的开头
            # 播起，等于每一屏都是同一个动作（实测四屏全在挥手）。
            ct = t + float(getattr(args, 'char_offset', 0.0) or 0.0)
            idx = min(len(char_frames) - 1, int(round(ct * char_fps)) % max(1, len(char_frames)))
            frame = paste_char(frame, char_frames[idx], w, h, char_size)

        frame = frame.convert("RGB")
        frame.save(os.path.join(args.out, "%04d.png" % (i + 1)), format="PNG")

    result = {
        "ok": True,
        "frames": frames,
        "w": w,
        "h": h,
        "fps": fps,
        "duration": round(duration, 2),
        "style": style,
        "lines": len(lines),
        "outdir": args.out.replace("\\", "/"),
    }
    with open(os.path.join(args.out, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--text", default="")
    ap.add_argument("--text-file", default="")
    ap.add_argument("--title", default="")
    ap.add_argument("--w", type=int, default=1280)
    ap.add_argument("--h", type=int, default=720)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--duration", type=float, default=4.0)
    ap.add_argument("--style", default="typewriter")
    ap.add_argument("--bg", default="")
    ap.add_argument("--accent", default="#7fd7ff")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--char-dir", default="", help="鲸鱼娘 RGBA 帧目录")
    ap.add_argument("--char-size", type=int, default=300)
    ap.add_argument("--card", default="", help="图卡（AI 分镜图）")
    ap.add_argument("--card-at", type=float, default=0.0, help="图卡在第几秒滑入")
    ap.add_argument("--glyph-shape", default="circle", help="stack 样式的目标形状: circle/wave/mountain/whale")
    ap.add_argument("--char-offset", type=float, default=0.0, help="该屏在全片中的起始秒（对齐角色动效时间线）")
    args = ap.parse_args()
    try:
        res = render(args)
        sys.stderr.write("[text-render] %s frames in %s\n" % (res["frames"], args.out))
    except Exception as e:
        err = str(e) + "\n" + traceback.format_exc()[-600:]
        try:
            os.makedirs(args.out, exist_ok=True)
            with open(os.path.join(args.out, "result.json"), "w", encoding="utf-8") as f:
                json.dump({"ok": False, "error": err}, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        sys.stderr.write("[text-render] failed: %r\n" % (e,))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
