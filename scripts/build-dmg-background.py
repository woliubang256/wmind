#!/usr/bin/env python3
"""生成 DMG 安装窗口的背景图（1x + 2x 两份，打包时合成 HiDPI TIFF）。

布局：一行品牌文字 + 一行「应用图标 → Applications」，之间一条带弧度的箭头。
不放说明文字，也不放品牌图标——背景里的图标会和下面真正的应用图标重复。

**为什么要出两份**：Finder 的背景图不认 SVG，也不做矢量渲染；它按位图铺。
窗口是 660×400 pt，只给 1x 图的话，在 Retina 屏上会被放大一倍，文字和箭头
出现明显锯齿。做法与 create-dmg 一致：出 1x 与 2x，用
`tiffutil -cathidpicheck` 合成一个多分辨率 TIFF，Finder 自动挑清晰的那份。

坐标约定（与 build-desktop.mjs 的 AppleScript 一致）：
  wmind.app     (200, 300) pt
  Applications  (460, 300) pt

用法：python3 scripts/build-dmg-background.py
依赖：Pillow
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / "backend" / "desktop" / "resources"

W, H = 660, 400
APP_CENTER = (200, 300)
FOLDER_CENTER = (460, 300)

TITLE_FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
]


def load_font(size):
    for path in TITLE_FONTS:
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


def curved_arrow(draw, start, end, bend, color, width):
    """二次贝塞尔弧线 + 沿切线方向的箭头。bend 为正向上弯。"""
    (x0, y0), (x1, y1) = start, end
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2 - bend
    points = []
    for i in range(80):
        t = i / 79
        x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1
        y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1
        points.append((x, y))
    draw.line(points, fill=color, width=width, joint="curve")
    # 箭头：三角形沿曲线末端的切线方向探出，尖端再往前一点点，
    # 让箭头与弧线连成一个整体而不是两块拼接。
    (px, py), (qx, qy) = points[-2], points[-1]
    angle = math.atan2(qy - py, qx - px)
    head = width * 3.2
    base = (x1, y1)
    tip = (x1 + math.cos(angle) * head * 0.85, y1 + math.sin(angle) * head * 0.85)
    spread = 0.42
    draw.polygon(
        [
            tip,
            (base[0] - math.cos(angle - spread) * head * 0.55, base[1] - math.sin(angle - spread) * head * 0.55),
            (base[0] - math.cos(angle + spread) * head * 0.55, base[1] - math.sin(angle + spread) * head * 0.55),
        ],
        fill=color,
    )


# 超采样倍数：Pillow 的直线与多边形没有抗锯齿，直接按目标尺寸画出来箭头边缘
# 是硬的（Retina 上尤其明显）。先按 4 倍画，再用 LANCZOS 缩回目标尺寸，等于
# 手工做了一次 4×4 的抗锯齿。
SUPERSAMPLE = 4


def render(scale):
    """按目标倍数出一张：内部按 4 倍超采样再缩回，边缘才平滑。"""
    big = render_raw(scale * SUPERSAMPLE)
    return big.resize((W * scale, H * scale), Image.LANCZOS)


def render_raw(scale):
    """实际绘制。scale 是超采样后的倍数。"""
    w, h = W * scale, H * scale
    img = vertical_gradient((w, h), (27, 36, 55), (13, 19, 32)).convert("RGBA")

    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (w // 2 - 280 * scale, -80 * scale, w // 2 + 280 * scale, 220 * scale),
        fill=(251, 90, 10, 34),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(80 * scale))
    img = Image.alpha_composite(img, glow)

    draw = ImageDraw.Draw(img)

    # 品牌：只有一行文字（不再放图标，避免与下面真正的应用图标重复）。
    title_font = load_font(96 * scale)
    text = "wmind"
    text_w = draw.textlength(text, font=title_font)
    ascent, descent = title_font.getmetrics()
    baseline_y = 150 * scale - (ascent + descent) / 2
    draw.text(((w - text_w) / 2, baseline_y), text, font=title_font, fill=(244, 247, 252))

    # 图标之间的弧形箭头。
    curved_arrow(
        draw,
        (APP_CENTER[0] * scale + 80 * scale, APP_CENTER[1] * scale - 2 * scale),
        (FOLDER_CENTER[0] * scale - 80 * scale, FOLDER_CENTER[1] * scale - 26 * scale),
        42 * scale,
        (139, 149, 167),
        max(1, round(11 * scale)),
    )
    return img.convert("RGB")


def main():
    RESOURCES.mkdir(parents=True, exist_ok=True)
    render(1).save(RESOURCES / "dmg-background.png", optimize=True)
    render(2).save(RESOURCES / "dmg-background@2x.png", optimize=True)
    print(f"written {RESOURCES / 'dmg-background.png'} (660x400)")
    print(f"written {RESOURCES / 'dmg-background@2x.png'} (1320x800)")


if __name__ == "__main__":
    main()
