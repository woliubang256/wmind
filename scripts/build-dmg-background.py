#!/usr/bin/env python3
"""生成 DMG 安装窗口的背景图（backend/desktop/resources/dmg-background.png）。

DMG 窗口的观感 = 一张全幅背景图 + Finder 里摆好位置的图标。注意两点：

1. **Finder 不缩放背景图**，它按原始像素 1:1 铺（超出窗口的部分被裁掉），
   所以背景图必须与窗口**同尺寸**：660×400 pt 的窗口就是 660×400 的图。
2. 图标由 build-desktop.mjs 用 AppleScript 摆放，坐标必须与这里的箭头对齐：
     wmind.app     (200, 300) pt
     Applications  (460, 300) pt
   箭头画在两者之间，带一点向上的弧度。

用法：python3 scripts/build-dmg-background.py
依赖：Pillow
"""

from pathlib import Path

import math

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE_LOGO = ROOT / "backend" / "desktop" / "resources" / "icon.png"
OUTPUT = ROOT / "backend" / "desktop" / "resources" / "dmg-background.png"

W, H = 660, 400
APP_CENTER = (200, 300)
FOLDER_CENTER = (460, 300)

TITLE_FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
]


def load_font(candidates, size):
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    raise RuntimeError("no usable system font found")


def vertical_gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / (h - 1)
        img.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.resize((w, h))


def centered_text(draw, text, font, cx, y, fill):
    width = draw.textlength(text, font=font)
    draw.text((cx - width / 2, y), text, font=font, fill=fill)


def curved_arrow(draw, start, end, bend, color, width=9):
    """二次贝塞尔弧线 + 沿切线方向的箭头。bend 为正向上弯。"""
    (x0, y0), (x1, y1) = start, end
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2 - bend
    steps = 48
    points = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1
        y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1
        points.append((x, y))
    draw.line(points, fill=color, width=width, joint="curve")
    # 箭头方向取曲线末端切线。
    (px, py), (qx, qy) = points[-2], points[-1]
    angle = math.atan2(qy - py, qx - px)
    head, spread = 26, 0.46
    tip = (x1 + width * 0.9, y1)
    draw.polygon(
        [
            tip,
            (tip[0] - head * math.cos(angle - spread), tip[1] - head * math.sin(angle - spread)),
            (tip[0] - head * math.cos(angle + spread), tip[1] - head * math.sin(angle + spread)),
        ],
        fill=color,
    )


def main():
    title_font = load_font(TITLE_FONTS, 72)

    img = vertical_gradient((W, H), (27, 36, 55), (13, 19, 32)).convert("RGBA")

    # 品牌色光晕：让标题区域不那么"平"。
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((W // 2 - 260, -60, W // 2 + 260, 260), fill=(251, 90, 10, 36))
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    img = Image.alpha_composite(img, glow)

    draw = ImageDraw.Draw(img)

    logo = Image.open(SOURCE_LOGO).convert("RGBA")
    logo = logo.resize((120, 120), Image.LANCZOS)
    img.paste(logo, (W // 2 - 60, 34), logo)

    centered_text(draw, "wmind", title_font, W // 2, 168, (244, 247, 252))

    # 图标之间带弧度的引导箭头（起点/终点避开图标本体 64pt 半径）。
    curved_arrow(draw, (APP_CENTER[0] + 78, APP_CENTER[1] + 6), (FOLDER_CENTER[0] - 78, FOLDER_CENTER[1] - 18), 34, (139, 149, 167))

    img.convert("RGB").save(OUTPUT, optimize=True)
    print(f"written {OUTPUT} ({W}x{H})")


if __name__ == "__main__":
    main()
