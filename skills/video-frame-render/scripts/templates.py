# -*- coding: utf-8 -*-
"""5 种固定版式（title / bullet / quote / bignum / caption）。

设计纪律：**版式里没有调用者可写的坐标**。所有位置、字号、行距都由 preset 推导，
调用者只能给文案和动效种类。这样模型无法把版式画歪，也无法用坐标把 token 堆上去。

build() 返回 {"items": [...], "decos": [...]}：
  items: 文本块 [{target, lines, size, xy, anchor, color, bold, line_gap, align}]
  decos: 装饰 [{target, kind, box, color, radius}]  kind ∈ rect/line/dot
"""
from __future__ import annotations

import re

_CJK = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]")
_UNIT = re.compile(r"[A-Za-z0-9_.%+\-/]+|.", re.S)


def _tokens(text):
    """切成可折行的单元：中文按字，英文/数字按词。"""
    out = []
    for chunk in _UNIT.findall(text):
        out.append(chunk)
    return out


def wrap(text, font, max_width):
    """按真实字宽折行。中文逐字，英文按词，超宽单词硬切。"""
    if not text:
        return [""]
    lines, cur = [], ""
    for tok in _tokens(text):
        if tok == "\n":
            lines.append(cur)
            cur = ""
            continue
        trial = cur + tok
        if font.getlength(trial) <= max_width or not cur:
            cur = trial
            # 单个 token 已经超宽 -> 硬切
            while font.getlength(cur) > max_width and len(cur) > 1:
                cut = len(cur) - 1
                while cut > 1 and font.getlength(cur[:cut]) > max_width:
                    cut -= 1
                lines.append(cur[:cut])
                cur = cur[cut:]
        else:
            lines.append(cur.rstrip())
            cur = tok if tok.strip() else ""
    if cur or not lines:
        lines.append(cur.rstrip())
    return [ln for ln in lines] or [""]


def text_len_block(lines):
    return sum(len(ln) for ln in lines)


# ---------------- 各版式 ----------------

def _title(scene, preset, theme, font_for):
    txt = scene.get("text", {})
    size = preset.get("title_px", 96)
    sub_size = preset.get("sub_px", 44)
    max_w = preset["w"] - preset["safe"]["x"] * 2
    items, decos = [], []

    title_lines = wrap(txt.get("title", ""), font_for(size, True), max_w)
    n = len(title_lines)
    lh = round(size * preset.get("line_gap", 1.55))
    cy = int(preset.get("title_y", preset["h"] * 0.44))
    top = cy - (n * lh) // 2
    items.append({"target": "title", "lines": title_lines, "size": size,
                  "xy": (preset["w"] // 2, top), "anchor": "mt",
                  "color": theme["fg"], "bold": True,
                  "line_gap": preset.get("line_gap", 1.55), "align": "center"})

    # 标题下的强调条
    bar_w = int(min(max_w * 0.34, size * 3.2))
    bar_y = top + n * lh + int(size * 0.34)
    decos.append({"target": "bar", "kind": "rect",
                  "box": (preset["w"] // 2 - bar_w // 2, bar_y, bar_w,
                          max(6, size // 14)),
                  "color": theme["accent"], "radius": 4})

    sub = txt.get("sub") or ""
    if sub:
        sub_lines = wrap(sub, font_for(sub_size, False), max_w)
        items.append({"target": "sub", "lines": sub_lines, "size": sub_size,
                      "xy": (preset["w"] // 2, bar_y + int(size * 0.62)),
                      "anchor": "mt", "color": theme["muted"], "bold": False,
                      "line_gap": 1.5, "align": "center"})
    return {"items": items, "decos": decos}


def _bullet(scene, preset, theme, font_for):
    txt = scene.get("text", {})
    size = preset.get("body_px", 52)
    title_size = preset.get("h2_px", 64)
    max_w = preset["w"] - preset["safe"]["x"] * 2
    left = preset["safe"]["x"]
    items, decos = [], []

    title = txt.get("title") or ""
    y = preset["safe"]["top"]
    if title:
        tl = wrap(title, font_for(title_size, True), max_w)
        items.append({"target": "title", "lines": tl, "size": title_size,
                      "xy": (left, y), "anchor": "lt", "color": theme["fg"],
                      "bold": True, "line_gap": 1.4, "align": "left"})
        y += len(tl) * round(title_size * 1.4) + int(title_size * 1.1)
        decos.append({"target": "rule", "kind": "rect",
                      "box": (left, y - int(title_size * 0.72),
                              int(title_size * 1.2), max(5, title_size // 12)),
                      "color": theme["accent"], "radius": 3})

    lines_src = txt.get("lines") or []
    lh = round(size * preset.get("line_gap", 1.55))
    indent = int(size * 1.15)
    for i, raw in enumerate(lines_src):
        wrapped = wrap(raw, font_for(size, False), max_w - indent)
        items.append({"target": f"line{i}", "lines": wrapped, "size": size,
                      "xy": (left + indent, y + i * lh), "anchor": "lt",
                      "color": theme["fg"], "bold": False,
                      "line_gap": 1.5, "align": "left"})
        dot_d = max(10, size // 6)
        decos.append({"target": f"dot{i}", "kind": "dot",
                      "box": (left + int(size * 0.1),
                              y + i * lh + int(size * 0.32), dot_d, dot_d),
                      "color": theme["accent"], "radius": 0})
    return {"items": items, "decos": decos}


def _quote(scene, preset, theme, font_for):
    txt = scene.get("text", {})
    size = preset.get("quote_px", 64)
    max_w = preset["w"] - preset["safe"]["x"] * 2 - int(size * 1.2)
    body = txt.get("quote") or txt.get("title") or ""
    lines = wrap(body, font_for(size, False), max_w)
    lh = round(size * preset.get("line_gap", 1.55))
    cy = int(preset.get("quote_y", preset["h"] * 0.46))
    top = cy - (len(lines) * lh) // 2
    left = preset["safe"]["x"] + int(size * 0.55)
    items = [{"target": "quote", "lines": lines, "size": size,
              "xy": (left, top), "anchor": "lt", "color": theme["fg"],
              "bold": False, "line_gap": preset.get("line_gap", 1.55),
              "align": "left"}]
    decos = [{"target": "qbar", "kind": "rect",
              "box": (preset["safe"]["x"], top, max(8, size // 8),
                      len(lines) * lh), "color": theme["accent"], "radius": 4}]
    by = txt.get("by")
    if by:
        items.append({"target": "by", "lines": [f"— {by}"],
                      "size": preset.get("sub_px", 44),
                      "xy": (preset["safe"]["x"], top + len(lines) * lh + int(size * 0.5)),
                      "anchor": "lt", "color": theme["muted"], "bold": False,
                      "line_gap": 1.5, "align": "left"})
    return {"items": items, "decos": decos}


def _bignum(scene, preset, theme, font_for):
    txt = scene.get("text", {})
    num = str(txt.get("num", ""))
    unit = str(txt.get("unit", "") or "")
    cap = txt.get("caption") or ""
    size = preset.get("num_px", 260)
    unit_size = preset.get("h2_px", 64)
    cap_size = preset.get("sub_px", 44)
    left = preset["safe"]["x"]
    max_w = preset["w"] - left * 2

    cy = int(preset.get("num_y", preset["h"] * 0.44))
    items = [{"target": "num", "lines": [num], "size": size,
              "xy": (preset["w"] // 2, cy), "anchor": "mt", "color": theme["accent"],
              "bold": True, "line_gap": 1.15, "align": "center"}]
    num_h = round(size * 1.15)
    if unit:
        items.append({"target": "unit", "lines": [unit], "size": unit_size,
                      "xy": (preset["w"] // 2, cy + num_h + int(unit_size * 0.2)),
                      "anchor": "mt", "color": theme["fg"], "bold": True,
                      "line_gap": 1.3, "align": "center"})
    if cap:
        cap_lines = wrap(cap, font_for(cap_size, False), max_w)
        items.append({"target": "caption", "lines": cap_lines, "size": cap_size,
                      "xy": (preset["w"] // 2, cy + num_h + int(unit_size * 1.9)),
                      "anchor": "mt", "color": theme["muted"], "bold": False,
                      "line_gap": 1.5, "align": "center"})
    decos = [{"target": "nbar", "kind": "rect",
              "box": (preset["w"] // 2 - int(size * 0.5), cy + num_h - int(size * 0.06),
                      int(size * 1.0), max(6, size // 26)),
              "color": theme["accent"], "radius": 4}]
    return {"items": items, "decos": decos}


def _caption(scene, preset, theme, font_for):
    txt = scene.get("text", {})
    size = preset.get("body_px", 52)
    max_w = preset["w"] - preset["safe"]["x"] * 2
    body = txt.get("text") or txt.get("title") or ""
    lines = wrap(body, font_for(size, False), max_w)
    lh = round(size * preset.get("line_gap", 1.55))
    cy = int(preset["h"] * 0.46)
    top = cy - (len(lines) * lh) // 2
    return {"items": [{"target": "text", "lines": lines, "size": size,
                       "xy": (preset["w"] // 2, top), "anchor": "mt",
                       "color": theme["fg"], "bold": False,
                       "line_gap": preset.get("line_gap", 1.55),
                       "align": "center"}],
            "decos": []}


TEMPLATES = {
    "title": _title,
    "bullet": _bullet,
    "quote": _quote,
    "bignum": _bignum,
    "caption": _caption,
}


def _bbox(result):
    """粗算整块内容的外接框（不依赖真实字形墨迹，够用于居中）。"""
    ys = []
    for it in result["items"]:
        n = len(it["lines"])
        lh = round(it["size"] * it.get("line_gap", 1.5))
        ys.append((it["xy"][1], it["xy"][1] + n * lh))
    for de in result["decos"]:
        x, y, w, h = de["box"]
        ys.append((y, y + h))
    if not ys:
        return None
    return min(a for a, _ in ys), max(b for _, b in ys)


def _vcenter(result, preset):
    """横屏专用：内容整体垂直居中（竖屏按 safe.top 排版更好看，不开）。"""
    box = _bbox(result)
    if not box:
        return result
    top, bottom = box
    target = preset["h"] * float(preset.get("vcenter_target", 0.45))
    dy = int(round(target - (top + bottom) / 2.0))
    if abs(dy) < 2:
        return result
    for it in result["items"]:
        it["xy"] = (it["xy"][0], it["xy"][1] + dy)
    for de in result["decos"]:
        x, y, w, h = de["box"]
        de["box"] = (x, y + dy, w, h)
    return result


def build(scene, preset, theme, font_for):
    name = scene.get("template", "title")
    if name not in TEMPLATES:
        raise SystemExit(
            f"未知 template: {name}（只能是 {'/'.join(TEMPLATES)}）")
    result = TEMPLATES[name](scene, preset, theme, font_for)
    if preset.get("vcenter"):
        result = _vcenter(result, preset)
    return result
