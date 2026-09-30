#!/usr/bin/env bash
# T2b: does a Pi-hole style resolver (dnsmasq with --stop-dns-rebind) pass the addresses a Vyre box publishes?
# A fake upstream answers for names in a test zone with tailnet addresses; a forwarder in front of it runs the
# rebind filter; we ask the forwarder and print, per address, whether it came through, and with the
# rebind-domain-ok exception. Loopback only, no real names, no outbound DNS. Needs dnsmasq and dig.
set -u
UP=5301; FW=5302; FX=5303
tmp=$(mktemp -d); trap 'kill $(cat "$tmp"/*.pid 2>/dev/null) 2>/dev/null; rm -rf "$tmp"' EXIT
DNSMASQ=$(command -v dnsmasq || echo /usr/sbin/dnsmasq)
# the addresses a box publishes (core/names: tailnet IPs only) plus controls the filter must block
cases=(
  "tailnet-v4 100.64.0.9"
  "tailnet-v4-high 100.127.255.254"
  "tailnet-v6 fd7a:115c:a1e0::9"
  "control-rfc1918 10.0.0.5"
  "control-loopback 127.0.0.2"
)
addr=()
for c in "${cases[@]}"; do set -- $c; addr+=("--address=/$1.test.vyre.example/$2"); done
$DNSMASQ --no-daemon --no-resolv --no-hosts --port=$UP --listen-address=127.0.0.1 --bind-interfaces --pid-file="$tmp/up.pid" "${addr[@]}" >"$tmp/up.log" 2>&1 &
sleep 0.5
$DNSMASQ --no-daemon --no-resolv --no-hosts --port=$FW --listen-address=127.0.0.1 --bind-interfaces --pid-file="$tmp/fw.pid" \
  --server=127.0.0.1#$UP --stop-dns-rebind --log-queries --log-facility="$tmp/fw.log" >/dev/null 2>&1 &
$DNSMASQ --no-daemon --no-resolv --no-hosts --port=$FX --listen-address=127.0.0.1 --bind-interfaces --pid-file="$tmp/fx.pid" \
  --server=127.0.0.1#$UP --stop-dns-rebind --rebind-domain-ok=/vyre.example/ --log-facility="$tmp/fx.log" >/dev/null 2>&1 &
sleep 0.8
echo "dnsmasq $($DNSMASQ --version | head -1)"
printf '%-18s %-26s %-22s %s\n' case address "stop-dns-rebind" "with rebind-domain-ok"
rc=0
for c in "${cases[@]}"; do
  set -- $c; name=$1.test.vyre.example; ip=$2; type=A; [[ "$ip" == *:* ]] && type=AAAA
  a=$(dig +short +time=3 +tries=1 @127.0.0.1 -p $FW "$name" $type | head -1)
  b=$(dig +short +time=3 +tries=1 @127.0.0.1 -p $FX "$name" $type | head -1)
  ra=$([ "$a" = "$ip" ] && echo passed || echo BLOCKED); rb=$([ "$b" = "$ip" ] && echo passed || echo BLOCKED)
  printf '%-18s %-26s %-22s %s\n' "$1" "$ip" "$ra" "$rb"
  case "$1" in tailnet-*) [ "$rb" = passed ] || rc=1 ;; esac   # the exception must always work
done
echo "--- forwarder log (rebind lines)"; grep -i rebind "$tmp/fw.log" | sed 's/^[A-Za-z]* *[0-9]* [0-9:]* //' | head -10
exit $rc
