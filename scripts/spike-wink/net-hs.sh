#!/bin/bash
# net-hs.sh up|key|down  -> one headless headscale for the two-machine proof, plain http, no DERP.
#   W=$HOME/wink-net IP=<address the other machine can reach> PORT=38480 ./net-hs.sh up
# Embedded DERP is off on purpose: with UDP blocked there is then no path at all, which is the case the relay peer stream is for.
set -e
W=${W:-$HOME/wink-net}; HSBIN=${HSBIN:-$HOME/spike-wink/bin/headscale}; IP=${IP:-127.0.0.1}; P=${PORT:-38480}
D=$W/hs; mkdir -p $D $W/logs
C="$HSBIN -c $D/config.yaml"
case "$1" in
up)
cat > $D/derp-dummy.yaml <<Y
regions:
  900:
    regionid: 900
    regioncode: none
    regionname: none
    nodes:
      - name: 900a
        regionid: 900
        hostname: derp.invalid
        stunport: -1
        stunonly: false
        derpport: 443
Y
cat > $D/policy.hujson <<'Y'
{ "acls": [ {"action": "accept", "src": ["*"], "dst": ["*:*"]} ] }
Y
cat > $D/config.yaml <<Y
server_url: http://$IP:$P
listen_addr: 0.0.0.0:$P
metrics_listen_addr: 127.0.0.1:$((P+1000))
grpc_listen_addr: 127.0.0.1:$((P+2000))
grpc_allow_insecure: false
noise: { private_key_path: $D/noise_private.key }
prefixes: { v4: 100.88.44.0/24, allocation: sequential }
derp:
  server: { enabled: false }
  urls: []
  paths: [$D/derp-dummy.yaml]
  auto_update_enabled: false
disable_check_updates: true
database: { type: sqlite, sqlite: { path: $D/db.sqlite } }
unix_socket: $D/hs.sock
unix_socket_permission: "0770"
policy: { mode: file, path: $D/policy.hujson }
dns: { magic_dns: false, base_domain: wink.test, override_local_dns: false, nameservers: { global: [] } }
log: { level: warn }
Y
nohup nice -n 15 $HSBIN serve -c $D/config.yaml > $W/logs/hs.log 2>&1 &
echo $! > $D/pid
for i in $(seq 1 40); do curl -sf http://127.0.0.1:$P/health >/dev/null && { echo "headscale up pid $(cat $D/pid)"; exit 0; }; sleep 0.25; done
echo "headscale did not come up"; tail -5 $W/logs/hs.log; exit 1;;
key)
$C users list -o json 2>/dev/null | grep -q '"name": "owner"' || $C users create owner >/dev/null 2>&1
UID_=$($C users list -o json | jq -r '.[]|select(.name=="owner").id')
$C preauthkeys create -u $UID_ -e 1h -o json | jq -r .key;;
down) [ -f $D/pid ] && kill $(cat $D/pid) && rm -f $D/pid;;
esac
