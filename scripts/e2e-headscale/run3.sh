#!/bin/sh
# Deck checks, then pair the Mac: vyre up there, approve from the phone with the synced passkey.
cd /srv/vyre-e2e
dc() { docker compose --profile mac --profile phone "$@"; }
S=./step.sh
echo "== tools the Deck needs"; ./e.sh < probe.js | python3 -c "import sys,json;print(json.load(sys.stdin)[\"ok\"])" | cut -c1-120
echo "== settings address"; ./c.sh /nav "{\"url\":\"https://vyre.tail0000.ts.net/settings\"}" >/dev/null; sleep 3
$S "const t=V();const i=t.indexOf(\"Address\");return t.slice(i,i+40).replace(/\\n/g,\" / \")"
echo "== vault item with passkey presence"; ./c.sh /nav "{\"url\":\"https://vyre.tail0000.ts.net/vault\"}" >/dev/null; sleep 2
$S "C(\"add item\");await W(1200);T(\"#vt-e-name\",\"northwind-mail\");T(\"#vt-e-url\",\"https://mail.northwind.test/login\");T(\"#vt-f-username\",\"alex\");T(\"#vt-f-password\",\"not-a-real-pass-1\");await W(300);C(\"seal it\");await W(2500);const r=C(\"use passkey\");await W(5000);return r+\" | \"+(V().match(/HISTORY\\nv1\\n[^\\n]*/)||[\"no history row\"])[0].replace(/\\n/g,\" \")"
echo "== agent with a job"; ./c.sh /nav "{\"url\":\"https://vyre.tail0000.ts.net/agents\"}" >/dev/null; sleep 2
$S "C(\"new agent\");await W(1200);T(\"#na-name\",\"kit\");T(\"#na-job\",\"Drafts replies for Northwind Bakery orders.\");await W(300);C(\"create agent\");await W(3000);return \"created\""
./c.sh /nav "{\"url\":\"https://vyre.tail0000.ts.net/agents/kit\"}" >/dev/null; sleep 3
$S "return (V().match(/JOB\\n[^\\n]*\\n[^\\n]*/)||[\"?\"])[0].replace(/\\n/g,\" / \")"
./c.sh /log | tr -d "\n" | cut -c1-400; echo
echo "== Mac: vyre up"
dc run --rm --no-deps -T mac sh -c "mkdir -p ~/.vyre && echo {\\\"role\\\":\\\"local\\\"} > ~/.vyre/config.json" >/dev/null 2>&1
dc up -d mac phone-ts phone >/dev/null 2>&1; sleep 14
(CDP_PORT=19223 CTL_PORT=19301 nohup node drive.mjs > drive-phone.log 2>&1 & echo $! > drive-phone.pid); sleep 2
curl -s -X POST 127.0.0.1:19301/webauthn >/dev/null
curl -s -X POST 127.0.0.1:19300/export | python3 -c "import sys,json;print(json.dumps({\"credentials\":json.load(sys.stdin)[\"ok\"]}))" | curl -s -X POST 127.0.0.1:19301/import -d @- >/dev/null
OUT=$(timeout 40 docker compose --profile mac exec -T mac sh -c "timeout 30 vyre up </dev/null 2>&1"); echo "$OUT" | sed -n 2,3p
CODE=$(echo "$OUT" | grep -o "Code: [0-9-]*" | cut -d" " -f2)
echo "== the Mac own browser cannot approve itself"
$S "const api=await import(\"/js/api.js\");try{return JSON.stringify(await api.call(\"link.pair.approve\",{code:\"$CODE\"},{presence:true}))}catch(e){return \"refused: \"+e.message}"
echo "== the phone approves"
curl -s -X POST 127.0.0.1:19301/nav -d "{\"url\":\"https://vyre.tail0000.ts.net/now\"}" >/dev/null
printf "(async()=>{const api=await import(\"/js/api.js\");try{return JSON.stringify(await api.call(\"link.pair.approve\",{code:\"$CODE\"},{presence:true}))}catch(e){return \"ERR \"+e.message}})()" | python3 -c "import json,sys;print(json.dumps({\"expr\":sys.stdin.read()}))" | curl -s -X POST 127.0.0.1:19301/eval -d @-
sleep 5
dc exec -T mac sh -c "vyre link; vyre call link.call \"{\\\"tool\\\":\\\"vault.list\\\"}\" | grep -c northwind-mail"
