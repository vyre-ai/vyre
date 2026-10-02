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
# checksum pinned inside that script), and the two small sudo helpers. They sit inside the app's signature.
#
# Signing is the person's, and optional. With the Developer ID secrets in the environment the app is signed
# with the hardened runtime and notarized and stapled; with none, it stays signed with the identity build.sh
# gave it (ad hoc) and the output says so, because macOS then asks the person to right-click Open once.
#   APPLE_DEVELOPER_ID_P12 (base64), APPLE_DEVELOPER_ID_P12_PASSWORD, APPLE_DEVELOPER_ID_IDENTITY (the certificate's name)
#   notarization, either an App Store Connect API key: APPLE_NOTARY_KEY_P8 (base64), APPLE_NOTARY_KEY_ID, APPLE_NOTARY_ISSUER
#   or an Apple ID: APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID
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
chmod 755 "$setup/install-mac-server.sh" "$setup/askpass" "$setup/vyre-sudo"
printf '{"node":"%s","arch":"%s","nodeSha256":"%s"}\n' "$nodev" "$na" "$want" > "$setup/setup.json"

signed=adhoc; notarized=no
if [ -n "${APPLE_DEVELOPER_ID_P12:-}" ] && [ -n "${APPLE_DEVELOPER_ID_IDENTITY:-}" ]; then
  kc="$work/sign.keychain-db"; pw="$(uuidgen)"
  printf %s "$APPLE_DEVELOPER_ID_P12" | base64 -d > "$work/id.p12"
  security create-keychain -p "$pw" "$kc"
  security set-keychain-settings -lut 3600 "$kc"
  security unlock-keychain -p "$pw" "$kc"
  security import "$work/id.p12" -k "$kc" -P "${APPLE_DEVELOPER_ID_P12_PASSWORD:-}" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$pw" "$kc" >/dev/null
  security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
  codesign --force --options runtime --timestamp --entitlements "$ent" --identifier sh.vyre.capsule \
    --sign "$APPLE_DEVELOPER_ID_IDENTITY" --keychain "$kc" "$stage"
  codesign --verify --strict --verbose=2 "$stage"
  signed=developer-id
  zipfor="$work/notarize.zip"; ditto -c -k --keepParent "$stage" "$zipfor"
  if [ -n "${APPLE_NOTARY_KEY_P8:-}" ] && [ -n "${APPLE_NOTARY_KEY_ID:-}" ] && [ -n "${APPLE_NOTARY_ISSUER:-}" ]; then
    printf %s "$APPLE_NOTARY_KEY_P8" | base64 -d > "$work/key.p8"
    xcrun notarytool submit "$zipfor" --key "$work/key.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER" --wait
    xcrun stapler staple "$stage"; notarized=yes
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    xcrun notarytool submit "$zipfor" --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
    xcrun stapler staple "$stage"; notarized=yes
  else
    echo "signed with Developer ID, but there is no notarization credential: the app is NOT notarized" >&2
  fi
fi

zip="$out/Vyre-Lumen_${version}_${arch}.zip"; dmg="$out/Vyre-Lumen_${version}_${arch}.dmg"
ditto -c -k --keepParent "$stage" "$zip"
mkdir "$work/dmg"; ditto "$stage" "$work/dmg/Vyre Lumen.app"; ln -s /Applications "$work/dmg/Applications"
hdiutil create -volname "Vyre Lumen" -srcfolder "$work/dmg" -ov -format UDZO "$dmg" >/dev/null
if [ "$notarized" = yes ]; then xcrun stapler staple "$dmg" || true; fi
cp "$zip" "$out/Vyre-Lumen-${arch}.zip"; cp "$dmg" "$out/Vyre-Lumen-${arch}.dmg"
echo "lumen app: signed=$signed notarized=$notarized"
( cd "$out" && shasum -a 256 Vyre-Lumen*.zip Vyre-Lumen*.dmg )
printf 'arch=%s\nnode=%s\nsigned=%s\nnotarized=%s\n' "$arch" "$nodev" "$signed" "$notarized" > "$out/mac-app-$arch.status"
