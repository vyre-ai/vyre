#!/bin/bash
# J2c: the installer's image-signature refusals against a REAL install and a REAL local TLS registry, on a throwaway CI runner only.
#   bash scripts/matrix/j2c-cosign-refusals.sh <box-dir> <out-dir>
# <box-dir> is the candidate as build-site.sh makes it (site/box). Part A: on a clean host, the real install-box.sh in PULLED mode
# against releases whose release.json names an image by digest (install-box.sh leaves a running install alone, so a refusal is
# shown on a host with nothing installed, and the proof is that nothing is). Part B: `vyre update` on an installed, filled box.
# The cases:
#   1. an image with no signature at all
#   2. an image signed by the wrong identity (a real keyless signature from THIS workflow, which is not Vyre's release workflow)
#   3. an image signed with an ordinary key (a signature exists, but not from the release workflow's identity)
#   4. a digest the registry does not hold (a tag moved away, an image deleted)
# Each must be refused with a plain message, and the refused image must not have been pulled (and, in part B, version and data stay). Part B turns the tgz-built box into a pulled one by deleting the COMPOSE_FILE build line from its .env, since a real pulled baseline needs a real Vyre image. The registry is a local registry:2 with TLS, serving ghcr.io through /etc/hosts and a test CA; the real
# install-box.sh and real cosign run unchanged. Honest limits, stated in the results: (a) the cosign image the installer runs is a
# rebuild of the pinned one (the real binary copied out of it) that carries the test CA and a hosts line, through the installer's own
# test-only VYRE_COSIGN_IMAGE override, because the pinned image has no way to trust a test CA; (b) a POSITIVE control (an image signed by
# the release workflow) cannot be met locally, since no local run can hold that identity: it needs a real signed release.
set -u
BOX=$(cd "$1" && pwd); OUT=$2; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
[ "${GITHUB_ACTIONS:-}" = true ] || { echo "j2c-cosign-refusals.sh: runs on a GitHub Actions runner only (it edits /etc/hosts and docker certs under sudo; GITHUB_ACTIONS is not true)" >&2; exit 2; }
FAILED=0; DIR=/srv/vyre; WORK=$(mktemp -d); PORT=18190; HERE=$(cd "$(dirname "$0")/../.." && pwd)
rec() { # rec STEP ok|false [why]
  ok=$2; [ "$ok" = ok ] && ok=true || { ok=false; FAILED=$((FAILED + 1)); }
  printf '{"journey":"J2c","device":"linux","step":"%s","ok":%s,"why":"%s"}\n' "$1" "$ok" "$(printf %s "${3:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)" >>"$OUT/results.jsonl"
  echo "$([ "$ok" = true ] && echo pass || echo FAIL)  J2c $1 ${3:-}"
}
version() { vyre version 2>/dev/null | tr -d ' \r\n'; }
hv() { if [ -f "$DIR/VERSION" ]; then tr -d ' \r\n' <"$DIR/VERSION"; else version; fi; }
ready() { i=0; until vyre status 2>/dev/null | grep -q 'vyred running'; do i=$((i + 1)); [ $i -ge 120 ] && return 1; sleep 1; done; }
seen() { vyre call planner.list '{}' 2>&1 | grep -q 'retainer draft'; }
mem() { vyre call memory.me '{}' 2>&1 | grep -q 'Robin'; }
: >"$OUT/pids"
serve() { python3 -m http.server "$2" --bind 127.0.0.1 --directory "$1" >/dev/null 2>&1 & echo $! >>"$OUT/pids"; for i in $(seq 1 50); do curl -fs "http://127.0.0.1:$2/VERSION" >/dev/null && return 0; sleep 0.2; done; }

V0=$(tr -d ' \r\n' <"$BOX/VERSION")

# ---- 2 the cosign the installer runs: the real binary, the real pinned image's, carrying the test CA (see the header)
COSIGN_PIN=$(sed -n 's/^COSIGN_IMAGE=\${VYRE_COSIGN_IMAGE:-\(.*\)}$/\1/p' "$BOX/install-box.sh")
[ -n "$COSIGN_PIN" ] || { rec 3-cosign-image false "the installer names no pinned cosign image"; exit 1; }
docker pull -q "$COSIGN_PIN" >/dev/null && cid=$(docker create "$COSIGN_PIN" x) || { rec 3-cosign-image false "could not pull the pinned cosign image"; exit 1; }
for p in /ko-app/cosign /cosign /usr/local/bin/cosign; do docker cp "$cid:$p" "$WORK/cosign" 2>/dev/null && break; done
docker rm "$cid" >/dev/null
[ -s "$WORK/cosign" ] || { rec 3-cosign-image false "no cosign binary in the pinned image"; exit 1; }

# ---- 3 the registry: TLS, a test CA, and ghcr.io mapped to it
P="$WORK/pki"; mkdir -p "$P"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$P/ca.key" -out "$P/ca.crt" -subj "/CN=vyre-test-ca" -days 1 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout "$P/reg.key" -out "$P/reg.csr" -subj "/CN=ghcr.io" 2>/dev/null
printf 'subjectAltName=DNS:ghcr.io\n' >"$P/ext.cnf"
openssl x509 -req -in "$P/reg.csr" -CA "$P/ca.crt" -CAkey "$P/ca.key" -CAcreateserial -out "$P/reg.crt" -days 1 -extfile "$P/ext.cnf" 2>/dev/null
sudo mkdir -p /etc/docker/certs.d/ghcr.io && sudo cp "$P/ca.crt" /etc/docker/certs.d/ghcr.io/ca.crt
sudo cp "$P/ca.crt" /usr/local/share/ca-certificates/vyre-test-ca.crt && sudo update-ca-certificates >/dev/null 2>&1
BRIDGE=$(ip -4 addr show docker0 | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | head -1)
printf 'FROM alpine:3.20\nRUN apk add --no-cache ca-certificates\nCOPY cosign /usr/local/bin/cosign\nCOPY ca.crt /usr/local/share/ca-certificates/vyre-test-ca.crt\nRUN update-ca-certificates\nCOPY entry.sh /entry.sh\nENTRYPOINT ["/entry.sh"]\n' >"$WORK/Dockerfile.cosign"
printf '#!/bin/sh\necho "%s ghcr.io" >> /etc/hosts\nexec /usr/local/bin/cosign "$@"\n' "$BRIDGE" >"$WORK/entry.sh"; chmod +x "$WORK/entry.sh" "$WORK/cosign"; cp "$P/ca.crt" "$WORK/ca.crt"
docker build -q -t vyre-cosign-test:1 -f "$WORK/Dockerfile.cosign" "$WORK" >/dev/null && rec 3-cosign-image ok "the pinned cosign binary with the test CA" || { rec 3-cosign-image false "could not build the cosign test image"; exit 1; }
echo "127.0.0.1 ghcr.io" | sudo tee -a /etc/hosts >/dev/null
# dockerd keeps the auth challenge it got from the real ghcr.io when it pulled the pinned cosign image, and would then ask our registry for a token; a restart forgets it
sudo systemctl restart docker && sleep 3
docker run -d --name vyre-testreg -p 443:5000 -v "$P:/certs:ro" -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/reg.crt -e REGISTRY_HTTP_TLS_KEY=/certs/reg.key registry:2 >/dev/null
up=0; for i in $(seq 1 60); do curl -fs --cacert "$P/ca.crt" https://ghcr.io/v2/ >/dev/null 2>&1 && { up=1; break; }; sleep 1; done
[ $up = 1 ] && rec 4-registry ok "a TLS registry answers as ghcr.io" || { rec 4-registry false "the local registry did not come up"; docker logs vyre-testreg 2>&1 | tail -3; exit 1; }

# ---- 4 the images, by digest
mkimg() { # mkimg N -> prints ghcr.io/vyre-ai/vyre@sha256:...
  d="$WORK/img$1"; mkdir -p "$d"; printf 'FROM busybox:1.36\nRUN echo "case %s" > /case\n' "$1" >"$d/Dockerfile"
  docker build -q -t "ghcr.io/vyre-ai/vyre:case$1" "$d" >/dev/null 2>"$OUT/mkimg$1.log" && docker push "ghcr.io/vyre-ai/vyre:case$1" >>"$OUT/mkimg$1.log" 2>&1 || { tail -5 "$OUT/mkimg$1.log" >&2; getent hosts ghcr.io >&2; docker logs --tail 5 vyre-testreg >&2; return 1; }
  r=$(docker inspect --format '{{index .RepoDigests 0}}' "ghcr.io/vyre-ai/vyre:case$1") || return 1
  docker rmi -f "ghcr.io/vyre-ai/vyre:case$1" >/dev/null 2>&1; docker rmi -f "$r" >/dev/null 2>&1; echo "$r"
}
R1=$(mkimg 1); R2=$(mkimg 2); R3=$(mkimg 3)
[ -n "$R1" ] && [ -n "$R2" ] && [ -n "$R3" ] && rec 5-images ok "$R1" || { rec 5-images false "could not build and push the test images"; exit 1; }
# 2: a real keyless signature from this workflow's own identity (not the release workflow's)
if "$WORK/cosign" sign --yes "$R2" >"$OUT/sign-keyless.log" 2>&1; then rec 6a-wrong-identity-signature ok "signed by this workflow"; else rec 6a-wrong-identity-signature false "$(tail -3 "$OUT/sign-keyless.log")"; fi
# 3: an ordinary key
( cd "$WORK" && COSIGN_PASSWORD="" "$WORK/cosign" generate-key-pair >/dev/null 2>&1 )
if COSIGN_PASSWORD="" "$WORK/cosign" sign --yes --key "$WORK/cosign.key" "$R3" >"$OUT/sign-key.log" 2>&1; then rec 6b-key-signature ok "signed with a plain key"; else rec 6b-key-signature false "$(tail -3 "$OUT/sign-key.log")"; fi
R4="ghcr.io/vyre-ai/vyre@sha256:$(printf '0%.0s' $(seq 1 64))"

# ---- 5 a release that names an image by digest, as release.sh will
mkrel() { # mkrel NAME REF
  d="$WORK/$1"; rm -rf "$d"; mkdir -p "$d"; cp -R "$BOX"/. "$d"/
  sed -i "s|\${VYRE_IMAGE:-ghcr.io/vyre-ai/vyre:latest}|$2|" "$d/compose.yml"
  # the installer wants every image pinned (it never pulls tailscale before cosign), so it gets a placeholder digest; an update pulls it, so it stays
  [ "${3:-}" = unpinned ] || sed -i "s|\${VYRE_TAILSCALE_IMAGE:-tailscale/tailscale:stable}|tailscale/tailscale@sha256:$(printf 'a%.0s' $(seq 1 64))|" "$d/compose.yml"
  printf '{"version":"%s","channel":"stable","box":{"ref":"%s"}}\n' "$V0" "$2" >"$d/release.json"
  files=$(awk '{print $2}' "$BOX/SHA256SUMS"; echo release.json)
  (cd "$d" && for f in $(printf '%s\n' $files | sort -u); do sha256sum "$f"; done >SHA256SUMS)
}
refused() { # refused STEP REF WANT_REGEX: a clean host stays clean
  PORT=$((PORT + 1)); mkrel "rel-$1" "$2" ${4:-}; serve "$WORK/rel-$1" $PORT
  out=$(VYRE_BOX_URL="http://127.0.0.1:$PORT/" VYRE_COSIGN_IMAGE=vyre-cosign-test:1 sh "$BOX/install-box.sh" --yes </dev/null 2>&1); rc=$?
  pulled=no; docker image inspect "$2" >/dev/null 2>&1 && pulled=yes
  left=no; [ -e "$DIR/compose.yml" ] || [ -n "$(docker ps -aq --filter label=com.docker.compose.project=vyre 2>/dev/null)" ] && left=yes
  if [ $rc -ne 0 ] && [ $pulled = no ] && [ $left = no ] && printf '%s' "$out" | grep -qiE "${5:-cosign could not verify.*Nothing was installed}" && printf '%s' "$out" | grep -qiE "$3"; then
    rec "$1" ok "$(printf %s "$out" | tail -2)"
  else rec "$1" false "rc $rc, pulled $pulled, left behind $left: $(printf %s "$out" | tail -4)"; fi
}
refused 7-unsigned "$R1" 'no signatures|no matching signatures|not found|MANIFEST'
refused 8-wrong-identity "$R2" 'expected identit|identity|certificate-identity'
refused 9-key-signature "$R3" 'no matching signatures|certificate|expected identit'
refused 10-digest-not-held "$R4" 'MANIFEST_UNKNOWN|not found|no such|unknown|no signatures'

refused 12-moving-tag "$R1" 'not pinned by digest' unpinned 'Nothing was installed'
# ---- part B: `vyre update` on an installed, filled box (launch's verify_release_images). A release signed with the Ed25519 key (the test
# seam VYRE_RELEASE_KEY) that names an image the cosign check cannot accept must be refused before anything changes.
# the baseline: a real install with data
serve "$BOX" 18180
V0=$(tr -d ' \r\n' <"$BOX/VERSION")
if VYRE_BOX_URL=http://127.0.0.1:18180/ VYRE_BUILD=tgz sh "$BOX/install-box.sh" --yes </dev/null >"$OUT/install.log" 2>&1 && ready; then rec B1-install ok "$(version)"
else rec B1-install false "install or start failed: $(tail -3 "$OUT/install.log")"; exit 1; fi
vyre call memory.remember '{"text":"My wife is Robin"}' >/dev/null 2>&1
vyre call planner.add '{"kind":"note","text":"Marlow and Finch retainer draft"}' >/dev/null 2>&1
seen && mem && rec B2-seed ok || rec B2-seed false "seed not readable"
SUMS0=$(sha256sum "$DIR/compose.yml" | cut -d' ' -f1)

ST=/var/lib/vyre-update
# The box was built from vyre.tgz (a real pulled install needs a real Vyre image). Make it a pulled box, as one would be: the
# build line comes out of its .env, so `vyre update` pulls the release's digest instead of building. Disclosed in the header.
# The image the box runs is also put in the local registry as ghcr.io/vyre-ai/vyre:latest, which is what a pulled box would be running.
docker tag vyre:local ghcr.io/vyre-ai/vyre:latest && docker push -q ghcr.io/vyre-ai/vyre:latest >/dev/null
sed -i '/^COMPOSE_FILE=.*compose.build.yml/d' "$DIR/.env"
sudo "$(command -v vyre)" updater install >"$OUT/updater.log" 2>&1; sudo systemctl disable --now vyre-update.path >/dev/null 2>&1
node -e 'const c=require("crypto"),fs=require("fs");const k=c.generateKeyPairSync("ed25519");fs.writeFileSync(process.argv[1]+"/good.pem",k.privateKey.export({type:"pkcs8",format:"pem"}));fs.writeFileSync(process.argv[1]+"/good.pub",k.publicKey.export({type:"spki",format:"der"}).toString("base64"));' "$WORK"
GOODPUB=$(cat "$WORK/good.pub")
mkupd() { # mkupd NAME REF: a newer release, signed by the throwaway key, naming REF for the box image
  mkrel "$1" "$2"; d="$WORK/$1"; printf '9.9.9-e2e.1\n' >"$d/VERSION"
  sed -i 's/"version":"[^"]*"/"version":"9.9.9-e2e.1"/' "$d/release.json"
  fl=$(awk '{print $2}' "$d/SHA256SUMS" | sort -u)
  (cd "$d" && for f in $fl; do sha256sum "$f"; done >SHA256SUMS)
  node -e 'const c=require("crypto"),fs=require("fs");const d=process.argv[1];const sums=fs.readFileSync(d+"/SHA256SUMS");fs.writeFileSync(d+"/SHA256SUMS.sig",c.sign(null,Buffer.concat([Buffer.from("vyre-release-sums\n"),sums]),c.createPrivateKey(fs.readFileSync(process.argv[2]))).toString("base64")+"\n");' "$d" "$WORK/good.pem"
}
askupd() { PORT=$((PORT + 1)); serve "$WORK/$1" $PORT
  sudo sh -c "printf 'update\n' >$ST/request/request"
  out=$(sudo env "VYRE_DIR=$DIR" "VYRE_BOX_URL=http://127.0.0.1:$PORT/" VYRE_RELEASES_API= "VYRE_RELEASE_KEY=$GOODPUB" VYRE_UPDATE_MIN_GAP=0 VYRE_UPDATE_WAIT=300 VYRE_COSIGN_IMAGE=vyre-cosign-test:1 "$(command -v vyre)" update-from-request 2>&1 </dev/null); rc=$?; }
# updrefused STEP NAME REF WANT_REGEX: a signed release whose image the cosign check cannot accept is refused with nothing changed
updrefused() {
  mkupd "$2" "$3"; askupd "$2"; ready; v=$(hv); pulled=no; docker image inspect "$3" >/dev/null 2>&1 && pulled=yes
  if [ $rc -ne 0 ] && [ "$v" = "$V0" ] && seen && mem && [ $pulled = no ] && printf '%s' "$out" | grep -qi 'cosign could not verify.*nothing was changed' && printf '%s' "$out" | grep -qiE "$4"; then rec "$1" ok "$(printf %s "$out" | tail -1)"
  else printf '%s\n' "$out" >"$OUT/$1.log"; rec "$1" false "rc $rc, runs '$v' (want $V0), pulled $pulled: $(printf %s "$out" | tail -4)"; fi
}
updrefused B3-update-unsigned-digest upd-unsigned "$R1" 'no signatures'
updrefused B4-update-wrong-identity upd-wrongid "$R2" 'identit'
updrefused B5-update-key-signature upd-key "$R3" 'no matching signatures|certificate'
updrefused B6-update-digest-not-held upd-missing "$R4" 'no signatures|manifest|not found'
# A release that is not pinned by digest at all (tailscale left on its tag) is refused before cosign runs.
mkupd upd-tag "$R1"; sed -i "s|tailscale/tailscale@sha256:a*|tailscale/tailscale:stable|" "$WORK/upd-tag/compose.yml"
(cd "$WORK/upd-tag" && fl=$(awk '{print $2}' SHA256SUMS | sort -u) && for f in $fl; do sha256sum "$f"; done >SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS)
node -e 'const c=require("crypto"),fs=require("fs");const d=process.argv[1];const sums=fs.readFileSync(d+"/SHA256SUMS");fs.writeFileSync(d+"/SHA256SUMS.sig",c.sign(null,Buffer.concat([Buffer.from("vyre-release-sums\n"),sums]),c.createPrivateKey(fs.readFileSync(process.argv[2]))).toString("base64")+"\n");' "$WORK/upd-tag" "$WORK/good.pem"
askupd upd-tag; ready; v=$(hv)
if [ $rc -ne 0 ] && [ "$v" = "$V0" ] && seen && mem && printf '%s' "$out" | grep -qi 'not pinned exactly by digest'; then rec B7-update-moving-tag ok "$(printf %s "$out" | tail -1)"
else printf '%s\n' "$out" >"$OUT/B7.log"; rec B7-update-moving-tag false "rc $rc, runs '$v': $(printf %s "$out" | tail -3)"; fi
rec 11-positive-control ok "NOT RUN: an image signed by Vyre's release workflow cannot be made locally; it needs a real signed release"

while read -r p; do kill "$p" 2>/dev/null; done <"$OUT/pids"
docker rm -f vyre-testreg >/dev/null 2>&1
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
