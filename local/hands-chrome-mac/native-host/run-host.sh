#!/bin/sh
# Chrome runs this file, not host.js, because a native messaging manifest names one executable
# and Chrome's PATH is not the person's. install.js records the node it was run with in node-path.
# The standalone package also records the socket it listens on in sock-path, since Chrome starts
# this with none of the person's environment.
here="$(cd "$(dirname "$0")" && pwd)"
node="$(cat "$here/node-path" 2>/dev/null)"
[ -x "$node" ] || node="$(command -v node)"
[ -f "$here/sock-path" ] && VYRE_CHROME_SOCK="$(cat "$here/sock-path")" && export VYRE_CHROME_SOCK
exec "$node" "$here/host.js" "$@"
