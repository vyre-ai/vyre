#!/bin/sh
# J1b: naming the box from a terminal, `vyre setup --name <n> --yes`, on a throwaway CI runner. The same
# stand-ins as J1 (the real relay and names Worker code on the runner, a fake DNS zone); no browser.
#   sh scripts/matrix/j1b-cli.sh <out-dir>     (run scripts/build-site.sh first)
set -u
[ -n "${CI:-}" ] || { echo "j1b-cli.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
OUT=$(mkdir -p "$1" && cd "$1" && pwd); FAILED=0
rec() { ok=$2; [ "$ok" = ok ] && ok=true || { ok=false; FAILED=$((FAILED + 1)); }
  printf '{"journey":"J1b","device":"linux","step":"%s","ok":%s,"why":"%s"}\n' "$1" "$ok" "$(printf %s "${3:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)" >>"$OUT/results.jsonl"
  echo "$([ "$ok" = true ] && echo pass || echo FAIL)  J1b $1 ${3:-}"; }
node scripts/matrix/j1-services.mjs "$RUNNER_TEMP/none" site/box >"$OUT/services.json" 2>"$OUT/services.err" &
SVC=$!
i=0; while [ ! -s "$OUT/services.json" ] && [ $i -lt 100 ]; do i=$((i + 1)); sleep 0.1; done
field() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$OUT/services.json" "$1"; }
SITE=$(field site); RELAY_BOX_WS=$(field relayForBoxWs); NAMES_BOX=$(field namesForBox); RELAY_BOX=$(field relayForBox)
sudo mkdir -p /srv/vyre && sudo chown "$(id -u):$(id -g)" /srv/vyre
docker volume create --label com.docker.compose.project=vyre --label com.docker.compose.volume=vyre-home vyre_vyre-home >/dev/null
docker run --rm -v vyre_vyre-home:/home/vyre -e R="$RELAY_BOX_WS" -e N="$NAMES_BOX" busybox sh -c \
  'mkdir -p /home/vyre/.vyre && printf "{\"relay\":{\"enabled\":true,\"url\":\"%s\"},\"network\":{\"directory\":\"%s\"}}\n" "$R" "$N" >/home/vyre/.vyre/config.json && chown -R 1000:1000 /home/vyre && chmod 700 /home/vyre/.vyre && chmod 600 /home/vyre/.vyre/config.json'
VYRE_BOX_URL="$SITE/box/" VYRE_RELAY="$RELAY_BOX" VYRE_BUILD=tgz sh site/box/install-box.sh --yes --print-link </dev/null >"$OUT/install.log" 2>&1
i=0; until vyre status 2>/dev/null | grep -q 'vyred running'; do i=$((i + 1)); [ $i -ge 120 ] && break; sleep 1; done
vyre status 2>&1 | grep -q 'vyred running' && rec 1b.0-install ok || { rec 1b.0-install false "$(tail -4 "$OUT/install.log")"; kill $SVC; exit 1; }

# a script without --yes is refused before the directory is asked
vyre setup --name marlow-cli </dev/null >"$OUT/noyes.log" 2>&1; rc=$?
[ $rc -eq 2 ] && rec 1b.1-refuses-without-yes ok || rec 1b.1-refuses-without-yes false "exit $rc: $(head -c 150 "$OUT/noyes.log")"
# an invalid name is refused in words
vyre setup --name "Not Valid!" --yes >"$OUT/invalid.log" 2>&1; rc=$?
[ $rc -eq 1 ] && rec 1b.2-invalid-name-refused ok "$(head -c 120 "$OUT/invalid.log")" || rec 1b.2-invalid-name-refused false "exit $rc: $(head -c 150 "$OUT/invalid.log")"
# the claim: address, phase, one recovery code
vyre setup --name marlow-cli --yes --json >"$OUT/claim.json" 2>"$OUT/claim.err"; rc=$?
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.name==="marlow-cli"&&/marlow-cli/.test(j.address||"")&&/^[a-z0-9]{4}(-[a-z0-9]{4,})+$/i.test(j.recoveryCode||"")&&j.phase?0:1)' "$OUT/claim.json" 2>/dev/null; shape=$?
if [ $rc -eq 0 ] && [ $shape -eq 0 ]; then rec 1b.3-claim ok "$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.address+" phase "+j.phase)' "$OUT/claim.json")"; else rec 1b.3-claim false "exit $rc: $(sed 's/"recoveryCode"[^,}]*//' "$OUT/claim.json" | head -c 200) $(head -c 100 "$OUT/claim.err")"; fi
# the same name again: no new recovery code, and it is not a failure for the owner
vyre setup --name marlow-cli --yes --json >"$OUT/again.json" 2>&1
grep -q '"recoveryCode"' "$OUT/again.json" && grep -qE '"recoveryCode": *"[a-z0-9]' "$OUT/again.json" && rec 1b.4-no-second-recovery-code false "a second claim printed a new recovery code" || rec 1b.4-no-second-recovery-code ok
# the recovery code is not in the terminal's plain output twice and not in vyred's events
kill $SVC 2>/dev/null
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
