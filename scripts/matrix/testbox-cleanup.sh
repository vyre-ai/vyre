#!/bin/sh
# testbox-cleanup.sh <run-id>: run ON the test server. Removes only this run's compose project
# (e2e2-<run-id>) and its dir, then compares containers and listeners with the preflight baseline.
# Exit 0 = box is as it was. Exit 1 = something differs (printed). Never touches other projects.
set -eu
RUN=${1:-}
case "$RUN" in *[!a-z0-9]*|"") echo "usage: testbox-cleanup.sh <run-id>" >&2; exit 2;; esac
DIR=$HOME/e2e2/$RUN
[ -f "$DIR/baseline.txt" ] || { echo "cleanup: no baseline for $RUN, refusing to guess" >&2; exit 2; }
P=e2e2-$RUN
ids=$(docker ps -aq --filter "label=com.docker.compose.project=$P" || true)
[ -z "$ids" ] || docker rm -f $ids >/dev/null
vols=$(docker volume ls -q --filter "label=com.docker.compose.project=$P" || true)
[ -z "$vols" ] || docker volume rm $vols >/dev/null
nets=$(docker network ls -q --filter "label=com.docker.compose.project=$P" || true)
[ -z "$nets" ] || docker network rm $nets >/dev/null 2>&1 || true
sleep 1
{ docker ps --format '{{.Names}} {{.Image}}' | sort; echo ---; ss -ltnH | awk '{print $4}' | sort; } >"$DIR/after.txt"
rc=0
diff "$DIR/baseline.txt" "$DIR/after.txt" >"$DIR/diff.txt" || rc=1
if [ $rc -eq 0 ]; then rm -rf "$DIR"; echo "cleanup: box matches the baseline, $DIR removed" >&2
else echo "cleanup: box differs from the baseline (kept $DIR for inspection):" >&2; cat "$DIR/diff.txt" >&2; fi
exit $rc
