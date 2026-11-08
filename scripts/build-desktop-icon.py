#!/usr/bin/env python3
"""生成桌面端应用图标（backend/desktop/resources/icon.png）。

macOS 的应用图标**不会**被系统自动裁圆角：Big Sur 起的规范是图标文件自带
「超椭圆（squircle）」形状，四边留出安全边距，阴影也画在文件里。全出血的
方形图放进 Dock 会出现一个生硬的方块——这正是之前的问题。

本脚本从源图（docs/wmind_logo.png，唯一事实来源，原位保留）派生：

- 画布 1024×1024（mygo 会转成 .icns 的多个尺寸）
- 图标本体 824×824，居中，圆角半径 185.4（Apple Big Sur 模板数值）
- 本体外画一层投影：偏移 (0, 10)，模糊 40，黑色 25%

用法：python3 scripts/build-desktop-icon.py
依赖：Pillow（pip install pillow）
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "wmind_logo.png"
OUTPUT = ROOT / "backend" / "desktop" / "resources" / "icon.png"

CANVAS = 1024
BODY = 824          # 图标本体尺寸（Apple 模板）
MARGIN = (CANVAS - BODY) // 2
RADIUS = 185.4      # Big Sur 模板的圆角半径
SHADOW_OFFSET = 10
SHADOW_BLUR = 40
SHADOW_ALPHA = 64   # 25% 左右


def rounded_mask(size: int) -> Image.Image:
    """生成 squircle 蒙版：白=可见，黑=透明。"""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=RADIUS, fill=255
    )
    return mask


def main() -> None:
    src = Image.open(SOURCE).convert("RGB")

    # 1) 图标本体：源图缩放后按圆角裁剪。
    artwork = src.resize((BODY, BODY), Image.LANCZOS)
    artwork.putalpha(rounded_mask(BODY))

    # 2) 画布 + 投影：先把黑色圆角块模糊一次再压暗，得到柔和的阴影。
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow = Image.new("L", (CANVAS, CANVAS), 0)
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (MARGIN, MARGIN + SHADOW_OFFSET, MARGIN + BODY, MARGIN + BODY + SHADOW_OFFSET),
        radius=RADIUS, fill=SHADOW_ALPHA,
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(SHADOW_BLUR))
    canvas.paste((0, 0, 0, 255), (0, 0), shadow)

    # 3) 本体落位。
    canvas.paste(artwork, (MARGIN, MARGIN), artwork)
    canvas.save(OUTPUT, optimize=True)

    print(f"written {OUTPUT} ({canvas.size[0]}x{canvas.size[1]})")


if __name__ == "__main__":
    main()
