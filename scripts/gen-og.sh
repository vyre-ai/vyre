#!/bin/sh
# gen-og.sh: render the 1200x630 social card for every page into site/og/<slug>.png.
#
#   scripts/gen-og.sh
#
# scripts/gen-site.mjs --og DIR writes one HTML card per page; this takes a picture of each with headless Chrome.
# Set CHROME to a Chrome or Chromium binary if it is not in the usual place.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chrome=${CHROME:-}
if [ -z "$chrome" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome google-chrome-stable chromium chromium-browser; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then chrome=$c; break; fi
  done
fi
[ -n "$chrome" ] || { echo "gen-og: no Chrome found; set CHROME" >&2; exit 1; }
node "$here/scripts/gen-site.mjs" --og "$tmp" >/dev/null
mkdir -p "$here/site/og"
for f in "$tmp"/*.html; do
  slug=$(basename "$f" .html)
  "$chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 --virtual-time-budget=4000 \
    --allow-file-access-from-files --screenshot="$here/site/og/$slug.png" "file://$f" >/dev/null 2>&1
done
ls "$here/site/og"
