#!/bin/sh
# Bring the e2e world up to the onboarding link: headscale, user alex, keys, box, stand-in Mac.
set -e
cd /srv/vyre-e2e
dc() { docker compose --profile mac --profile phone "$@"; }
dc up -d headscale >/dev/null 2>&1; sleep 4
hs() { dc exec -T headscale headscale "$@"; }
hs users create alex --email alex@example.com --display-name Alex >/dev/null
hs policy set -f /etc/headscale/policy.json >/dev/null
key() { hs preauthkeys create --user 1 --expiration 3h -o json | python3 -c "import sys,json;print(json.load(sys.stdin)[\"key\"])"; }
printf "MAC_AUTHKEY=%s\nPHONE_AUTHKEY=%s\nBOX_IP=100.64.0.2\n" "$(key)" "$(key)" > .env; chmod 600 .env
dc up -d tailscale >/dev/null 2>&1
# The box's computers go through its own Docker proxy, image, network and label prefix.
dc run --rm -T -u 1000:1000 vyre sh -c 'mkdir -p ~/.vyre && echo "{\"computers\":{\"docker\":\"http://docker-api:2375\",\"image\":\"vyre-e2e/computer:0.1\",\"network\":\"vyre-e2e-computers\",\"labelPrefix\":\"run.vyre.e2e.computers\"}}" > ~/.vyre/config.json' >/dev/null 2>&1
dc --profile computers up -d vyre docker-api mac-ts chrome >/dev/null 2>&1
sleep 12
dc exec -T mac-ts tailscale status | head -2
(nohup node drive.mjs > drive.log 2>&1 & echo $! > drive.pid); sleep 2
./c.sh /webauthn
dc exec -T vyre vyre up --print-link 2>&1 | grep -o "http://127.0.0.1:7300/onboard?t=[A-Za-z0-9_-]*"
