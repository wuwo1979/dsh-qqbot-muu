#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""plot.py — 没有 matplotlib 也要出图：用 Pillow 画干净的数据图。

为什么要自己画：本机 office-runtime 里没有 matplotlib（也不能装：pip 走不通），
而 Word/PPT 里要的其实是**一张 PNG**。这里只做报告真正需要的四种图：
折线（循环、CV）、柱状（倍率）、散点（EIS 的 Nyquist）、双轴折线。
风格跟 office_kit 一致：等线/宋体、蓝灰配色、2× 超采样后缩小（边缘不糊）。

用法：
  from plot import line, bars, scatter
  line({"循环": (xs, ys), "库伦效率%": (xs2, ys2)}, "循环性能", "循环序号", "比容量(mAh/g)", out="fig1.png", y2="库伦效率%")
"""
from __future__ import annotations

import math
import os
from typing import Sequence

from PIL import Image, ImageDraw, ImageFont

SCALE = 2                      # 超采样倍数
W, H = 900, 520                # 逻辑尺寸（px），×SCALE 后 1800×1040
INK = (0x1F, 0x28, 0x37)
MUTED = (0x5B, 0x64, 0x72)
GRID = (0xDC, 0xE3, 0xEA)
ACCENT = (0x0B, 0x6E, 0x99)
WARM = (0xC0, 0x62, 0x1B)
GREEN = (0x2E, 0x7D, 0x5B)
SERIES = [ACCENT, WARM, GREEN, (0x7A, 0x5A, 0xA8), (0xB0, 0x3A, 0x5B)]

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def _font(size: int) -> ImageFont.ImageFont:
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size * SCALE)
            except Exception:  # noqa: BLE001
                continue
    return ImageFont.load_default()


def _nice_ticks(lo: float, hi: float, n: int = 5) -> list[float]:
    if not (hi > lo):
        return [lo]
    raw = (hi - lo) / max(n, 2)
    mag = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1
    step = mag
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            step = m * mag
            break
    start = math.floor(lo / step) * step
    ticks = []
    v = start
    while v <= hi + step * 0.5:
        ticks.append(round(v, 10))
        v += step
    return ticks or [lo, hi]


def _fmt(v: float) -> str:
    if v == 0:
        return "0"
    a = abs(v)
    if a >= 1e5 or a < 1e-3:
        return f"{v:.1e}"
    if a >= 100:
        return f"{v:.0f}"
    if a >= 10:
        return f"{v:g}"
    return f"{v:.2f}".rstrip("0").rstrip(".")


class _Plot:
    def __init__(self, title: str, xlabel: str, ylabel: str, y2label: str = ""):
        self.im = Image.new("RGB", (W * SCALE, H * SCALE), (255, 255, 255))
        self.d = ImageDraw.Draw(self.im)
        self.title, self.xlabel, self.ylabel, self.y2label = title, xlabel, ylabel, y2label
        self.f_title, self.f_tick, self.f_label = _font(20), _font(12), _font(14)
        pad_l = 118 if y2label else 100
        self.box = (pad_l * SCALE, 62 * SCALE, (W - (78 if y2label else 34)) * SCALE, (H - 62) * SCALE)
        self.xr: list[float] = []
        self.yr: list[float] = []
        self.yr2: list[float] = []
        self.nox = False

    def scale(self) -> None:
        self.xr = _nice_ticks(min(self.xr), max(self.xr))
        self.yr = _nice_ticks(min(self.yr), max(self.yr))
        if self.yr2:
            self.yr2 = _nice_ticks(min(self.yr2), max(self.yr2))

    def px(self, x: float, y: float, second: bool = False) -> tuple[float, float]:
        l, t, r, b = self.box
        x0, x1 = self.xr[0], self.xr[-1]
        yy = self.yr2 if second else self.yr
        y0, y1 = yy[0], yy[-1]
        px = l + (x - x0) / (x1 - x0) * (r - l) if x1 != x0 else l
        py = b - (y - y0) / (y1 - y0) * (b - t) if y1 != y0 else b
        return px, py

    def axes(self) -> None:
        l, t, r, b = self.box
        for i, yv in enumerate(self.yr):
            py = b - (yv - self.yr[0]) / (self.yr[-1] - self.yr[0]) * (b - t) if self.yr[-1] != self.yr[0] else b
            self.d.line([(l, py), (r, py)], fill=GRID, width=1 * SCALE)
            self.d.text((l - 10 * SCALE, py), _fmt(yv), font=self.f_tick, fill=MUTED, anchor="rm")
        for xv in self.xr:
            px = l + (xv - self.xr[0]) / (self.xr[-1] - self.xr[0]) * (r - l) if self.xr[-1] != self.xr[0] else l
            self.d.line([(px, b), (px, b + 4 * SCALE)], fill=INK, width=1 * SCALE)
            if not self.nox:                      # 柱状图用类别标签，不再叠数字刻度
                self.d.text((px, b + 8 * SCALE), _fmt(xv), font=self.f_tick, fill=MUTED, anchor="mt")
        self.d.line([(l, b), (r, b)], fill=INK, width=2 * SCALE)
        self.d.line([(l, t), (l, b)], fill=INK, width=2 * SCALE)
        if self.yr2:
            for yv in self.yr2:
                py = b - (yv - self.yr2[0]) / (self.yr2[-1] - self.yr2[0]) * (b - t) if self.yr2[-1] != self.yr2[0] else b
                self.d.text((r + 10 * SCALE, py), _fmt(yv), font=self.f_tick, fill=WARM, anchor="lm")

    def titles(self) -> None:
        l, t, r, b = self.box
        self.d.text((W * SCALE // 2, 22 * SCALE), self.title, font=self.f_title, fill=INK, anchor="mt")
        self.d.text(((l + r) // 2, H * SCALE - 22 * SCALE), self.xlabel, font=self.f_label, fill=INK, anchor="mm")
        # y 轴标题竖排（旋转 90°），避免长标题被左边框切掉
        if self.ylabel:
            self._vtext(self.ylabel, self.f_label, INK, 8 * SCALE, (t + b) // 2, right=False)
        if self.y2label:
            self._vtext(self.y2label, self.f_label, WARM, W * SCALE - 8 * SCALE, (t + b) // 2, right=True)

    def _vtext(self, text: str, font, color, x: int, ymid: int, right: bool) -> None:
        w = int(self.d.textlength(text, font=font)) + 8 * SCALE
        h = int(font.size * 1.7)
        tmp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(tmp).text((w // 2, h // 2), text, font=font, fill=color, anchor="mm")
        tmp = tmp.rotate(90, expand=True)
        px = (x - tmp.width) if right else x
        self.im.paste(tmp, (px, ymid - tmp.height // 2), tmp)

    def legend(self, names: Sequence[str], colors: Sequence[tuple]) -> None:
        if len(names) <= 1:
            return
        x = self.box[0] + 12 * SCALE
        y = self.box[3] - (18 * len(names) + 16) * SCALE     # 放左下角：多数数据从左上爬升，这里更空
        self.d.rectangle([x - 6 * SCALE, y - 6 * SCALE, x + 210 * SCALE, y + (18 * len(names)) * SCALE],
                         fill=(255, 255, 255), outline=GRID)
        for i, (n, c) in enumerate(zip(names, colors)):
            yy = y + i * 18 * SCALE
            self.d.line([(x, yy + 6 * SCALE), (x + 18 * SCALE, yy + 6 * SCALE)], fill=c, width=3 * SCALE)
            self.d.text((x + 24 * SCALE, yy), n, font=self.f_tick, fill=INK)

    def save(self, out: str) -> str:
        self.titles()
        self.axes()
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        self.im.resize((W, H), Image.LANCZOS).save(out)
        return out


def line(series: dict[str, tuple[Sequence[float], Sequence[float]]], title: str,
         xlabel: str = "", ylabel: str = "", out: str = "fig.png",
         y2: str | None = None, markers: bool = True) -> str:
    """多序列折线；`y2` 指定的那条画在右轴（比如容量 + 库伦效率）。"""
    p = _Plot(title, xlabel, ylabel, "库伦效率(%)" if y2 else "")
    names = list(series)
    for k in names:
        xs, ys = series[k]
        if y2 and k == y2:
            p.yr2 += [float(v) for v in ys if v == v]
        else:
            p.yr += [float(v) for v in ys if v == v]
        p.xr += [float(v) for v in xs if v == v]
    p.scale()
    for i, k in enumerate(names):
        xs, ys = series[k]
        second = bool(y2 and k == y2)
        color = WARM if second else SERIES[i % len(SERIES)]
        pts = [p.px(float(x), float(y), second) for x, y in zip(xs, ys) if x == x and y == y]
        if len(pts) > 1:
            p.d.line(pts, fill=color, width=3 * SCALE, joint="curve")
        if markers and len(pts) <= 40:
            for (cx, cy) in pts:
                p.d.ellipse([cx - 3 * SCALE, cy - 3 * SCALE, cx + 3 * SCALE, cy + 3 * SCALE], fill=color)
    p.axes()
    p.legend(names, [WARM if (y2 and k == y2) else SERIES[i % len(SERIES)] for i, k in enumerate(names)])
    return p.save(out)


def bars(labels: Sequence[str], values: Sequence[float], title: str,
         xlabel: str = "", ylabel: str = "", out: str = "fig.png") -> str:
    p = _Plot(title, xlabel, ylabel)
    p.nox = True
    p.xr = [0, max(1, len(labels) - 1)]
    p.yr = [0.0] + [float(v) for v in values]
    p.scale()
    l, t, r, b = p.box
    n = max(1, len(labels))
    step = (r - l) / n
    for i, (lab, v) in enumerate(zip(labels, values)):
        cx = l + step * (i + 0.5)
        _, cy = p.px(i, float(v))
        half = step * 0.3
        p.d.rectangle([cx - half, cy, cx + half, b], fill=SERIES[i % len(SERIES)])
        p.d.text((cx, b + 8 * SCALE), str(lab), font=p.f_tick, fill=MUTED, anchor="mt")
        p.d.text((cx, cy - 6 * SCALE), _fmt(float(v)), font=p.f_tick, fill=INK, anchor="mb")
    p.axes()
    return p.save(out)


def scatter(xs: Sequence[float], ys: Sequence[float], title: str,
            xlabel: str = "", ylabel: str = "", out: str = "fig.png") -> str:
    p = _Plot(title, xlabel, ylabel)
    p.xr += [float(v) for v in xs if v == v]
    p.yr += [0.0] + [float(v) for v in ys if v == v]
    p.scale()
    pts = [p.px(float(x), float(y)) for x, y in zip(xs, ys) if x == x and y == y]
    if len(pts) > 1:
        p.d.line(pts, fill=ACCENT, width=2 * SCALE)
    for (cx, cy) in pts:
        p.d.ellipse([cx - 3 * SCALE, cy - 3 * SCALE, cx + 3 * SCALE, cy + 3 * SCALE],
                    fill=(255, 255, 255), outline=ACCENT, width=2 * SCALE)
    p.axes()
    return p.save(out)
