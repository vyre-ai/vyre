#!/bin/sh
set -e
cd /srv/vyre-e2e
dc() { docker compose --profile mac --profile phone "$@"; }
S=./step.sh
./c.sh /nav "{\"url\":\"$1\"}" >/dev/null
$S "await W(1500);T(\"#name\",\"alex\");T(\"#assistant\",\"juno\");await W(1500);return C(\"continue\")"
$S "await W(2500);return C(\"skip for now\")+\" | \"+V().split(\"STEP\")[1].slice(0,40)"
$S "await W(2500);return C(\"connect\")+\" | \"+V().split(\"STEP\")[1].slice(0,40)"
sleep 12
URL=$($S "return [...document.querySelectorAll(\"a[href]\")].map(a=>a.href).find(h=>h.includes(\"/register/\"))")
echo "sign-in link on the page: $URL"
dc exec -T headscale headscale nodes register --user alex --key "${URL##*/}" | tail -1
sleep 8
$S "await W(3000);return V().match(/vyre\\.\\S+ at \\S+/)?.[0]+\" | \"+C(\"continue\")"
$S "await W(2500);return C(\"get your address\")"
sleep 8
$S "return V().split(\"STEP\")[1].slice(0,400)"
$S "setTimeout(()=>C(\"switch to vyre.tail0000.ts.net\"),10);return 1"
sleep 5
$S "return location.href+\" | \"+V().slice(0,80)"
$S "T(\"#pk-name\",\"alex-mac\");C(\"add a passkey\");await W(5000);return V().slice(0,60)"
$S "setTimeout(()=>C(\"continue setting up\"),10);return 1"; sleep 4
$S "return location.href+\" | \"+C(\"continue\")"; sleep 3
$S "return location.href+\" | \"+V().split(\"STEP\")[1].slice(0,60)"
$S "setTimeout(()=>C(\"open the deck\"),10);return 1"; sleep 4
$S "return V().slice(0,80)"
$S "setTimeout(()=>C(\"open vyre\"),10);return 1"; sleep 4
$S "return location.href+\" | \"+document.title"
./c.sh /log
./c.sh /creds
