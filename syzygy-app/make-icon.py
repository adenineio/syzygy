#!/usr/bin/env python3
"""Build the app icons from the pane's own mark and the pane's own themes.

`sips` cannot read SVG on current macOS, and neither rsvg-convert nor
ImageMagick may be assumed to exist -- so this rasterises the mark itself,
with nothing but the standard library, and then hands the PNG to the two
icon tools macOS ships.

It does not REDRAW the mark, it PARSES it: one rect and two circles, which is
all favicon.svg contains. Anything else and this exits non-zero having written
nothing, so a changed mark fails the build loudly instead of shipping a stale
icon.

The colours are not the mark's. There is one icon per accent the pane offers,
each read from app.css the same way: the plate is that theme's --surface, a
thin inner border and the far disc are its --accent, and the covering disc is
the plate colour again -- the mark flipped for a dark host, the way the command
bar shows it on a panel. The plate is a rounded square on the macOS icon grid,
with clear corners, and the eclipse is drawn smaller on it than the mark draws
it on its own square.

  python3 make-icon.py                          # every theme's png, and the icns
  python3 make-icon.py --png-only               # every theme's png
  python3 make-icon.py --theme green --png-only # one theme
  python3 make-icon.py --svg - --png-only       # read the mark on stdin
"""
import argparse
import colorsys
import json
import math
import os
import re
import struct
import subprocess
import sys
import zlib

PNG_MAGIC = bytes([137, 80, 78, 71, 13, 10, 26, 10])
FILTER_NONE = bytes([0])
SIZE = 1024
SUPERSAMPLE = 3
# The macOS icon grid: an 824 px body centred in the 1024 canvas, and that
# body's corner radius. Everything outside the body is transparent.
PLATE = 824
PLATE_RADIUS = 185.4
# The accent border, inside the body's edge: about 2 px at Dock size.
BORDER = 16
# The eclipse on the plate, as a fraction of its size on the mark's own square.
GLYPH_SCALE = 0.72
# The theme whose icon the bundle itself carries, where Finder and Launchpad
# show it. The Dock follows the pane's accent once the pane has loaded.
BUNDLE_THEME = "green"
CENTRE = SIZE / 2
HALF = PLATE / 2
RECT_RE = re.compile(r'<rect\s+width="(\d+)"\s+height="(\d+)"\s+fill="(#[0-9a-fA-F]{6})"\s*/>')
CIRCLE_RE = re.compile(r'<circle\s+cx="([\d.]+)"\s+cy="([\d.]+)"\s+r="([\d.]+)"\s+fill="(#[0-9a-fA-F]{6})"\s*/>')
VIEWBOX_RE = re.compile(r'viewBox="0 0 (\d+) (\d+)"')
ELEMENT_RE = re.compile(r'<(\w+)[\s/>]')
THEME_RE = re.compile(r':root\[data-theme="([a-z]+)"\]\s*\{\s*--hue:\s*(\d+);\s*\}')
SURFACE_RE = re.compile(r'--surface:\s*hsl\(var\(--hue\)\s+([\d.]+)%\s+([\d.]+)%\)')
ACCENT_RE = re.compile(r'--accent:\s*hsl\(var\(--hue\)\s+([\d.]+)%\s+([\d.]+)%\)')


def die(msg):
    print("make-icon: " + msg, file=sys.stderr)
    raise SystemExit(2)


def read_text(path, label):
    if path == "-":
        return sys.stdin.read(), "the " + label + " on stdin"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read(), os.path.basename(path)
    except OSError as err:
        die("cannot read %s at %s: %s" % (label, path, err))


def rgb(text):
    return (int(text[1:3], 16), int(text[3:5], 16), int(text[5:7], 16))


def parse_mark(svg, where):
    body = svg[svg.index("<svg"):] if "<svg" in svg else die(where + " has no <svg>")
    view = VIEWBOX_RE.search(body) or die(where + " has no square viewBox at the origin")
    if view.group(1) != view.group(2):
        die(where + " is not square")
    RECT_RE.search(body) or die(where + " has no full-bleed <rect> fill")
    circles = CIRCLE_RE.findall(body)
    if len(circles) != 2:
        die(where + " has %d circles, expected 2" % len(circles))
    # Every drawn element must be one of the three this understands. A mark that
    # grew a <path> or a <linearGradient> is a mark this cannot rasterise, and
    # guessing would ship an icon that is not the brand.
    drawn = [e for e in ELEMENT_RE.findall(body) if e not in ("svg", "rect", "circle")]
    if drawn:
        die(where + " carries elements this cannot draw: " + ", ".join(sorted(set(drawn))))
    return int(view.group(1)), [(float(cx), float(cy), float(r)) for cx, cy, r, _fill in circles]


def rgb_of_hsl(hue, sat, light):
    r, g, b = colorsys.hls_to_rgb(hue / 360.0, light / 100.0, sat / 100.0)
    return [int(round(c * 255)) for c in (r, g, b)]


def parse_themes(css, where):
    """Every theme app.css styles, in its order, with the two colours the icon
    needs computed from that theme's hue exactly as the stylesheet spells them."""
    themes = THEME_RE.findall(css)
    if not themes:
        die(where + " defines no :root[data-theme] hue")
    surface = SURFACE_RE.search(css) or die(where + " has no --surface: hsl(var(--hue) S% L%)")
    accent = ACCENT_RE.search(css) or die(where + " has no --accent: hsl(var(--hue) S% L%)")
    return {
        name: {
            "plate": rgb_of_hsl(int(hue), float(surface.group(1)), float(surface.group(2))),
            "accent": rgb_of_hsl(int(hue), float(accent.group(1)), float(accent.group(2))),
        }
        for name, hue in themes
    }


def glyph(units, circles):
    """The two discs placed on the plate: mark units onto the plate, then scaled
    about its centre. The first is the far body, the second covers it."""
    k = PLATE / units
    return [
        (CENTRE + (cx * k - HALF) * GLYPH_SCALE, CENTRE + (cy * k - HALF) * GLYPH_SCALE, r * k * GLYPH_SCALE)
        for cx, cy, r in circles
    ]


def plate_depth(px, py):
    """How far inside the rounded body's edge a point lies; negative outside."""
    qx = abs(px - CENTRE) - (HALF - PLATE_RADIUS)
    qy = abs(py - CENTRE) - (HALF - PLATE_RADIUS)
    return PLATE_RADIUS - math.hypot(max(qx, 0.0), max(qy, 0.0)) - min(max(qx, qy), 0.0)


def raster(discs, plate, accent):
    # The far body is lit in the accent and the covering disc is the plate
    # colour: on a dark host that is what reads as a crescent.
    prims = [(cx, cy, r, colour) for (cx, cy, r), colour in zip(discs, (accent, plate))]
    lo = CENTRE - HALF
    hi = CENTRE + HALF
    offsets = [(s + 0.5) / SUPERSAMPLE for s in range(SUPERSAMPLE)]
    taps = SUPERSAMPLE * SUPERSAMPLE
    clear = bytes([0, 0, 0, 0])
    rows = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            if x + 1 < lo or x > hi or y + 1 < lo or y > hi:
                row += clear
                continue
            acc = [0, 0, 0]
            inside = 0
            for dy in offsets:
                py = y + dy
                for dx in offsets:
                    px = x + dx
                    depth = plate_depth(px, py)
                    if depth < 0:
                        continue
                    inside += 1
                    colour = accent if depth < BORDER else plate
                    for cx, cy, r, fill in prims:
                        if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
                            colour = fill
                    for i in range(3):
                        acc[i] += colour[i]
            if not inside:
                row += clear
                continue
            # Straight, not premultiplied, alpha: the colour is the average of the
            # taps that landed on the plate, and coverage alone sets the alpha, so
            # the anti-aliased corner never darkens into a fringe.
            row += bytes(a // inside for a in acc)
            row += bytes([inside * 255 // taps])
        rows.append(bytes(row))
    return rows


def probe_of(rows, discs):
    """Five pixels that pin the layout down. `lit` sits inside the far body
    BELOW the covering disc, and `covered` at the covering disc's centre: the
    image centre is inside the covering disc, which is the whole shape of the
    mark and an easy thing to assert backwards."""
    (fx, fy, fr), (cx, cy, _cr) = discs

    def pixel(x, y):
        return list(rows[y][x * 4:x * 4 + 4])

    top = CENTRE - HALF
    return {
        "corner": pixel(0, 0),
        "border": pixel(SIZE // 2, int(top + BORDER / 2)),
        "plate": pixel(SIZE // 2, int((top + BORDER + fy - fr) / 2)),
        "lit": pixel(int(fx), int(fy + fr * 0.75)),
        "covered": pixel(int(cx), int(cy)),
    }


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def encode_png(rows):
    raw = b"".join(FILTER_NONE + r for r in rows)
    return (PNG_MAGIC
            + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def run(argv):
    subprocess.run(argv, check=True, stdout=subprocess.DEVNULL)


ICONSET = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    public = os.path.join(here, "..", "syzygy", "bridge", "public")
    ap = argparse.ArgumentParser()
    ap.add_argument("--svg", default=os.path.join(public, "favicon.svg"))
    ap.add_argument("--css", default=os.path.join(public, "app.css"))
    ap.add_argument("--out", default=os.path.join(here, "dist", "icon"))
    ap.add_argument("--theme", default=None)
    ap.add_argument("--png-only", action="store_true")
    ap.add_argument("--probe", action="store_true")
    args = ap.parse_args()

    svg, where = read_text(args.svg, "mark")
    units, circles = parse_mark(svg, where)
    css, css_where = read_text(args.css, "stylesheet")
    themes = parse_themes(css, css_where)
    if args.theme is not None:
        if args.theme not in themes:
            die("no theme named %r in %s" % (args.theme, css_where))
        themes = {args.theme: themes[args.theme]}
    if not args.png_only and BUNDLE_THEME not in themes:
        die("the bundle's icon is the " + BUNDLE_THEME + " theme's, so that theme must be rendered too")

    discs = glyph(units, circles)
    theme_dir = os.path.join(args.out, "themes")
    os.makedirs(theme_dir, exist_ok=True)
    probe = None
    for name, colours in themes.items():
        rows = raster(discs, colours["plate"], colours["accent"])
        path = os.path.join(theme_dir, name + ".png")
        with open(path, "wb") as fh:
            fh.write(encode_png(rows))
        print("wrote " + path)
        if args.probe and probe is None:
            probe = dict(probe_of(rows, discs), theme=name, plateRgb=colours["plate"], accentRgb=colours["accent"])

    if probe is not None:
        with open(os.path.join(args.out, "probe.json"), "w", encoding="utf-8") as fh:
            json.dump(probe, fh)

    if args.png_only:
        return

    iconset = os.path.join(args.out, "Syzygy.iconset")
    os.makedirs(iconset, exist_ok=True)
    source = os.path.join(theme_dir, BUNDLE_THEME + ".png")
    for name, size in ICONSET:
        run(["sips", "-z", str(size), str(size), source, "--out", os.path.join(iconset, name)])
    icns = os.path.join(args.out, "Syzygy.icns")
    run(["iconutil", "-c", "icns", iconset, "-o", icns])
    print("wrote " + icns)


if __name__ == "__main__":
    main()
