#!/bin/sh
# e.sh < js  : evaluate stdin in the page (helpers T(sel,text), C(text) click by text, V() visible text)
python3 -c "import json,sys;h=open(\"/srv/vyre-e2e/helpers.js\").read();print(json.dumps({\"expr\":h+\"\\n\"+sys.stdin.read()}))" | curl -s -X POST 127.0.0.1:19300/eval -d @-
