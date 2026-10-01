#!/bin/sh
# Run a PowerShell script FILE in the VM over ssh (no shell-quoting trouble): gf.sh script.ps1
export SSHPASS="$(cat /srv/vyre-test/win11/secrets/vm-password)"
exec sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/srv/vyre-test/win11/run/known_hosts -o ConnectTimeout=60 -p 2222 vyre@127.0.0.1 powershell -NoProfile -NonInteractive -Command - < "$1"
