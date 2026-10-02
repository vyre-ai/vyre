#!/bin/sh
# cloud-init per-instance: runs once on a new droplet's first boot, never again on a reboot.
# An image that baked a release in (/var/lib/vyre/baked) installs that one; the default image installs the latest.
if [ -f /var/lib/vyre/baked ]; then
  exec /usr/local/sbin/vyre-firstboot --from-baked >>/var/log/vyre-firstboot.log 2>&1
fi
exec /usr/local/sbin/vyre-firstboot >>/var/log/vyre-firstboot.log 2>&1
