#!/bin/bash
# Sign an unsigned release APK and AAB with one keystore, verify both, and compare the certificate with the pinned one.
#   APK_IN=... AAB_IN=... OUT_DIR=... KEYSTORE_FILE=... KS_PASS=... KEY_ALIAS=... KEY_PASS=... [PIN_FILE=docs/native/android-cert.sha256] [PIN_MODE=enforce|none] \
#     bash scripts/native/android-sign.sh
# It runs only the platform's own tools (zipalign, apksigner, jarsigner), never npm or gradle, because it runs in the one job that holds the
# real key. Passwords come through the environment (apksigner reads env:NAME, jarsigner -storepass:env), never arguments, and nothing here
# prints one. PIN_MODE=enforce fails unless the certificate's SHA-256 equals the first word of PIN_FILE; a PIN_FILE that says PENDING fails
# closed after printing the fingerprint to commit (a reviewed commit records it). PIN_MODE=none is for the throwaway-key dry run only.
set -euo pipefail
set +x
: "${APK_IN:?}" "${AAB_IN:?}" "${OUT_DIR:?}" "${KEYSTORE_FILE:?}" "${KS_PASS:?}" "${KEY_ALIAS:?}" "${KEY_PASS:?}"
PIN_MODE=${PIN_MODE:-enforce}
bt=$(ls -d "${ANDROID_HOME:?}"/build-tools/* | sort -V | tail -1)
mkdir -p "$OUT_DIR"
export KS_PASS KEY_PASS

# Pull the digest out of `apksigner verify --print-certs` (lower-case hex, no colons).
cert_of() { "$bt/apksigner" verify --print-certs "$1" 2>/dev/null | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -1 | tr 'A-F' 'a-f'; }

apk_out="$OUT_DIR/$(basename "$APK_IN" | sed 's/-unsigned//; s/\.apk$//')-signed.apk"
"$bt/zipalign" -p -f 4 "$APK_IN" "$OUT_DIR/aligned.tmp"
"$bt/apksigner" sign --ks "$KEYSTORE_FILE" --ks-key-alias "$KEY_ALIAS" --ks-pass env:KS_PASS --key-pass env:KEY_PASS \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --out "$apk_out" "$OUT_DIR/aligned.tmp" </dev/null
rm -f "$OUT_DIR/aligned.tmp" "$apk_out.idsig"
"$bt/apksigner" verify --verbose --min-sdk-version 24 "$apk_out" | head -8
apk_cert=$(cert_of "$apk_out")
[ -n "$apk_cert" ] || { echo "could not read the APK's signing certificate"; exit 1; }

aab_out="$OUT_DIR/$(basename "$AAB_IN" | sed 's/-unsigned//; s/\.aab$//')-signed.aab"
cp "$AAB_IN" "$aab_out"
jarsigner -keystore "$KEYSTORE_FILE" -storepass:env KS_PASS -keypass:env KEY_PASS -sigalg SHA256withRSA -digestalg SHA-256 "$aab_out" "$KEY_ALIAS" >/dev/null
jarsigner -verify "$aab_out" | head -3
aab_cert=$(keytool -printcert -jarfile "$aab_out" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p' | head -1 | tr -d ':' | tr 'A-F' 'a-f')
[ "$apk_cert" = "$aab_cert" ] || { echo "the APK and the AAB carry different certificates ($apk_cert vs $aab_cert)"; exit 1; }

echo "signing certificate sha256: $apk_cert"
case "$PIN_MODE" in
  none) echo "pin check skipped (PIN_MODE=none: a throwaway key)" ;;
  enforce)
    pinned=$(awk 'NF && $1 !~ /^#/ {print tolower($1); exit}' "${PIN_FILE:?PIN_MODE=enforce needs PIN_FILE}")
    if [ "$pinned" = pending ] || [ -z "$pinned" ]; then
      echo "FAIL: ${PIN_FILE} says PENDING. Commit this fingerprint after you have checked it is your key: $apk_cert"; exit 1
    fi
    [ "$pinned" = "$apk_cert" ] || { echo "FAIL: the signing certificate is not the pinned one (pinned $pinned, got $apk_cert)"; exit 1; } ;;
  *) echo "PIN_MODE must be enforce or none"; exit 1 ;;
esac
( cd "$OUT_DIR" && sha256sum "$(basename "$apk_out")" "$(basename "$aab_out")" > SHA256SUMS-android )
cat "$OUT_DIR/SHA256SUMS-android"
