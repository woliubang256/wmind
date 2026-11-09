#!/usr/bin/env python3
"""生成 DMG 安装窗口的背景图（1x + 2x 两份，打包时合成 HiDPI TIFF）。

布局：一行品牌文字 + 一行「应用图标 → Applications」，之间一条带弧度的箭头。
不放说明文字，也不放品牌图标——背景里的图标会和下面真正的应用图标重复。

**为什么要出两份**：Finder 的背景图不认 SVG，也不做矢量渲染；它按位图铺。
窗口是 660×400 pt，只给 1x 图的话，在 Retina 屏上会被放大一倍，文字和箭头
出现明显锯齿。做法与 create-dmg 一致：出 1x 与 2x，用
`tiffutil -cathidpicheck` 合成一个多分辨率 TIFF，Finder 自动挑清晰的那份。

坐标约定（与 build-desktop.mjs 的 AppleScript 一致）：
  Wmind.app     (200, 300) pt
  Applications  (460, 300) pt

用法：python3 scripts/build-dmg-background.py
依赖：Pillow
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / "desktop" / "resources"

W, H = 660, 400
# 内容整体偏上：底部留白比顶部多，视觉重心在窗口中上部。
APP_CENTER = (200, 272)
FOLDER_CENTER = (460, 272)

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


def curved_arrow(draw, start, end, rise, color, width):
    """三次贝塞尔：先向上抬，再压平，末端切线接近水平——箭头「指向右边」。

    用对称二次曲线的问题是其末端切线必然向下斜，箭头看起来像扎进文件夹；
    三次曲线把两个控制点都放在高位，曲线升上去以后走平，箭头才自然。
    """
    (x0, y0), (x1, y1) = start, end
    c1 = (x0 + (x1 - x0) * 0.38, min(y0, y1) - rise)
    c2 = (x0 + (x1 - x0) * 0.72, min(y0, y1) - rise)
    points = []
    for i in range(80):
        t = i / 79
        x = (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * c1[0] + 3 * (1 - t) * t ** 2 * c2[0] + t ** 3 * x1
        y = (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * c1[1] + 3 * (1 - t) * t ** 2 * c2[1] + t ** 3 * y1
        points.append((x, y))
    draw.line(points, fill=color, width=width, joint="curve")
    for px, py in (points[0],):
        draw.ellipse((px - width / 2, py - width / 2, px + width / 2, py + width / 2), fill=color)
    # 箭头沿末端切线方向探出。
    (px, py), (qx, qy) = points[-2], points[-1]
    angle = math.atan2(qy - py, qx - px)
    head = width * 3.4
    tip = (x1 + math.cos(angle) * head * 0.8, y1 + math.sin(angle) * head * 0.8)
    spread = 0.44
    base = (x1, y1)
    draw.polygon(
        [
            tip,
            (base[0] - math.cos(angle - spread) * head * 0.6, base[1] - math.sin(angle - spread) * head * 0.6),
            (base[0] - math.cos(angle + spread) * head * 0.6, base[1] - math.sin(angle + spread) * head * 0.6),
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
    text = "Wmind"
    text_w = draw.textlength(text, font=title_font)
    ascent, descent = title_font.getmetrics()
    baseline_y = 150 * scale - (ascent + descent) / 2
    draw.text(((w - text_w) / 2, baseline_y), text, font=title_font, fill=(244, 247, 252))

    # 图标之间的弧形箭头。
    curved_arrow(
        draw,
        (APP_CENTER[0] * scale + 80 * scale, APP_CENTER[1] * scale - 6 * scale),
        (FOLDER_CENTER[0] * scale - 80 * scale, FOLDER_CENTER[1] * scale - 14 * scale),
        34 * scale,
        (139, 149, 167),
        max(1, round(10 * scale)),
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
