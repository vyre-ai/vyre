#!/bin/bash
# J2b: the signed-update refusals against a REAL install (real Docker, real image build), on a throwaway CI runner only.
#   bash scripts/matrix/j2-update-refusals.sh <box-dir> <out-dir>
# MODE=source (default): <box-dir> was built with VYRE_TEST_UNSTRIPPED_WRAPPER=1, so the wrapper still reads the test overrides, and the
# matrix below runs in full, a correctly signed update as the positive control. MODE=stripped: <box-dir> is the plain release build
# (site/box); the wrapper reads no override, so the cases are the ones that must hold for the shipped wrapper (see the end of this file).
# <box-dir> is the candidate as build-site.sh makes it (site/box). The candidate is installed the way a person does, filled with
# data through `vyre call`, then offered releases served from local folders:
#   unsigned, signed by a key that is not the pinned one, a signature over other bytes, a signed release with a tampered
#   file, a signed release older than what the box has (downgrade), then a correctly signed newer one (the positive control).
# The signed ones use a throwaway key that the box is told to trust for this run with VYRE_RELEASE_KEY (the test's own
# seam, as in test/box-update.test.js); the pinned key stays the default for the "wrong signer" cases. After every refusal:
# a non-zero exit, a plain message, the same version, the status file saying failed, and the seeded data still readable.
set -u
BOX=$(cd "$1" && pwd); OUT=$2; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
[ -n "${CI:-}" ] || { echo "j2-update-refusals.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
MODE=${J2B_MODE:-source}; FAILED=0; DIR=/srv/vyre; ST=/var/lib/vyre-update; WORK=$(mktemp -d); PORT=18090
rec() { # rec STEP ok|false [why]
  ok=$2; [ "$ok" = ok ] && ok=true || { ok=false; FAILED=$((FAILED + 1)); }
  printf '{"journey":"J2b","device":"linux","step":"%s","ok":%s,"why":"%s"}\n' "$1" "$ok" "$(printf %s "${3:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)" >>"$OUT/results.jsonl"
  echo "$([ "$ok" = true ] && echo pass || echo FAIL)  J2b $1 ${3:-}"
}
version() { vyre version 2>/dev/null | tr -d ' \r\n'; }
# What the host's own VERSION file says it holds: the release variants share the candidate's vyre.tgz, so the running image's
# own version does not move with them, and the file the update writes is the honest record.
# An install has no VERSION file until its first update, so until then the running image's version is the record.
hv() { if [ -f "$DIR/VERSION" ]; then tr -d ' \r\n' <"$DIR/VERSION"; else version; fi; }
ready() { i=0; until vyre status 2>/dev/null | grep -q 'vyred running'; do i=$((i + 1)); [ $i -ge 120 ] && return 1; sleep 1; done; }
# The seed is two files in the box's home volume, which an update (or a refused one) must leave as it is. (Planner and personal memory need the record store and a person's chain,
# neither of which a bare CI box has, so they cannot be the seed here.) seen/mem read them back through the running container.
seen() { docker exec -u vyre vyre-vyre-1 sh -c 'cat /home/vyre/j2b-seed-note.txt' 2>/dev/null | grep -q 'retainer draft'; }
mem() { docker exec -u vyre vyre-vyre-1 sh -c 'cat /home/vyre/j2b-seed-memory.txt' 2>/dev/null | grep -q 'Robin'; }
statusf() { sudo cat "$ST/status/status.json" 2>/dev/null | tr -d '\n'; }
: >"$OUT/pids"
serve() { python3 -m http.server "$2" --bind 127.0.0.1 --directory "$1" >/dev/null 2>&1 & echo $! >>"$OUT/pids"; for i in $(seq 1 50); do curl -fs "http://127.0.0.1:$2/VERSION" >/dev/null && return 0; sleep 0.2; done; }

# A throwaway signing key: the private half signs, the public half (SPKI, base64) is what the box is told to trust. With J2B_KEYDIR the candidate was already pinned to and signed with that
# key (scripts/matrix/j2-pin-key.mjs), so its modules boot; without it a key is made here and the candidate's modules cannot boot.
if [ -n "${J2B_KEYDIR:-}" ] && [ -s "$J2B_KEYDIR/good.pem" ]; then cp "$J2B_KEYDIR/good.pem" "$J2B_KEYDIR/good.pub" "$WORK"/
else node -e '
const c=require("crypto"),fs=require("fs");const k=c.generateKeyPairSync("ed25519");
const o=process.argv[1];
fs.writeFileSync(o+"/good.pem",k.privateKey.export({type:"pkcs8",format:"pem"}));
fs.writeFileSync(o+"/good.pub",k.publicKey.export({type:"spki",format:"der"}).toString("base64"));' "$WORK"; fi
node -e '
const c=require("crypto"),fs=require("fs");const o=process.argv[1];
const k2=c.generateKeyPairSync("ed25519");fs.writeFileSync(o+"/other.pem",k2.privateKey.export({type:"pkcs8",format:"pem"}));' "$WORK"
GOODPUB=$(cat "$WORK/good.pub")
sign() { # sign DIR KEYPEM: SHA256SUMS.sig = base64 Ed25519 over "vyre-release-sums\n" + the exact SHA256SUMS bytes
  node -e '
const c=require("crypto"),fs=require("fs");const d=process.argv[1];
const sums=fs.readFileSync(d+"/SHA256SUMS");
const sig=c.sign(null,Buffer.concat([Buffer.from("vyre-release-sums\n"),sums]),c.createPrivateKey(fs.readFileSync(process.argv[2])));
fs.writeFileSync(d+"/SHA256SUMS.sig",sig.toString("base64")+"\n");' "$1" "$2"
}
# mk NAME VERSION KIND: a copy of the candidate at another version, its SHA256SUMS regenerated, signed as KIND says
mk() {
  d="$WORK/$1"; rm -rf "$d"; mkdir -p "$d"; cp -R "$BOX"/. "$d"/
  printf '%s\n' "$2" >"$d/VERSION"
  files=$(awk '{print $2}' "$BOX/SHA256SUMS")
  (cd "$d" && for f in $files; do sha256sum "$f"; done >SHA256SUMS)
  rm -f "$d/SHA256SUMS.sig"
  case "$3" in
    unsigned) ;;
    good) sign "$d" "$WORK/good.pem" ;;
    other) sign "$d" "$WORK/other.pem" ;;
    badsig) sign "$d" "$WORK/good.pem"; tac "$d/SHA256SUMS" >"$d/SUMS.rev" && mv "$d/SUMS.rev" "$d/SHA256SUMS" ;; # still a valid list, but not the bytes that were signed
    tamper) sign "$d" "$WORK/good.pem"; printf 'tampered\n' >>"$d/vyre.tgz" ;;
  esac
}
PORT=18090
offer() { PORT=$((PORT + 1)); serve "$WORK/$1" $PORT; }
# ask PORT KEY: what the root unit does for a request, run directly (the unit itself is off so nothing else runs it)
ask() {
  sudo sh -c "printf 'update\n' >$ST/request/request"
  out=$(sudo env "VYRE_DIR=$DIR" "VYRE_BOX_URL=http://127.0.0.1:$1/" VYRE_RELEASES_API= "VYRE_RELEASE_KEY=${2:-}" VYRE_UPDATE_MIN_GAP=0 VYRE_UPDATE_WAIT=300 "$(command -v vyre)" update-from-request 2>&1 </dev/null); rc=$?
}
# refused STEP WANT_REGEX: the box is exactly as before
refused() { # a third word, nostatus: a hand-run update does not write the status file
  ready; v=$(hv); s=$(statusf)
  if [ $rc -ne 0 ] && [ "$v" = "$V0" ] && seen && mem && printf '%s' "$out" | grep -qiE "$2" && { [ "${3:-}" = nostatus ] || printf '%s' "$s" | grep -q '"state":"failed"'; }; then rec "$1" ok "$(printf %s "$out" | tail -1)"
  else rec "$1" false "rc $rc, runs '$v' (want $V0), status '$s': $(printf %s "$out" | tail -3)"; fi
}

V0=$(tr -d ' \r\n' <"$BOX/VERSION")
# 1 install the candidate, fill it
serve "$BOX" 18080
if VYRE_BOX_URL=http://127.0.0.1:18080/ VYRE_BUILD=tgz sh "$BOX/install-box.sh" --yes </dev/null >"$OUT/install.log" 2>&1 && ready; then rec 1-install ok "$(version)"
else rec 1-install false "install or start failed: $(tail -3 "$OUT/install.log")"; { echo "--- vyre status"; vyre status 2>&1 | head -40; echo "--- container logs"; docker logs --tail 80 vyre-vyre-1 2>&1; } >"$OUT/install-diag.log"; tail -120 "$OUT/install-diag.log" >&2; exit 1; fi
wdir() { docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$(docker ps -q --filter name=vyre-vyre | head -1)" 2>/dev/null; }
docker exec -u vyre vyre-vyre-1 sh -c 'echo "My wife is Robin" >/home/vyre/j2b-seed-memory.txt; echo "Marlow and Finch retainer draft" >/home/vyre/j2b-seed-note.txt' >"$OUT/seed.log" 2>&1; cat "$OUT/seed.log" >&2; docker ps --format '{{.Names}} {{.Status}}' >&2
seen && mem && rec 2-seed ok || { vyre status 2>&1 | head -8 >&2; vyre modules 2>&1 | grep -v running | head -20 >&2; docker logs --tail 40 vyre-vyre-1 2>&1 | grep -iE "planner|memory|not first party|kernel" | head -15 >&2; false; } || rec 2-seed false "seed not readable"
# 2b where the installer's own first `up` ran compose from: recorded as it is (the installer runs it as the person when they are in the docker
#    group, so this is the stack folder; root's copies exist only once the updater is installed, which is the next step)
rec 2b-first-up-working-dir ok "compose ran from $(wdir)"
# 3 the update folders and root unit exist as on a real server; the path unit is switched off so only this script asks
sudo "$(command -v vyre)" updater install >"$OUT/updater.log" 2>&1; sudo systemctl disable --now vyre-update.path >/dev/null 2>&1
vyre updater status 2>&1 | grep -q installed && rec 3-updater ok || rec 3-updater false "$(tail -3 "$OUT/updater.log")"

# H1/H2 (both modes): root never interprets what a person can write as compose configuration. An override file and a COMPOSE_FILE in .env are
# refused before anything is fetched, whatever else is set, and the box is exactly as it was.
rootreq() { sudo sh -c "printf 'update\\n' >$ST/request/request"; out=$(sudo "$(command -v vyre)" update-from-request 2>&1 </dev/null); rc=$?; }
printf 'services:\n  vyre:\n    privileged: true\n' | sudo tee "$DIR/compose.override.yml" >/dev/null
rootreq; ready; hv_now=$(hv)
if [ $rc -ne 0 ] && [ "$hv_now" = "$V0" ] && seen && mem && printf '%s' "$out" | grep -q 'does not read override files' && printf '%s' "$(statusf)" | grep -q '"state":"failed"'; then rec H1-override-file-refused ok "$(printf %s "$out" | tail -1)"
else rec H1-override-file-refused false "rc $rc, runs '$hv_now': $(printf %s "$out" | tail -2)"; fi
sudo rm -f "$DIR/compose.override.yml"
printf 'COMPOSE_FILE=/tmp/evil.yml\n' | sudo tee -a "$DIR/.env" >/dev/null
rootreq
# (the person's own compose reads that .env too, so it is put right before anything is read back)
sudo sed -i '/^COMPOSE_FILE=\/tmp\/evil.yml$/d' "$DIR/.env"; ready; hv_now=$(hv)
if [ $rc -ne 0 ] && [ "$hv_now" = "$V0" ] && seen && mem && printf '%s' "$out" | grep -q 'COMPOSE_FILE is set in'; then rec H2-compose-file-in-env-refused ok "$(printf %s "$out" | tail -1)"
else rec H2-compose-file-in-env-refused false "rc $rc, runs '$hv_now': $(printf %s "$out" | tail -2)"; fi

if [ "$MODE" = stripped ]; then
  # S1 the shipped wrapper is the release build: it names none of the test overrides
  if grep -qE 'VYRE_(RELEASE_KEY|COSIGN_IMAGE|BOX_URL|RELEASES_API|RELEASES_REPO|UPDATE_ROOT|ROOT_UID|CHAIN_TOP|WRAPPER|UPDATE_WAIT|UPDATE_MIN_GAP|SYSTEMD_DIR|UPDATER_NAME|CONTAINER_HOME)' "$(command -v vyre)"; then rec S1-wrapper-clean false "the installed wrapper still names an override"; else rec S1-wrapper-clean ok "$(grep -c '' "$(command -v vyre)") lines"; fi
  # S2 a root run refuses to start with ANY override in its environment, and nothing changes
  for v in VYRE_RELEASE_KEY="$GOODPUB" VYRE_COSIGN_IMAGE=evil.example/cosign@sha256:$(printf 'b%.0s' $(seq 1 64)) VYRE_BOX_URL=http://127.0.0.1:1/ VYRE_RELEASES_API=http://127.0.0.1:1/api VYRE_UPDATE_ROOT=/tmp/x VYRE_ROOT_UID=1 VYRE_WRAPPER=/tmp/evil; do
    sudo sh -c "printf 'update\\n' >$ST/request/request"
    out=$(sudo env "$v" "$(command -v vyre)" update-from-request 2>&1 </dev/null); rc=$?
    ready; hv_now=$(hv)
    if [ $rc -ne 0 ] && [ "$hv_now" = "$V0" ] && seen && mem && printf '%s' "$out" | grep -q 'reads no override'; then rec "S2-root-refuses-${v%%=*}" ok "$(printf %s "$out" | tail -1)"
    else rec "S2-root-refuses-${v%%=*}" false "rc $rc, runs '$hv_now': $(printf %s "$out" | tail -2)"; fi
  done
  # S3 a hostile .env (an image that "signs everything") does not change how a release is verified: the real wrapper, the real network,
  # no override. Whatever the newest real release is, nothing on this box changes and the failure is not about the .env's image.
  printf 'VYRE_IMAGE=evil.example/signs-everything:latest\n' | sudo tee -a "$DIR/.env" >/dev/null
  sudo sh -c "printf 'update\\n' >$ST/request/request"
  out=$(sudo "$(command -v vyre)" update-from-request 2>&1 </dev/null); rc=$?
  ready; hv_now=$(hv)
  if [ "$hv_now" = "$V0" ] && seen && mem && ! printf '%s' "$out" | grep -qiE 'evil\.example|pull access|manifest unknown'; then rec S3-hostile-env-image-ignored ok "rc $rc: $(printf %s "$out" | tail -1)"
  else rec S3-hostile-env-image-ignored false "rc $rc, runs '$hv_now': $(printf %s "$out" | tail -3)"; fi
  # S4 a hand-run update by the person, every override set to a local release signed by the throwaway key: the wrapper ignores all of it
  mk good 9.9.9-e2e.1 good; offer good
  out=$(VYRE_RELEASE_KEY="$GOODPUB" VYRE_BOX_URL="http://127.0.0.1:$PORT/" VYRE_RELEASES_API="" vyre update </dev/null 2>&1); rc=$?
  ready; hv_now=$(hv)
  # With the real network and no override, a hand-run update by the person installs the newest real signed release when there is one
  # (a person may go back; only the automatic path refuses), so the box may legitimately end on that; it must never end on the local 9.9.9 one.
  if [ "$hv_now" != "9.9.9-e2e.1" ] && ! printf '%s' "$out" | grep -q "127.0.0.1:$PORT"; then rec S4-hand-run-overrides-ignored ok "rc $rc: $(printf %s "$out" | tail -1)"
  else rec S4-hand-run-overrides-ignored false "rc $rc, runs '$hv_now': $(printf %s "$out" | tail -3)"; fi
  while read -r p; do kill "$p" 2>/dev/null; done <"$OUT/pids"
  exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
fi

# 4 hand-run, no override: an unsigned release is refused unless --allow-unsigned
mk unsigned 9.9.9-e2e.1 unsigned; offer unsigned
out=$(VYRE_BOX_URL="http://127.0.0.1:$PORT/" VYRE_RELEASES_API="" vyre update </dev/null 2>&1); rc=$?
refused 4-hand-unsigned 'not signed.*(nothing was changed|allow-unsigned)' nostatus
# 5 automatic path: unsigned, another key, a signature over other bytes, a signed release with a changed file
mk unsigned 9.9.9-e2e.1 unsigned; offer unsigned; ask $PORT "$GOODPUB"; refused 5a-auto-unsigned 'not signed.*automatic update installs only signed'
mk other 9.9.9-e2e.1 other; offer other; ask $PORT "$GOODPUB"; refused 5b-wrong-signer 'does not match.*(release key|signature)|signature does not match'
mk badsig 9.9.9-e2e.1 badsig; offer badsig; ask $PORT "$GOODPUB"; refused 5c-signature-over-other-bytes 'signature does not match'
mk tamper 9.9.9-e2e.1 tamper; offer tamper; ask $PORT "$GOODPUB"; refused 5d-signed-file-tampered 'checksum|sha256|does not match'
# 5e the pinned key stays the default: a release signed by the throwaway key is refused when no override is given
mk good 9.9.9-e2e.1 good; offer good; ask $PORT ""; refused 5e-pinned-key-default 'does not match|not signed'
# 6 downgrade: a correctly signed release older than what the box runs
mk old 0.0.1-e2e.1 good; offer old; ask $PORT "$GOODPUB"; refused 6-downgrade 'never goes back'
# 6b the same version's earlier prerelease is a downgrade too (#15): the compare used to ignore the suffix
mk oldpre "${V0%%-*}-e2e.0" good; offer oldpre; ask $PORT "$GOODPUB"; refused 6b-same-version-earlier-prerelease 'never goes back'
# 7 positive control: the same signed release, newer, installs and keeps the data. The person's compose.yml is edited first to make the
#   vyre service privileged; root runs from its own verified copy, so the container that comes up is not.
sudo sed -i '/^  vyre:$/a\    privileged: true' "$DIR/compose.yml"
mk new 9.9.9-e2e.1 good; offer new; ask $PORT "$GOODPUB"; ready; v=$(hv); s=$(statusf)
priv=$(docker inspect -f '{{.HostConfig.Privileged}}' "$(docker ps -q --filter name=vyre-vyre | head -1)" 2>/dev/null)
wd=$(wdir)
[ "$wd" = "$ST/private/run" ] && rec 7c-root-update-ran-from-root-copy ok "working_dir $wd" || rec 7c-root-update-ran-from-root-copy false "working_dir '$wd', want $ST/private/run"
[ "$priv" = false ] && rec 7b-edited-compose-not-run ok "the running vyre container is not privileged" || rec 7b-edited-compose-not-run false "privileged='$priv'"
if [ $rc -eq 0 ] && [ "$v" = "9.9.9-e2e.1" ] && seen && mem && printf '%s' "$s" | grep -q '"state":"ok"'; then rec 7-signed-update ok "$V0 to $v"
else rec 7-signed-update false "rc $rc, runs '$v', status '$s': $(printf %s "$out" | tail -4)"; printf '%s\n' "$out" | tail -40 >&2; docker logs --tail 60 vyre-vyre-1 2>&1 | tail -40 >&2; fi
# 8 now the floor is 9.9.9: the candidate's own, validly signed version is an old release and is refused
V0=9.9.9-e2e.1
mk back "$(tr -d ' \r\n' <"$BOX/VERSION")" good; offer back; ask $PORT "$GOODPUB"; refused 8-floor-after-update 'never goes back'

while read -r p; do kill "$p" 2>/dev/null; done <"$OUT/pids"
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
