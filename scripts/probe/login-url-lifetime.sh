#!/usr/bin/env bash
# T2a: how long does a Tailscale sign-in link (the AuthURL `tailscale up` prints) keep working?
# Starts a userspace tailscaled with no state, asks for a login, never signs in, and polls the link every
# minute until it changes or MAX_MIN passes. Needs network to Tailscale's control plane, and no account, no
# auth key and no tailnet: the link is never used. Prints minute, HTTP status and body size per probe.
set -u
MAX_MIN=${MAX_MIN:-50}; STEP=${STEP:-60}
tmp=$(mktemp -d); trap 'sudo tailscale logout >/dev/null 2>&1; sudo kill $(cat "$tmp/ts.pid" 2>/dev/null) 2>/dev/null; rm -rf "$tmp"' EXIT
sudo tailscaled --tun=userspace-networking --state=mem: --socket="$tmp/ts.sock" >"$tmp/tsd.log" 2>&1 &
echo $! >"$tmp/ts.pid"
sleep 3
T="sudo tailscale --socket=$tmp/ts.sock"
$T up --hostname "vyre-probe-$$" --timeout 25s >"$tmp/up.out" 2>&1 &
for _ in $(seq 1 30); do url=$(grep -o 'https://login.tailscale.com/a/[A-Za-z0-9]*' "$tmp/up.out" | head -1); [ -n "$url" ] && break; sleep 1; done
[ -z "${url:-}" ] && { echo "no sign-in link was printed"; cat "$tmp/up.out"; exit 2; }
echo "tailscale $(tailscale version | head -1); link host login.tailscale.com, id length ${#url}"
first=""; changed=""
for m in $(seq 0 $((MAX_MIN))); do
  out=$(curl -s -o "$tmp/body" -w '%{http_code} %{size_download}' --max-time 15 "$url")
  echo "minute $m: $out"
  [ -z "$first" ] && first="$out"
  # the link stopped being the page it was: a different status, or a much smaller body
  code=${out% *}; size=${out#* }; fcode=${first% *}; fsize=${first#* }
  if [ "$code" != "$fcode" ] || [ "$size" -lt $((fsize / 2)) ]; then changed=$m; break; fi
  sleep $STEP
done
if [ -n "$changed" ]; then echo "RESULT: the link changed at minute $changed (first: $first, then: $out)"; else echo "RESULT: still the same page after $MAX_MIN minutes (first: $first, last: $out)"; fi
