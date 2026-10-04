#!/bin/sh
# The Space wall (SH-1, SH-4, SH-5), the entry's half: run by wall-entry.sh on EVERY start of the vyre container and before the daemon. The container has no NET_ADMIN for this and is
# never privileged: the rules that keep every uid but the daemon's away from a Space's store live in this container's network namespace and are put there by the root-side Space helper
# on the host (box/vyre `space-helper`), which proves them and then writes status/wall-ready: one line, `<first 12 characters of the container id> <start time, epoch seconds>`. A plain
# `docker restart` keeps the container's id and joins but loses its rules, so the marker must name this id AND this start: the entry compares the marker's start time with its own
# (PID 1's start time, from /proc), and a marker from an earlier start never matches. The helper also removes the marker when the container dies.
# Fails closed: if the helper is installed on the host (status/ready) and its list of firewalled subnets (status/subnets) is missing, nothing starts. An empty list means no store is
# firewalled, so there is nothing to wait for. If the marker does not come in time the container does not start, and Docker's restart policy tries again: the daemon never runs with a
# store open to the agents.
set -u
state=${VYRE_SPACES_STATE:-/run/vyre-spaces-state}
[ -f "$state/ready" ] || exit 0
if [ ! -f "$state/subnets" ]; then echo "space wall: the host's Space helper is installed but its list of firewalled stores is missing, so the daemon is not starting" >&2; exit 1; fi
[ -s "$state/subnets" ] || exit 0
me=$(hostname | cut -c1-12)
# This container's start, in epoch seconds: PID 1's start time (field 22 of /proc/1/stat, in clock ticks since boot) plus the boot time. VYRE_WALL_TEST_START stands in for it in tests.
if [ -n "${VYRE_WALL_TEST_START:-}" ]; then mystart=$VYRE_WALL_TEST_START
else
  hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
  ticks=$(sed 's/^.*) //' /proc/1/stat 2>/dev/null | awk '{print $20}')
  btime=$(awk '/^btime/ { print $2 }' /proc/stat 2>/dev/null)
  case "$ticks$btime" in ""|*[!0-9]*) echo "space wall: this container's start time cannot be read, so the daemon is not starting" >&2; exit 1 ;; esac
  mystart=$((btime + ticks / hz))
fi
wait=${VYRE_WALL_WAIT:-120}
i=0
while [ "$i" -lt "$wait" ]; do
  read -r mid mst <"$state/wall-ready" 2>/dev/null || { mid=""; mst=""; }
  case "$mst" in ""|*[!0-9]*) ;; *)
    d=$((mst - mystart)); [ "$d" -ge 0 ] || d=$((0 - d))
    if [ "$mid" = "$me" ] && [ "$d" -le 3 ]; then exit 0; fi ;;
  esac
  i=$((i + 1)); sleep 1
done
echo "space wall: the host has not confirmed the firewall for this start of the container ($me) in ${wait}s, so the daemon is not starting: a store would be open to the agents" >&2
exit 1
