#!/bin/sh
# vyre-firstboot.sh: runs once, on the first boot of a droplet made from the Vyre 1-Click image. The image holds only Docker and this unit;
# Vyre itself is installed here, from the signed installer, so every new droplet gets the newest release, not the one that was current when
# the image was built. A failed install leaves the unit to retry on the next boot and the reason in /var/log/vyre-firstboot.log.
set -eu
LOG=/var/log/vyre-firstboot.log
exec >>"$LOG" 2>&1
[ ! -e /var/lib/vyre-firstboot.done ] || exit 0
echo "vyre first boot: $(date -u +%FT%TZ)"
i=0; until curl -fsS -o /dev/null https://vyre.run/i; do i=$((i + 1)); [ "$i" -ge 30 ] && { echo "vyre.run is not reachable"; exit 1; }; sleep 5; done
curl -fsSL https://vyre.run/i | sh -s -- --yes
touch /var/lib/vyre-firstboot.done
