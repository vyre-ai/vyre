#!/bin/sh
# Renders the app icon from the 1024 SVG in docs/design/TOKENS.md ("App icon") to the asset
# catalog's single 1024 PNG. Headless Chrome draws the SVG (ImageMagick's own SVG renderer gets
# the transforms wrong); ImageMagick then flattens it onto carbon, because iOS wants an opaque
# square and applies its own corner mask, which matches the tile's rx of 22.46 percent.
#   apps/ios/scripts/render-icon.sh
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
TOKENS="$HERE/../../docs/design/TOKENS.md"
OUT="$HERE/Vyre/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/vyre-icon.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

SVG=$(awk '/^### App icon/{f=1;next} f&&/^<svg/{print;exit}' "$TOKENS")
[ -n "$SVG" ] || { echo "no App icon SVG in $TOKENS" >&2; exit 1; }
printf '<!doctype html><html><body style="margin:0;background:#161513">%s</body></html>' "$SVG" > "$TMP/icon.html"

# perl's alarm is the timeout: a headless Chrome that hangs must not hang the build.
nice -n 10 perl -e 'alarm 20; exec @ARGV' "$CHROME" --headless=new --use-mock-keychain --password-store=basic --disable-gpu --hide-scrollbars \
  --user-data-dir="$TMP/profile" --window-size=1024,1024 --force-device-scale-factor=1 \
  --screenshot="$TMP/icon.png" "file://$TMP/icon.html" >/dev/null 2>&1 || true
[ -s "$TMP/icon.png" ] || { echo "Chrome did not render the icon" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
magick "$TMP/icon.png" -crop 1024x1024+0+0 +repage -background '#161513' -alpha remove -alpha off "$OUT"
echo "wrote $OUT"
