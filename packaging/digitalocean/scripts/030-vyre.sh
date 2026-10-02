#!/bin/bash
# Put the first-boot installer, the release key it trusts, the per-instance hook and the login banner in place.
# Runs with the repo's files/ folder uploaded to /tmp/vyre-files.
set -euo pipefail
F=/tmp/vyre-files
install -m 0755 "$F/vyre-firstboot" /usr/local/sbin/vyre-firstboot
install -d -m 0755 /usr/local/share/vyre
install -m 0644 "$F/release-key.pem" /usr/local/share/vyre/release-key.pem
install -d -m 0755 /var/lib/cloud/scripts/per-instance
install -m 0755 "$F/01-vyre-firstboot.sh" /var/lib/cloud/scripts/per-instance/01-vyre-firstboot.sh
install -d -m 0755 /etc/update-motd.d
install -m 0755 "$F/99-vyre-motd" /etc/update-motd.d/99-vyre
install -d -m 0755 /var/lib/vyre
rm -rf "$F"
