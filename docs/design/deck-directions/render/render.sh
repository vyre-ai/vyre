#!/bin/sh
# Render every artboard to PNG and audit contrast and clipping, on testbox.
# Usage (from the repo root): docs/design/deck-directions/render/render.sh [Board ...]
# Output: <scratch>/png/*.png and a summary; exits 1 if any text fails AA or leaves its frame.
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST=${DEST:-vyre-ci/deck-design-render}
OUT=${OUT:-${TMPDIR:-/tmp}/deck-render}
mkdir -p "$OUT"
rsync -a --delete --exclude render "$HERE/" "testbox:$DEST/"
rsync -a "$HERE/render/" "testbox:$DEST/"
ssh testbox "cd $DEST && rm -rf png && mkdir -p png && nice -n 15 sh run-all.sh $*"
rsync -a --delete "testbox:$DEST/png/" "$OUT/"
# The headless window is taller than the board; crop each PNG to the board's own size.
for p in "$OUT"/*.png; do
  b=$(basename "$p" .png)
  h=$(node -e 'const c=require(process.argv[1]).boards[process.argv[2]+".dc.html"];console.log(c?c.h:900)' "$HERE/canvas.json" "$b")
  python3 "$HERE/render/crop.py" "$p" "$h"
done
cat "$OUT/summary.txt"
! grep -q '^FAIL' "$OUT/summary.txt"
