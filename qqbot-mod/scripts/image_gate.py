#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
image_gate.py — 出图质检（给 lib/image-gate.mjs 用）

为什么要有这一层：
    本地 SD1.5 / 免费云端出图都会稳定地吐出"能用但很垃圾"的图：
    糊（低清放大）、灰（无对比）、花（噪点）、空（大面积纯色）、重（两张几乎一样）。
    这些图直接进成片，观众第一秒就划走；而模型自己不知道。
    这里用**可量化的图像指标**当守门人：宁可回退文字动效，也不放垃圾图上片。

指标：
    lap    拉普拉斯方差（清晰度）——糊图 < 100
    cf     色彩丰富度（Hasler-Süsstrunk）——灰图 < 14
    mean   平均亮度 —— 太暗 < 28 / 太亮 > 232
    ent    灰度熵 —— 空图 < 4.0
    colors 4bit 分桶后的独特色数 —— 色块/纯色图 < 200（真实插图 300~1500）
    dh     64 位 dHash（判重复：汉明距离 <= 6 视为同一张）

产物（唯一结果通道，跟 text_render.py 一致）：
    <out>/gate.json  {"ok":true,"items":[{path, dhash, lap, cf, ...}]}

跑法：
    python image_gate.py --out gate.json --json '["a.jpg","b.jpg"]'
    python image_gate.py --out gate.json a.jpg b.jpg
"""
import argparse
import json
import math
import os
import sys
import traceback

try:
    from PIL import Image, ImageFilter, ImageStat
except Exception as e:  # pragma: no cover
    Image = None
    _import_error = repr(e)


def _gray(img):
    return img.convert("L")


def laplacian_var(img, work=512):
    """清晰度近似：先缩到 512 长边，再用 FIND_EDGES + 方差。
    直接在全尺寸上算，噪点会把糊图也顶上去（缩图相当于低通，比较公平）。"""
    g = _gray(img)
    w, h = g.size
    scale = min(1.0, float(work) / max(w, h))
    if scale < 1.0:
        g = g.resize((max(8, int(w * scale)), max(8, int(h * scale))), Image.LANCZOS)
    edges = g.filter(ImageFilter.FIND_EDGES)
    st = ImageStat.Stat(edges)
    return float(st.var[0]) if st.var else 0.0


def colorfulness(img, work=256):
    """Hasler & Süsstrunk 色彩丰富度：rg=R-G, yb=0.5(R+G)-B 的标准差与均值。"""
    im = img.convert("RGB")
    w, h = im.size
    scale = min(1.0, float(work) / max(w, h))
    if scale < 1.0:
        im = im.resize((max(8, int(w * scale)), max(8, int(h * scale))), Image.LANCZOS)
    px = list(im.getdata())
    n = float(len(px)) or 1.0
    rg = [(r - g) for (r, g, b) in px]
    yb = [(0.5 * (r + g) - b) for (r, g, b) in px]
    mrg = sum(rg) / n
    myb = sum(yb) / n
    srg = math.sqrt(max(0.0, sum((x - mrg) ** 2 for x in rg) / n))
    syb = math.sqrt(max(0.0, sum((x - myb) ** 2 for x in yb) / n))
    return float(math.sqrt(srg ** 2 + syb ** 2) + 0.3 * math.sqrt(mrg ** 2 + myb ** 2))


def gray_entropy(img, work=256):
    g = _gray(img)
    w, h = g.size
    scale = min(1.0, float(work) / max(w, h))
    if scale < 1.0:
        g = g.resize((max(8, int(w * scale)), max(8, int(h * scale))), Image.LANCZOS)
    hist = g.histogram()[:256]
    total = float(sum(hist)) or 1.0
    ent = 0.0
    for c in hist:
        if c:
            p = c / total
            ent -= p * math.log(p, 2)
    return float(ent)


def dhash(img, size=8):
    """64 位 dHash → 16 进制串；用于跨屏查重。"""
    g = _gray(img).resize((size + 1, size), Image.LANCZOS)
    px = list(g.getdata())
    bits = 0
    i = 0
    for row in range(size):
        for col in range(size):
            left = px[row * (size + 1) + col]
            right = px[row * (size + 1) + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
            i += 1
    return "%016x" % bits


def unique_colors(img, work=160, bits=4):
    """按 4bit/通道分桶后数独特色数（上限 4096）。
    注意不要用 convert("P", colors=16) —— 那会把结果直接截到 16 色，
    阈值永远命中，等于把所有图都判成"色块图"。"""
    im = img.convert("RGB")
    w, h = im.size
    scale = min(1.0, float(work) / max(w, h))
    if scale < 1.0:
        im = im.resize((max(8, int(w * scale)), max(8, int(h * scale))), Image.LANCZOS)
    shift = 8 - bits
    return len({(r >> shift, g >> shift, b >> shift) for (r, g, b) in im.getdata()})


def judge(st):
    """阈值 → 问题列表 + 0~1 分。阈值是按 '1024x576 的动漫插图' 调出来的。"""
    issues = []
    if st["lap"] < 100:
        issues.append("blur")
    if st["cf"] < 14:
        issues.append("flat")
    if st["mean"] < 28:
        issues.append("dark")
    if st["mean"] > 232:
        issues.append("blown")
    if st["ent"] < 4.0:
        issues.append("empty")
    if st["colors"] < 200:
        issues.append("posterized")

    # 加权打分：清晰度权重最高，其次色彩，再是信息量
    f_lap = min(1.0, st["lap"] / 420.0)
    f_cf = min(1.0, st["cf"] / 42.0)
    f_ent = min(1.0, st["ent"] / 7.2)
    f_col = min(1.0, st["colors"] / 3200.0)
    f_bri = 1.0 - min(1.0, abs(st["mean"] - 128) / 128.0)
    score = 0.42 * f_lap + 0.24 * f_cf + 0.16 * f_ent + 0.10 * f_col + 0.08 * f_bri
    return issues, round(float(score), 4)


def gate_one(path):
    if not os.path.isfile(path):
        return {"path": path, "ok": False, "reason": "not-found"}
    try:
        with Image.open(path) as im:
            im.load()
            info = {"w": im.size[0], "h": im.size[1]}
            st = {
                "lap": round(laplacian_var(im), 2),
                "cf": round(colorfulness(im), 2),
                "ent": round(gray_entropy(im), 3),
                "colors": unique_colors(im),
                "mean": round(sum(ImageStat.Stat(_gray(im)).mean) / max(1, len(ImageStat.Stat(_gray(im)).mean)), 2),
            }
            dh = dhash(im)
    except Exception as e:
        return {"path": path, "ok": False, "reason": "open: %r" % (e,)}
    issues, score = judge(st)
    return {
        "path": path,
        "ok": not issues,
        "score": score,
        "issues": issues,
        "dhash": dh,
        "bytes": os.path.getsize(path),
        **info,
        **st,
    }


def hamming(a, b):
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except Exception:
        return 64


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--json", default="")
    ap.add_argument("--baseline", default="", help="已有的 dhash 列表（JSON 数组），用于跨屏查重")
    ap.add_argument("--maxhamming", type=int, default=6)
    ap.add_argument("paths", nargs="*")
    a = ap.parse_args()

    paths = list(a.paths)
    if a.json:
        try:
            extra = json.loads(a.json)
            if isinstance(extra, list):
                paths.extend([str(x) for x in extra])
        except Exception:
            pass

    baseline = []
    if a.baseline and os.path.isfile(a.baseline):
        try:
            with open(a.baseline, "r", encoding="utf-8") as f:
                baseline = json.load(f) or []
        except Exception:
            baseline = []

    if Image is None:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump({"ok": False, "error": "Pillow missing: " + _import_error}, f, ensure_ascii=False)
        return 1

    items = []
    seen = list(baseline)
    for p in paths:
        r = gate_one(p)
        if r.get("dhash"):
            dup = [d for d in seen if hamming(r["dhash"], d) <= a.maxhamming]
            if dup:
                r["dupOf"] = dup[0]
                r.setdefault("issues", []).append("duplicate")
                r["ok"] = False
            seen.append(r["dhash"])
        items.append(r)

    # 最佳候选：分数高且没有硬伤优先
    ranked = sorted(items, key=lambda x: (len(x.get("issues") or []), -(x.get("score") or 0)))
    best = next((x for x in ranked if x.get("ok")), None)
    payload = {
        "ok": True,
        "items": items,
        "best": best["path"] if best else "",
        "bestScore": best["score"] if best else 0,
        "accepted": bool(best),
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        try:
            with open("gate.json", "w", encoding="utf-8") as f:
                json.dump({"ok": False, "error": str(e) + "\n" + traceback.format_exc()[-400:]}, f, ensure_ascii=False)
        except Exception:
            pass
        sys.stderr.write("[image-gate] failed: %r\n" % (e,))
        sys.exit(1)
