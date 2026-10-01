#!/bin/sh
# Run a PowerShell command in the VM over ssh: g.sh "<powershell>"   (password from the secrets file, never printed)
export SSHPASS="$(cat /srv/vyre-test/win11/secrets/vm-password)"
exec sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/srv/vyre-test/win11/run/known_hosts -o ConnectTimeout=60 -p 2222 vyre@127.0.0.1 "$@"
