#!/bin/sh
# Provision a real Twenty for a throwaway Space on a test box, run the kernel conformance suite and the Twenty-specific suite
# against it from a container on its internal network, then tear it all down. Run ON the box, from a synced checkout:
#   sh stores/twenty/live/conformance-live.sh [space-label, default rcf]   (about 4 minutes of provisioning, then the tests)
#   PATTERN='webhook' runs the tests whose name matches; KEEP=1 leaves the Space up and prints how to remove it; REUSE=1 skips provisioning for a kept one
set -eu
SPACE="${1:-rcf}"
cd "$(dirname "$0")/../../.."
LOG="$(mktemp)"
STATE="$HOME/.rcf-$SPACE"
if [ -z "${REUSE:-}" ]; then
  node stores/twenty/live/provision-live.mjs "$SPACE" >"$LOG" 2>&1 || { cat "$LOG"; exit 1; }
  sed -n 's/^HOME //p' "$LOG" >"$STATE"
fi
HOME_DIR="$(cat "$STATE")"
KEY="$(find "$HOME_DIR" -name service.key | head -1)"
echo "Space $SPACE is up"
set +e
docker run --rm --network "vyre-${SPACE}-twenty_store" --network-alias "vyre-${SPACE}" -v "$PWD:/repo:ro" -v "$KEY:/data/twenty.key:ro" -w /repo \
  -e VYRE_TWENTY_LIVE_URL="http://twenty-${SPACE}:3000" -e VYRE_TWENTY_LIVE_KEY_FILE=/data/twenty.key -e VYRE_TWENTY_LIVE_HOOK_HOST="vyre-${SPACE}" node:22-alpine \
  node --test ${PATTERN:+--test-name-pattern="$PATTERN"} --test-timeout=180000 --test-reporter=spec stores/twenty/live/live.test.js
RC=$?
if [ -n "${KEEP:-}" ]; then echo "kept: remove with  docker compose -p vyre-${SPACE}-twenty down -v; rm -rf $HOME_DIR $STATE"; exit $RC; fi
docker compose -p "vyre-${SPACE}-twenty" down -v >/dev/null 2>&1
rm -rf "$HOME_DIR" "$LOG" "$STATE"
exit $RC
