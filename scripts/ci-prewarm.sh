#!/bin/sh
# Install the repo's dependencies in seconds on a runner that keeps its disk (the self-hosted ones), and the pinned Chrome without the cache action's download. The first run for a lockfile pays for npm ci once
# and keeps the result under $VYRE_CI_CACHE (default ~/.cache/vyre-ci), keyed by the lockfiles and the node version; every later run copies it. A GitHub-hosted runner has no such disk: it runs the plain commands.
#   scripts/ci-prewarm.sh            root node_modules, then apps/app's (--ignore-scripts, as the workflow ran them), then the pinned Chrome
set -eu
cache="${VYRE_CI_CACHE:-$HOME/.cache/vyre-ci}"
node_v=$(node -p 'process.versions.node.split(".")[0]')
key=$(cat package-lock.json apps/app/package-lock.json | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16)-node$node_v
mkdir -p "$cache"
restore_or_install() { # <dir> <npm args...>
  dir=$1; shift
  slot="$cache/$key/$(echo "$dir" | tr '/' '_')"
  if [ -d "$slot/node_modules" ]; then
    echo "prewarm: $dir/node_modules from $slot"
    rm -rf "$dir/node_modules"; cp -a "$slot/node_modules" "$dir/node_modules"
  else
    echo "prewarm: $dir/node_modules is new for this lockfile: installing"
    (cd "$dir" && npm ci --no-audit --no-fund "$@")
    mkdir -p "$slot.tmp.$$" && cp -a "$dir/node_modules" "$slot.tmp.$$/node_modules" && { mv "$slot.tmp.$$" "$slot" 2>/dev/null || rm -rf "$slot.tmp.$$"; }
  fi
}
restore_or_install .
restore_or_install apps/app --ignore-scripts
# keep the last few lockfile generations only
ls -1dt "$cache"/*/ 2>/dev/null | tail -n +4 | while read -r old; do rm -rf "$old"; done
node scripts/install-test-chrome.mjs
