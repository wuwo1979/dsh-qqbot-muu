# -*- coding: utf-8 -*-
"""render_art.py — 视频路子 C：程序化生成艺术成片（算力"画画"，2026-10-25）

纯 numpy + PIL 计算每一帧（粒子/流场/波场），不依赖出图模型、不联网，
帧交 encode.py 走同一套体检 → x264(bt709) → 数帧核对。适合氛围片头、B站封面动图、
直播间背景、情绪片段。效果风格化明显（不是写实绘画），主人也说了"不是很靠谱"——
它在这里的角色是零成本兜底的氛围路子。

用法：
    python render_art.py --spec spec.json --out out.mp4

spec.json：
{
  "preset": "vertical",          // vertical / horizontal / 或 "size":[w,h]
  "fps": 30,
  "seconds": 6,
  "style": "flowfield",          // flowfield 流场拖尾 / waves 叠浪 / orbits 星轨
  "seed": 42,
  "palette": ["#0b1020", "#6ea8ff", "#a78bfa", "#f0abfc"],
  "caption": "· ambient ·"       // 可选角标
}
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common as C
import encode as E
from PIL import Image, ImageDraw, ImageFont

STYLES = ("flowfield", "waves", "orbits")


def hex_rgb(s, fallback):
    try:
        s = str(s).lstrip("#")
        return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)
    except Exception:
        return np.array(fallback, dtype=np.float32)


class FlowField:
    """curl-noise 风格流场：粒子沿势场移动，画布缓慢衰减形成拖尾。"""

    def __init__(self, w, h, rng, palette):
        self.w, self.h = w, h
        self.rng = rng
        self.canvas = np.full((h, w, 3), palette[0], dtype=np.float32)
        n = max(300, (w * h) // 4200)
        self.px = rng.uniform(0, w, n).astype(np.float32)
        self.py = rng.uniform(0, h, n).astype(np.float32)
        self.cols = [hex_rgb(c, (110, 168, 255)) for c in palette[1:4]] or [hex_rgb("#6ea8ff", (110, 168, 255))]
        self.pc = rng.integers(0, len(self.cols), n)
        self.phase = rng.uniform(0, math.tau, 3)
        self.speed = 2.6

    def _angle(self, x, y, t):
        xs, ys = x / self.w, y / self.h
        a = (np.sin(xs * 3.1 + self.phase[0] + t * 0.35)
             + np.sin(ys * 2.7 + self.phase[1] - t * 0.27)
             + np.sin((xs + ys) * 4.3 + self.phase[2] + t * 0.2)) * 2.1
        return a

    def step(self, t):
        h, w = self.h, self.w
        self.canvas *= 0.965  # 拖尾衰减
        a = self._angle(self.px, self.py, t)
        nx = self.px + np.cos(a) * self.speed
        ny = self.py + np.sin(a) * self.speed
        xi = np.clip(nx.astype(np.int32), 0, w - 1)
        yi = np.clip(ny.astype(np.int32), 0, h - 1)
        for ci in range(len(self.cols)):
            m = self.pc == ci
            if m.any():
                self.canvas[yi[m], xi[m]] = self.cols[ci] * (0.75 + 0.25 * np.sin(t * 2 + ci))
        # 出界粒子重生
        out = (nx < 0) | (nx >= w) | (ny < 0) | (ny >= h)
        if out.any():
            self.px[out] = self.rng.uniform(0, w, int(out.sum()))
            self.py[out] = self.rng.uniform(0, h, int(out.sum()))
            self.pc[out] = self.rng.integers(0, len(self.cols), int(out.sum()))
        self.px, self.py = np.clip(nx, 0, w - 1), np.clip(ny, 0, h - 1)

    def frame(self):
        return self.canvas


class Waves:
    """多层正弦叠浪，色带缓慢流动。"""

    def __init__(self, w, h, rng, palette):
        self.w, self.h = w, h
        self.layers = []
        cols = palette[1:5] if len(palette) >= 5 else palette[1:4]
        for i, c in enumerate(cols):
            rgb = hex_rgb(c, (110, 168, 255))
            self.layers.append({
                "rgb": rgb,
                "amp": h * rng.uniform(0.05, 0.12),
                "base": h * (0.35 + 0.14 * i),
                "freq": rng.uniform(1.2, 2.8),
                "spd": rng.uniform(0.4, 1.0) * (1 if i % 2 else -1),
                "ph": rng.uniform(0, math.tau),
            })

    def frame(self, t):
        w, h = self.w, self.h
        xs = np.arange(w, dtype=np.float32)
        img = np.zeros((h, w, 3), dtype=np.float32)
        img[:, :] = 0  # 先画黑，逐层覆盖
        for L in self.layers:
            yy = (L["base"] + L["amp"] * np.sin(xs / w * math.tau * L["freq"] + L["ph"] + t * L["spd"] * math.tau)).astype(np.int32)
            mask = np.zeros((h, w), dtype=bool)
            for x in range(0, w, max(1, w // 240)):
                seg = yy[x:x + max(1, w // 240)]
                lo = int(seg.min())
                mask[lo:h, x:x + max(1, w // 240)] = True
            img[mask] = L["rgb"] * (0.55 + 0.3 * math.sin(t * 1.7 + L["ph"]))
        return img


class Orbits:
    """星轨：粒子绕若干引力点转圈，拖尾渐隐。"""

    def __init__(self, w, h, rng, palette):
        self.w, self.h = w, h
        self.rng = rng
        self.canvas = np.full((h, w, 3), palette[0], dtype=np.float32)
        self.attractors = [(rng.uniform(0.25, 0.75) * w, rng.uniform(0.25, 0.75) * h,
                            rng.uniform(60, min(w, h) * 0.35)) for _ in range(3)]
        n = 900
        self.parts = []
        cols = [hex_rgb(c, (110, 168, 255)) for c in palette[1:4]]
        for i in range(n):
            ax, ay, ar = self.attractors[i % len(self.attractors)]
            ang = rng.uniform(0, math.tau)
            r = ar * rng.uniform(0.25, 1.0)
            self.parts.append([ax + math.cos(ang) * r, ay + math.sin(ang) * r,
                               ax, ay, r, ang, cols[i % len(cols)]])
        self.canvas = np.tile(palette[0], (h, w, 1)).astype(np.float32)

    def step(self, t):
        self.canvas *= 0.955
        w, h = self.w, self.h
        for p in self.parts:
            px, py, ax, ay, r, ang, col = p
            ang += 0.05 + 0.02 * math.sin(t + r * 0.01)
            x = ax + math.cos(ang) * r + math.sin(t * 0.6) * 18
            y = ay + math.sin(ang) * r * 0.92
            xi, yi = int(np.clip(x, 0, w - 1)), int(np.clip(y, 0, h - 1))
            self.canvas[yi, xi] = col
            p[0], p[1], p[5] = x, y, ang

    def frame(self):
        return self.canvas


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=0)
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args(argv)

    spec = C.load_json(args.spec)
    preset = str(spec.get("preset") or "")
    if preset == "vertical":
        w, h = 1080, 1920
    elif preset == "horizontal":
        w, h = 1920, 1080
    else:
        size = spec.get("size") or [1280, 720]
        w, h = int(size[0]), int(size[1])
    # 性能护栏：程序化画大分辨率很吃 CPU，1080p 以上自动降采样渲染再放大
    render_scale = 1.0
    if w * h > 1280 * 720:
        render_scale = 720 / math.sqrt(w * h)
    rw, rh = max(320, int(w * render_scale)) // 2 * 2, max(180, int(h * render_scale)) // 2 * 2

    fps = int(args.fps or spec.get("fps") or 30)
    seconds = float(spec.get("seconds") or 6)
    total = max(fps, int(seconds * fps))
    style = str(spec.get("style") or "flowfield")
    if style not in STYLES:
        style = "flowfield"
    seed = int(spec.get("seed") or 42)
    rng = np.random.default_rng(seed)
    palette = spec.get("palette") or ["#0b1020", "#6ea8ff", "#a78bfa", "#f0abfc"]
    base = hex_rgb(palette[0], (11, 16, 32))
    caption = str(spec.get("caption") or "")

    eng = {"flowfield": FlowField, "waves": Waves, "orbits": Orbits}[style](rw, rh, rng, [hex_rgb(palette[0], (11, 16, 32))] + list(palette))

    work = C.work_dir("art-render")
    frames_dir = work / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for f in frames_dir.glob("*.png"):
        f.unlink()

    font = ImageFont.truetype(C.find_font(bold=False), max(18, h // 55)) if caption else None

    for i in range(total):
        t = i / fps
        if hasattr(eng, "step") and style in ("flowfield", "orbits"):
            eng.step(t)
            arr = eng.frame()
        else:
            arr = eng.frame(t)
        arr = np.clip(arr, 0, 255).astype(np.uint8)
        if render_scale != 1.0:
            img = Image.fromarray(arr).resize((w, h), Image.BILINEAR)
        else:
            img = Image.fromarray(arr)
        # 底部渐变压暗，保证字幕可读
        if caption:
            d = ImageDraw.Draw(img, "RGBA")
            grad_h = int(h * 0.16)
            overlay = Image.new("RGBA", (w, grad_h), (0, 0, 0, 0))
            od = ImageDraw.Draw(overlay)
            for gy in range(grad_h):
                od.line([(0, gy), (w, gy)], fill=(0, 0, 0, int(140 * gy / grad_h)))
            img.paste(overlay, (0, h - grad_h), overlay)
            cb = font.getbbox(caption)
            d.text(((w - (cb[2] - cb[0])) // 2, h - int(h * 0.085)), caption,
                   font=font, fill=tuple(int(x) for x in hex_rgb(palette[1], (110, 168, 255))) + (255,))
        arr = np.asarray(img)
        Image.fromarray(arr).save(frames_dir / C.frame_name(i), "PNG")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    E.encode(frames_dir, out, fps=fps, expect=total)
    info = C.media_info(str(out))
    dur = info.get("duration_sec") or (total / fps)
    print(json.dumps({
        "ok": True, "route": "art", "style": style, "seed": seed,
        "out": str(out).replace("\\", "/"), "frames": total, "fps": fps,
        "duration": round(float(dur), 2), "bytes": out.stat().st_size,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
