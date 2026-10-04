#!/bin/sh
# The box container's command (box/Dockerfile CMD), under tini. As root with NET_ADMIN (compose gives only this container's
# root that, and vyred drops to uid vyre with no capability) it installs the watcher wall and probes it, writes
# /run/vyre/wall.json, and then REPLACES itself with the spawner under a bounding set without NET_ADMIN, so the serving spawner can never
# change the rule or put the capability back. It keeps SETPCAP (it cannot add NET_ADMIN: that is gone from the bounding set for good) so a
# watcher child can be started with an empty bounding set of its own. It runs on every container start, so a restart
# reinstalls and re-probes before any watcher can be spawned (the spawner refuses one while the status says not ok).
# Not root (a plain docker run), or without the capability: no wall, the status says so, and the spawner starts anyway.
set -u
here=$(dirname "$0")
node_bin=${VYRE_NODE:-node}
if [ "$(id -u)" = 0 ]; then
  # The release's signed files, where the kernel reads them (core/spawner/place-release.sh).
  /bin/sh "$here/place-release.sh" || echo "wall: could not place the release's signed files; first-party modules will not start" >&2
  "$node_bin" "$here/wall.js" install || true
  # The Space wall: the rules that keep every uid but the daemon's away from each Space's store, put back before anything can run (core/spawner/space-wall.sh). A rule that
  # cannot be put in stops the container: it is restarted by Docker's policy and tried again, and the daemon never runs with a store open.
  /bin/sh "$here/space-wall.sh" || exit 1
  # Dropping needs CAP_SETPCAP (held by the entry script, kept by the spawner): tried on a no-op first, so a container without it still starts the spawner.
  if /usr/bin/setpriv --bounding-set=-net_admin /bin/true 2>/dev/null; then
    exec /usr/bin/setpriv --bounding-set=-net_admin "$node_bin" "$here/main.js"
  fi
  echo "wall: could not drop NET_ADMIN, so no watcher will be started" >&2
  "$node_bin" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ok:false,why:"the spawner could not drop NET_ADMIN",at:Math.floor(Date.now()/1000)})+"\n")' "${VYRE_WALL_STATUS:-/run/vyre/wall.json}" 2>/dev/null || true
fi
exec "$node_bin" "$here/main.js"
