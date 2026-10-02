#!/bin/bash
# The BAKED variant of the image (packer build -var bake=true): the release is staged INTO the image at build time,
# so a new Droplet needs no download from vyre.run on first boot and the Vyre images are already on its disk. Built
# for the case where DigitalOcean's review does not allow a first boot to download software. The default image does
# not run this. The baked image is only as new as its build: rebuild it per Vyre release; `vyre update` moves a
# running Droplet forward.
set -euo pipefail
[ "${BAKE:-0}" = 1 ] || { echo "not baking: BAKE is not 1"; exit 0; }
# 1. Download and check the latest release (the same code as the first boot), into /var/lib/vyre/release.
/usr/local/sbin/vyre-firstboot --stage-only
# 2. Pull the images the release names, by digest, so first boot has them. The installer still checks each one's
#    signature with cosign before it runs anything.
j=$(tr -d '\n' </var/lib/vyre/release/release.json)
BOX_REF=$(printf '%s' "$j" | sed -n 's/.*"box": *{[^}]*"ref": *"\([^"]*\)".*/\1/p')
COMPUTER_REF=$(printf '%s' "$j" | sed -n 's/.*"computer": *{[^}]*"ref": *"\([^"]*\)".*/\1/p')
COSIGN_IMAGE=$(sed -n 's/^COSIGN_IMAGE=${VYRE_COSIGN_IMAGE:-\(.*\)}$/\1/p' /var/lib/vyre/release/install-box.sh | head -n 1)
for ref in $BOX_REF $COMPUTER_REF $COSIGN_IMAGE; do
  case "$ref" in ghcr.io/*@sha256:*) docker pull -q "$ref" >/dev/null ;; *) echo "refusing to pull $ref: not a ghcr.io digest" >&2; exit 1 ;; esac
done
# 3. The marker the per-instance hook looks for. No Vyre state exists yet: nothing was started or installed here.
install -m 0644 /dev/null /var/lib/vyre/baked
rm -f /var/lib/vyre/firstboot.status
echo "baked $(cat /var/lib/vyre/release/VERSION)"
