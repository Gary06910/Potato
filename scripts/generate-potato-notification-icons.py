"""Generate uni-app x UniPush notification resources for Potato.

The small icon is a white alpha glyph drawn at 8x resolution. The large icon
uses the existing full-color Potato artwork; launcher resources are untouched.
Requires Pillow.
"""

from pathlib import Path
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "apps/tokenm-android/nativeResources/android/res"
LARGE_SOURCE = ROOT / "assets/icon-win.png"
SCALE = 8
CANVAS = 100 * SCALE
RESAMPLING = Image.Resampling.LANCZOS


def point(x, y):
    return (round(x * SCALE), round(y * SCALE))


def cubic(start, first, second, end, steps=24):
    result = []
    for index in range(1, steps + 1):
        t = index / steps
        inverse = 1 - t
        result.append((
            inverse**3 * start[0] + 3 * inverse**2 * t * first[0]
            + 3 * inverse * t**2 * second[0] + t**3 * end[0],
            inverse**3 * start[1] + 3 * inverse**2 * t * first[1]
            + 3 * inverse * t**2 * second[1] + t**3 * end[1],
        ))
    return result


def small_glyph():
    alpha = Image.new("L", (CANVAS, CANVAS), 0)
    draw = ImageDraw.Draw(alpha)
    # An intentionally uneven potato silhouette, with no arms or legs.
    segments = [
        ((50, 10), (27, 8), (16, 20), (15, 42)),
        ((15, 42), (8, 63), (17, 82), (38, 89)),
        ((38, 89), (56, 95), (80, 88), (87, 70)),
        ((87, 70), (93, 51), (84, 23), (69, 14)),
        ((69, 14), (63, 10), (56, 9), (50, 10)),
    ]
    outline = [segments[0][0]]
    for segment in segments:
        outline.extend(cubic(*segment))
    draw.polygon([point(*xy) for xy in outline], fill=255)

    # Transparent facial cutouts remain legible when Android tints the mask.
    for x in (38, 63):
        draw.ellipse((*point(x - 4, 37), *point(x + 4, 45)), fill=0)
    mouth = [
        (33, 55),
        *cubic((33, 55), (42, 62), (59, 62), (69, 54), steps=32),
    ]
    draw.line([point(*xy) for xy in mouth], fill=0, width=7 * SCALE, joint="curve")
    for x, y in (mouth[0], mouth[-1]):
        draw.ellipse((*point(x - 3.5, y - 3.5), *point(x + 3.5, y + 3.5)), fill=0)

    image = Image.new("RGBA", alpha.size, (255, 255, 255, 0))
    image.putalpha(alpha)
    return image


def main():
    small = small_glyph()
    with Image.open(LARGE_SOURCE) as source:
        large = source.convert("RGBA")
        for density, small_size, large_size in (
            ("ldpi", 18, 48),
            ("mdpi", 24, 64),
            ("hdpi", 36, 96),
            ("xhdpi", 48, 128),
            ("xxhdpi", 72, 192),
            ("xxxhdpi", 96, None),
        ):
            directory = RES / f"drawable-{density}"
            directory.mkdir(parents=True, exist_ok=True)
            small.resize((small_size, small_size), RESAMPLING).save(
                directory / "push_small.png", optimize=True
            )
            if large_size is not None:
                large.resize((large_size, large_size), RESAMPLING).save(
                    directory / "push.png", optimize=True
                )


if __name__ == "__main__":
    main()
