# -*- coding: utf-8 -*-
"""渲染引擎：把 (scene, 本屏内秒数) 画成一帧 PIL.Image。

铁律：
* 时间只来自帧号：local_t = frame_index / fps - scene_start。
* 不读系统时钟，不用 requestAnimationFrame，不依赖上一帧（无累积状态）——所以可跳帧、
  可并行、可断点续渲，且同参数重渲逐像素一致。
* 文字用「小图层 + alpha_composite」而不是直接在底图上画半透明，避免 ImageDraw 在
  RGB/RGBA 上的混合差异。
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

import templates

FONT_CACHE = {}
BG_CACHE = {}
BUILD_CACHE = {}


def hex_to_rgb(value, default=(255, 255, 255)):
    if not value:
        return default
    v = str(value).strip()
    if v.startswith("#"):
        v = v[1:]
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6:
        return default
    try:
        return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return default


def resolve_theme(preset, override=None):
    base = dict(preset.get("theme") or {})
    base.update(override or {})
    keys = {"bg": (11, 16, 32), "fg": (255, 255, 255),
            "accent": (78, 161, 255), "muted": (169, 182, 204)}
    return {k: hex_to_rgb(base.get(k), d) for k, d in keys.items()}


class Ctx:
    """渲染上下文：字体、背景、版式缓存。一次渲染只建一次。"""

    def __init__(self, preset, theme, fps=30):
        self.preset = preset
        self.theme = theme
        self.fps = fps
        self.w = preset["w"]
        self.h = preset["h"]
        self.font_bold = preset.get("font_bold")
        self.font_regular = preset.get("font_regular")
        self._bg = None

    def font(self, size, bold):
        size = max(8, int(round(size)))
        key = (size, bool(bold))
        if key not in FONT_CACHE:
            path = self.font_bold if bold else self.font_regular
            if not path or not Path(path).is_file():
                raise SystemExit(f"找不到中文字体: {path}（改 presets/*.json 的 font_bold）")
            FONT_CACHE[key] = ImageFont.truetype(path, size)
        return FONT_CACHE[key]

    def font_for(self, size, bold):
        """给 templates.build 用的回调。"""
        return self.font(size, bold)

    def background(self):
        """一次性生成的背景：竖向渐变 + 右上角强调色辉光。缓存复用。"""
        if self._bg is not None:
            return self._bg
        key = (self.w, self.h, self.theme["bg"], self.theme["accent"])
        if key in BG_CACHE:
            self._bg = BG_CACHE[key]
            return self._bg

        bg = self.theme["bg"]
        top = tuple(min(255, int(c * 1.55) + 10) for c in bg)
        grad = Image.linear_gradient("L").resize((self.w, self.h), Image.BILINEAR)
        img = Image.composite(Image.new("RGB", (self.w, self.h), top),
                              Image.new("RGB", (self.w, self.h), bg), grad)

        # 辉光：一个真正「边缘为 0」的软斑，贴到右上角再 composite 上色。
        # 实测坑（两次）：
        #  1) 早先用「小画布椭圆 + GaussianBlur + Image.blend」——blend 会整体压暗背景；
        #  2) 换成 radial_gradient 后，radial 在自身四边并不为 0，缩放贴上后画布上
        #     留下一条硬边矩形色带（预览图能直接看出来）。
        # 所以这里在 256 小画布上按解析式算一个 |1-d/R|^2 衰减、R 留够边距，保证
        # 遮罩在画布边缘严格为 0，放大后不会有任何接缝。一次性成本 ~20ms。
        small = 256
        m_small = Image.new("L", (small, small), 0)
        px = m_small.load()
        cx_s, cy_s = small * 0.72, small * 0.30
        r_s = small * 0.40
        for yy in range(small):
            dy = (yy - cy_s) / r_s
            for xx in range(small):
                dx = (xx - cx_s) / r_s
                d = math.sqrt(dx * dx + dy * dy)
                if d < 1.0:
                    f = 1.0 - d
                    px[xx, yy] = int(255 * f * f)
        gw, gh = self.w, self.h
        m = m_small.resize((gw, gh), Image.BICUBIC).point(
            lambda v: int(v * 0.30))
        img = Image.composite(Image.new("RGB", (self.w, self.h), self.theme["accent"]),
                              img, m)
        self._bg = img.convert("RGBA")
        BG_CACHE[key] = self._bg
        return self._bg


# ---------------- 绘制原语 ----------------

def _text_budget(lines, chars):
    """按行分配 typewriter 的可见字符预算，返回新行列表。"""
    if chars is None:
        return lines
    left = max(0, int(chars))
    out = []
    for ln in lines:
        if left <= 0:
            out.append("")
            continue
        out.append(ln[:left])
        left -= len(ln)
    return out


def draw_text_block(base, ctx, item, state):
    """把一个文本块（可多行）按 state 画上去。alpha/reveal/chars/scale 全在这里生效。"""
    if not state.visible or state.alpha <= 0.002:
        return
    lines = [ln for ln in item["lines"]]
    # count_up：模板不关心数值，只把中间值塞进第一行（其余行原样保留）
    if state.value is not None and lines:
        try:
            fmt = item.get("value_fmt") or "{:.0f}"
            lines = [fmt.format(state.value)] + lines[1:]
        except Exception:
            pass
    lines = _text_budget(lines, state.chars)
    if not any(ln.strip() for ln in lines):
        return

    size = max(8.0, item["size"] * state.scale * state.pulse)
    font = ctx.font(size, item.get("bold", False))
    gap = item.get("line_gap", 1.55)
    lh = size * gap
    widths = [font.getlength(ln) for ln in lines]
    block_w = max(1.0, max(widths))
    ascent, descent = font.getmetrics()
    block_h = (len(lines) - 1) * lh + ascent + descent

    x, y = item["xy"]
    ax, ay = item.get("anchor", "lt")
    x0 = x - block_w / 2 if ax == "m" else (x - block_w if ax == "r" else x)
    y0 = y - block_h / 2 if ay == "m" else (y - block_h if ay == "b" else y)
    x0 += state.dx
    y0 += state.dy

    pad = 6
    layer = Image.new("RGBA", (int(math.ceil(block_w)) + pad * 2,
                               int(math.ceil(block_h)) + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    align = item.get("align", "left")
    for i, ln in enumerate(lines):
        if not ln:
            continue
        lx = pad
        if align == "center":
            lx = pad + (block_w - widths[i]) / 2
        elif align == "right":
            lx = pad + (block_w - widths[i])
        ly = pad + i * lh + ascent
        d.text((lx, ly), ln, font=font, fill=item["color"] + (255,), anchor="ls")

    if state.reveal < 0.999:
        w = max(1, int(layer.width * state.reveal))
        layer = layer.crop((0, 0, w, layer.height))
    if state.alpha < 0.999:
        a = layer.getchannel("A").point(lambda v: int(v * state.alpha))
        layer.putalpha(a)
    base.alpha_composite(layer, (int(round(x0 - pad)), int(round(y0 - pad))))


def draw_deco(base, ctx, deco, state):
    if not state.visible or state.alpha <= 0.002:
        return
    x, y, w, h = deco["box"]
    cx, cy = x + w / 2, y + h / 2
    if state.scale != 1.0:
        w, h = w * state.scale, h * state.scale
        x, y = cx - w / 2, cy - h / 2
    x += state.dx
    y += state.dy
    if state.reveal < 0.999:
        w = max(1.0, w * state.reveal)

    layer = Image.new("RGBA", (ctx.w, ctx.h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    color = tuple(deco["color"]) + (int(255 * state.alpha),)
    if deco["kind"] == "dot":
        r = w / 2
        d.ellipse([x, y, x + w, y + h], fill=color)
    elif deco.get("radius"):
        d.rounded_rectangle([x, y, x + w, y + h], radius=deco["radius"], fill=color)
    else:
        d.rectangle([x, y, x + w, y + h], fill=color)
    base.alpha_composite(layer)


def draw_subtitle(base, ctx, text, alpha):
    """底部字幕条：圆角半透明底 + 居中文本，自动避让安全边距。"""
    if alpha <= 0.002 or not text.strip():
        return
    preset = ctx.preset
    size = preset.get("subtitle_px", 46)
    max_w = preset["w"] - preset["safe"]["x"] * 2 - size
    lines = templates.wrap(text, ctx.font(size, False), max_w)
    lines = lines[:int(preset.get("subtitle_max_lines", 2))]
    lh = size * 1.42
    block_h = len(lines) * lh
    pad_x, pad_y = int(size * 0.72), int(size * 0.42)

    widths = [ctx.font(size, False).getlength(ln) for ln in lines]
    box_w = min(ctx.w - preset["safe"]["x"], max(widths) + pad_x * 2)
    box_h = block_h + pad_y * 2
    cx = ctx.w / 2
    cy = preset.get("subtitle_y", int(ctx.h * 0.82))
    box = [cx - box_w / 2, cy - box_h / 2, cx + box_w / 2, cy + box_h / 2]

    layer = Image.new("RGBA", (ctx.w, ctx.h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, radius=int(size * 0.34),
                        fill=(0, 0, 0, int(150 * alpha)))
    font = ctx.font(size, False)
    ascent, _ = font.getmetrics()
    for i, ln in enumerate(lines):
        w = font.getlength(ln)
        lx = cx - w / 2
        ly = box[1] + pad_y + i * lh + ascent
        d.text((lx, ly), ln, font=font, fill=ctx.theme["fg"] + (int(255 * alpha),),
               anchor="ls")
    base.alpha_composite(layer)


# ---------------- 场景 / 时间轴 ----------------

def scene_build(scene, ctx):
    key = id(scene)
    if key not in BUILD_CACHE:
        BUILD_CACHE[key] = templates.build(scene, ctx.preset, ctx.theme, ctx.font_for)
    return BUILD_CACHE[key]


def scene_anims(scene):
    anims = scene.get("anim") or []
    # 无 anim 时：默认对主文案做一次 fade_in，避免出现"第一帧就全亮"的死板观感
    if not anims and scene.get("template") != "caption":
        return [{"target": "title", "kind": "fade_in", "at": 0.05, "dur": 0.45},
                {"target": "lines", "kind": "stagger_fade", "at": 0.15,
                 "stagger": 0.22}]
    return anims


def _expand_targets(anims, items):
    """把 "lines" / "all" 这类聚合目标展开成实际块名。"""
    names = {it["target"] for it in items}
    out = []
    for a in anims:
        tgt = a.get("target", "all")
        if tgt in ("all", "*"):
            for n in sorted(names):
                out.append({**a, "target": n})
        elif tgt in ("lines", "list"):
            for n in sorted(names):
                if n.startswith("line"):
                    out.append({**a, "target": n})
        else:
            out.append(a)
    return out


def render_at(scene, local_t, ctx, subtitle=None):
    """本屏在 local_t 秒时应有的画面（RGBA）。"""
    img = ctx.background().copy()
    built = scene_build(scene, ctx)
    anims = _expand_targets(scene_anims(scene), built["items"])

    import primitives as P  # 延迟导入，避免循环

    for item in built["items"]:
        n_lines = len(item["lines"])
        states = P.states_for(item["target"], anims, local_t, ctx.preset,
                              line_count=n_lines,
                              text_len=sum(len(l) for l in item["lines"]))
        if len(states) == 1:
            draw_text_block(img, ctx, item, states[0])
        else:
            # 逐行状态（stagger）：拆成单行块分别绘制
            lh = item["size"] * item.get("line_gap", 1.55)
            for i, st in enumerate(states):
                sub = dict(item)
                sub["lines"] = [item["lines"][i]]
                sub["xy"] = (item["xy"][0],
                             item["xy"][1] + i * lh
                             if item.get("anchor", "lt")[1] == "t"
                             else item["xy"][1])
                draw_text_block(img, ctx, sub, st)
    for deco in built["decos"]:
        states = P.states_for(deco["target"], anims, local_t, ctx.preset, line_count=1)
        draw_deco(img, ctx, deco, states[0])
    for deco in built.get("decos_after", []):
        pass

    if subtitle:
        draw_subtitle(img, ctx, subtitle[0], subtitle[1])
    return img


def locate(scenes, frame_index, fps):
    """帧号 -> (scene_index, 本屏内秒数)。纯整数累加，避免浮点漂移。"""
    t = frame_index / float(fps)
    acc = 0.0
    for idx, sc in enumerate(scenes):
        dur = float(sc["dur"])
        if t < acc + dur or idx == len(scenes) - 1:
            return idx, t - acc
        acc += dur
    return len(scenes) - 1, t - acc


def scene_frame_counts(scenes, fps):
    """每屏帧数：四舍五入到整帧，并把误差补到最后，保证总帧数 = round(sum(dur)*fps)。"""
    counts = [max(1, int(round(float(sc["dur"]) * fps))) for sc in scenes]
    total_target = max(1, int(round(sum(float(sc["dur"]) for sc in scenes) * fps)))
    diff = total_target - sum(counts)
    if diff:
        counts[-1] = max(1, counts[-1] + diff)
    return counts


def scene_bounds(scene_counts):
    """返回每屏的 (start_frame, end_frame)。"""
    out, acc = [], 0
    for c in scene_counts:
        out.append((acc, acc + c))
        acc += c
    return out


def subtitle_at(subtitles, t):
    """全局时间轴字幕：返回 (text, alpha) 或 None。带 0.15s 淡入淡出。

    时间键支持 t0/t1（短）与 from/to（自然写法，JSON 里更直观）两种。
    """
    for sub in subtitles or []:
        t0 = float(sub.get("t0", sub.get("from", 0.0)))
        t1 = float(sub.get("t1", sub.get("to", 0.0)))
        if t0 <= t <= t1:
            fade = min(0.15, max(0.05, (t1 - t0) / 6.0))
            a = 1.0
            if t - t0 < fade:
                a = (t - t0) / fade
            elif t1 - t < fade:
                a = (t1 - t) / fade
            return sub.get("text", ""), max(0.0, min(1.0, a))
    return None


# ---------------- 代价预估（dry-run 用） ----------------

FRAME_COST_MS = {"title": 24.0, "bullet": 24.0, "quote": 30.0,
                 "bignum": 26.0, "caption": 20.0}


def estimate(scenes, fps):
    """返回 (总帧数, 预估渲染秒, 预估编码秒, 预估 PNG 字节, 档位)。"""
    counts = scene_frame_counts(scenes, fps)
    total = sum(counts)
    render_ms = 0.0
    for sc, n in zip(scenes, counts):
        w = FRAME_COST_MS.get(sc.get("template", "title"), 24.0)
        anims = sc.get("anim") or []
        if any(a.get("kind") in ("shake", "pulse", "wipe_in") for a in anims):
            w *= 1.25
        render_ms += w * n
    px = total * 54000  # 实测 1080x1920 轻负载约 54 KB/帧
    level = "light" if render_ms / total < 60 else "heavy"
    return total, render_ms / 1000.0, total * 0.0045, px, level
