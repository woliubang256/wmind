#!/usr/bin/env python3
"""生成桌面端应用图标（backend/desktop/resources/icon.png）。

macOS 的应用图标**不会**被系统自动裁圆角：Big Sur 起的规范是图标文件自带
「超椭圆（squircle）」形状，四边留出安全边距，阴影也画在文件里。全出血的
方形图放进 Dock 会出现一个生硬的方块——这正是之前的问题。

本脚本从源图（docs/wmind_logo.png，唯一事实来源，原位保留）派生：

- 画布 1024×1024（mygo 会转成 .icns 的多个尺寸）
- 图标本体 824×824，居中，圆角半径 185.4（Apple Big Sur 模板数值）
- 本体外画一层投影：偏移 (0, 10)，模糊 40，黑色 25%

**Windows / Linux 的图标另出一份**（`icon-windows.png`）：这两个平台的图标
不像 macOS 那样自带安全边距，同一个带 20% 留白的图放进任务栏会比旁边的原生
应用明显小一圈。所以：

- `icon.png`：macOS 规范（本体 824/1024 + 投影），给 .icns 与 DMG 用
- `icon-windows.png`：本体接近满幅（1000/1024）、无投影，给 Windows/Linux 用
- `icon.icns`：由 `icon.png` 生成（需要 macOS 的 sips + iconutil）

用法：python3 scripts/build-desktop-icon.py
依赖：Pillow（pip install pillow）；生成 .icns 需要 macOS
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "wmind_logo.png"
RESOURCES = ROOT / "desktop" / "resources"
OUTPUT = RESOURCES / "icon.png"
OUTPUT_WINDOWS = RESOURCES / "icon-windows.png"
OUTPUT_ICNS = RESOURCES / "icon.icns"

CANVAS = 1024
BODY = 824          # 图标本体尺寸（Apple 模板）
# Windows / Linux：图标自己占满画布（Windows 11 的第三方应用基本如此），
# 只留 12px 余量给投影与抗锯齿，圆角按 Windows 的观感收小。
WINDOWS_BODY = 1000
WINDOWS_MARGIN = (CANVAS - WINDOWS_BODY) // 2
WINDOWS_RADIUS = 150
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

    # 4) Windows / Linux 版：接近满幅、无投影。
    windows_mask = Image.new("L", (WINDOWS_BODY, WINDOWS_BODY), 0)
    ImageDraw.Draw(windows_mask).rounded_rectangle(
        (0, 0, WINDOWS_BODY - 1, WINDOWS_BODY - 1), radius=WINDOWS_RADIUS, fill=255
    )
    windows = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    windows_art = src.resize((WINDOWS_BODY, WINDOWS_BODY), Image.LANCZOS)
    windows_art.putalpha(windows_mask)
    windows.paste(windows_art, (WINDOWS_MARGIN, WINDOWS_MARGIN), windows_art)
    windows.save(OUTPUT_WINDOWS, optimize=True)
    print(f"written {OUTPUT_WINDOWS} ({CANVAS}x{CANVAS})")

    # 5) macOS 用的 .icns：mygo 的 macos.icon 只接受 .icns / .car / .icon。
    write_icns()


def write_icns() -> None:
    """由 icon.png 生成 .icns（macOS 的 sips + iconutil，其他平台跳过）。"""
    import shutil
    import subprocess
    import tempfile

    if not shutil.which("iconutil") or not shutil.which("sips"):
        print("跳过 .icns：需要 macOS 的 sips 与 iconutil")
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                pixels = size * scale
                name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
                subprocess.run(
                    ["sips", "-z", str(pixels), str(pixels), str(OUTPUT), "--out", str(iconset / name)],
                    check=True, stdout=subprocess.DEVNULL,
                )
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUTPUT_ICNS)], check=True)
    print(f"written {OUTPUT_ICNS}")


if __name__ == "__main__":
    main()
