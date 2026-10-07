#!/bin/sh
# place-release.sh [PACKAGE_ROOT] [RELEASE_DIR]: the release's signed files go where the kernel and the daemon read them, at the package root (SHA256SUMS, SHA256SUMS.sig, modules.json, and appbuild.json for the web app, lib/app-build.js;
# kernel/modules/release-list.js). They come from the folder the host publishes and the container mounts read-only (box/vyre publish_release, mounted at web/release), copied
# as plain files only, never through a link, and a file the host does not have is removed here too, so a restart never keeps a list from an older release.
# Run by wall-entry.sh as root on every container start, before the spawner; a development checkout has no such folder and nothing is placed.
set -u
fail=0
root=${1:-$(cd "$(dirname "$0")/../.." && pwd)}
rel=${2:-$root/web/release}
for f in SHA256SUMS SHA256SUMS.sig modules.json appbuild.json; do
  rm -f "$root/$f"
  if [ -f "$rel/$f" ] && [ ! -L "$rel/$f" ]; then
    if cp "$rel/$f" "$root/$f" && chmod 0644 "$root/$f"; then :; else echo "place-release: could not place $f at $root" >&2; rm -f "$root/$f"; fail=1; fi
  fi
done
# A release an old updater published has shell.json but no modules.json or appbuild.json: they are rebuilt from the signed shell.json that carries them (core/spawner/place-shell-list.mjs).
if [ -f "$rel/shell.json" ] && [ -f "$root/core/spawner/place-shell-list.mjs" ] && command -v node >/dev/null 2>&1; then node "$root/core/spawner/place-shell-list.mjs" "$root" || true; fi
exit "$fail"
