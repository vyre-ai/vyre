#!/bin/bash
# The release job's Android step (release.yml, stable only): sign the unsigned APK the native-android build made with the sideload key and put it in dist.
#   UNSIGNED=<dir with vyre-release-unsigned.apk and SHA256SUMS-build> DIST=dist VERSION=x.y.z TAG=vX.Y.Z PUBLISH=true|false \
#   ANDROID_SIDELOAD_KEYSTORE_B64=... ANDROID_SIDELOAD_KEYSTORE_PASSWORD=... ANDROID_SIDELOAD_KEY_ALIAS=... ANDROID_SIDELOAD_KEY_PASSWORD=... \
#   [ANDROID_SIGNING=required] GH_TOKEN=... GITHUB_REPOSITORY=... bash scripts/native/android-release.sh
# A dry run (PUBLISH not true) holds no key and signs nothing: native-android.yml already proved the signing path with a throwaway key.
# With a key missing it prints one "skipped:" line and the release goes out without an APK, unless ANDROID_SIGNING=required, which fails it.
# The certificate pin is read from the PREVIOUS published release's tag (the newest one that has a real pin), never from the commit being released, so
# one commit cannot change the key and its pin. The first signing has no such tag: it uses the pin in this commit, and the approver has seen both that
# diff (the signing-path summary) and the fingerprint the record_cert run printed.
set -euo pipefail
set +x
: "${UNSIGNED:?}" "${DIST:?}" "${VERSION:?}" "${TAG:?}"
if [ "${PUBLISH:-}" != true ]; then echo "Android: a dry run signs nothing (the throwaway-key proof ran in native-android)"; exit 0; fi

skip() {
  echo "skipped: $1 is not set in the release environment, so this release has no Android APK"
  [ "${ANDROID_SIGNING:-}" != required ] || { echo "ANDROID_SIGNING is required: refusing to publish a release without the APK"; exit 1; }
  exit 0
}
[ -n "${ANDROID_SIDELOAD_KEYSTORE_B64:-}" ] || skip ANDROID_SIDELOAD_KEYSTORE_B64
[ -n "${ANDROID_SIDELOAD_KEYSTORE_PASSWORD:-}" ] || skip ANDROID_SIDELOAD_KEYSTORE_PASSWORD
[ -n "${ANDROID_SIDELOAD_KEY_ALIAS:-}" ] || skip ANDROID_SIDELOAD_KEY_ALIAS
[ -n "${ANDROID_SIDELOAD_KEY_PASSWORD:-}" ] || skip ANDROID_SIDELOAD_KEY_PASSWORD
for s in "$ANDROID_SIDELOAD_KEYSTORE_B64" "$ANDROID_SIDELOAD_KEYSTORE_PASSWORD" "$ANDROID_SIDELOAD_KEY_ALIAS" "$ANDROID_SIDELOAD_KEY_PASSWORD"; do echo "::add-mask::$s"; done

(cd "$UNSIGNED" && sha256sum -c SHA256SUMS-build)

# The pin: the newest earlier release whose tag carries a real sideload line.
pin_from=""; pin_line=""
for t in $(gh release list -R "${GITHUB_REPOSITORY:?}" --exclude-drafts --limit 10 --json tagName --jq '.[].tagName'); do
  [ "$t" != "$TAG" ] || continue
  git fetch --no-tags --depth=1 origin "refs/tags/$t:refs/tags/$t" >/dev/null 2>&1 || continue
  line=$(git show "refs/tags/$t:docs/native/android-cert.sha256" 2>/dev/null | awk '$1 == "sideload" && $2 != "PENDING" {print; exit}' || true)
  if [ -n "$line" ]; then pin_from=$t; pin_line=$line; break; fi
done
pinfile="$RUNNER_TEMP/android-cert.pin"
if [ -n "$pin_line" ]; then
  echo "$pin_line" > "$pinfile"; echo "certificate pin: from the tag $pin_from"
else
  awk '$1 == "sideload" && $2 != "PENDING" {print; exit}' docs/native/android-cert.sha256 > "$pinfile"
  [ -s "$pinfile" ] || { echo "FIRST SIGNING and docs/native/android-cert.sha256 says PENDING: run native-android with record_cert, check the fingerprint is your key, commit it"; exit 1; }
  echo "certificate pin: FIRST SIGNING, no earlier release carries one, so this commit's pin is used (compare it with the record_cert run)"
fi

umask 077
ks="$RUNNER_TEMP/sideload.p12"; out="$RUNNER_TEMP/android-signed"
trap 'rm -f "$ks" "$pinfile"' EXIT
printf '%s' "$ANDROID_SIDELOAD_KEYSTORE_B64" | base64 -d > "$ks"
KEYSTORE_FILE="$ks" KS_PASS="$ANDROID_SIDELOAD_KEYSTORE_PASSWORD" KEY_ALIAS="$ANDROID_SIDELOAD_KEY_ALIAS" KEY_PASS="$ANDROID_SIDELOAD_KEY_PASSWORD" \
  APK_IN="$UNSIGNED/vyre-release-unsigned.apk" OUT_DIR="$out" OUT_NAME="Vyre_${VERSION}_android.apk" PIN_MODE=enforce PIN_FILE="$pinfile" PIN_KEY=sideload \
  bash scripts/native/android-sign.sh
cp "$out/Vyre_${VERSION}_android.apk" "$DIST/Vyre_${VERSION}_android.apk"
cp "$out/Vyre_${VERSION}_android.apk" "$DIST/Vyre-android.apk"
echo "Android: Vyre_${VERSION}_android.apk and Vyre-android.apk are in dist, signed with the sideload key"
