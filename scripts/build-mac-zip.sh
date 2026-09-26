#!/bin/sh
# build-mac-zip.sh: the Capsule as a zip for vyre.run/box/Vyre-mac.zip. macOS only.
#
#   scripts/build-mac-zip.sh OUT.zip [--keep]
#
# Packages Vyre.app with `vyre capsule build --app`, then ad-hoc signs the whole bundle: packager
# signs only the Electron binary, which fails `codesign --verify`, and macOS calls a downloaded app
# in that state damaged, with no way past it. There is no Developer ID yet, so the result is still
# unsigned as far as Gatekeeper goes (right-click, Open). The zip is checked after a round trip.
# Without --keep, the build output (Electron, dist, helpers; about 650 MB) is deleted afterwards.
set -eu

[ "$(uname -s)" = Darwin ] || { echo "build-mac-zip: macOS only" >&2; exit 1; }
[ $# -ge 1 ] || { sed -n '2,11p' "$0"; exit 1; }
out=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
keep=0
[ "${2:-}" = --keep ] && keep=1

repo=$(cd "$(dirname "$0")/.." && pwd)
capsule=$repo/local/capsule
app=$capsule/dist/Vyre-darwin-$(uname -m | sed 's/x86_64/x64/')/Vyre.app
check=$(mktemp -d)
cleanup() {
  rm -rf "$check"
  [ "$keep" = 1 ] || rm -rf "$capsule/dist" "$capsule/node_modules" "$capsule/bin"
}
trap cleanup EXIT

"$repo/bin/vyre" capsule build --app
[ -d "$app" ] || { echo "build-mac-zip: no $app" >&2; exit 1; }

# `vyre capsule build --app` signs the bundle itself from capsule 9cefc71 on. For an older build,
# sign it here: helpers first, keeping their identities, then the bundle around them.
if ! codesign --verify --deep --strict "$app" 2>/dev/null; then
  codesign --force -s - --identifier run.vyre.hotkey "$app/Contents/Resources/bin/hotkey"
  codesign --force -s - --identifier run.vyre.launcher "$app/Contents/Resources/bin/vyre-launcher"
  codesign --force -s - --identifier run.vyre.local "$app/Contents/Resources/bin/local"
  codesign --force --deep -s - --identifier run.vyre.capsule "$app"
  codesign --force -s - --identifier run.vyre.capsule "$app"
fi
codesign --verify --deep --strict "$app"

rm -f "$out"
ditto -c -k --sequesterRsrc --keepParent "$app" "$out"
ditto -x -k "$out" "$check"
codesign --verify --deep --strict "$check/Vyre.app"
echo "built $out ($(du -h "$out" | cut -f1)), signature verified after unzip"
