#!/bin/sh
# ios-j0.sh <link-file>: J0 in Safari on the iOS simulator. The simulator shares the Mac's network,
# so 127.0.0.1:7300 is mac-proxy.mjs. English is set before the check (the runner's own locale
# showed through once). The page is read back from the screenshot (ocr.swift). CI runners only.
set -u
[ -n "${CI:-}" ] || { echo "ios-j0.sh: runs on a CI runner only" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
dev=$(xcrun simctl list devices available | grep -m1 -E "iPhone 1[5-7]( Pro)? \(" | sed -E 's/.*\(([0-9A-F-]+)\).*/\1/')
xcrun simctl boot "$dev" && xcrun simctl bootstatus "$dev" -b >/dev/null
xcrun simctl spawn "$dev" defaults write -g AppleLanguages -array en
xcrun simctl spawn "$dev" defaults write -g AppleLocale en_US
xcrun simctl shutdown "$dev" && xcrun simctl boot "$dev" && xcrun simctl bootstatus "$dev" -b >/dev/null
# A booted simulator is not yet ready for Safari: on a hosted runner the first openurl timed out (NSPOSIXErrorDomain 60) and the screenshot was the
# home screen. Let the springboard settle, start Safari itself, then open the link, again if it times out, and check Safari is in front.
sleep 20
xcrun simctl launch "$dev" com.apple.mobilesafari >/dev/null 2>&1 || true
sleep 5
opened=0
for i in 1 2 3 4; do
  if perl -e 'alarm 90; exec @ARGV' xcrun simctl openurl "$dev" "$(cat "$1")"; then opened=1; break; fi
  echo "ios-j0: openurl try $i failed; again" >&2; sleep 10
done
[ "$opened" = 1 ] || echo "ios-j0: openurl never succeeded" >&2
sleep 15
mkdir -p "$RUNNER_TEMP/ios"
xcrun simctl io "$dev" screenshot "$RUNNER_TEMP/ios/shot.png" >/dev/null 2>&1
swiftc -O "$HERE/ocr.swift" -o "$RUNNER_TEMP/ocr" 2>/dev/null && "$RUNNER_TEMP/ocr" "$RUNNER_TEMP/ios/shot.png" >"$RUNNER_TEMP/ios/text.txt"
node "$HERE/j0-screen.mjs" --png "$RUNNER_TEMP/ios/shot.png" --text "$RUNNER_TEMP/ios/text.txt" --device ios-safari --out results/ios
