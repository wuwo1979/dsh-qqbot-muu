# -*- coding: utf-8 -*-
"""2D 动画原语：纯函数，帧号唯一决定进度。

关键纪律：这里不允许出现 time.time() / datetime.now() / requestAnimationFrame 之类
真实时间来源。进度 p 只由「本屏内秒数」算出，所以同参数重渲必然逐像素一致（可并行、
可跳帧、可断点续渲）。
"""
from __future__ import annotations

import math

# ---------------- 缓动 ----------------

def _clamp01(x):
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


EASINGS = {
    "linear": lambda p: p,
    "easeOutQuad": lambda p: 1 - (1 - p) ** 2,
    "easeOutCubic": lambda p: 1 - (1 - p) ** 3,
    "easeInOutCubic": lambda p: 4 * p ** 3 if p < 0.5 else 1 - ((-2 * p + 2) ** 3) / 2,
    "easeOutExpo": lambda p: 1.0 if p >= 1 else 1 - 2 ** (-10 * p),
    "easeOutBack": lambda p: 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2,
    "easeInOutSine": lambda p: -(math.cos(math.pi * p) - 1) / 2,
}

DEFAULT_EASE = "easeOutCubic"


def ease(name):
    return EASINGS.get(name or DEFAULT_EASE, EASINGS[DEFAULT_EASE])


def progress(t, at, dur):
    """t: 本屏内秒数；at: 起始秒；dur: 时长秒。返回 0..1 的缓动前进度。"""
    at = float(at or 0.0)
    if dur is None or float(dur) <= 0:
        return 1.0 if t >= at else 0.0
    return _clamp01((t - at) / float(dur))


def local_progress(t, at, dur, name=DEFAULT_EASE):
    return ease(name)(progress(t, at, dur))


# ---------------- 状态 ----------------

class State:
    """一个可绘制目标的当前状态（每帧从动画列表重新算，绝不累积）。"""

    __slots__ = ("alpha", "dx", "dy", "scale", "reveal", "chars",
                 "value", "pulse", "visible")

    def __init__(self):
        self.alpha = 1.0
        self.dx = 0.0
        self.dy = 0.0
        self.scale = 1.0
        self.reveal = 1.0
        self.chars = None      # None = 不截断；int = 只显示前 N 个字符
        self.value = None      # count_up 的结果（模板负责格式化）
        self.pulse = 1.0
        self.visible = True

    def copy(self):
        s = State()
        s.alpha, s.dx, s.dy, s.scale = self.alpha, self.dx, self.dy, self.scale
        s.reveal, s.chars, s.value = self.reveal, self.chars, self.value
        s.pulse, s.visible = self.pulse, self.visible
        return s

    def __repr__(self):
        return (f"State(a={self.alpha:.2f} dx={self.dx:.0f} dy={self.dy:.0f} "
                f"sc={self.scale:.2f} rev={self.reveal:.2f} ch={self.chars})")


KIND_NAMES = ("fade_in", "fade_out", "slide_in", "scale_in", "typewriter",
              "wipe_in", "count_up", "pulse", "shake", "stagger_fade",
              "underline_grow")


def _dist_px(spec, preset):
    """'8%' -> 相对短边的像素；数字 -> 原样像素。"""
    if isinstance(spec, str) and spec.strip().endswith("%"):
        try:
            pct = float(spec.strip()[:-1]) / 100.0
        except ValueError:
            pct = 0.08
        return pct * min(preset["w"], preset["h"])
    return float(spec)


def apply_kind(state, anim, t, preset):
    """把单条动画作用到 state 上（就地修改）。"""
    kind = anim.get("kind")
    at = float(anim.get("at", 0.0) or 0.0)
    dur = anim.get("dur", 0.4)
    e = anim.get("ease")
    p = local_progress(t, at, dur, e)

    if kind == "fade_in":
        state.alpha *= p
    elif kind == "fade_out":
        state.alpha *= 1.0 - p
    elif kind == "slide_in":
        dist = _dist_px(anim.get("dist", "8%"), preset)
        k = 1.0 - p
        direction = anim.get("dir", "up")
        if direction == "up":
            state.dy += dist * k
        elif direction == "down":
            state.dy -= dist * k
        elif direction == "left":
            state.dx += dist * k
        elif direction == "right":
            state.dx -= dist * k
        state.alpha *= min(1.0, p * 1.6)
    elif kind == "scale_in":
        start = float(anim.get("from", 0.92))
        state.scale *= start + (1.0 - start) * p
        state.alpha *= min(1.0, p * 1.5)
    elif kind == "typewriter":
        cps = anim.get("cps")
        if cps:
            n = int(max(0.0, t - at) * float(cps))
        else:
            n = int(p * int(anim.get("_len", 999)))
        state.chars = n if state.chars is None else min(state.chars, n)
    elif kind == "wipe_in":
        state.reveal *= p
    elif kind == "count_up":
        lo = float(anim.get("from", 0.0))
        hi = float(anim.get("to", 0.0))
        state.value = lo + (hi - lo) * p
    elif kind in ("pulse", "shake"):
        amp = float(anim.get("amp", 0.03 if kind == "pulse" else 6))
        hz = float(anim.get("hz", 1.2))
        if kind == "pulse":
            state.pulse *= 1.0 + amp * math.sin(2 * math.pi * hz * (t - at))
        else:
            decay = max(0.001, float(anim.get("decay", 4)))
            env = math.exp(-decay * (t - at)) if t >= at else 0.0
            state.dx += amp * env * math.sin(2 * math.pi * hz * (t - at))
            state.dy += amp * env * math.cos(2 * math.pi * hz * 1.7 * (t - at))
    elif kind == "underline_grow":
        state.reveal *= p
    elif kind == "stagger_fade":
        pass  # 由 states_for() 按行展开，这里不动
    return state


def states_for(target, anims, t, preset, line_count=1, text_len=0):
    """算出某个目标当前该用的状态列表（长度 = 行数）。

    普通动画 -> 所有行同一状态；stagger_fade -> 每行延迟 stagger 秒。
    """
    relevant = [a for a in (anims or []) if a.get("target") == target]
    if not relevant:
        return [State() for _ in range(max(1, line_count))]

    stagger = None
    for a in relevant:
        if a.get("kind") == "stagger_fade":
            stagger = a
    if stagger is not None:
        at = float(stagger.get("at", 0.0) or 0.0)
        step = float(stagger.get("stagger", 0.25))
        dur = float(stagger.get("dur", 0.4) or 0.4)
        e = stagger.get("ease")
        out = []
        for i in range(max(1, line_count)):
            s = State()
            p = local_progress(t, at + i * step, dur, e)
            s.alpha = p
            s.dy = _dist_px(stagger.get("dist", "4%"), preset) * (1.0 - p)
            for a in relevant:
                if a is not stagger:
                    apply_kind(s, {**a, "_len": text_len}, t, preset)
            out.append(s)
        return out

    s = State()
    for a in relevant:
        apply_kind(s, {**a, "_len": text_len}, t, preset)
    return [s.copy() for _ in range(max(1, line_count))]


def snap_to_grid(value, bpm, fps):
    """把秒吸附到拍网格（有 bpm）或帧网格。卡点唯一正确做法：禁止秒数近似。"""
    if fps:
        value = round(value * fps) / float(fps)
    if bpm:
        beat = 60.0 / float(bpm)
        value = round(value / beat) * beat
    return value
