#!/bin/sh
# mac-app-package: Lumen's built Vyre.app as the files a release carries (CI, macOS only).
#
#   sh scripts/mac-app-package.sh <version> <aarch64|x86_64> <path/to/Vyre.app> <out dir>
#
# One file pair per architecture, the way Windows has Vyre_<version>_x64-setup.exe and VyreSetup.exe:
#   Vyre-Lumen_<version>_<arch>.dmg   Vyre-Lumen_<version>_<arch>.zip
#   Vyre-Lumen-<arch>.dmg             Vyre-Lumen-<arch>.zip          (the same files under the stable names)
#
# The app carries what it needs to set Vyre up with no terminal and no Node on the Mac: in Contents/Resources/setup,
# scripts/install-mac-server.sh, the pinned Node tarball for this architecture (VYRE_NODE_TGZ, checked here against the
# checksum pinned inside that script), and the sudo helpers (vyre-sudo, which runs only the installer's root step, pinned by the generated vyre-sudo-check). They sit inside the app's signature.
#
# Signing is the person's, and optional. With the Developer ID secrets in the environment the app is signed
# with the hardened runtime and notarized and stapled; with none, it stays signed with the identity build.sh
# gave it (ad hoc) and the output says so, because macOS then asks the person to right-click Open once.
#   APPLE_DEVELOPER_ID_P12 (base64), APPLE_DEVELOPER_ID_P12_PASSWORD, APPLE_DEVELOPER_ID_IDENTITY (the certificate's name)
#   notarization, either an App Store Connect API key: APPLE_NOTARY_KEY_P8 (base64), APPLE_NOTARY_KEY_ID, APPLE_NOTARY_ISSUER
#   No secret is ever a command-line argument: the .p12 is re-exported with an empty password (the password read from the environment) and the
#   notary key goes into a notarytool keychain profile in the same throwaway keychain, which the EXIT trap deletes. An Apple ID password is not supported.
set -eu
[ "$#" = 4 ] || { echo "usage: mac-app-package.sh <version> <aarch64|x86_64> <Vyre.app> <out dir>" >&2; exit 2; }
version="$1"; arch="$2"; app="$3"; out="$4"
case "$arch" in aarch64) na=arm64; pin=NODE_SHA256_ARM64 ;; x86_64) na=x64; pin=NODE_SHA256_X64 ;; *) echo "unknown architecture $arch" >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
ent="$here/../local/capsule/native/Lumen.entitlements"
[ -d "$app" ] || { echo "no app at $app" >&2; exit 1; }
mkdir -p "$out"
work="$(mktemp -d)"
trap 'security delete-keychain "$work/sign.keychain-db" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
stage="$work/Vyre Lumen.app"
ditto "$app" "$stage"
setup="$stage/Contents/Resources/setup"
mkdir -p "$setup"
installer="$here/install-mac-server.sh"
want="$(sed -n "s/^$pin=//p" "$installer" | head -1)"
nodev="$(sed -n 's/^NODE_VERSION=//p' "$installer" | head -1)"
[ -n "$want" ] && [ -n "$nodev" ] || { echo "no pinned Node in $installer" >&2; exit 1; }
[ -f "${VYRE_NODE_TGZ:-}" ] || { echo "VYRE_NODE_TGZ must be the Node $nodev darwin-$na tarball" >&2; exit 1; }
[ "$(shasum -a 256 "$VYRE_NODE_TGZ" | cut -d' ' -f1)" = "$want" ] || { echo "the Node tarball does not match the checksum pinned in install-mac-server.sh" >&2; exit 1; }
cp "$VYRE_NODE_TGZ" "$setup/node-$nodev-darwin-$na.tar.gz"
cp "$installer" "$setup/install-mac-server.sh"; cp "$here/mac-app/askpass" "$here/mac-app/vyre-sudo" "$setup/"
sh "$here/mac-app/make-pins.sh" "$arch" "$setup/vyre-sudo-check"
chmod 755 "$setup/install-mac-server.sh" "$setup/askpass" "$setup/vyre-sudo" "$setup/vyre-sudo-check"
printf '{"node":"%s","arch":"%s","nodeSha256":"%s"}\n' "$nodev" "$na" "$want" > "$setup/setup.json"

# The app's own version is the release's (build.sh stamps whatever package.json said when the app was compiled).
plist="$stage/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" -c "Set :CFBundleVersion $version" "$plist" || { echo "could not stamp the version into $plist" >&2; exit 1; }
# A prerelease is installed from its own tag's release assets (the rc channel): the installer reads this file beside itself. A stable release has none
# and uses vyre.run/box. VYRE_APP_BOX_URL overrides (a rehearsal), and must end in a slash.
case "$version" in *-*) boxurl="https://github.com/vyre-ai/vyre/releases/download/v$version/" ;; *) boxurl="" ;; esac
boxurl="${VYRE_APP_BOX_URL:-$boxurl}"
case "$boxurl" in ""|https://*/) ;; *) echo "VYRE_APP_BOX_URL must be an https URL ending in /" >&2; exit 2 ;; esac
if [ -n "$boxurl" ]; then printf '%s\n' "$boxurl" > "$setup/box-url"; chmod 644 "$setup/box-url"; fi
# The app's web build (apps/app, expo export -p web) rides inside the app, for the mode that talks to a server with no vyred of its own.
if [ -n "${VYRE_APP_WEB_DIR:-}" ]; then
  [ -f "$VYRE_APP_WEB_DIR/index.html" ] || { echo "VYRE_APP_WEB_DIR has no index.html: $VYRE_APP_WEB_DIR" >&2; exit 1; }
  mkdir -p "$stage/Contents/Resources/app"
  ditto "$VYRE_APP_WEB_DIR" "$stage/Contents/Resources/app"
  find "$stage/Contents/Resources/app" -type l | grep -q . && { echo "the web build holds a symlink" >&2; exit 1; }
fi

signed=adhoc; notarized=no
if [ -n "${APPLE_DEVELOPER_ID_P12:-}" ] && [ -n "${APPLE_DEVELOPER_ID_IDENTITY:-}" ]; then
  kc="$work/sign.keychain-db"
  # The keychain is throwaway (it lives in $work and the EXIT trap deletes it), so it gets an empty password: nothing secret is on a command line.
  # The .p12's own password is read by openssl from the environment and the certificate is re-exported without one before security imports it.
  printf %s "$APPLE_DEVELOPER_ID_P12" | base64 -d > "$work/id.p12"
  openssl pkcs12 -in "$work/id.p12" -passin env:APPLE_DEVELOPER_ID_P12_PASSWORD -export -passout pass: -out "$work/id-nopass.p12"
  rm -f "$work/id.p12"
  security create-keychain -p "" "$kc"
  security set-keychain-settings -lut 3600 "$kc"
  security unlock-keychain -p "" "$kc"
  security import "$work/id-nopass.p12" -k "$kc" -P "" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "" "$kc" >/dev/null
  security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
  codesign --force --options runtime --timestamp --entitlements "$ent" --identifier sh.vyre.capsule \
    --sign "$APPLE_DEVELOPER_ID_IDENTITY" --keychain "$kc" "$stage"
  codesign --verify --strict --verbose=2 "$stage"
  signed=developer-id
  # notarize <file>: submit and wait through the keychain profile, and require the verdict "Accepted" in the output (never trust the exit status alone).
  notary=""
  if [ -n "${APPLE_NOTARY_KEY_P8:-}" ] && [ -n "${APPLE_NOTARY_KEY_ID:-}" ] && [ -n "${APPLE_NOTARY_ISSUER:-}" ]; then
    printf %s "$APPLE_NOTARY_KEY_P8" | base64 -d > "$work/key.p8"
    xcrun notarytool store-credentials vyre-notary --key "$work/key.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER" --keychain "$kc" >/dev/null
    rm -f "$work/key.p8"; notary=profile
  else
    echo "skip: notarization (no APPLE_NOTARY_KEY_P8, APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER); signed with Developer ID, the app is NOT notarized" >&2
  fi
  notarize() {
    xcrun notarytool submit "$1" --keychain-profile vyre-notary --keychain "$kc" --wait > "$work/notary.log" 2>&1 || { cat "$work/notary.log" >&2; return 1; }
    cat "$work/notary.log"
    grep -q "status: Accepted" "$work/notary.log" || { echo "notarization of $1 was not Accepted" >&2; return 1; }
  }
  if [ -n "$notary" ]; then
    zipfor="$work/notarize.zip"; ditto -c -k --keepParent "$stage" "$zipfor"
    notarize "$zipfor"; xcrun stapler staple "$stage"; notarized=yes
  fi
else
  echo "skip: Developer ID signing and notarization (no APPLE_DEVELOPER_ID_P12 and APPLE_DEVELOPER_ID_IDENTITY); the app stays ad hoc signed" >&2
fi

zip="$out/Vyre-Lumen_${version}_${arch}.zip"; dmg="$out/Vyre-Lumen_${version}_${arch}.dmg"
ditto -c -k --keepParent "$stage" "$zip"
mkdir "$work/dmg"; ditto "$stage" "$work/dmg/Vyre Lumen.app"; ln -s /Applications "$work/dmg/Applications"
hdiutil create -volname "Vyre Lumen" -srcfolder "$work/dmg" -ov -format UDZO "$dmg" >/dev/null
if [ "$signed" = developer-id ]; then
  # The container is signed too, and notarized and stapled on its own (a ticket for the app inside does not staple to the dmg).
  codesign --force --timestamp --sign "$APPLE_DEVELOPER_ID_IDENTITY" --keychain "$kc" "$dmg"
  codesign --verify --strict --verbose=2 "$dmg"
  if [ "$notarized" = yes ]; then notarize "$dmg"; xcrun stapler staple "$dmg"; fi
fi
if [ "$notarized" = yes ]; then
  # What Gatekeeper will say on a user's Mac, checked here so a release cannot ship a build it would refuse. Any failure stops the script (set -e).
  spctl -a -t exec -vv "$stage"
  xcrun stapler validate "$stage"
  spctl -a -t open --context context:primary-signature -vv "$dmg"
  xcrun stapler validate "$dmg"
  gatekeeper=accepted
else
  gatekeeper=not-checked
fi
cp "$zip" "$out/Vyre-Lumen-${arch}.zip"; cp "$dmg" "$out/Vyre-Lumen-${arch}.dmg"
echo "lumen app: signed=$signed notarized=$notarized gatekeeper=$gatekeeper"
( cd "$out" && shasum -a 256 Vyre-Lumen*.zip Vyre-Lumen*.dmg )
printf 'arch=%s\nnode=%s\nversion=%s\nbox_url=%s\nweb_app=%s\nsigned=%s\nnotarized=%s\ngatekeeper=%s\n' "$arch" "$nodev" "$version" "${boxurl:-default}" "$([ -d "$stage/Contents/Resources/app" ] && echo yes || echo no)" "$signed" "$notarized" "$gatekeeper" > "$out/mac-app-$arch.status"
