#!/usr/bin/env bash
# Fit screenshots to Chrome Web Store dimensions.
#
# The store accepts 1280x800 or 640x400 and nothing else — not "at most", exactly. Source
# captures never match that ratio, so the choice is stretch or pad. Stretching a portrait
# popup into a landscape box visibly distorts the type, which is the one thing a screenshot
# of a reading tool cannot afford. So: scale to fit, then pad to the exact canvas with the
# extension's own paper colour, which makes the padding read as the frame rather than as a
# mistake. Output is finally re-encoded to 24-bit RGB, which the store requires and sips
# will not produce on its own.
#
# Usage:  ./tools/store-shots.sh shot1.png shot2.png ...
#         SIZE=640x400 ./tools/store-shots.sh ...
set -euo pipefail
cd "$(dirname "$0")/.."

SIZE=${SIZE:-1280x800}
W=${SIZE%x*}
H=${SIZE#*x}
PAD=${PAD:-FBFAF7}          # --paper from shelf/src/theme.css, light theme
OUT_DIR=${OUT_DIR:-store/screenshots}

[ $# -gt 0 ] || { echo "usage: $0 <image>..." >&2; exit 1; }

mkdir -p "$OUT_DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

i=0
for src in "$@"; do
  [ -f "$src" ] || { echo "missing: $src" >&2; exit 1; }
  i=$((i + 1))

  sw=$(sips -g pixelWidth  "$src" | awk '/pixelWidth/{print $2}')
  sh=$(sips -g pixelHeight "$src" | awk '/pixelHeight/{print $2}')

  # Scale so the whole capture fits inside the canvas; never upscale past 1:1, since
  # enlarging a screenshot past its native pixels only produces soft text.
  read -r tw th <<< "$(python3 -c "
sw,sh,W,H = $sw,$sh,$W,$H
s = min(W/sw, H/sh, 1.0)
print(max(1,round(sw*s)), max(1,round(sh*s)))")"

  base=$(basename "${src%.*}" | tr ' ' '-')
  dest="$OUT_DIR/$(printf '%02d' "$i")-${base}-${W}x${H}.png"

  sips -s format png -z "$th" "$tw" "$src" --out "$tmp/s.png" >/dev/null
  sips -p "$H" "$W" --padColor "$PAD" "$tmp/s.png" --out "$tmp/p.png" >/dev/null 2>&1

  # The store demands 24-bit RGB. sips carries the capture's unused alpha channel through
  # every operation, and the uploader rejects that as "image size is incorrect".
  python3 tools/png24.py "$tmp/p.png" "$dest" >/dev/null

  gw=$(sips -g pixelWidth  "$dest" | awk '/pixelWidth/{print $2}')
  gh=$(sips -g pixelHeight "$dest" | awk '/pixelHeight/{print $2}')
  got="${gw}x${gh}"
  printf '  %-46s %sx%s -> %s (fit %sx%s)\n' "$(basename "$dest")" "$sw" "$sh" "$got" "$tw" "$th"
done

echo
echo "wrote $i file(s) to $OUT_DIR/"
