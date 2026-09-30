#!/bin/sh
# j1.sh: J1 on a throwaway CI runner. Run scripts/build-site.sh first.
#   sh scripts/matrix/j1.sh <out-dir>
# Stand-ins, all named in the results: the real relay and the real names Worker on the runner (a fake
# DNS zone), a headscale for the tailnet, pebble for ACME, a fake `claude setup-token`. The box's
# addresses for them are set before it first starts, so it never talks to a production service.
set -eu
[ -n "${CI:-}" ] || { echo "j1.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
STAGED=$RUNNER_TEMP/staged
T=$RUNNER_TEMP/j1
mkdir -p "$T"
node scripts/matrix/j1-services.mjs "$STAGED" site/box >"$OUT/services.json" 2>"$OUT/services.err" &
echo $! >"$OUT/services.pid"
i=0; while [ ! -s "$OUT/services.json" ] && [ $i -lt 100 ]; do i=$((i + 1)); sleep 0.1; done
[ -s "$OUT/services.json" ] || { echo "j1.sh: the stand-in services did not start" >&2; cat "$OUT/services.err" >&2; exit 1; }
field() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$OUT/services.json" "$1"; }
SITE=$(field site); RELAY=$(field relay); RELAY_BOX_WS=$(field relayForBoxWs); NAMES_BOX=$(field namesForBox); IP=$(field hostIp)
VYRE_SETUP_RELAY=$RELAY VYRE_SETUP_INSTALL_URL=$SITE/i sh scripts/stage-site.sh --out "$STAGED"

# The tailnet: a headscale on the runner (the harness in scripts/e2e-headscale, on the runner's own address).
mkdir -p "$T/hs"
sed -e "s#^server_url:.*#server_url: http://$IP:8080#" -e 's#mode: database#mode: file#' -e 's#^  path: ""#  path: /etc/headscale/policy.json#' scripts/e2e-headscale/headscale/config.yaml >"$T/hs/config.yaml"
printf '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}\n' >"$T/hs/policy.json"
docker run -d --name e2e-headscale -p 8080:8080 -v "$T/hs":/etc/headscale headscale/headscale:0.29.4 serve >/dev/null
sleep 5
docker exec e2e-headscale headscale users create marlow >/dev/null

# ACME: pebble accepts every challenge, so the box gets a certificate with no public DNS.
docker run -d --name e2e-pebble -p 14000:14000 -e PEBBLE_VA_ALWAYS_VALID=1 -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 ghcr.io/letsencrypt/pebble:latest >/dev/null

# The box's folder and home volume, made before the install so its first start already points at the stand-ins.
sudo mkdir -p /srv/vyre && sudo chown "$(id -u):$(id -g)" /srv/vyre
mkdir -p "$T/fake" && cp scripts/rc-smoke/fake-claude/fake-claude "$T/fake/fake-claude" 2>/dev/null || cp scripts/rc-smoke/fake-claude "$T/fake/fake-claude"
chmod 755 "$T/fake/fake-claude"
cat >/srv/vyre/compose.e2e.yml <<YML
services:
  vyre:
    environment:
      - VYRE_TAILSCALE_UP_FLAGS=--accept-dns=false --hostname=vyre --login-server=http://$IP:8080
      - VYRE_ACME_DIRECTORY=https://$IP:14000/dir
      - NODE_TLS_REJECT_UNAUTHORIZED=0
      - VYRE_CLAUDE_BIN=/opt/rc/fake-claude
    volumes:
      - $T/fake:/opt/rc:ro
YML
docker volume create --label com.docker.compose.project=vyre --label com.docker.compose.volume=vyre-home vyre_vyre-home >/dev/null
docker run --rm -v vyre_vyre-home:/home/vyre -e R="$RELAY_BOX_WS" -e N="$NAMES_BOX" busybox sh -c \
  'mkdir -p /home/vyre/.vyre && printf "{\"relay\":{\"enabled\":true,\"url\":\"%s\"},\"network\":{\"directory\":\"%s\"}}\n" "$R" "$N" >/home/vyre/.vyre/config.json && chown -R 1000:1000 /home/vyre && chmod 700 /home/vyre/.vyre && chmod 600 /home/vyre/.vyre/config.json'

printf '{"VYRE_BOX_URL":"%s/box/","VYRE_RELAY":"http://%s:%s","VYRE_BUILD":"tgz","COMPOSE_FILE":"/srv/vyre/compose.yml:/srv/vyre/compose.build.yml:/srv/vyre/compose.e2e.yml"}\n' "$SITE" "$IP" "${RELAY##*:}" >"$OUT/env.json"
google-chrome --headless=new --remote-debugging-port=9222 --user-data-dir="$RUNNER_TEMP/chrome-j1" --use-mock-keychain --password-store=basic --no-first-run about:blank >/dev/null 2>&1 &
for i in $(seq 1 50); do curl -fs http://127.0.0.1:9222/json/version >/dev/null && break; sleep 0.2; done
rc=0
node scripts/matrix/j1.mjs --site "$SITE" --env-file "$OUT/env.json" --out "$OUT/j1" || rc=$?
docker logs --tail 80 vyre-vyre-1 >"$OUT/vyred.log" 2>&1 || true
docker exec -u vyre vyre-vyre-1 sh -c 'for f in ~/.vyre/logs/* ~/.vyre/*.log; do [ -f "$f" ] && { echo "== $f"; tail -60 "$f"; }; done' >>"$OUT/vyred.log" 2>&1 || true
docker exec -u vyre vyre-vyre-1 sh -c 'ls -la /opt/rc; echo $VYRE_CLAUDE_BIN; /opt/rc/fake-claude --version' >>"$OUT/vyred.log" 2>&1 || true
docker logs --tail 40 e2e-headscale >"$OUT/headscale.log" 2>&1 || true
kill "$(cat "$OUT/services.pid")" 2>/dev/null || true
exit $rc
