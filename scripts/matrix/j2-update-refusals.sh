#!/bin/bash
# J2b: the signed-update refusals against a REAL install (real Docker, real image build), on a throwaway CI runner only.
#   bash scripts/matrix/j2-update-refusals.sh <box-dir> <out-dir>
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
FAILED=0; DIR=/srv/vyre; ST=/var/lib/vyre-update; WORK=$(mktemp -d); PORT=18090
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
seen() { vyre call planner.list '{}' 2>&1 | grep -q 'retainer draft'; }
mem() { vyre call memory.me '{}' 2>&1 | grep -q 'Robin'; }
statusf() { sudo cat "$ST/status/status.json" 2>/dev/null | tr -d '\n'; }
: >"$OUT/pids"
serve() { python3 -m http.server "$2" --bind 127.0.0.1 --directory "$1" >/dev/null 2>&1 & echo $! >>"$OUT/pids"; for i in $(seq 1 50); do curl -fs "http://127.0.0.1:$2/VERSION" >/dev/null && return 0; sleep 0.2; done; }

# A throwaway signing key: the private half signs, the public half (SPKI, base64) is what the box is told to trust.
node -e '
const c=require("crypto"),fs=require("fs");const k=c.generateKeyPairSync("ed25519");
const o=process.argv[1];
fs.writeFileSync(o+"/good.pem",k.privateKey.export({type:"pkcs8",format:"pem"}));
fs.writeFileSync(o+"/good.pub",k.publicKey.export({type:"spki",format:"der"}).toString("base64"));
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
else rec 1-install false "install or start failed: $(tail -3 "$OUT/install.log")"; exit 1; fi
vyre call memory.remember '{"text":"My wife is Robin"}' >/dev/null 2>&1
vyre call planner.add '{"kind":"note","text":"Marlow and Finch retainer draft"}' >/dev/null 2>&1
seen && mem && rec 2-seed ok || rec 2-seed false "seed not readable"
# 3 the update folders and root unit exist as on a real server; the path unit is switched off so only this script asks
sudo "$(command -v vyre)" updater install >"$OUT/updater.log" 2>&1; sudo systemctl disable --now vyre-update.path >/dev/null 2>&1
vyre updater status 2>&1 | grep -q installed && rec 3-updater ok || rec 3-updater false "$(tail -3 "$OUT/updater.log")"

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
# 7 positive control: the same signed release, newer, installs and keeps the data
mk new 9.9.9-e2e.1 good; offer new; ask $PORT "$GOODPUB"; ready; v=$(hv); s=$(statusf)
if [ $rc -eq 0 ] && [ "$v" = "9.9.9-e2e.1" ] && seen && mem && printf '%s' "$s" | grep -q '"state":"ok"'; then rec 7-signed-update ok "$V0 to $v"
else rec 7-signed-update false "rc $rc, runs '$v', status '$s': $(printf %s "$out" | tail -4)"; fi
# 8 now the floor is 9.9.9: the candidate's own, validly signed version is an old release and is refused
V0=9.9.9-e2e.1
mk back "$(tr -d ' \r\n' <"$BOX/VERSION")" good; offer back; ask $PORT "$GOODPUB"; refused 8-floor-after-update 'never goes back'

while read -r p; do kill "$p" 2>/dev/null; done <"$OUT/pids"
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
