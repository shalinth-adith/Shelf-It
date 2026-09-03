#!/usr/bin/env python3
"""Rewrite a PNG as 24-bit RGB, dropping the alpha channel.

The Chrome Web Store requires 24-bit PNG with no alpha. macOS screen captures are RGBA,
and `sips` carries that fourth channel through every resize and pad even when it is fully
opaque, so the uploader rejects the file — reporting it, unhelpfully, as "The image size
is incorrect."

Converting via JPEG would strip alpha too, but at the cost of compression ringing around
text, which is the one artifact a listing for a reading tool cannot afford. So this decodes
and re-encodes losslessly instead. No third-party dependency: zlib and struct are enough.

Usage:  png24.py in.png out.png
"""
import struct, sys, zlib

SIG = b"\x89PNG\r\n\x1a\n"


def _chunks(buf):
    if buf[:8] != SIG:
        raise ValueError("not a PNG")
    i = 8
    while i < len(buf):
        (n,) = struct.unpack(">I", buf[i:i + 4])
        typ = buf[i + 4:i + 8]
        yield typ, buf[i + 8:i + 8 + n]
        i += 12 + n


def _unfilter(raw, w, h, bpp):
    """Reverse the per-scanline filters (PNG spec 9.2) into flat pixel bytes."""
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        ft = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if ft == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif ft != 0:
            raise ValueError(f"bad filter {ft}")
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return out


def _chunk(typ, data):
    return (struct.pack(">I", len(data)) + typ + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))


def to_rgb(src, dst):
    buf = open(src, "rb").read()
    idat = bytearray()
    hdr = None
    for typ, data in _chunks(buf):
        if typ == b"IHDR":
            hdr = struct.unpack(">IIBBBBB", data)
        elif typ == b"IDAT":
            idat += data

    w, h, depth, ctype, comp, filt, interlace = hdr
    if depth != 8 or interlace != 0 or ctype not in (2, 6):
        raise ValueError(f"unsupported PNG: depth={depth} colour={ctype} interlace={interlace}")
    if ctype == 2:
        return False, w, h            # already 24-bit; nothing to do

    px = _unfilter(zlib.decompress(bytes(idat)), w, h, 4)

    # Drop every fourth byte. Alpha in a screen capture is fully opaque, so discarding it
    # changes no visible pixel — this is a channel removal, not a composite.
    rgb = bytearray()
    for y in range(h):
        row = px[y * w * 4:(y + 1) * w * 4]
        rgb += b"\x00"                # filter 0 (None): smallest code, no scanline cost
        rgb += bytes(b for i in range(0, len(row), 4) for b in row[i:i + 3])

    out = bytearray(SIG)
    out += _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    out += _chunk(b"IDAT", zlib.compress(bytes(rgb), 9))
    out += _chunk(b"IEND", b"")
    open(dst, "wb").write(out)
    return True, w, h


if __name__ == "__main__":
    changed, w, h = to_rgb(sys.argv[1], sys.argv[2])
    print(f"{'converted' if changed else 'already 24-bit'}  {w}x{h}")
