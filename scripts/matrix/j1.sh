#!/bin/sh
# j1.sh: J1 on a throwaway CI runner. Builds nothing itself: run scripts/build-site.sh first.
#   sh scripts/matrix/j1.sh <out-dir>
# Stand-ins (all named in results): a real relay on the runner, the staged setup page, the box
# files served from the runner. The box's relay address is seeded in its home volume before it
# first starts, so it never talks to the production relay.
set -eu
[ -n "${CI:-}" ] || { echo "j1.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
STAGED=$RUNNER_TEMP/staged
node scripts/matrix/j1-services.mjs "$STAGED" site/box >"$OUT/services.json" 2>"$OUT/services.err" &
echo $! >"$OUT/services.pid"
i=0; while [ ! -s "$OUT/services.json" ] && [ $i -lt 100 ]; do i=$((i + 1)); sleep 0.1; done
[ -s "$OUT/services.json" ] || { echo "j1.sh: the stand-in services did not start" >&2; cat "$OUT/services.err" >&2; exit 1; }
field() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$OUT/services.json" "$1"; }
SITE=$(field site); RELAY=$(field relay); RELAY_BOX=$(field relayForBox); RELAY_BOX_WS=$(field relayForBoxWs); NAMES_BOX=$(field namesForBox)
VYRE_SETUP_RELAY=$RELAY VYRE_SETUP_INSTALL_URL=$SITE/i sh scripts/stage-site.sh --out "$STAGED"

# The box's home volume, made before the install so its first start already points at the runner's relay.
docker volume create --label com.docker.compose.project=vyre --label com.docker.compose.volume=vyre-home vyre_vyre-home >/dev/null
docker run --rm -v vyre_vyre-home:/home/vyre -e R="$RELAY_BOX_WS" -e N="$NAMES_BOX" busybox sh -c \
  'mkdir -p /home/vyre/.vyre && printf "{\"relay\":{\"enabled\":true,\"url\":\"%s\"},\"network\":{\"directory\":\"%s\"}}\n" "$R" "$N" >/home/vyre/.vyre/config.json && chown -R 1000:1000 /home/vyre && chmod 700 /home/vyre/.vyre && chmod 600 /home/vyre/.vyre/config.json'

printf '{"VYRE_BOX_URL":"%s/box/","VYRE_RELAY":"%s","VYRE_BUILD":"tgz"}\n' "$SITE" "$RELAY_BOX" >"$OUT/env.json"
google-chrome --headless=new --remote-debugging-port=9222 --user-data-dir="$RUNNER_TEMP/chrome-j1" --use-mock-keychain --password-store=basic --no-first-run about:blank >/dev/null 2>&1 &
for i in $(seq 1 50); do curl -fs http://127.0.0.1:9222/json/version >/dev/null && break; sleep 0.2; done
rc=0
node scripts/matrix/j1.mjs --site "$SITE" --env-file "$OUT/env.json" --out "$OUT/j1" || rc=$?
kill "$(cat "$OUT/services.pid")" 2>/dev/null || true
exit $rc
