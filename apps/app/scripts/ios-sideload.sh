#!/usr/bin/env bash
# Build the iPhone app for sideloading with a free personal Apple team (RC1: no paid Apple account), and install it over USB.
#
#   scripts/ios-sideload.sh            build a Release .app, signed with the local Apple Development identity
#   scripts/ios-sideload.sh --install  build, then install on the plugged-in, unlocked iPhone (xcrun devicectl)
#   scripts/ios-sideload.sh --install-only   install the .app from the last build
#
# What it does on this Mac: `expo prebuild` and `xcodebuild` inside apps/app (ios/ is gitignored), and a device install. It never installs or starts Vyre itself and never reads
# ~/.vyre, the person's sessions or env files. The build is signed with a 7 day personal-team profile: install again within the week (rerun with --install).
#
# A personal team cannot hold App Attest, push, associated domains, app groups or iCloud, so app.config.js (VYRE_SIDELOAD=1) leaves them out and this script strips whatever the
# prebuild left in the entitlements file. The app copes: its presence key stays a Secure Enclave key, unattested.
#
# Settings (environment): VYRE_SIGN_IDENTITY (default the Apple Development identity found in the login keychain), VYRE_IOS_BUNDLE_ID (default sh.vyre.sideload.<team id>),
# VYRE_IOS_TEAM (default read from the identity's certificate), VYRE_IOS_DEVICE (a devicectl device name or id; default the one connected iPhone).
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
mode=build
case "${1:-}" in --install) mode=install ;; --install-only) mode=install-only ;; "") ;; *) echo "usage: $0 [--install|--install-only]" >&2; exit 2 ;; esac

say() { printf '%s\n' "$*"; }
die() { printf 'ios-sideload: %s\n' "$*" >&2; exit 1; }

IDENTITY=${VYRE_SIGN_IDENTITY:-}
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)
fi
[ -n "$IDENTITY" ] || die "no Apple Development signing identity in the keychain (set VYRE_SIGN_IDENTITY)"
TEAM=${VYRE_IOS_TEAM:-$(security find-certificate -c "$IDENTITY" -p | openssl x509 -noout -subject | sed -n 's/.*OU=\([A-Z0-9]*\).*/\1/p' | head -1)}
[ -n "$TEAM" ] || die "could not read the team id from $IDENTITY (set VYRE_IOS_TEAM)"
BUNDLE=${VYRE_IOS_BUNDLE_ID:-sh.vyre.sideload.$(printf '%s' "$TEAM" | tr 'A-Z' 'a-z')}
OUT="$APP_DIR/ios/dd/Build/Products/Release-iphoneos"

install_app() {
  local app dev
  app=$(find "$OUT" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)
  [ -n "$app" ] || die "no built .app under $OUT (run without --install-only first)"
  dev=${VYRE_IOS_DEVICE:-}
  if [ -z "$dev" ]; then
    dev=$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && /(connected|available \(paired\))/ { for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{4}-/) { print $i; exit } }')
  fi
  [ -n "$dev" ] || die "no iPhone is connected. Plug it in by USB, unlock it, tap Trust, turn on Developer Mode (Settings, Privacy and Security), then rerun with --install."
  say "installing $(basename "$app") on $dev"
  xcrun devicectl device install app --device "$dev" "$app"
  say "installed. First launch: Settings, General, VPN and Device Management, trust \"$IDENTITY\"."
}

if [ "$mode" = install-only ]; then install_app; exit 0; fi

command -v node >/dev/null || die "node is not on PATH"
command -v pod >/dev/null || die "CocoaPods is not installed (brew install cocoapods)"
xcodebuild -version >/dev/null || die "Xcode is not installed or selected"

export EXPO_NO_TELEMETRY=1 VYRE_SIDELOAD=1 VYRE_IOS_BUNDLE_ID="$BUNDLE"
# A real build talks to the person's own server: never the sample world (deck/ui/store.js).
unset EXPO_PUBLIC_VYRE_MOCK

say "identity  $IDENTITY"; say "team      $TEAM"; say "bundle id $BUNDLE"

[ -d node_modules ] || nice -n 10 npm ci --no-audit --no-fund
nice -n 10 npx expo prebuild -p ios --clean

# Entitlements a personal team cannot hold. The prebuild writes only what app.config.js leaves, but be sure.
for f in ios/*/*.entitlements; do
  [ -f "$f" ] || continue
  for k in com.apple.developer.devicecheck.appattest-environment com.apple.developer.associated-domains aps-environment com.apple.security.application-groups \
           com.apple.developer.icloud-container-identifiers com.apple.developer.icloud-services com.apple.developer.ubiquity-kvstore-identifier keychain-access-groups; do
    /usr/libexec/PlistBuddy -c "Delete :$k" "$f" 2>/dev/null || true
  done
done

ws=$(ls -d ios/*.xcworkspace | head -1); scheme=$(basename "$ws" .xcworkspace)
say "building $scheme (Release, embedded bundle)"
set -o pipefail
nice -n 10 xcodebuild -workspace "$ws" -scheme "$scheme" -configuration Release -destination 'generic/platform=iOS' -derivedDataPath ios/dd \
  -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_IDENTITY="$IDENTITY" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" build 2>&1 | tee ios/xcodebuild.log | tail -25

app=$(find "$OUT" -maxdepth 1 -name '*.app' | head -1)
[ -n "$app" ] || die "the build made no .app; see ios/xcodebuild.log"
say "built    $app"
say "signature:"; codesign -dv "$app" 2>&1 | sed -n 's/^\(Identifier\|TeamIdentifier\|Authority\)=/  \1 /p' | head -4
say "entitlements it carries:"; codesign -d --entitlements :- "$app" 2>/dev/null | plutil -p - 2>/dev/null | sed 's/^/  /' || true
if codesign -d --entitlements :- "$app" 2>/dev/null | grep -qE 'appattest|associated-domains|aps-environment|application-groups|icloud'; then die "the app still carries an entitlement a personal team cannot hold"; fi

[ "$mode" = install ] && install_app
say "done. Install later with: scripts/ios-sideload.sh --install-only"
