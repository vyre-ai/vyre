#!/bin/bash
# Sign an unsigned release APK with the sideload key, verify it, and compare its certificate with the pin.
#   APK_IN=... OUT_DIR=... [OUT_NAME=Vyre.apk] KEYSTORE_FILE=... KS_PASS=... KEY_ALIAS=... KEY_PASS=... \
#     [PIN_MODE=enforce|none] [PIN_FILE=docs/native/android-cert.sha256] [PIN_KEY=sideload] bash scripts/native/android-sign.sh
#   RECORD_CERT=1 KEYSTORE_FILE=... KS_PASS=... KEY_ALIAS=... bash scripts/native/android-sign.sh     prints the certificate's SHA-256 and nothing else
# It runs only the platform's own tools (zipalign, apksigner, keytool), never npm or gradle, because it runs in the job that holds the real key.
# Passwords come through the environment (apksigner reads env:NAME, keytool -storepass:env), never arguments, and nothing here prints one;
# only certificate fingerprints are printed. The keystore must hold exactly one key, under KEY_ALIAS.
# PIN_MODE=enforce fails unless the certificate's SHA-256 equals the PIN_KEY line of PIN_FILE ("<name> <sha256>", lower-case hex, no colons).
# A line that says PENDING fails closed after printing the fingerprint to commit. PIN_MODE=none is for the throwaway-key dry run only.
set -euo pipefail
set +x
: "${KEYSTORE_FILE:?}" "${KS_PASS:?}" "${KEY_ALIAS:?}"
export KS_PASS
[ -z "${KEY_PASS:-}" ] || export KEY_PASS

# The one key in the keystore, by name and fingerprint. Output is kept in a variable (no pipe closes early on a long listing).
listing=$(keytool -list -v -keystore "$KEYSTORE_FILE" -storepass:env KS_PASS 2>&1) || { echo "could not open the keystore"; exit 1; }
n=$(printf '%s\n' "$listing" | grep -c '^Alias name: ' || true)
[ "$n" = 1 ] || { echo "the keystore holds $n keys; it must hold exactly one"; exit 1; }
alias_found=$(printf '%s\n' "$listing" | sed -n 's/^Alias name: //p')
[ "$(printf '%s' "$alias_found" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$KEY_ALIAS" | tr 'A-Z' 'a-z')" ] || { echo "the keystore's key is not the alias that was asked for"; exit 1; }
printf '%s\n' "$listing" | grep -q '^Entry type: PrivateKeyEntry' || { echo "the keystore entry is not a private key"; exit 1; }
key_cert=$(printf '%s\n' "$listing" | sed -n 's/^[[:space:]]*SHA256: //p' | head -1 | tr -d ':' | tr 'A-F' 'a-f' || true)
[ -n "$key_cert" ] || { echo "could not read the key's certificate"; exit 1; }
echo "key certificate sha256: $key_cert"
printf '%s\n' "$listing" | sed -n 's/^Owner: /key certificate subject: /p' | head -1 || true

if [ "${RECORD_CERT:-}" = 1 ]; then exit 0; fi
: "${APK_IN:?}" "${OUT_DIR:?}" "${KEY_PASS:?}"
PIN_MODE=${PIN_MODE:-enforce}
bt=$(ls -d "${ANDROID_HOME:?}"/build-tools/* | sort -V | tail -1)
mkdir -p "$OUT_DIR"

apk_out="$OUT_DIR/${OUT_NAME:-$(basename "$APK_IN" | sed 's/-unsigned//')}"
"$bt/zipalign" -p -f 4 "$APK_IN" "$OUT_DIR/aligned.tmp"
"$bt/apksigner" sign --ks "$KEYSTORE_FILE" --ks-key-alias "$KEY_ALIAS" --ks-pass env:KS_PASS --key-pass env:KEY_PASS \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --out "$apk_out" "$OUT_DIR/aligned.tmp" </dev/null
rm -f "$OUT_DIR/aligned.tmp" "$apk_out.idsig"
report=$("$bt/apksigner" verify --verbose --print-certs --min-sdk-version 24 "$apk_out" 2>&1) || { printf '%s\n' "$report"; echo "apksigner does not verify the signed APK"; exit 1; }
printf '%s\n' "$report" | grep -E '^(Verifies|Verified using v[23] scheme|Number of signers)'
apk_cert=$(printf '%s\n' "$report" | sed -n 's/^Signer.* certificate SHA-256 digest: //p' | head -1 | tr 'A-F' 'a-f' || true)
[ -n "$apk_cert" ] || { echo "could not read the APK's signing certificate; apksigner said:"; printf '%s\n' "$report" | grep -i 'signer\|certificate' | cut -c1-120 || true; exit 1; }
[ "$apk_cert" = "$key_cert" ] || { echo "the APK's certificate is not the keystore's ($apk_cert vs $key_cert)"; exit 1; }

echo "signing certificate sha256: $apk_cert"
case "$PIN_MODE" in
  none) echo "pin check skipped (PIN_MODE=none: a throwaway key)" ;;
  enforce)
    pinned=$(awk -v k="${PIN_KEY:-sideload}" '$1 == k {print tolower($2); exit}' "${PIN_FILE:?PIN_MODE=enforce needs PIN_FILE}")
    if [ "$pinned" = pending ] || [ -z "$pinned" ]; then
      echo "FAIL: ${PIN_FILE} has no pinned certificate for ${PIN_KEY:-sideload} (PENDING). Commit this fingerprint after you have checked it is your key: $apk_cert"; exit 1
    fi
    [ "$pinned" = "$apk_cert" ] || { echo "FAIL: the signing certificate is not the pinned one (pinned $pinned, got $apk_cert)"; exit 1; } ;;
  *) echo "PIN_MODE must be enforce or none"; exit 1 ;;
esac
