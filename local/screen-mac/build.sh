#!/bin/sh
# Build the screen helpers: sight (screen context for the screen module) and testwin (the window
# the real-Mac tests open and read, so they never read the person's own screen).
#
# Built on the machine that runs them, never shipped prebuilt: macOS ties the Accessibility
# grant to the code signature of whatever asks, and ad-hoc signing gives each binary a stable
# identity of its own. Rebuilding changes that identity, so after a rebuild macOS may ask for
# the grant again.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "screen-mac builds only on macOS" >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode command line tools: xcode-select --install" >&2
  exit 1
fi
mkdir -p "$here/bin"
for name in sight testwin; do
  swiftc -O -o "$here/bin/$name" "$here/swift/$name.swift"
  codesign -s - --force "$here/bin/$name" >/dev/null 2>&1
  echo "built $here/bin/$name"
done
