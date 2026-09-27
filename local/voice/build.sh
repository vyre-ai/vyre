#!/bin/sh
# Build the microphone helper for the voice module.
#
# The binary is built on the machine that runs it, never shipped prebuilt: macOS ties the
# Microphone grant to the code signature of whatever asks, so a binary copied in from
# elsewhere would be a stranger to the permission system. Ad-hoc signing gives it a stable
# identity of its own. Rebuilding changes that identity, so after a rebuild macOS may ask for
# the grant again.
#
# The Info.plist is linked into the binary itself. A command-line tool has no bundle to carry
# one, and without an NSMicrophoneUsageDescription macOS kills the process the moment it
# touches the microphone rather than asking the person.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "voice builds only on macOS" >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode command line tools: xcode-select --install" >&2
  exit 1
fi
plist="$(mktemp -t vyre-mic-plist)"
trap 'rm -f "$plist"' EXIT
cat > "$plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>sh.vyre.mic</string>
  <key>CFBundleName</key>
  <string>vyre-mic</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Vyre listens only while you hold the talk key, to turn what you say into text.</string>
</dict>
</plist>
EOF
mkdir -p "$here/bin"
swiftc -O -o "$here/bin/vyre-mic" "$here/swift/Mic.swift" "$here/swift/main.swift" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist"
codesign -s - --force "$here/bin/vyre-mic" >/dev/null 2>&1
echo "built $here/bin/vyre-mic"
