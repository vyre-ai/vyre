#!/bin/sh
# Stop the Windows 11 VM: ask Windows to shut down, then stop the units if it does not.
set -eu
ROOT=/srv/vyre-test/win11
if systemctl --user is-active --quiet vyre-win11.service; then
  echo "system_powerdown" | nc -U -q1 "$ROOT/run/monitor.sock" >/dev/null 2>&1 || true
  for i in $(seq 1 60); do systemctl --user is-active --quiet vyre-win11.service || break; sleep 2; done
  systemctl --user stop vyre-win11.service 2>/dev/null || true
fi
systemctl --user stop vyre-win11-tpm.service 2>/dev/null || true
echo stopped
