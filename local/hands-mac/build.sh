#!/bin/sh
# Build the helpers for the hands module: ax (the accessibility helper) and overlay (the ring,
# the "Vyre is controlling" pill and the stop keys).
#
# The binary is built on the machine that runs it, never shipped prebuilt: macOS ties the
# Accessibility grant to the code signature of whatever asks, so a binary copied in from
# elsewhere would be a stranger to the permission system. Ad-hoc signing gives it a stable
# identity of its own. Rebuilding changes that identity, so after a rebuild macOS may need the
# grant again.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "hands-mac builds only on macOS" >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode command line tools: xcode-select --install" >&2
  exit 1
fi
mkdir -p "$here/bin"
for name in ax overlay; do
  swiftc -O -o "$here/bin/$name" "$here/$name.swift"
  codesign -s - --force "$here/bin/$name" >/dev/null 2>&1
  echo "built $here/bin/$name"
done
