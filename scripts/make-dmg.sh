#!/bin/sh
# make-dmg.sh: Vyre.app into a Vyre.dmg with the drag-to-Applications layout (the app beside an Applications shortcut).
# Usage: sh scripts/make-dmg.sh [path/to/Vyre.app] [out.dmg]   (defaults: local/capsule/native/.build/Vyre.app, dist/Vyre.dmg)
# The app keeps whatever signature build.sh gave it (ad hoc or Vyre Local): there is no Developer ID and no notarization, so macOS asks
# the first time (right-click the app, then Open). macOS only (hdiutil).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
app=${1:-$here/local/capsule/native/.build/Vyre.app}
out=${2:-$here/dist/Vyre.dmg}
[ "$(uname)" = Darwin ] || { echo "make-dmg: needs macOS (hdiutil)" >&2; exit 1; }
[ -d "$app" ] || { echo "make-dmg: no app at $app (run: sh local/capsule/native/build.sh app)" >&2; exit 1; }
stage=$(mktemp -d "${TMPDIR:-/tmp}/vyre-dmg.XXXXXX")
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Vyre.app"
ln -s /Applications "$stage/Applications"
mkdir -p "$(dirname "$out")"
rm -f "$out"
hdiutil create -quiet -volname "Vyre" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$out"
hdiutil verify -quiet "$out"
echo "make-dmg: $out ($(du -h "$out" | cut -f1))"
