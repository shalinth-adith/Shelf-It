#!/usr/bin/env python3
"""Render the Shelf It toolbar icons from the design's own geometry.

The marks are not one drawing scaled four ways. The design tunes each size on a 64-unit
grid — bars thicken as the canvas shrinks so the 16px toolbar slot still resolves three
distinct lines — so this reproduces those four specs rather than resampling one master.

The mark sits on a paper tile. The design draws the grey bars as #1B1A17 at 16-22% opacity,
which only reads against a light ground; on transparency those bars vanish into a dark
toolbar and the icon collapses to a single orange dash. Giving the mark the background it
was drawn for is what makes it survive every theme.

Anti-aliasing is by supersampling: the shape is sampled on a finer grid and box-averaged
down, which is why the 16px corners and bar ends stay smooth without a rasteriser.

Usage:  make-icons.py [outdir]        (default shelf/icons)
"""
import os, sys, zlib, struct

PAPER  = (0xFB, 0xFA, 0xF7)     # --paper, light theme
ACCENT = (0xA8, 0x46, 0x2A)
GREY   = (0x1B, 0x1A, 0x17)
R_RATIO = 11 / 52               # tile corner radius, from the 52px chip in artboard 1a

# size: (x, [w1,w2,w3], bar_height, [y1,y2,y3], grey_opacity, supersample)
SPECS = {
    16:  (8,  [48, 36, 26], 8.0,  [16, 28, 40], 0.22, 16),
    32:  (9,  [46, 35, 25], 7.0,  [16, 28, 40], 0.20, 12),
    48:  (10, [44, 34, 24], 6.5,  [17, 29, 41], 0.18, 8),
    128: (10, [44, 34, 24], 6.0,  [17, 29, 41], 0.16, 4),
}


def _in_rrect(px, py, x, y, w, h, r):
    if px < x or py < y or px > x + w or py > y + h:
        return False
    r = min(r, w / 2, h / 2)
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= r * r


def _mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size):
    x0, widths, bh, ys, op, S = SPECS[size]
    k = size / 64.0                       # 64-unit grid -> pixels
    n = size * S
    tile_r = R_RATIO * size
    grey_on_paper = _mix(PAPER, GREY, op)

    bars = []
    for i, (w, y) in enumerate(zip(widths, ys)):
        bars.append((x0 * k, y * k, w * k, bh * k, (bh / 2) * k,
                     ACCENT if i == 0 else grey_on_paper))

    acc = [[0, 0, 0, 0] for _ in range(size * size)]
    inv = 1.0 / S
    for sy in range(n):
        py = (sy + 0.5) * inv
        row = (sy // S) * size
        for sx in range(n):
            px = (sx + 0.5) * inv
            if not _in_rrect(px, py, 0, 0, size, size, tile_r):
                continue
            col = PAPER
            for bx, by, bw, bh_, br, c in bars:
                if _in_rrect(px, py, bx, by, bw, bh_, br):
                    col = c
                    break
            a = acc[row + (sx // S)]
            a[0] += col[0]; a[1] += col[1]; a[2] += col[2]; a[3] += 255

    # Box-average, then un-premultiply so partly covered edge pixels keep their true hue.
    out = bytearray()
    tot = S * S
    for yy in range(size):
        out.append(0)                     # filter 0
        for xx in range(size):
            r, g, b, a = acc[yy * size + xx]
            cov = a / tot
            if cov == 0:
                out += b"\x00\x00\x00\x00"
            else:
                w = a / 255.0
                out += bytes((round(r / w), round(g / w), round(b / w), round(cov)))
    return out


def _chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


def write(size, path):
    raw = render(size)
    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + _chunk(b"IEND", b""))
    open(path, "wb").write(png)


if __name__ == "__main__":
    outdir = sys.argv[1] if len(sys.argv) > 1 else "shelf/icons"
    os.makedirs(outdir, exist_ok=True)
    for s in (16, 32, 48, 128):
        p = os.path.join(outdir, f"{s}.png")
        write(s, p)
        print(f"  {p}  {s}x{s}  {os.path.getsize(p)} bytes")
