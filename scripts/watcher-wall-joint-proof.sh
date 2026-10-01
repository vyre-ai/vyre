#!/bin/bash
# The box wall through the real watchers code, on a CI runner only: launch's spawner and image with
# watchers' spawner candidate, probe and runner. Builds the image, starts the box container the way
# compose does, and drives vyred's side as uid vyre.
#   bash scripts/watcher-wall-joint-proof.sh <out-dir>
set -u
OUT=$1; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
[ -n "${CI:-}" ] || { echo "runs on a CI runner only (CI is unset)" >&2; exit 2; }
FAILED=0
rec() { ok=$2; [ "$ok" = ok ] && ok=true || { ok=false; FAILED=$((FAILED + 1)); }
  printf '{"step":"%s","ok":%s,"why":"%s"}\n' "$1" "$ok" "$(printf %s "${3:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-400)" >>"$OUT/results.jsonl"
  echo "$([ "$ok" = true ] && echo pass || echo FAIL)  JOINT $1 ${3:-}"; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
docker build -q -f "$HERE/box/Dockerfile" -t vyre-joint:test "$HERE" >"$OUT/build.log" 2>&1 || { rec 0-build false "$(tail -5 "$OUT/build.log")"; exit 1; }
rec 0-build ok
docker rm -f jointpause jointbox jointbare >/dev/null 2>&1
docker run -d --name jointpause alpine sleep 3600 >/dev/null
box() { docker run -d --name "$1" --network container:jointpause --user 0:0 --cap-drop ALL $2 --security-opt no-new-privileges:true -e VYRE_ONBOARD_HOST=127.0.0.1 vyre-joint:test >/dev/null; }
CAPS="--cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_ADMIN --cap-add SETPCAP"
status() { docker exec "$1" cat /run/vyre/wall.json 2>/dev/null; }
waitwall() { i=0; until status "$1" | grep -q '"at"'; do i=$((i + 1)); [ $i -ge 60 ] && return 1; sleep 1; done; }
drv() { docker cp "$HERE/scripts/watcher-wall-joint-driver.mjs" "$1:/tmp/joint-driver.mjs"; docker exec -u vyre "$1" node /tmp/joint-driver.mjs "$2" 2>&1; }
j() { printf %s "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s.trim().split("\n").pop());console.log(eval("o."+process.argv[1]))}catch{console.log("unparsed")}})' "$2"; }

box jointbox "$CAPS"
waitwall jointbox || { rec 1-wall-status false "no status: $(docker logs jointbox 2>&1 | tail -5)"; exit 1; }
rec 1-spawner-wall-in-place ok "$(status jointbox)"

# 2 the watchers code finds the spawner wall, probes it with the child's own attempts, and runs a watcher through it
a=$(drv jointbox run); echo "$a" >"$OUT/run.json"
echo "$a" | tail -3
kind=$(j "$a" "wall"); used=$(j "$a" "wallUsed")
[ "$kind" = spawner ] && [ "$used" = spawner ] && rec 2-wall-is-the-spawner ok "$kind" || rec 2-wall-is-the-spawner false "wall=$kind used=$used why=$(j "$a" why) error=$(j "$a" error)"
v=$(printf %s "$a" | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=o.verdict||{};const bad=[];
if(v.note!=="handed in")bad.push("the handed-in file: "+v.note);
if(!(v.uid>=3000&&v.uid<=3031))bad.push("uid "+v.uid);
for(const k of ["tcp","internet","spawnerSock","vyreHome","work","signal"])if(!String(v[k]).startsWith("blocked"))bad.push(k+" "+v[k]);
if(o.listenerSaw!==0)bad.push("the listener saw "+o.listenerSaw);
console.log(bad.length?"BAD "+bad.join("; "):"ok")}catch(e){console.log("BAD unparsed")}})')
[ "$v" = ok ] && rec 3-watcher-through-spawner ok "$(echo "$a" | tail -1 | cut -c1-300)" || rec 3-watcher-through-spawner false "$v :: $(echo "$a" | tail -1 | cut -c1-300)"

# 4 the container recreated (the tailnet holder and the box), then the wall is re-found and a watcher still runs
docker rm -f jointbox >/dev/null; docker rm -f jointpause >/dev/null
docker run -d --name jointpause alpine sleep 3600 >/dev/null
box jointbox "$CAPS"; waitwall jointbox || rec 4-recreated false "no status"
b=$(drv jointbox run)
[ "$(j "$b" wallUsed)" = spawner ] && rec 4-recreated-still-walled ok "wall $(j "$b" wallUsed)" || rec 4-recreated-still-walled false "$(echo "$b" | tail -1 | cut -c1-300)"

# 5 a box without NET_ADMIN: the watchers code finds no wall, and a watcher is refused in words
docker rm -f jointbox >/dev/null
box jointbare "--cap-add SETUID --cap-add SETGID --cap-add KILL"; waitwall jointbare
c=$(drv jointbare run)
[ "$(j "$c" wall)" = null ] && echo "$c" | tail -1 | grep -q 'not in place' && rec 5-no-netadmin-refused ok "$(echo "$c" | tail -1 | cut -c1-300)" || rec 5-no-netadmin-refused false "$(echo "$c" | tail -1 | cut -c1-300)"

docker rm -f jointpause jointbox jointbare >/dev/null 2>&1
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
