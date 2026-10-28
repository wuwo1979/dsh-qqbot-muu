#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdf2png.py — 把 PDF 栅格化成 PNG，并做「这页是不是空的 / 有没有跑版」的机器判断。

为什么需要它：docx/xlsx 只能导出 PDF，而 PDF 我没法直接用眼睛看。
先栅格化，再看 ink 比例、四边留白、以及把每页拼成一张 contact sheet 便于快速浏览。

用法：
  python pdf2png.py <in.pdf> [--out dir] [--dpi 110] [--sheet]
输出：每页 PNG +（--sheet 时）contact-sheet.png + 一张 JSON 报告
"""
from __future__ import annotations

import argparse
import json
import os

import fitz  # pymupdf
from PIL import Image

INK_THRESHOLD = 0.0015  # 低于这个非白像素比例 = 空白页
EDGE_BAND = 0.03        # 距边 3% 以内算「贴边」，用来发现跑出页面的内容


def ink_stats(img: Image.Image) -> dict:
    g = img.convert("L")
    w, h = g.size
    px = g.load()
    step = max(1, min(w, h) // 400)  # 抽样，别为了统计把大图逐像素跑一遍
    ink = 0
    total = 0
    edge = 0
    bw, bh = int(w * EDGE_BAND), int(h * EDGE_BAND)
    for y in range(0, h, step):
        for x in range(0, w, step):
            total += 1
            if px[x, y] < 235:
                ink += 1
                if x < bw or y < bh or x > w - bw or y > h - bh:
                    edge += 1
    return {
        "inkRatio": round(ink / max(total, 1), 5),
        "edgeInkRatio": round(edge / max(total, 1), 5),
        "blank": (ink / max(total, 1)) < INK_THRESHOLD,
    }


def contact_sheet(images: list[Image.Image], cols: int = 3, pad: int = 12) -> Image.Image:
    thumbs = []
    tw = 520
    for im in images:
        ratio = tw / im.width
        thumbs.append(im.resize((tw, max(1, int(im.height * ratio))), Image.LANCZOS))
    rows = (len(thumbs) + cols - 1) // cols
    colw = tw
    rowh = max(t.height for t in thumbs)
    sheet = Image.new("RGB", (cols * colw + pad * (cols + 1), rows * rowh + pad * (rows + 1)), (240, 242, 245))
    for i, t in enumerate(thumbs):
        r, c = divmod(i, cols)
        x = pad + c * (colw + pad)
        y = pad + r * (rowh + pad)
        sheet.paste(t, (x, y))
    return sheet


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out", default="")
    ap.add_argument("--dpi", type=int, default=110)
    ap.add_argument("--sheet", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    out_dir = a.out or (os.path.splitext(a.pdf)[0] + "-png")
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(a.pdf)
    report = {"pdf": os.path.abspath(a.pdf), "pages": doc.page_count, "dpi": a.dpi, "items": []}
    imgs: list[Image.Image] = []
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=a.dpi)
        path = os.path.join(out_dir, f"p{i + 1:02d}.png")
        pix.save(path)
        im = Image.open(path).convert("RGB")
        imgs.append(im)
        st = ink_stats(im)
        st.update({
            "page": i + 1, "png": path, "w": im.width, "h": im.height,
            "textChars": len(page.get_text().strip()),
            "images": len(page.get_images(full=True)),
        })
        report["items"].append(st)
    if a.sheet and imgs:
        sheet_path = os.path.join(out_dir, "contact-sheet.png")
        contact_sheet(imgs).save(sheet_path)
        report["contactSheet"] = sheet_path
    report["blankPages"] = [it["page"] for it in report["items"] if it["blank"]]
    report["ok"] = not report["blankPages"]
    with open(os.path.join(out_dir, "render-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: report[k] for k in ("ok", "pages", "blankPages")}, ensure_ascii=False))
    if a.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["blankPages"]:
        print("警告：空白页 ->", report["blankPages"], file=sys.stderr)


import sys  # noqa: E402  (放这里避免 argparse 报错时缺 sys)

if __name__ == "__main__":
    main()
