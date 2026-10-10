#!/bin/sh
# check.sh: from OUTSIDE the edge VM (your laptop, or a phone on mobile data), is the public door doing its job? One PASS or FAIL line per check; exit 1 if any FAIL.
#   EDGE_IP=203.0.113.7 sh relay/deploy/check.sh                       the real edge
#   EDGE_IP=127.0.0.1 EDGE_TLS_PORT=49153 EDGE_HTTP_PORT=49154 EDGE_SKIP="dns control directory" sh relay/deploy/check.sh   a local rehearsal
# EDGE_NAME=harlow adds a check that https://documents.harlow.vyre.run/ is answered by that box with a public certificate (the box's own, not the relay's).
# say always succeeds, so A && B || C is safe in this file
# shellcheck disable=SC2015
set -u
IP="${EDGE_IP:?set EDGE_IP to the reserved address of the edge VM}"
HOST="${EDGE_HOST:-edge.vyre.run}"; ZONE="${EDGE_ZONE:-vyre.run}"; DIRECTORY="${EDGE_DIRECTORY:-https://names.vyre.run}"
CONTROL="${EDGE_CONTROL_PORT:-8443}"; TLS="${EDGE_TLS_PORT:-443}"; PLAIN="${EDGE_HTTP_PORT:-80}"; SKIP=" ${EDGE_SKIP:-} "
bad=0
say() { printf '%s  %s\n' "$1" "$2"; [ "$1" = FAIL ] && bad=1; return 0; }
skipped() { case "$SKIP" in *" $1 "*) return 0;; esac; return 1; }

if skipped dns; then :; else
  got=$(dig +short A "$HOST" | tail -1)
  [ "$got" = "$IP" ] && say PASS "dns: $HOST is $IP" || say FAIL "dns: $HOST is '${got:-nothing}', expected $IP"
fi
if skipped control; then :; else
  out=$(curl -fsS --max-time 10 "https://$HOST:$CONTROL/health" 2>&1) && say PASS "control link: https://$HOST:$CONTROL/health answers with a certificate curl trusts" || say FAIL "control link: $out"
fi
code=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 8 -H "Host: documents.example.$ZONE" "http://$IP:$PLAIN/x")
case "$code" in 301*https://*|308*https://*) say PASS "port $PLAIN: redirects to https ($code)";; *) say FAIL "port $PLAIN: expected a redirect to https, got '$code'";; esac
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: $IP" "http://$IP:$PLAIN/x")
[ "$code" = 400 ] && say PASS "port $PLAIN: a bare address gets 400, never a box" || say FAIL "port $PLAIN: a bare address got $code, expected 400"
# a name nobody declared: the relay closes it before any box is told, so curl gets no answer at all (000), not even a certificate error page
code=$(curl -sk --max-time 8 --resolve "nobody.$ZONE:$TLS:$IP" -o /dev/null -w '%{http_code}' "https://nobody.$ZONE:$TLS/")
[ "$code" = 000 ] && say PASS "port $TLS: a name nobody declared is closed with no answer" || say FAIL "port $TLS: a name nobody declared got $code"
if skipped directory; then :; else
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$DIRECTORY/v1/tunnel/resolve?host=documents.example.$ZONE")
  case "$code" in 401|404) say PASS "directory: resolve refuses a caller without the relay's secret ($code)";; *) say FAIL "directory: resolve answered $code without the secret";; esac
fi
if [ -n "${EDGE_NAME:-}" ]; then
  out=$(curl -s --max-time 15 -o /dev/null -w '%{http_code} %{ssl_verify_result}' "https://documents.$EDGE_NAME.$ZONE/")
  case "$out" in 200\ 0|404\ 0) say PASS "box: documents.$EDGE_NAME.$ZONE answered ($out) with a verified certificate";; *) say FAIL "box: documents.$EDGE_NAME.$ZONE gave '$out' (want 200 or 404, verify 0)";; esac
fi
[ "$bad" = 0 ] && echo "edge: all checks passed" || echo "edge: something is wrong (see FAIL above)"
exit "$bad"
