#!/bin/sh
# loop.sh: vyred inside the box container (ADR 0029, R4 and R7).
#
# tini is the container's init; this loop is its child and vyred is ours. When vyred exits on its
# own (a crash, or a SIGTERM from `vyre up` inside the box), the loop starts it again in 2 s, so
# the container and everything vyred left running in it (the dtach terminals, now children of
# tini) stay up and the next vyred picks them up. When the container is stopping (docker sends
# SIGTERM to tini, which passes it here), vyred gets the SIGTERM, drains, and the loop ends with
# its code. Five exits inside a minute ends the loop too, so Docker's restart policy takes over
# a vyred that cannot start. VYRE_DAEMON and VYRE_LOOP_PAUSE (seconds) override the command and the pause, for tests.

cmd=${VYRE_DAEMON:-"node /opt/vyre/core/daemon/main.js"}
stopping=0
pid=
trap 'stopping=1; [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null' TERM INT
recent=""

while :; do
  $cmd &
  pid=$!
  wait "$pid"
  code=$?
  # A trapped signal ends `wait` early with 128+n, whether or not vyred is done: wait again
  # until it answers with vyred's own status. A vyred killed by a signal really is 128+n: bash
  # then answers 127 (already collected) and dash the same 128+n again, forever, so either
  # one means the last status stands.
  while [ "$code" -gt 128 ]; do
    wait "$pid"
    again=$?
    [ "$again" = 127 ] && break
    [ "$again" = "$code" ] && break
    code=$again
  done
  pid=
  [ "$stopping" = 1 ] && exit "$code"
  now=$(date +%s)
  kept=""
  for t in $recent; do [ $((now - t)) -lt 60 ] && kept="$kept $t"; done
  recent="$kept $now"
  if [ "$(echo $recent | wc -w)" -ge 5 ]; then
    echo "vyred exited 5 times in a minute (last code $code); leaving it to Docker" >&2
    exit "$code"
  fi
  echo "vyred exited ($code); starting it again in 2 s" >&2
  sleep "${VYRE_LOOP_PAUSE:-2}"
done
