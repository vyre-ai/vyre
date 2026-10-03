#!/bin/sh
# Run the live conformance suite against a Space's Twenty on testbox, from a container on that
# Space's internal network (Twenty has no published port).
#   stores/twenty/live/run-on-testbox.sh <compose project, default twspike> <key volume, default twspike_gw-data>
# The key lives in the volume as /data/twenty.key (mode 0600, root). Nothing is printed from it.
set -eu
PROJECT="${1:-twspike}"
KEYVOL="${2:-${PROJECT}_gw-data}"
HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
rsync -a --delete --exclude node_modules --exclude .git "$HERE"/ testbox:vyre-ci/records/
ssh testbox "docker run --rm --network ${PROJECT}_store --network-alias gateway -v \$HOME/vyre-ci/records:/repo:ro -v ${KEYVOL}:/data:ro -w /repo \
  -e VYRE_FEED_DEBUG=${VYRE_FEED_DEBUG:-} -e VYRE_TWENTY_LIVE_URL=http://server:3000 -e VYRE_TWENTY_LIVE_KEY_FILE=/data/twenty.key node:22-alpine \
  node --test --test-force-exit --test-timeout=120000 --test-reporter=spec stores/twenty/live/live.test.js"
