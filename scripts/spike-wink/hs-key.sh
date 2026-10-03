#!/bin/bash
# hs-key.sh NAME TAG [EPHEMERAL] -> prints a 10 minute pre-auth key for that tag
W=${W:-$HOME/spike-wink2}; HSBIN=${HSBIN:-$HOME/spike-wink/bin/headscale}; D=$W/hs-$1
C="$HSBIN -c $D/config.yaml"
$C users list -o json 2>/dev/null | grep -q '"name": "owner"' || $C users create owner >/dev/null 2>&1
UID_=$($C users list -o json | jq -r '.[]|select(.name=="owner").id')
$C preauthkeys create -u $UID_ -e 10m --tags $2 ${3:+--ephemeral} -o json | jq -r .key
