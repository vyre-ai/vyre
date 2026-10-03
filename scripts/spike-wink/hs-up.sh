#!/bin/bash
# hs-up.sh NAME LISTEN_IP PORT STUN_PORT PREFIX  -> one headless headscale per space under $W/hs-NAME
# Everything from config files and the CLI over a unix socket: no UI, no browser, no OIDC.
set -e
W=${W:-$HOME/spike-wink2}; HSBIN=${HSBIN:-$HOME/spike-wink/bin/headscale}
N=$1; IP=$2; P=$3; STUN=$4; PREFIX=${5:-100.97.143.0/24}
D=$W/hs-$N; mkdir -p $D $W/logs
if [ ! -f $D/cert.pem ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3 -subj "/CN=wink-$N" \
    -addext "subjectAltName=IP:$IP,IP:127.0.0.1" -addext "basicConstraints=critical,CA:TRUE" \
    -keyout $D/key.pem -out $D/cert.pem 2>/dev/null
fi
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
{
  "tagOwners": { "tag:hub": ["owner@"], "tag:device": ["owner@"] },
  "acls": [
    {"action": "accept", "src": ["tag:device"], "dst": ["tag:hub:7000"]},
    {"action": "accept", "src": ["tag:hub"], "dst": ["tag:device:7000"]}
  ]
}
Y
cat > $D/config.yaml <<Y
server_url: https://$IP:$P
listen_addr: $IP:$P
tls_cert_path: $D/cert.pem
tls_key_path: $D/key.pem
metrics_listen_addr: 127.0.0.1:$((P+1000))
grpc_listen_addr: 127.0.0.1:$((P+2000))
grpc_allow_insecure: false
noise: { private_key_path: $D/noise_private.key }
prefixes: { v4: $PREFIX, allocation: sequential }
derp:
  server:
    enabled: true
    region_id: 999
    region_code: wink
    region_name: "Wink embedded DERP"
    verify_clients: true
    stun_listen_addr: "$IP:$STUN"
    private_key_path: $D/derp_server_private.key
    automatically_add_embedded_derp_region: true
    ipv4: $IP
  urls: []
  paths: [$D/derp-dummy.yaml]
  auto_update_enabled: false
disable_check_updates: true
node: { expiry: 0, ephemeral: { inactivity_timeout: 30m } }
database: { type: sqlite, sqlite: { path: $D/db.sqlite, write_ahead_log: true } }
log: { level: info, format: text }
policy: { mode: file, path: $D/policy.hujson }
dns: { magic_dns: false, override_local_dns: false, base_domain: wink.internal, nameservers: { global: [] } }
unix_socket: $D/hs.sock
unix_socket_permission: "0600"
logtail: { enabled: false }
taildrop: { enabled: false }
Y
s=$(date +%s.%N)
setsid nohup nice -n 15 $HSBIN serve -c $D/config.yaml > $W/logs/hs-$N.log 2>&1 &
echo $! > $D/pid
for i in $(seq 1 100); do curl -sk -o /dev/null -w '%{http_code}' https://$IP:$P/health 2>/dev/null | grep -q 200 && break; sleep 0.1; done
e=$(date +%s.%N)
echo "hs-$N pid=$(cat $D/pid) healthy_after_s=$(echo "$e - $s" | bc) rss_kb=$(awk '/VmRSS/{print $2}' /proc/$(cat $D/pid)/status)"
