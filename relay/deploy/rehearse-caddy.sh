#!/bin/bash
# rehearse-caddy.sh: the edge's Caddy, as it will run, against a test certificate authority (Pebble) on this machine. It proves what the container rehearsal (edge.live.test.js) cannot:
# Caddy gets a certificate for edge.vyre.run by HTTP-01 on port 80 while the relay owns 443, serves the boxes' control link on 8443 (a WebSocket through to the relay), and leaves port 80 to the
# relay's fixed redirect. It uses the real Caddyfile with two lines added (the test CA) and the relay on other ports. Needs Docker; binds ports 80 and 8443 on this machine for a minute, so run it
# on a test box, never where something already serves them. Prints PASS or FAIL per check and removes everything it made.
#   bash relay/deploy/rehearse-caddy.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
W="$(mktemp -d)"; P=caddy-reh; CA_PORT=24000; CA_MGMT=25000; CHALL=18055
SECRET="$(head -c 40 /dev/zero | tr '\0' b)"
CADDY="$(sed -n 's/^    image: \(caddy:[^ ]*\).*/\1/p' "$HERE/compose.yml" | head -1)"
bad=0
say() { printf '%s  %s\n' "$1" "$2"; [ "$1" = FAIL ] && bad=1; return 0; }
stop_all() {
  docker rm -f reh-chall reh-pebble reh-caddy >/dev/null 2>&1
  (cd "$HERE" && VYRE_RELAY_SECRET="$SECRET" docker compose -p $P -f compose.yml down -v --timeout 2 >/dev/null 2>&1)
  docker network rm $P >/dev/null 2>&1; docker volume rm $P-data >/dev/null 2>&1
  sudo -n sed -i '/# caddy-reh/d' /etc/hosts 2>/dev/null
}
trap 'stop_all; rm -rf "$W"' EXIT
stop_all
for port in 80 8443 $CA_PORT $CA_MGMT $CHALL; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "port $port is already in use here; this rehearsal needs it free"; exit 2; fi
done
docker network create $P >/dev/null
GW="$(docker network inspect $P -f '{{(index .IPAM.Config 0).Gateway}}')"

# Pebble (a test CA that checks challenges on port 80) and its DNS stand-in, which says edge.vyre.run is this machine
pebble_id="$(docker create ghcr.io/letsencrypt/pebble:latest)"
docker cp "$pebble_id:/test/config/pebble-config.json" "$W/pebble-config.json" && docker cp "$pebble_id:/test/certs/pebble.minica.pem" "$W/minica.pem"; docker rm "$pebble_id" >/dev/null
sed -i 's/"httpPort": 5002/"httpPort": 80/' "$W/pebble-config.json"
docker run -d --name reh-chall --network $P -p 127.0.0.1:$CHALL:8055 ghcr.io/letsencrypt/pebble-challtestsrv -http01 "" -https01 "" -tlsalpn01 "" >/dev/null
docker run -d --name reh-pebble --network $P -p 127.0.0.1:$CA_PORT:14000 -p 127.0.0.1:$CA_MGMT:15000 -e PEBBLE_VA_NOSLEEP=1 -v "$W/pebble-config.json:/cfg/pebble-config.json:ro" ghcr.io/letsencrypt/pebble -config /cfg/pebble-config.json -dnsserver reh-chall:8053 >/dev/null
sleep 3
curl -s -X POST -d "{\"host\":\"edge.vyre.run\",\"addresses\":[\"$GW\"]}" http://127.0.0.1:$CHALL/add-a >/dev/null
curl -s -X POST -d '{"ip":""}' http://127.0.0.1:$CHALL/set-default-ipv6 >/dev/null

# the relay as compose runs it, on other ports; the Caddyfile is the real one, pointed at those ports and at the test CA
export VYRE_RELAY_SECRET="$SECRET" EDGE_TLS_BIND=127.0.0.1:19443 EDGE_HTTP_BIND=127.0.0.1:19080 EDGE_CONTROL_BIND=127.0.0.1:18080
(cd "$HERE" && docker compose -p $P -f compose.yml up -d --build relay >/dev/null 2>&1) || { say FAIL "the relay did not start"; exit 1; }
python3 - "$HERE/Caddyfile" "$W/Caddyfile" "$CA_PORT" <<'PY'
import sys
s = open(sys.argv[1]).read()
s = s.replace("\tadmin off\n", "\tadmin off\n\tacme_ca https://127.0.0.1:%s/dir\n\tacme_ca_root /certs/minica.pem\n" % sys.argv[3], 1)
s = s.replace("127.0.0.1:9080", "127.0.0.1:19080").replace("127.0.0.1:8080", "127.0.0.1:18080")
open(sys.argv[2], "w").write(s)
PY
docker run -d --name reh-caddy --network host -v "$W/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$W/minica.pem:/certs/minica.pem:ro" -v $P-data:/data --cap-drop ALL --cap-add NET_BIND_SERVICE "$CADDY" >/dev/null
sleep 8
curl -sk https://127.0.0.1:$CA_MGMT/roots/0 > "$W/root.pem"

ok=0
for _ in $(seq 1 40); do
  out="$(curl -s --max-time 4 --cacert "$W/root.pem" --resolve edge.vyre.run:8443:127.0.0.1 https://edge.vyre.run:8443/health 2>/dev/null)"
  case "$out" in *'"ok":true'*) ok=1; break;; esac
  sleep 3
done
if [ "$ok" = 1 ]; then say PASS "Caddy got a certificate for edge.vyre.run by HTTP-01 and the control link's address answers through it"
else say FAIL "https://edge.vyre.run:8443/health did not answer ($(docker logs reh-caddy 2>&1 | grep -m1 '"level":"error"' | cut -c1-200))"; fi
code="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Host: documents.harlow.vyre.run' http://127.0.0.1:80/x)"
case "$code" in 308*https://*|301*https://*) say PASS "port 80 is the relay's fixed redirect ($code)";; *) say FAIL "port 80 answered '$code'";; esac
# a box's control link: a WebSocket to wss://edge.vyre.run:8443 reaches the relay through Caddy (the name must resolve here: a hosts line, removed on exit)
if sudo -n true 2>/dev/null && [ -f "$HERE/../../core/relay/link.js" ]; then
  sudo -n sh -c 'echo "127.0.0.1 edge.vyre.run # caddy-reh" >> /etc/hosts'
  probe="$W/probe.mjs"
  cat > "$probe" <<JS
import { relayLink } from "$HERE/../../core/relay/link.js";
import { keyPair } from "$HERE/../../core/relay/noise.js";
import { newRouteKey, routeId } from "$HERE/../../core/relay/wire.js";
const k = newRouteKey();
const link = relayLink({ url: "wss://edge.vyre.run:8443", route: routeId(k.pub), routeKey: k, boxKey: keyPair(), admit: async () => ({ v: 1 }), onchannel: () => {}, ontunnel: () => {} });
const ok = await Promise.race([link.ready(), new Promise(r => setTimeout(() => r(false), 15000))]);
link.stop(); process.exit(ok === true ? 0 : 1);
JS
  if NODE_EXTRA_CA_CERTS="$W/root.pem" node "$probe" >/dev/null 2>&1; then say PASS "a box's control link (WebSocket over TLS on 8443) reaches the relay through Caddy"; else say FAIL "the control link did not come up through Caddy"; fi
else
  echo "skip  the WebSocket check needs passwordless sudo (one hosts line) and a repo checkout"
fi
if [ "$bad" = 0 ]; then echo "caddy: all checks passed"; else echo "caddy: something is wrong (see FAIL above)"; fi
exit "$bad"
