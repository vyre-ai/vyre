#!/bin/sh
# testbox-preflight.sh <run-id>: run ON the test server. Records what is running now (containers and
# listeners), refuses to start if the box is busy, and makes the throwaway dir for this run.
# Prints RUN_DIR=, COMPOSE_PROJECT= on stdout. Never touches /srv/vyre or any other container.
set -eu
RUN=${1:-}
case "$RUN" in *[!a-z0-9]*|"") echo "usage: testbox-preflight.sh <run-id, a-z0-9, 4-16 chars>" >&2; exit 2;; esac
[ ${#RUN} -ge 4 ] && [ ${#RUN} -le 16 ] || { echo "run id must be 4-16 chars" >&2; exit 2; }
ROOT=$HOME/e2e2
DIR=$ROOT/$RUN
[ ! -e "$DIR" ] || { echo "preflight: $DIR already exists" >&2; exit 1; }
load=$(cut -d' ' -f1 /proc/loadavg | cut -d. -f1)
[ "$load" -le "${E2E2_MAX_LOAD:-12}" ] || { echo "preflight: load $load is over 12, wait" >&2; exit 3; }
free_gb=$(df -Pk "$HOME" | awk 'NR==2{print int($4/1048576)}')
[ "$free_gb" -ge 10 ] || { echo "preflight: only ${free_gb} GB free, need 10" >&2; exit 4; }
mkdir -p "$DIR"
snap() { { docker ps --format '{{.Names}} {{.Image}}' | sort; echo ---; ss -ltnH | awk '{print $4}' | sort; } ; }
snap >"$DIR/baseline.txt"
echo "RUN_DIR=$DIR"
echo "COMPOSE_PROJECT=e2e2-$RUN"
echo "preflight: baseline saved ($(wc -l <"$DIR/baseline.txt") lines), load $load, ${free_gb} GB free" >&2
