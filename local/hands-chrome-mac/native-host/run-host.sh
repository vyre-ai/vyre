#!/bin/sh
# Chrome runs this file, not host.js, because a native messaging manifest names one executable
# and Chrome's PATH is not the person's. install.js records the node it was run with in node-path.
here="$(cd "$(dirname "$0")" && pwd)"
node="$(cat "$here/node-path" 2>/dev/null)"
[ -x "$node" ] || node="$(command -v node)"
exec "$node" "$here/host.js" "$@"
