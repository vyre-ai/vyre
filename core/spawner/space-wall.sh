#!/bin/sh
# The Space wall (SH-1): run by wall-entry.sh as root with NET_ADMIN, in the vyre container's own network namespace, on EVERY start of the container and before the daemon
# runs. The root-side Space helper (box/vyre, `space-helper`) writes status/subnets, one `<space> <subnet>` line for each store network it firewalled, into the folder the
# container mounts read-only. Here every such subnet gets the rule that refuses every uid but the daemon's: a plain `docker restart` keeps the container's network joins and
# loses its rules, and without this a store would be reachable by agents until the next `up`. If a listed rule cannot be put in, this exits 1 and the container does not start:
# the daemon never runs with a store open to the agents. No file, no Spaces, nothing to do.
set -u
list=${VYRE_SPACES_STATE:-/run/vyre-spaces-state}/subnets
uid=${VYRE_DAEMON_UID:-1000}
[ -f "$list" ] || exit 0
bad=0
while IFS=' ' read -r name subnet extra; do
  [ -n "$name" ] || continue
  # Only what the helper writes: a Space name and a subnet. Anything else is skipped and said, never run.
  if [ -n "$extra" ] || ! printf '%s\n' "$name" | grep -Eqx '[a-z][a-z0-9-]{0,30}' || ! printf '%s\n' "$subnet" | grep -Eqx '([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}|[0-9a-f:]+/[0-9]{1,3}'; then
    echo "space wall: a line in $list is not one the helper writes; it was skipped" >&2; continue
  fi
  case "$subnet" in *:*) ipt=ip6tables ;; *) ipt=iptables ;; esac
  if ! "$ipt" -w -C OUTPUT -d "$subnet" -m owner ! --uid-owner "$uid" -m comment --comment "vyre:$name" -j REJECT >/dev/null 2>&1; then
    "$ipt" -w -I OUTPUT 1 -d "$subnet" -m owner ! --uid-owner "$uid" -m comment --comment "vyre:$name" -j REJECT >/dev/null 2>&1 || { echo "space wall: the rule for $name could not be added" >&2; bad=1; continue; }
  fi
  "$ipt" -w -C OUTPUT -d "$subnet" -m owner ! --uid-owner "$uid" -m comment --comment "vyre:$name" -j REJECT >/dev/null 2>&1 || { echo "space wall: the rule for $name is not there after it was added" >&2; bad=1; }
done <"$list"
[ "$bad" = 0 ] || { echo "space wall: not starting the daemon: a store would be open to the agents" >&2; exit 1; }
exit 0
