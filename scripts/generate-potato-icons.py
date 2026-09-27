"""Render the supplied Potato artwork into the Windows and Android icon slots.

Requires Pillow. Run from the repository root after replacing
assets/potato-icon-source.png with an approved square source image.
"""
from collections import deque
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Image.open(ROOT / "assets/potato-icon-source.png").convert("RGBA")
# The supplied square artwork has generous white margins. Keep the whole courier
# silhouette while making the face readable at launcher and taskbar sizes.
ART = SOURCE.crop((150, 175, 1050, 1075))
RESAMPLING = Image.Resampling.LANCZOS


def flat_icon(size):
    canvas = Image.new("RGB", (size, size), "#fffdf8")
    inner = ART.resize((size, size), RESAMPLING).convert("RGB")
    canvas.paste(inner)
    return canvas


flat_icon(1024).save(ROOT / "assets/icon-win.png", optimize=True)
flat_icon(256).save(ROOT / "assets/icon-win.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

android = ROOT / "apps/tokenm-android"
icon_dir = android / "package/icons"
icon_dir.mkdir(parents=True, exist_ok=True)
for density, size in (("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
    flat_icon(size).save(icon_dir / f"potato-{density}.png", optimize=True)

# Remove only the source's edge-connected near-white background. The outlined
# envelope and face remain part of the supplied illustration.
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
    if min(r, g, b) < 240:
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

# Android adaptive icons reserve their outer 18dp for launcher masks and motion.
foreground = Image.new("RGBA", (432, 432))
foreground.alpha_composite(cutout.resize((296, 296), RESAMPLING), (68, 68))
drawable = android / "nativeResources/android/res/drawable"
drawable.mkdir(parents=True, exist_ok=True)
foreground.save(drawable / "icon_foreground.png", optimize=True)
