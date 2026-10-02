#!/bin/bash
# The iOS TestFlight step: export the UNSIGNED archive the build job made, signed by Apple's cloud-managed signing, and upload it to App Store Connect.
#   ARCHIVE_TGZ=<Vyre.xcarchive.tgz> ARCHIVE_SHA256=<its sha256 from the build job> EXPECT_BUNDLE_ID=sh.vyre.app EXPECT_TAG=vX.Y.Z EXPECT_BUILD=n WORK=<scratch dir> \
#   ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_KEY_P8=<the .p8 text> APPLE_TEAM_ID=... bash scripts/native/ios-upload.sh
# It runs in the job with the `apple` environment (a required reviewer, v* tags only) and nothing else runs there: no npm, no pods. The key file is written
# mode 600 and deleted on exit; the key's id, issuer and path are the only things on the xcodebuild command line, never the key's text.
# A missing secret prints one "skipped:" line and ends well. XCODEBUILD overrides the tool (the test uses a fake).
set -euo pipefail
set +x
: "${ARCHIVE_TGZ:?}" "${ARCHIVE_SHA256:?}" "${WORK:?}"
skip() { echo "skipped: $1 is not set in the apple environment, so nothing was sent to TestFlight"; exit 0; }
[ -n "${ASC_KEY_ID:-}" ] || skip ASC_KEY_ID
[ -n "${ASC_ISSUER_ID:-}" ] || skip ASC_ISSUER_ID
[ -n "${ASC_KEY_P8:-}" ] || skip ASC_KEY_P8
[ -n "${APPLE_TEAM_ID:-}" ] || skip APPLE_TEAM_ID
echo "::add-mask::$ASC_KEY_ID"; echo "::add-mask::$ASC_ISSUER_ID"; echo "::add-mask::$APPLE_TEAM_ID"
printf '%s\n' "$ASC_KEY_P8" | while IFS= read -r l; do [ -z "$l" ] || echo "::add-mask::$l"; done
case "$APPLE_TEAM_ID" in *[!A-Z0-9]*) echo "APPLE_TEAM_ID is not a ten-character team id"; exit 1 ;; esac

got=$(shasum -a 256 "$ARCHIVE_TGZ" | cut -d' ' -f1)
[ "$got" = "$ARCHIVE_SHA256" ] || { echo "the archive is not the one the build job made (sha256 $got, expected $ARCHIVE_SHA256)"; exit 1; }
echo "archive sha256: $got"

umask 077
mkdir -p "$WORK/archive"; key="$WORK/AuthKey.p8"; trap 'rm -f "$key"' EXIT
tar -xzf "$ARCHIVE_TGZ" -C "$WORK/archive"
archive=$(ls -d "$WORK"/archive/*.xcarchive | head -1)
[ -d "$archive" ] || { echo "no .xcarchive in the tarball"; exit 1; }
# The checksum only proves the archive was not changed in transit. Before the key is written, read what the archive says it is, against values the
# workflow supplied: the bundle id, the release version, the build number, and no usage key that is not listed.
: "${EXPECT_BUNDLE_ID:?}" "${EXPECT_TAG:?}" "${EXPECT_BUILD:?}"
# The version comes from the tag this run was started by (vX.Y.Z or vX.Y.Z-rc.N), not from the build job whose archive is being checked.
EXPECT_VERSION=${EXPECT_TAG#v}; EXPECT_VERSION=${EXPECT_VERSION%%-*}
apps=("$archive"/Products/Applications/*.app)
[ "${#apps[@]}" = 1 ] && [ -d "${apps[0]}" ] || { echo "the archive must hold exactly one app; it holds ${#apps[@]}"; exit 1; }
app=${apps[0]}
plists="$app/Info.plist $({ find "$app/PlugIns" -name Info.plist 2>/dev/null || true; } | tr '\n' ' ')"
# shellcheck disable=SC2086
node scripts/native/check-permissions.mjs ios-expect "$EXPECT_BUNDLE_ID" "$EXPECT_VERSION" "$EXPECT_BUILD" $plists
printf '%s\n' "$ASC_KEY_P8" > "$key"
cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${APPLE_TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
"${XCODEBUILD:-xcodebuild}" -exportArchive -archivePath "$archive" -exportPath "$WORK/export" -exportOptionsPlist "$WORK/ExportOptions.plist" \
  -allowProvisioningUpdates -authenticationKeyPath "$key" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
echo "uploaded to App Store Connect: the build appears in TestFlight once Apple has processed it"
