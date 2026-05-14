#!/usr/bin/env python3
# [PRISM] 2026-05-14 — Sprint 14-B: DMG 背景图生成脚本
# 依赖：pip install Pillow
# 用法：python3 prism-install/build-background.py

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).parent / "assets"
OUT_DIR.mkdir(exist_ok=True)

W, H = 660, 400

def build(scale: int = 1) -> Image.Image:
    w, h = W * scale, H * scale
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)

    # Dark gradient background
    for y in range(h):
        t = y / h
        r = int(10 + (18 - 10) * t)
        g = int(10 + (18 - 10) * t)
        b = int(15 + (30 - 15) * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))

    # Crystal grid decoration (top-right)
    for i in range(10):
        for j in range(7):
            x = (440 + i * 30) * scale
            y = (20 + j * 30) * scale
            s = 6 * scale
            draw.polygon(
                [(x, y - s), (x + s, y), (x, y + s), (x - s, y)],
                fill=(50, 40, 80), outline=(70, 55, 110)
            )

    # Separator
    draw.line([(330 * scale, 60 * scale), (330 * scale, 340 * scale)], fill=(35, 30, 55), width=scale)

    # Fonts
    try:
        font_big = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 52 * scale)
        font_sub = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 16 * scale)
        font_ver = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13 * scale)
    except Exception:
        font_big = ImageFont.load_default()
        font_sub = font_big
        font_ver = font_big

    # Wordmark
    tx, ty = 390 * scale, 155 * scale
    draw.text((tx, ty),      "Prism",                 fill=(220, 210, 255), font=font_big)
    draw.text((tx, ty + 60 * scale), "One gateway · All AI", fill=(130, 115, 165), font=font_sub)
    draw.text((tx, ty + 82 * scale), "v0.2.0",        fill=(80, 70, 110), font=font_ver)

    # Drag hint arrow
    ax, ay = 290 * scale, 195 * scale
    for i in range(3):
        draw.line([(ax + i * 8 * scale, ay), (ax + i * 8 * scale + 5 * scale, ay)], fill=(60, 50, 95), width=scale)
    draw.polygon([
        (ax + 32 * scale, ay - 5 * scale),
        (ax + 42 * scale, ay),
        (ax + 32 * scale, ay + 5 * scale)
    ], fill=(60, 50, 95))

    # Drag label
    draw.text((395 * scale, 340 * scale), "Drag to Applications", fill=(55, 45, 90), font=font_ver)

    # Bottom bar
    draw.line([(0, (H - 28) * scale), (w, (H - 28) * scale)], fill=(20, 16, 35), width=scale)
    draw.text((20 * scale, (H - 22) * scale),
              "Open source · AGPL-3.0  •  prism-ai.app",
              fill=(45, 38, 70), font=font_ver)

    return img


if __name__ == "__main__":
    print("Generating DMG backgrounds...")
    img1x = build(scale=1)
    img1x.save(OUT_DIR / "dmg-background.png", "PNG", optimize=True)
    print("  ✅ dmg-background.png (660×400)")

    img2x = build(scale=2)
    img2x.save(OUT_DIR / "dmg-background@2x.png", "PNG", optimize=True)
    print("  ✅ dmg-background@2x.png (1320×800)")

    print("Done.")
