#!/bin/sh
# cloud-init per-instance: runs once on a new droplet's first boot, never again on a reboot.
exec /usr/local/sbin/vyre-firstboot >>/var/log/vyre-firstboot.log 2>&1
