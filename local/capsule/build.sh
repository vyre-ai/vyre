#!/bin/sh
# Build the Capsule's Swift helpers into local/capsule/bin/.
#
#   hotkey          the double-Control listener the Capsule runs as a child
#   vyre-launcher   one macOS identity for vyred, so Accessibility is granted to Vyre alone
#   local           Contacts and Dictionary lookups for the launcher, as a long-lived child
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
# local asks for Contacts, and macOS refuses that ask without a usage string from an Info.plist.
# When local is its own responsible process, the plist it reads is the one linked into it.
# Under $TMPDIR (so a caller can move it), and removed however the script ends: plain sh runs an
# EXIT trap on a normal exit only, so a signal exits through it too.
plist="$(mktemp "${TMPDIR:-/tmp}/vyre-local-plist.XXXXXX")"
trap 'rm -f "$plist"' EXIT
trap 'exit 130' INT TERM HUP
cat > "$plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>run.vyre.local</string>
  <key>CFBundleName</key><string>Vyre</string>
  <key>NSContactsUsageDescription</key><string>Vyre's launcher shows matching contacts as you type. Nothing leaves this Mac.</string>
</dict></plist>
PLIST
for name in hotkey launcher local; do
  out="$here/bin/$name"
  [ "$name" = launcher ] && out="$here/bin/vyre-launcher"
  if [ "$name" = local ]; then
    swiftc -O -o "$out" "$here/swift/$name.swift" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist"
  else
    swiftc -O -o "$out" "$here/swift/$name.swift"
  fi
  codesign -s - --force --identifier "run.vyre.$name" "$out" >/dev/null 2>&1
  echo "built $out"
done
