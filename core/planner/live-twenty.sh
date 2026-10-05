#!/bin/sh
# Run the planner's live suite against a real, pinned Twenty on a test box: provision a throwaway Space, run core/planner/live-twenty.test.js from a container on its internal network, tear it down.
# Run ON the box, from a synced checkout:  sh core/planner/live-twenty.sh [space-label, default plv]   (KEEP=1 keeps the Space; REUSE=1 uses a kept one)
set -eu
SPACE="${1:-plv}"
cd "$(dirname "$0")/../.."
LOG="$(mktemp)"
STATE="$HOME/.rcf-$SPACE"
if [ -z "${REUSE:-}" ]; then
  node stores/twenty/live/provision-live.mjs "$SPACE" >"$LOG" 2>&1 || { cat "$LOG"; exit 1; }
  sed -n 's/^HOME //p' "$LOG" >"$STATE"
fi
HOME_DIR="$(cat "$STATE")"
KEY="$(find "$HOME_DIR" -name service.key | head -1)"
set +e
docker run --rm --network "vyre-${SPACE}-twenty_store" -v "$PWD:/repo:ro" -v "$KEY:/data/twenty.key:ro" -w /repo \
  -e VYRE_TEST_HOSTED=1 -e VYRE_TWENTY_LIVE_URL="http://twenty-${SPACE}:3000" -e VYRE_TWENTY_LIVE_KEY_FILE=/data/twenty.key node:22-alpine \
  node --test --test-timeout=280000 --test-reporter=spec core/planner/live-twenty.test.js
RC=$?
if [ -n "${KEEP:-}" ]; then echo "kept: remove with  docker compose -p vyre-${SPACE}-twenty down -v; rm -rf $HOME_DIR $STATE"; exit $RC; fi
docker compose -p "vyre-${SPACE}-twenty" down -v >/dev/null 2>&1
rm -rf "$HOME_DIR" "$LOG" "$STATE"
exit $RC
