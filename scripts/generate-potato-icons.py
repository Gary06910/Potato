"""Render the approved Potato avatar into rounded Windows and Android icons.

Requires Pillow. The source in assets/potato-icon-source.png is an exact copy of
the user-provided artwork; this script only crops, masks, and resizes it.
"""
from collections import deque
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Image.open(ROOT / "assets/potato-icon-source.png").convert("RGBA")
# Crop only the wide outer whitespace. Keep the head, arms, and feet unchanged.
ART = SOURCE.crop((145, 180, 670, 705))
RESAMPLING = Image.Resampling.LANCZOS
TILE = (255, 253, 248, 255)


# Remove only edge-connected white pixels, leaving the original drawing intact.
cutout = ART.copy()
pixels = cutout.load()
width, height = cutout.size
seen = bytearray(width * height)
queue = deque()
for x in range(width):
    queue.append((x, 0))
    queue.append((x, height - 1))
for y in range(height):
    queue.append((0, y))
    queue.append((width - 1, y))
while queue:
    x, y = queue.popleft()
    index = y * width + x
    if seen[index]:
        continue
    seen[index] = 1
    r, g, b, _ = pixels[x, y]
    if min(r, g, b) < 245:
        continue
    pixels[x, y] = (r, g, b, 0)
    if x > 0:
        queue.append((x - 1, y))
    if x + 1 < width:
        queue.append((x + 1, y))
    if y > 0:
        queue.append((x, y - 1))
    if y + 1 < height:
        queue.append((x, y + 1))

# Compose a warm ivory rounded square, with transparent corners on Windows and
# the four legacy Android launcher sizes. Compose once at 1024 for smooth edges.
master = Image.new("RGBA", (1024, 1024))
rounded_tile = Image.new("RGBA", master.size)
ImageDraw.Draw(rounded_tile).rounded_rectangle((0, 0, 1023, 1023), radius=180, fill=TILE)
master.alpha_composite(rounded_tile)
master.alpha_composite(cutout.resize(master.size, RESAMPLING))
master.save(ROOT / "assets/icon-win.png", optimize=True)
master.resize((256, 256), RESAMPLING).save(
    ROOT / "assets/icon-win.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

android = ROOT / "apps/tokenm-android"
icon_dir = android / "package/icons"
icon_dir.mkdir(parents=True, exist_ok=True)
for density, size in (("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
    master.resize((size, size), RESAMPLING).save(icon_dir / f"potato-{density}.png", optimize=True)

# Android adaptive icons use the system's launcher mask. The foreground remains
# transparent and fits inside its safe area; the separate background fills the
# mask, whether a launcher chooses a circle or a rounded square.
foreground = Image.new("RGBA", (432, 432))
figure = cutout.crop((60, 45, 455, 495))
figure.thumbnail((280, 288), RESAMPLING)
foreground.alpha_composite(figure, ((432 - figure.width) // 2, (432 - figure.height) // 2))
drawable = android / "nativeResources/android/res/drawable"
drawable.mkdir(parents=True, exist_ok=True)
foreground.save(drawable / "icon_foreground.png", optimize=True)
