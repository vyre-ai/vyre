#!/bin/sh
# box-up.sh <site-box-dir> <link-file>: install a Vyre box on this throwaway runner the way a
# person does (install-box.sh from the box files, checked against SHA256SUMS), with the files
# served from a local folder instead of vyre.run. Writes the one-time onboarding link to
# <link-file>. For hosted CI runners only: never run it on a real server.
set -eu
BOX=$(cd "$1" && pwd)
LINK=$2
[ -n "${CI:-}" ] || { echo "box-up.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
python3 -m http.server 18080 --bind 127.0.0.1 --directory "$BOX" >/dev/null 2>&1 &
for i in $(seq 1 50); do curl -fs http://127.0.0.1:18080/SHA256SUMS >/dev/null && break; sleep 0.2; done
t0=$(date +%s)
out=$(VYRE_BOX_URL=http://127.0.0.1:18080/ VYRE_BUILD=tgz sh "$BOX/install-box.sh" --yes --print-link </dev/null)
echo "box-up: installed in $(( $(date +%s) - t0 )) s" >&2
echo "$out" | sed -n 's/^VYRE_LINK=//p' | head -1 >"$LINK"
[ -s "$LINK" ] || { echo "box-up: the installer printed no link" >&2; echo "$out" >&2; exit 1; }
