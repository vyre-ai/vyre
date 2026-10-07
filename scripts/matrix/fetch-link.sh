#!/bin/sh
# fetch-link.sh <rv-dir> <device>: one fresh onboarding link for this device, from the box runner's
# link server (link-server.py) through its tunnel, written to <rv-dir>/<device>. CI runners only.
set -eu
[ -n "${CI:-}" ] || { echo "fetch-link.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
RV=$1; D=$2
for i in $(seq 1 30); do
  curl -fsS --max-time 30 "$(cat "$RV/linkurl")/$(cat "$RV/secret")" >"$RV/$D" 2>/dev/null && [ -s "$RV/$D" ] && exit 0
  sleep 2
done
echo "fetch-link.sh: no link for $D" >&2; exit 1
