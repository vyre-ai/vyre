#!/bin/sh
# place-release.sh [PACKAGE_ROOT] [RELEASE_DIR]: the release's three signed files go where the kernel reads them, at the package root (SHA256SUMS, SHA256SUMS.sig, modules.json;
# kernel/modules/release-list.js). They come from the folder the host publishes and the container mounts read-only (box/vyre publish_release, mounted at deck/release), copied
# as plain files only, never through a link, and a file the host does not have is removed here too, so a restart never keeps a list from an older release.
# Run by wall-entry.sh as root on every container start, before the spawner; a development checkout has no such folder and nothing is placed.
set -u
root=${1:-$(cd "$(dirname "$0")/../.." && pwd)}
rel=${2:-$root/deck/release}
for f in SHA256SUMS SHA256SUMS.sig modules.json; do
  rm -f "$root/$f"
  if [ -f "$rel/$f" ] && [ ! -L "$rel/$f" ]; then
    cp "$rel/$f" "$root/$f" && chmod 0644 "$root/$f" || rm -f "$root/$f"
  fi
done
