#!/bin/sh
# The iOS app icon is app-design's Vyre master (docs/design/brand/export/vyre/ios/AppIcon-1024.png, the brand sheet in
# docs/design/brand/README.md), copied as it is: opaque, iOS applies its own corner mask, and it carries no signature.
# It is no longer drawn from TOKENS.md. To refresh it after the brand export changes:
#   apps/ios/scripts/render-icon.sh
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC="$HERE/../../docs/design/brand/export/vyre/ios/AppIcon-1024.png"
OUT="$HERE/Vyre/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
[ -f "$SRC" ] || { echo "no $SRC (the brand export is on work/app-design until it lands)" >&2; exit 1; }
cp "$SRC" "$OUT"
echo "wrote $OUT"
