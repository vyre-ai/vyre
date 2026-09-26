#!/bin/bash
# Build (and optionally test) the iPhone app without signing, from any directory, with no prompts.
# Used by CI (.github/workflows/ios.yml) and on the Mac through the build lock:
#   apps/ios/scripts/build.sh              generate the project, build for the simulator
#   apps/ios/scripts/build.sh test         also run VyreTests on a simulator (SIM, default "iPhone 17")
# Needs Xcode and XcodeGen. The .xcodeproj is generated, never committed.
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
DD="${DERIVED_DATA:-$IOS/build/dd}"
cd "$IOS"
xcodegen generate --quiet --spec project.yml
common=(-project Vyre.xcodeproj -scheme Vyre -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO -skipPackagePluginValidation)
if [ "${1:-}" = test ]; then
  xcodebuild "${common[@]}" -destination "platform=iOS Simulator,name=${SIM:-iPhone 17}" test
else
  xcodebuild "${common[@]}" -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build
fi
echo "app: $DD/Build/Products/Debug-iphonesimulator/Vyre.app"
