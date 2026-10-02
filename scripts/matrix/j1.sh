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
mkdir -p "$T/fake" && cp scripts/matrix/fake-claude-login.js "$T/fake/claude-login.cjs" && chmod 755 "$T/fake/claude-login.cjs"
printf '#!/bin/sh\nexec node /opt/matrix/claude-login.cjs "$@"\n' >"$T/fake/claude" && chmod 755 "$T/fake/claude"
cat >/srv/vyre/compose.e2e.yml <<YML
services:
  vyre:
    environment:
      - VYRE_TAILSCALE_UP_FLAGS=--accept-dns=false --hostname=vyre --login-server=http://$IP:8080
      - VYRE_ACME_DIRECTORY=https://$IP:14000/dir
      - NODE_TLS_REJECT_UNAUTHORIZED=0
    volumes:
      - $T/fake/claude:/usr/local/bin/claude:ro
      - $T/fake/claude-login.cjs:/opt/matrix/claude-login.cjs:ro
YML
docker volume create --label com.docker.compose.project=vyre --label com.docker.compose.volume=vyre-home vyre_vyre-home >/dev/null
docker run --rm -v vyre_vyre-home:/home/vyre -e R="$RELAY_BOX_WS" -e N="$NAMES_BOX" busybox sh -c \
  'mkdir -p /home/vyre/.vyre && printf "{\"relay\":{\"enabled\":true,\"url\":\"%s\"},\"network\":{\"directory\":\"%s\"}}\n" "$R" "$N" >/home/vyre/.vyre/config.json && chown -R 1000:1000 /home/vyre && chmod 700 /home/vyre/.vyre && chmod 600 /home/vyre/.vyre/config.json'


# Variants (J1_VARIANT): the same journey on a different server or link. Set by the workflow, never by a person.
#   snap | podman | rootless  a docker on PATH that answers the way that flavour does (a stand-in, named in the results):
#                             the installer has to turn it away in plain words and start nothing
#   slow                      the link to the page and the installer is 1 Mbit with 100 ms each way (tc on the runner)
#   twice                     the install line pasted a second time changes nothing
#   hostile                   another server runs the same line first (someone with a screenshot)
#   cgnat                     no new inbound connection reaches the runner's uplink
VARIANT=${J1_VARIANT:-}
SHIM=""
case "$VARIANT" in
  snap|podman|rootless)
    REAL=$(command -v docker)
    case "$VARIANT" in snap) D=$T/shim/snap/bin ;; *) D=$T/shim/bin ;; esac
    mkdir -p "$D"
    case "$VARIANT" in
      snap) printf '#!/bin/sh\nexec %s "$@"\n' "$REAL" >"$D/docker" ;;
      podman) printf '#!/bin/sh\ncase "$1" in --version) echo "podman version 4.9.3";; *) exec %s "$@";; esac\n' "$REAL" >"$D/docker" ;;
      rootless) printf '#!/bin/sh\ncase "$1 $2" in "info --format") echo "[name=seccomp,profile=builtin name=rootless name=cgroupns]";; *) exec %s "$@";; esac\n' "$REAL" >"$D/docker" ;;
    esac
    chmod 755 "$D/docker"; SHIM=$D
    case "$VARIANT" in snap) export J1_EXPECT_REFUSE="snap" ;; podman) export J1_EXPECT_REFUSE="podman" ;; rootless) export J1_EXPECT_REFUSE="rootless" ;; esac ;;
  slow)
    IFACE=$(ip route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
    # The page, the relay and the installer's download travel over loopback here: 1 Mbit. The runner's own uplink
    # (image layers from registries) only gets the 100 ms, since a real server pulls those at its provider's speed.
    sudo tc qdisc add dev lo root netem delay 100ms rate 1mbit limit 1000 2>"$OUT/tc.err" || sudo tc qdisc add dev lo root tbf rate 1mbit burst 32kbit latency 400ms 2>>"$OUT/tc.err" || echo "j1.sh: could not throttle lo" >&2
    sudo tc qdisc add dev "$IFACE" root netem delay 100ms 2>>"$OUT/tc.err" || echo "j1.sh: could not delay $IFACE" >&2
    sudo tc qdisc show >"$OUT/tc.txt" 2>&1 ;;
  twice) export J1_TWICE=1 ;;
  hostile) export J1_HOSTILE=1 ;;
  cgnat)
    # A server behind carrier-grade NAT: nothing can open a connection to it from outside. Everything the journey needs
    # (the relay, the name directory, the tailnet's control plane) is reached by the box dialling out, so dropping every
    # NEW inbound connection on the runner's uplink must change nothing. (The stand-ins listen on the runner's address
    # for the box's container, which is not the uplink.)
    IFACE=$(ip route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
    sudo iptables -I INPUT -i "$IFACE" -m conntrack --ctstate NEW -j DROP
    sudo iptables -L INPUT -n -v >"$OUT/iptables.txt" 2>&1 ;;
esac

PATHV=$PATH; [ -z "$SHIM" ] || PATHV=$SHIM:$PATH
printf '{"VYRE_BOX_URL":"%s/box/","VYRE_RELAY":"http://%s:%s","VYRE_BUILD":"tgz","COMPOSE_FILE":"/srv/vyre/compose.yml:/srv/vyre/compose.build.yml:/srv/vyre/compose.e2e.yml","PATH":"%s"}\n' "$SITE" "$IP" "${RELAY##*:}" "$PATHV" >"$OUT/env.json"
# A browser that is not the runner's own Chrome (arm64) gets Playwright's usual flags for a container-like runner.
EXTRA=""; [ -z "${J1_CHROME:-}" ] || EXTRA="--no-sandbox --disable-gpu --disable-dev-shm-usage"
${J1_CHROME:-google-chrome} --headless=new --remote-debugging-port=9222 --user-data-dir="$RUNNER_TEMP/chrome-j1" --use-mock-keychain --password-store=basic --no-first-run $EXTRA about:blank >"$OUT/chrome.log" 2>&1 &
for i in $(seq 1 150); do curl -fs http://127.0.0.1:9222/json/version >/dev/null && break; sleep 0.2; done
curl -fs http://127.0.0.1:9222/json/version >/dev/null || { echo "j1.sh: Chrome DevTools never came up" >&2; tail -20 "$OUT/chrome.log" >&2; exit 1; }
rc=0
node scripts/matrix/j1.mjs --site "$SITE" --env-file "$OUT/env.json" --out "$OUT/j1" || rc=$?
# Drive on the fresh box (J1_DRIVE=1): a project made on the server is listed and opens, before anything is shared.
if [ "${J1_DRIVE:-}" = 1 ] && [ "$rc" -eq 0 ]; then node scripts/matrix/drive-fresh.mjs "$OUT/drive" || rc=$?; fi
docker logs --tail 80 vyre-vyre-1 >"$OUT/vyred.log" 2>&1 || true
{ echo "== relay, setup and channel lines, whole log"; docker logs vyre-vyre-1 2>&1 | grep -i -E "relay|setup|channel|claim|onboard|error|warn" | tail -80; } >>"$OUT/vyred.log" 2>&1 || true
docker exec -u vyre vyre-vyre-1 vyre call onboard.status '{}' >>"$OUT/vyred.log" 2>&1 || true
docker exec -u vyre vyre-vyre-1 sh -c 'for f in ~/.vyre/logs/* ~/.vyre/*.log; do [ -f "$f" ] && { echo "== $f"; tail -60 "$f"; }; done' >>"$OUT/vyred.log" 2>&1 || true
docker exec -u vyre vyre-vyre-1 sh -c 'claude --version' >>"$OUT/vyred.log" 2>&1 || true
docker logs --tail 40 e2e-headscale >"$OUT/headscale.log" 2>&1 || true
kill "$(cat "$OUT/services.pid")" 2>/dev/null || true
exit $rc
