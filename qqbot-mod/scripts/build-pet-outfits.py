#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build-pet-outfits.py — 从既有立绘生成本地宠物皮肤资产

读 assets/pet-outfits/manifest.json，对每个 form/outfit：
  · default：原样复制（不调色）；
  · 其他：按 palette.tint + strength 做 RGB 混合，保留 alpha；
  · 输出 pose/<pose>.png + preview.png（透明底，供宠物页/形象卡使用）；
  · 最后拼一张 contact-sheet.png 作为资产清单总览。

不调模型、不联网；只处理本项目自有立绘，出处与授权写在 manifest.license。
用法：python qqbot-mod/scripts/build-pet-outfits.py [--force]
"""
import argparse
import json
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.join(ROOT, "assets", "pet-outfits")
MANIFEST = os.path.join(ASSETS, "manifest.json")
FONTS = ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"]


def load_font(size):
    for p in FONTS:
        try:
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def hex_rgb(s):
    s = str(s or "").lstrip("#")
    if len(s) != 6:
        return None
    try:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return None


def tint(img, color, strength):
    """2026-11-07 重做：保留亮部原色，只把中间调/暗部染色。
    旧版整图 blend 会把皮肤、眼睛一起糊成一片，看起来「只是加了滤镜」。
    """
    if not color or strength <= 0:
        return img.copy()
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    base = rgba.convert("RGB")
    solid = Image.new("RGB", base.size, color)
    blended = Image.blend(base, solid, max(0.0, min(1.0, strength)))
    # 亮度 >150 的部分保留原色（高光不脏），150 以下才吃染色
    lum = base.convert("L")
    hi = lum.point(lambda v: 0 if v < 150 else min(255, int((v - 150) * 255 / 105)))
    out = Image.composite(base, blended, hi)
    out = out.convert("RGBA")
    out.putalpha(alpha)
    return out


def _vgrad(size, colors):
    """三段落日式竖向渐变（背景不透明，给形象卡用）"""
    w, h = size
    stops = list(colors or [])[:3]
    while len(stops) < 3:
        stops.append(stops[-1] if stops else "#0a1420")
    rgb = [hex_rgb(c) or (8, 18, 28) for c in stops]
    img = Image.new("RGB", size)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        if t <= 0.5:
            k, a, b = t * 2, rgb[0], rgb[1]
        else:
            k, a, b = (t - 0.5) * 2, rgb[1], rgb[2]
        d.line([(0, y), (w, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3)))
    return img.convert("RGBA")


def _radial(size, center, radius, color, strength):
    """柔光层：PIL 自带的径向渐变放大，避免逐像素循环"""
    mask = Image.radial_gradient("L").resize((radius * 2, radius * 2), Image.LANCZOS)
    # strength 是 0~255 的透明度，不除以 255 会被 point() 截断成全不透明
    mask = ImageOps.invert(mask).point(lambda v: int(v * strength / 255))
    layer = Image.new("RGBA", (radius * 2, radius * 2), (color[0], color[1], color[2], 255))
    layer.putalpha(mask)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    canvas.alpha_composite(layer, (center[0] - radius, center[1] - radius))
    return canvas


def _vignette(size, strength=0.32):
    g = Image.radial_gradient("L").resize(size, Image.LANCZOS)
    layer = Image.new("RGBA", size, (0, 0, 0, 255))
    layer.putalpha(g.point(lambda v: int(v * strength)))
    return layer


def _rim(img, color, width=5, alpha=0.55):
    """轮廓光：alpha 膨胀 - 原 alpha = 边缘环，贴一圈强调色"""
    a = img.getchannel("A")
    grown = a.filter(ImageFilter.MaxFilter(width))
    ring = ImageChops.subtract(grown, a).point(lambda v: int(v * alpha))
    layer = Image.new("RGBA", img.size, (color[0], color[1], color[2], 255))
    layer.putalpha(ring)
    return Image.alpha_composite(img, layer)


def _sparkles(size, color, seed):
    """固定种子的星点/水光，低透明，只加在背景"""
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rnd = random.Random(seed)
    for _ in range(22):
        x, y = rnd.randint(24, size[0] - 24), rnd.randint(24, size[1] - 150)
        r = rnd.choice([1, 1, 2, 2, 3])
        a = rnd.randint(40, 120)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(color[0], color[1], color[2], a))
        if r == 3:
            d.line([(x - 7, y), (x + 7, y)], fill=(color[0], color[1], color[2], a // 2))
            d.line([(x, y - 7), (x, y + 7)], fill=(color[0], color[1], color[2], a // 2))
    return layer


def make_preview(img, accent, bg, seed=0):
    """640x800 形象卡：渐变夜海底 + 柔光 + 星点 + 落影 + 轮廓光 + 统一基线。"""
    W, H = 640, 800
    ar = hex_rgb(accent) or (127, 215, 255)
    canvas = _vgrad((W, H), bg)
    canvas = Image.alpha_composite(canvas, _radial((W, H), (W // 2, 300), 330, ar, 46))
    canvas = Image.alpha_composite(canvas, _sparkles((W, H), ar, seed))
    canvas = Image.alpha_composite(canvas, _vignette((W, H)))

    im = img.copy()
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    k = min(540 / max(1, im.width), 640 / max(1, im.height))
    im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    im = _rim(im, ar)

    x = (W - im.width) // 2
    y = H - 84 - im.height
    # 落影：主体下方椭圆，先高斯模糊再合成
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.ellipse([x + im.width * 0.12, y + im.height - 6, x + im.width * 0.88, y + im.height + 36],
               fill=(0, 0, 0, 130))
    sh = sh.filter(ImageFilter.GaussianBlur(16))
    canvas = Image.alpha_composite(canvas, sh)
    canvas.alpha_composite(im, (x, y))

    # 底部强调线：让四张卡一眼能区分
    d = ImageDraw.Draw(canvas)
    d.line([(W // 2 - 70, H - 22), (W // 2 + 70, H - 22)], fill=(ar[0], ar[1], ar[2], 150), width=2)
    return canvas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="已存在也重建")
    args = ap.parse_args()

    if not os.path.exists(MANIFEST):
        print("找不到 manifest: " + MANIFEST)
        return 2
    with open(MANIFEST, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    built = 0
    skipped = 0
    records = []
    for form, info in (manifest.get("forms") or {}).items():
        src_dir = os.path.join(ROOT, str(info.get("sourceDir", "")).replace("/", os.sep))
        poses = info.get("poses") or []
        pose_files = info.get("poseFiles") or {}
        for outfit in (info.get("outfits") or []):
            oid = str(outfit.get("id"))
            pal = outfit.get("palette") or {}
            accent = pal.get("accent") or "#7fd7ff"
            bg = pal.get("bg") or ["#08131f", "#103650", "#050e16"]
            color = hex_rgb(pal.get("tint"))
            strength = float(pal.get("strength") or 0)
            seed = sum(ord(c) for c in (form + oid))
            out_dir = os.path.join(ASSETS, form, oid)
            pose_dir = os.path.join(out_dir, "pose")
            os.makedirs(pose_dir, exist_ok=True)
            made = []
            for pose in poses:
                src = os.path.join(src_dir, pose_files.get(pose, pose + ".png"))
                dst = os.path.join(pose_dir, pose + ".png")
                if not os.path.exists(src):
                    continue
                if os.path.exists(dst) and not args.force:
                    skipped += 1
                    made.append(pose)
                    continue
                im = Image.open(src).convert("RGBA")
                out = tint(im, color, strength)
                out.save(dst, "PNG", optimize=True)
                made.append(pose)
                built += 1
            preview_src = poses[0] if poses else ""
            preview_path = os.path.join(out_dir, "preview.png")
            preview_file = os.path.join(src_dir, pose_files.get(preview_src, preview_src + ".png"))
            if preview_src and os.path.exists(preview_file) and (args.force or not os.path.exists(preview_path)):
                im = Image.open(preview_file).convert("RGBA")
                make_preview(tint(im, color, strength), accent, bg, seed).save(preview_path, "PNG", optimize=True)
                built += 1
            records.append({
                "form": form,
                "formName": info.get("displayName", form),
                "outfit": oid,
                "name": outfit.get("name", oid),
                "poses": made,
                "preview": "assets/pet-outfits/%s/%s/preview.png" % (form, oid),
            })
            print("  %-8s %-8s poses=%d" % (form, oid, len(made)))

    # 资产总览图：4 列
    cols = 4
    cell_w, cell_h = 300, 400
    rows = max(1, (len(records) + cols - 1) // cols)
    sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), (8, 18, 28))
    sd = ImageDraw.Draw(sheet)
    f_title = load_font(22)
    f_name = load_font(18)
    for i, rec in enumerate(records):
        x = (i % cols) * cell_w
        y = (i // cols) * cell_h
        sd.rounded_rectangle([x + 8, y + 8, x + cell_w - 8, y + cell_h - 8], radius=14,
                             fill=(13, 31, 46), outline=(60, 110, 140), width=1)
        pv = os.path.join(ROOT, rec["preview"].replace("/", os.sep))
        if os.path.exists(pv):
            im = Image.open(pv).convert("RGBA")
            k = min((cell_w - 40) / im.width, (cell_h - 92) / im.height)
            im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
            sheet.paste(im, (x + (cell_w - im.width) // 2, y + 44 + (cell_h - 92 - im.height) // 2), im)
        sd.text((x + 16, y + 14), "%s · %s" % (rec["formName"], rec["name"]), font=f_title, fill=(220, 240, 252))
        sd.text((x + 16, y + cell_h - 34), "%s/%s" % (rec["form"], rec["outfit"]), font=f_name, fill=(140, 180, 210))
    sheet_path = os.path.join(ASSETS, "contact-sheet.png")
    sheet.save(sheet_path, "PNG", optimize=True)

    report = {
        "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "built": built,
        "skipped": skipped,
        "outfits": records,
        "contactSheet": "assets/pet-outfits/contact-sheet.png",
    }
    with open(os.path.join(ASSETS, "build-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("完成：新建 %d 个文件，跳过 %d；总览 %s" % (built, skipped, sheet_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
