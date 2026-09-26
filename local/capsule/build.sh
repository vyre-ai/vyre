#!/bin/sh
# Build the Capsule's Swift helpers into local/capsule/bin/.
#
#   hotkey          the double-Control listener the Capsule runs as a child
#   vyre-launcher   one macOS identity for vyred, so Accessibility is granted to Vyre alone
#
# Built on the machine that runs them, never shipped prebuilt: macOS ties a permission grant to
# the code signature of whatever asks, and ad-hoc signing gives each binary an identity of its
# own. A rebuild changes that identity, so after one macOS may ask for the grant again.
#
# `vyre capsule build` runs this, then packages the app when asked (--app).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "the Capsule builds only on macOS" >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode command line tools: xcode-select --install" >&2
  exit 1
fi
mkdir -p "$here/bin"
for name in hotkey launcher; do
  out="$here/bin/$name"
  [ "$name" = launcher ] && out="$here/bin/vyre-launcher"
  swiftc -O -o "$out" "$here/swift/$name.swift"
  codesign -s - --force --identifier "run.vyre.$name" "$out" >/dev/null 2>&1
  echo "built $out"
done
