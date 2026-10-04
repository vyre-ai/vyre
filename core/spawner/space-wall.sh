#!/bin/sh
# The Space wall (SH-1), the entry's half: run by wall-entry.sh on EVERY start of the vyre container and before the daemon. The container has no NET_ADMIN for this and is never
# privileged: the rules that keep every uid but the daemon's away from a Space's store live in this container's network namespace and are put there by the root-side Space helper on
# the host (box/vyre `space-helper`), which proves them and then writes status/wall-ready: one line, the first 12 characters of the id of the container instance it did this for. A plain
# `docker restart` keeps the container's network joins and loses its rules, so this waits for the marker of THIS instance (the hostname Docker gives it); a marker from an earlier start
# never matches. If the host has firewalled no store (no status/subnets), there is nothing to wait for. If the marker does not come in time the container does not start, and Docker's
# restart policy tries again: the daemon never runs with a store open to the agents.
set -u
state=${VYRE_SPACES_STATE:-/run/vyre-spaces-state}
[ -s "$state/subnets" ] || exit 0
me=$(hostname | cut -c1-12)
wait=${VYRE_WALL_WAIT:-120}
i=0
while [ "$i" -lt "$wait" ]; do
  [ "$(head -n 1 "$state/wall-ready" 2>/dev/null)" = "$me" ] && exit 0
  i=$((i + 1)); sleep 1
done
echo "space wall: the host has not confirmed the firewall for this container ($me) in ${wait}s, so the daemon is not starting: a store would be open to the agents" >&2
exit 1
