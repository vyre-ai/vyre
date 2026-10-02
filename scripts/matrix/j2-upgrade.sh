#!/bin/bash
# J2: a box installed from the v0.1.1 release is filled with data, updated to the candidate,
# rolled back, updated again, and a tampered release is refused. Runs on a throwaway CI runner only.
#   bash scripts/matrix/j2-upgrade.sh <old-box-dir> <new-box-dir> <out-dir>
# <old-box-dir> holds the v0.1.1 release files (install-box.sh, vyre.tgz, SHA256SUMS, ...),
# <new-box-dir> is the candidate as build-site.sh makes it (site/box). Data goes in and out through
# `vyre call`, as the person at the command line; nothing reaches into the box's files.
set -u
OLD=$(cd "$1" && pwd); NEW=$(cd "$2" && pwd); OUT=$3; mkdir -p "$OUT"
[ -n "${CI:-}" ] || { echo "j2-upgrade.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
DEV=${J2_DEVICE:-linux}; FAILED=0
rec() { # rec STEP ok|false [why]
  ok=$2; [ "$ok" = ok ] && ok=true || { ok=false; FAILED=$((FAILED + 1)); }
  printf '{"journey":"J2","device":"%s","step":"%s","ok":%s,"why":"%s"}\n' "$DEV" "$1" "$ok" "$(printf %s "${3:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)" >>"$OUT/results.jsonl"
  echo "$([ "$ok" = true ] && echo pass || echo FAIL)  J2 $DEV $1 ${3:-}"
}
serve() { python3 -m http.server "$2" --bind 127.0.0.1 --directory "$1" >/dev/null 2>&1 & echo $! >>"$OUT/pids"; }
version() { vyre version 2>/dev/null | tr -d ' \r\n'; }
ready() { i=0; until vyre status 2>/dev/null | grep -q ' is running'; do i=$((i + 1)); [ $i -ge 120 ] && return 1; sleep 1; done; }
upd() { VYRE_BOX_URL="http://127.0.0.1:$1/" VYRE_RELEASES_API="" VYRE_UPDATE_WAIT=180 vyre update --yes "${@:2}" </dev/null 2>&1; }
: >"$OUT/pids"
serve "$OLD" 18081; serve "$NEW" 18082
TAMPER=$(mktemp -d); cp -R "$NEW"/. "$TAMPER"/; printf 'tampered\n' >>"$TAMPER/vyre.tgz"; serve "$TAMPER" 18083
for i in $(seq 1 50); do curl -fs http://127.0.0.1:18083/SHA256SUMS >/dev/null && break; sleep 0.2; done
CAND=$(tr -d ' \r\n' <"$NEW/VERSION"); OLDV=$(tr -d ' \r\n' <"$OLD/VERSION")
[ "$CAND" != "$OLDV" ] || { echo "j2-upgrade.sh: the candidate is $CAND, the same as the old release; bump its version first" >&2; exit 2; }

# 2.1 install from the old release
if VYRE_BOX_URL=http://127.0.0.1:18081/ VYRE_BUILD=tgz sh "$OLD/install-box.sh" --yes --print-link </dev/null >"$OUT/install.log" 2>&1 && ready; then
  v=$(version); [ "$v" = "$OLDV" ] && rec 2.1-install-old ok "$v" || rec 2.1-install-old false "runs '$v', expected $OLDV"
else rec 2.1-install-old false "install or start failed: $(tail -3 "$OUT/install.log")"; exit 1; fi

# 2.2 fill it with a made-up world and read it back
vyre call memory.remember '{"text":"My wife is Robin"}' >"$OUT/seed-memory.json" 2>&1
vyre call planner.add '{"kind":"note","text":"Marlow and Finch retainer draft"}' >"$OUT/seed-note.json" 2>&1
seen() { vyre call planner.list '{}' 2>&1 | grep -q 'retainer draft' && vyre call memory.facts '{}' 2>&1 | grep -q 'Robin'; }
seen && rec 2.2-seed ok || rec 2.2-seed false "seed not readable: $(head -c 200 "$OUT/seed-memory.json")"

# 2.3 update to the candidate
out=$(upd 18082); rc=$?; ready
v=$(version)
[ $rc -eq 0 ] && [ "$v" = "$CAND" ] && rec 2.3-update ok "$OLDV to $v" || rec 2.3-update false "rc $rc, runs '$v', want $CAND: $(echo "$out" | tail -4)"
# 2.4 nothing lost
seen && rec 2.4-data-kept ok || rec 2.4-data-kept false "memory or note gone after the update"

# 2.5 roll back with data, then update again
out=$(upd 18082 --rollback --restore-data); rc=$?; ready; v=$(version)
[ $rc -eq 0 ] && [ "$v" = "$OLDV" ] && rec 2.5a-rollback ok "$v" || rec 2.5a-rollback false "rc $rc, runs '$v': $(echo "$out" | tail -4)"
seen && rec 2.5b-rollback-data ok || rec 2.5b-rollback-data false "data missing after rollback"
out=$(upd 18082); rc=$?; ready; v=$(version)
[ $rc -eq 0 ] && [ "$v" = "$CAND" ] && rec 2.5c-update-again ok "$v" || rec 2.5c-update-again false "rc $rc, runs '$v': $(echo "$out" | tail -4)"

# 2.6 a tampered release is refused and the box stays as it was
out=$(upd 18083); rc=$?; ready; v=$(version)
if [ $rc -ne 0 ] && [ "$v" = "$CAND" ] && seen; then rec 2.6-tamper-refused ok "$(echo "$out" | tail -1)"
else rec 2.6-tamper-refused false "rc $rc, runs '$v': $(echo "$out" | tail -3)"; fi

while read -r p; do kill "$p" 2>/dev/null; done <"$OUT/pids"
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
