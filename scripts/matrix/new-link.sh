#!/bin/sh
# new-link.sh <link-file>: a fresh one-time onboarding link from the box box-up.sh installed on
# this runner (each link opens once, in one browser). CI runners only.
set -eu
[ -n "${CI:-}" ] || { echo "new-link.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
/usr/local/bin/vyre up --print-link </dev/null 2>/dev/null | sed -n 's/^VYRE_LINK=//p' | head -1 >"$1"
[ -s "$1" ] || { echo "new-link.sh: no link" >&2; exit 1; }
