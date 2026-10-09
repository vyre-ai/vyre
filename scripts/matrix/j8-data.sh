#!/bin/bash
# J8: export, import and uninstall on a throwaway CI runner.
#   bash scripts/matrix/j8-data.sh <box-dir> <out-dir>
# Install a box from the candidate's own files, put a made-up world in it, save it sealed under a
# passphrase (`vyre backup`), take Vyre off with --keep-data (data stays, a reinstall picks it up),
# off again with --delete-data (the audit finds nothing left), then restore the saved file into a
# fresh box. Data goes in and out through `vyre call`, as the person at the command line.
set -u
[ -n "${CI:-}" ] || { echo "j8-data.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
BOX=$(cd "$1" && pwd); mkdir -p "$2"; OUT=$(cd "$2" && pwd); DIR=/srv/vyre
DEV=${J8_DEVICE:-linux}; FAILED=0
rec() { ok=$2; [ "$ok" = ok ] && ok=true || { ok=false; FAILED=$((FAILED + 1)); }
  printf '{"journey":"J8","device":"%s","step":"%s","ok":%s,"why":"%s"}\n' "$DEV" "$1" "$ok" "$(printf %s "${3:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)" >>"$OUT/results.jsonl"
  echo "$([ "$ok" = true ] && echo pass || echo FAIL)  J8 $DEV $1 ${3:-}"; }
python3 -m http.server 18080 --bind 127.0.0.1 --directory "$BOX" >/dev/null 2>&1 & SRV=$!
for i in $(seq 1 50); do curl -fs http://127.0.0.1:18080/SHA256SUMS >/dev/null && break; sleep 0.2; done
install() { VYRE_STORE=sqlite VYRE_BOX_URL=http://127.0.0.1:18080/ VYRE_BUILD=tgz sh "$BOX/install-box.sh" --yes --print-link </dev/null >"$OUT/install-$1.log" 2>&1; }
ready() { i=0; until vyre status 2>/dev/null | grep -q 'vyred running'; do i=$((i + 1)); [ $i -ge 120 ] && return 1; sleep 1; done; }
# The made-up world is one planner note on the built-in store (personal memory needs a person's chain, which `vyre call` on a bare box has not, so it is not part of the world here).
seed() { vyre call planner.add '{"kind":"note","text":"Marlow and Finch retainer draft"}' >"$OUT/seed.log" 2>&1; }
has_data() { for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do vyre call planner.list '{}' 2>&1 | grep -q 'retainer draft' && return 0; sleep 4; done; return 1; }
vols() { docker volume ls -q --filter label=run.vyre=1; }
leftovers() { # what a complete uninstall must not leave
  { docker ps -aq --filter label=com.docker.compose.project=vyre | sed 's/^/container /'
    docker ps -aq --filter network=vyre-computers | sed 's/^/computer /'
    vols | sed 's/^/volume /'
    docker network ls -q --filter label=run.vyre=1 | sed 's/^/network /'
    docker image ls -q --filter 'reference=ghcr.io/vyre-ai/*' --filter 'reference=vyre:*' | sed 's/^/image /'
    [ -e /usr/local/bin/vyre ] && echo "wrapper /usr/local/bin/vyre"
    systemctl list-unit-files 2>/dev/null | grep '^vyre-update' | awk '{print "systemd " $1 " " $2}'; } | sort -u
}
docker ps -a --format '{{.Names}}' | sort >"$OUT/containers-before.txt"

# 8.0 install and fill
if install a && ready; then rec 8.0-install ok; else rec 8.0-install false "$(tail -4 "$OUT/install-a.log")"; kill $SRV; exit 1; fi
seed; has_data && rec 8.1-seed ok || rec 8.1-seed false "the made-up world is not readable: $(head -c 200 "$OUT/seed.log" | tr '\n' ' ')"

# 8.2 export: one step, sealed under a passphrase
PASS=$(head -c 18 /dev/urandom | base64 | tr -d '=+/\n' | cut -c1-20)
cd $DIR
printf '%s\n%s\n' "$PASS" "$PASS" | docker compose exec -T vyre vyre backup /home/vyre/.vyre/backups/export.tar.gz >"$OUT/backup.log" 2>&1
rc=$?; docker compose cp vyre:/home/vyre/.vyre/backups/export.tar.gz "$OUT/export.tar.gz" >/dev/null 2>&1; cd - >/dev/null
sudo chmod 644 "$OUT/export.tar.gz" 2>/dev/null; printf '%s\n' "$PASS" >"$RUNNER_TEMP/export.key"; chmod 600 "$RUNNER_TEMP/export.key"
[ $rc -eq 0 ] && [ -s "$OUT/export.tar.gz" ] && rec 8.2-export ok "$(stat -c %s "$OUT/export.tar.gz") bytes" || rec 8.2-export false "rc $rc: $(tail -2 "$OUT/backup.log")"
if tar -tzf "$OUT/export.tar.gz" >/dev/null 2>&1; then rec 8.2b-export-sealed false "the export opens as a plain archive; it must be sealed"; else rec 8.2b-export-sealed ok; fi
grep -q "$PASS" "$OUT/backup.log" && rec 8.2c-passphrase-not-echoed false "the passphrase is in the CLI output" || rec 8.2c-passphrase-not-echoed ok

# 8.3 uninstall keeping the data
vyre uninstall --keep-data --yes >"$OUT/uninstall-keep.log" 2>&1; rck=$?
left=$(leftovers | grep -v '^volume ' | tr '\n' ' ')
[ $rck -eq 0 ] && [ -z "$left" ] && rec 8.3a-uninstall-keep ok || rec 8.3a-uninstall-keep false "rc $rck, left: $left"
[ -n "$(vols)" ] && rec 8.3b-data-kept ok || rec 8.3b-data-kept false "no volume survived --keep-data"

# 8.4 a reinstall picks up where it left off
if install b && ready && has_data; then rec 8.4-reinstall-keeps-data ok; else rec 8.4-reinstall-keeps-data false "data gone after a reinstall"; fi

# 8.5 uninstall deleting everything: the audit finds nothing
vyre uninstall --delete-data --yes >"$OUT/uninstall-delete.log" 2>&1; rcd=$?
left=$(leftovers | tr '\n' ' ')
[ $rcd -eq 0 ] && [ -z "$left" ] && rec 8.5-uninstall-complete ok || rec 8.5-uninstall-complete false "rc $rcd, left: $left"
docker ps -a --format '{{.Names}}' | sort >"$OUT/containers-after.txt"
diff -q "$OUT/containers-before.txt" "$OUT/containers-after.txt" >/dev/null && rec 8.5b-other-containers-untouched ok || rec 8.5b-other-containers-untouched false "the runner's containers changed"

# 8.6 import into a fresh box
if install c && ready; then
  has_data && rec 8.6a-fresh-box-empty false "a fresh box already has the world" || rec 8.6a-fresh-box-empty ok
  cd $DIR; docker compose stop vyre >/dev/null 2>&1
  # a wrong passphrase is refused and changes nothing
  echo "not-the-passphrase" >"$RUNNER_TEMP/wrong.key"
  EXP=$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")/export.tar.gz
  docker compose run --rm --no-deps -T -v "$EXP:/in/export.tar.gz:ro" vyre vyre restore /in/export.tar.gz --force <"$RUNNER_TEMP/wrong.key" >"$OUT/restore-wrong.log" 2>&1; rcw=$?
  [ $rcw -ne 0 ] && rec 8.6b-wrong-passphrase-refused ok || rec 8.6b-wrong-passphrase-refused false "a wrong passphrase restored"
  docker compose run --rm --no-deps -T -v "$EXP:/in/export.tar.gz:ro" vyre vyre restore /in/export.tar.gz --force <"$RUNNER_TEMP/export.key" >"$OUT/restore.log" 2>&1; rcr=$?
  docker compose up -d >/dev/null 2>&1; cd - >/dev/null
  ready; has_data && [ $rcr -eq 0 ] && rec 8.6c-import-restores ok || rec 8.6c-import-restores false "rc $rcr: $(tail -3 "$OUT/restore.log")"
else rec 8.6-fresh-install false "$(tail -4 "$OUT/install-c.log")"; fi

# 8.7 take it off again, completely
vyre uninstall --delete-data --yes >"$OUT/uninstall-final.log" 2>&1
left=$(leftovers | tr '\n' ' ')
[ -z "$left" ] && rec 8.7-final-uninstall-complete ok || rec 8.7-final-uninstall-complete false "left: $left"
kill $SRV 2>/dev/null
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
