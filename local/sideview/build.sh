#!/bin/sh
# Build vyre-tile, the side view's window mover.
#
# Built on the machine that runs it, never shipped prebuilt: macOS ties the Accessibility grant
# to the code signature of whatever asks, and ad-hoc signing gives the binary a stable identity
# of its own. Rebuilding changes that identity, so after a rebuild macOS may ask for the grant
# again.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "sideview builds only on macOS" >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode command line tools: xcode-select --install" >&2
  exit 1
fi
mkdir -p "$here/bin"
swiftc -O -o "$here/bin/vyre-tile" "$here/swift/tile.swift"
codesign -s - --force "$here/bin/vyre-tile" >/dev/null 2>&1
echo "built $here/bin/vyre-tile"
