#!/bin/sh
# Render every artboard to PNG and audit contrast and clipping, on testbox.
# Usage (from the repo root): docs/design/deck-directions/render/render.sh [Board ...]
# Output: <scratch>/png/*.png and a summary; exits 1 if any text fails AA or leaves its frame.
set -e
HERE=$(cd "$(dirname "$0")/../project" && pwd)
DEST=${DEST:-vyre-ci/app-design-render}
OUT=${OUT:-${TMPDIR:-/tmp}/app-render}
mkdir -p "$OUT"
rsync -a --delete --exclude render "$HERE/" "testbox:$DEST/"
rsync -a "$HERE/../render/" "testbox:$DEST/"
ssh testbox "cd $DEST && rm -rf png && mkdir -p png && nice -n 15 sh run-all.sh $*"
rsync -a --delete "testbox:$DEST/png/" "$OUT/"
# The headless window is taller than the board; crop each PNG to the board's own size.
for p in "$OUT"/*.png; do
  [ -f "$HERE/$(basename "$p" .png).dc.html" ] || continue
  b=$(basename "$p" .png)
  h=$(node "$HERE/../render/size.js" "$HERE/$b.dc.html" | cut -d, -f2)
  python3 "$HERE/../render/crop.py" "$p" "$h"
done
cat "$OUT/summary.txt"
! grep -q '^FAIL' "$OUT/summary.txt"
