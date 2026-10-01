#!/usr/bin/env bash
# T2c: when a rebind-filtering resolver (dnsmasq --stop-dns-rebind, as in Pi-hole) drops the IPv6 tailnet
# (fd7a:115c:a1e0::/48) answer for a name that also has an IPv4 100.64/10 answer, does a real client still connect
# over IPv4? One name, both records, a real HTTP server listening on both addresses (added to lo), the system
# resolver pointed at the filtering forwarder. Prints the AAAA/A answers as the client's resolver sees them, then
# what each client did. Linux hosted runner, sudo, no outbound network.
set -u
NAME=both.test.vyre.example
V4=100.64.0.9; V6=fd7a:115c:a1e0::9; DNS=127.0.0.77; UP=5301
tmp=$(mktemp -d)
cleanup() { sudo kill $(cat "$tmp"/*.pid 2>/dev/null) 2>/dev/null; sudo ip addr del $V4/32 dev lo 2>/dev/null; sudo ip addr del $V6/128 dev lo 2>/dev/null; sudo cp "$tmp/resolv.conf.bak" /etc/resolv.conf 2>/dev/null; rm -rf "$tmp"; }
trap cleanup EXIT
sudo ip addr add $V4/32 dev lo; sudo ip -6 addr add $V6/128 dev lo nodad
sudo ip addr add $DNS/32 dev lo 2>/dev/null
# a server on both addresses that says which one the client used
python3 - "$V4" "$V6" >"$tmp/srv.log" 2>&1 <<'PY' &
import http.server, socket, sys, threading
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s):
        s.send_response(200); s.end_headers(); s.wfile.write(("via " + s.server.family_name + " from " + s.client_address[0] + "\n").encode())
    def log_message(s, *a): pass
def serve(addr, fam, name):
    class S(http.server.HTTPServer): address_family = fam
    s = S((addr, 8080), H); s.family_name = name; s.serve_forever()
for a, f, n in ((sys.argv[1], socket.AF_INET, "IPv4"), (sys.argv[2], socket.AF_INET6, "IPv6")):
    threading.Thread(target=serve, args=(a, f, n), daemon=True).start()
threading.Event().wait()
PY
echo $! >"$tmp/srv.pid"
DNSMASQ=$(command -v dnsmasq || echo /usr/sbin/dnsmasq)
$DNSMASQ --no-daemon --no-resolv --no-hosts --port=$UP --listen-address=127.0.0.1 --bind-interfaces --pid-file="$tmp/up.pid" \
  --address=/$NAME/$V4 --address=/$NAME/$V6 >"$tmp/up.log" 2>&1 &
sudo $DNSMASQ --no-daemon --no-resolv --no-hosts --port=53 --listen-address=$DNS --bind-interfaces --pid-file="$tmp/fw.pid" \
  --server=127.0.0.1#$UP --stop-dns-rebind --log-queries --log-facility="$tmp/fw.log" >/dev/null 2>&1 &
sleep 1
sudo cp /etc/resolv.conf "$tmp/resolv.conf.bak"
printf 'nameserver %s\noptions timeout:2 attempts:1\n' $DNS | sudo tee /etc/resolv.conf >/dev/null
echo "== what the resolver answers"
for t in A AAAA; do printf '%-5s ' $t; dig +noall +comments +answer +time=3 +tries=1 @$DNS $NAME $t | grep -E "status:|IN" | tr '\n' ' ' | sed 's/;; ->>HEADER<<- //'; echo; done
run() { local label=$1; shift; local t0=$(date +%s.%N); local out; out=$("$@" 2>&1 | tr '\n' ' ' | cut -c1-120); local rc=$?; printf '%-22s %-6.2fs  %s\n' "$label" "$(echo "$(date +%s.%N) - $t0" | bc)" "$out"; }
echo "== what each client did (name resolves to both families; the IPv6 answer is filtered)"
run "getent ahosts"   getent ahosts $NAME
run "curl"            curl -s --max-time 15 http://$NAME:8080/
run "python urllib"   python3 -c "import urllib.request;print(urllib.request.urlopen('http://$NAME:8080/',timeout=15).read().decode())"
run "node fetch"      node -e "fetch('http://$NAME:8080/').then(r=>r.text()).then(console.log).catch(e=>console.log('FAILED',e.cause&&e.cause.code||e.message))"
for b in google-chrome chromium chromium-browser; do command -v $b >/dev/null && { run "$b (headless)" timeout 40 $b --headless=new --no-sandbox --disable-gpu --user-data-dir="$tmp/chrome" --dump-dom http://$NAME:8080/; break; }; done
command -v firefox >/dev/null && run "firefox (headless)" timeout 60 firefox --headless --screenshot "$tmp/ff.png" http://$NAME:8080/ || true
echo "-- forwarder log"; grep -iE "rebind|config|reply $NAME" "$tmp/fw.log" | sed 's/^[A-Za-z]* *[0-9]* [0-9:]* //' | head
