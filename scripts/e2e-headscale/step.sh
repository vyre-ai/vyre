#!/bin/sh
# step.sh "<js body>" : run an async page step, print its result
printf "(async()=>{%s})()" "$1" | ./e.sh | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get(\"ok\",d))"
