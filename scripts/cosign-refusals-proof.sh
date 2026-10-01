#!/bin/bash
# The installer's image check against REAL images on a local registry, on a CI runner only. install-box.sh verifies each image with
# the pinned cosign container, the release workflow's identity and GitHub's OIDC issuer, then pulls it by digest. Here the very
# same command (its image, identity and issuer are read out of install-box.sh, so they cannot drift) is run against:
#   1. an unsigned image            -> refused
#   2. an image signed by another signer (a throwaway key, not the release workflow) -> refused
#   3. a tag moved to other bytes after release.json named the digest -> the pinned digest still pulls the original bytes
# A correctly signed image needs GitHub's keyless signature and cannot be made here; the release job proves that side.
#   bash scripts/cosign-refusals-proof.sh <out-dir>
set -u
OUT=$1; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
[ -n "${CI:-}" ] || { echo "cosign-refusals-proof.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
FAILED=0
rec() { # rec STEP ok|false [why]
  ok=$2; [ "$ok" = ok ] && ok=true || { ok=false; FAILED=$((FAILED + 1)); }
  printf '{"journey":"COSIGN","step":"%s","ok":%s,"why":"%s"}\n' "$1" "$ok" "$(printf %s "${3:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)" >>"$OUT/results.jsonl"
  echo "$([ "$ok" = true ] && echo pass || echo FAIL)  COSIGN $1 ${3:-}"
}
HERE=$(cd "$(dirname "$0")/.." && pwd)
# The installer's own pins, read from its text.
COSIGN_IMAGE=$(sed -n 's/^COSIGN_IMAGE=\${VYRE_COSIGN_IMAGE:-\(.*\)}$/\1/p' "$HERE/scripts/install-box.sh")
COSIGN_ID=$(sed -n "s/^COSIGN_ID='\(.*\)'$/\1/p" "$HERE/scripts/install-box.sh")
COSIGN_ISSUER=$(sed -n 's/^COSIGN_ISSUER=\(.*\)$/\1/p' "$HERE/scripts/install-box.sh")
case "$COSIGN_IMAGE" in ghcr.io/sigstore/cosign/cosign@sha256:*) ;; *) rec 0-pins false "cannot read the cosign pin out of install-box.sh: '$COSIGN_IMAGE'"; exit 1 ;; esac
[ -n "$COSIGN_ID" ] && [ -n "$COSIGN_ISSUER" ] || { rec 0-pins false "identity or issuer not found in install-box.sh"; exit 1; }
rec 0-pins ok "$COSIGN_IMAGE"
docker pull -q "$COSIGN_IMAGE" >/dev/null 2>&1 || { rec 0-cosign-image false "cannot pull the pinned cosign image"; exit 1; }

docker rm -f vreg >/dev/null 2>&1; docker run -d --name vreg -p 127.0.0.1:5000:5000 registry:2 >/dev/null
for i in $(seq 1 30); do curl -fs http://127.0.0.1:5000/v2/ >/dev/null && break; sleep 1; done
# Two small images: the "release" one and an "other bytes" one.
W=$(mktemp -d); printf 'FROM alpine:3.20\nRUN echo release > /r\n' >"$W/Dockerfile"; docker build -q -t 127.0.0.1:5000/vyre-ai/vyre:v0 "$W" >/dev/null
printf 'FROM alpine:3.20\nRUN echo other-bytes > /r\n' >"$W/Dockerfile"; docker build -q -t 127.0.0.1:5000/vyre-ai/vyre:other "$W" >/dev/null
docker push -q 127.0.0.1:5000/vyre-ai/vyre:v0 >/dev/null; docker push -q 127.0.0.1:5000/vyre-ai/vyre:other >/dev/null
digest() { docker buildx imagetools inspect "$1" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"' || true; }
D0=$(digest 127.0.0.1:5000/vyre-ai/vyre:v0); DO=$(digest 127.0.0.1:5000/vyre-ai/vyre:other)
[ -n "$D0" ] && [ -n "$DO" ] && [ "$D0" != "$DO" ] && rec 1-registry ok "release $D0, other $DO" || { rec 1-registry false "digests: '$D0' '$DO'"; exit 1; }
REF="127.0.0.1:5000/vyre-ai/vyre@$D0"
verify() { docker run --rm --network host "$COSIGN_IMAGE" verify --allow-insecure-registry --certificate-identity-regexp "$COSIGN_ID" --certificate-oidc-issuer "$COSIGN_ISSUER" "$1" 2>&1; }

# 2 unsigned
out=$(verify "$REF"); rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -qiE 'no signatures found|no matching signatures' && rec 2-unsigned-refused ok "$(echo "$out" | grep -iE 'no (matching )?signatures' | head -1)" || rec 2-unsigned-refused false "rc $rc: $(echo "$out" | tail -3)"

# 3 signed by another signer: a throwaway key, no certificate from the release workflow
KD=$(mktemp -d); docker run --rm --user "$(id -u):$(id -g)" -v "$KD:/k" -w /k -e COSIGN_PASSWORD= "$COSIGN_IMAGE" generate-key-pair >"$OUT/keygen.log" 2>&1
if [ -s "$KD/cosign.key" ]; then
  docker run --rm --network host -v "$KD:/k" -e COSIGN_PASSWORD= "$COSIGN_IMAGE" sign --yes --key /k/cosign.key --allow-insecure-registry --tlog-upload=false "$REF" >"$OUT/sign.log" 2>&1
  # It is now signed, by a key: with the keyless identity the installer demands it must still be refused.
  docker run --rm --network host -v "$KD:/k" "$COSIGN_IMAGE" verify --key /k/cosign.pub --allow-insecure-registry --insecure-ignore-tlog "$REF" >/dev/null 2>&1 && signed=1 || signed=0
  out=$(verify "$REF"); rc=$?
  [ "$signed" = 1 ] && [ $rc -ne 0 ] && rec 3-wrong-signer-refused ok "signed by a throwaway key, refused by the release identity: $(echo "$out" | tail -1)" || rec 3-wrong-signer-refused false "signed=$signed rc=$rc: $(echo "$out" | tail -3) $(tail -2 "$OUT/sign.log")"
else rec 3-wrong-signer-refused false "could not make a throwaway key: $(tail -2 "$OUT/keygen.log")"; fi

# 4 the tag is moved to other bytes after the release named the digest: the pinned digest is not the tag
docker tag 127.0.0.1:5000/vyre-ai/vyre:other 127.0.0.1:5000/vyre-ai/vyre:v0 && docker push -q 127.0.0.1:5000/vyre-ai/vyre:v0 >/dev/null
Dnow=$(digest 127.0.0.1:5000/vyre-ai/vyre:v0)
docker rmi -f 127.0.0.1:5000/vyre-ai/vyre:v0 >/dev/null 2>&1; docker rmi -f "$REF" >/dev/null 2>&1
docker pull -q "$REF" >/dev/null 2>&1
got=$(docker run --rm "$REF" cat /r 2>/dev/null)
[ "$Dnow" = "$DO" ] && [ "$got" = release ] && rec 4-moved-tag-pinned ok "the tag now points at $DO, the pinned digest still gives the release bytes" || rec 4-moved-tag-pinned false "tag at $Dnow, pinned digest ran '$got'"
# and the installer would refuse a tag in the first place (its release.json check wants name@sha256:<64 hex>)
printf '%s' "127.0.0.1:5000/vyre-ai/vyre:v0" | grep -Eq '^ghcr\.io/vyre-ai/[a-z-]+@sha256:[0-9a-f]{64}$' && rec 4b-tag-not-accepted false "a tag passed the installer's ref pattern" || rec 4b-tag-not-accepted ok

docker rm -f vreg >/dev/null 2>&1
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
