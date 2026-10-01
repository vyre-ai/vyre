#!/bin/bash
# The watcher wall on a real container, on a CI runner only: the image is built, the box container is started the way compose
# starts it (a namespace holder it shares, as tailscale is for the vyre service; root with exactly SETUID SETGID KILL NET_ADMIN
# SETPCAP and no-new-privileges), and a watcher child is spawned through the real spawner as vyred would.
#   bash scripts/watcher-wall-proof.sh <out-dir>
set -u
OUT=$1; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
[ -n "${CI:-}" ] || { echo "watcher-wall-proof.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
FAILED=0
rec() { # rec STEP ok|false [why]
  ok=$2; [ "$ok" = ok ] && ok=true || { ok=false; FAILED=$((FAILED + 1)); }
  printf '{"journey":"WALL","step":"%s","ok":%s,"why":"%s"}\n' "$1" "$ok" "$(printf %s "${3:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-300)" >>"$OUT/results.jsonl"
  echo "$([ "$ok" = true ] && echo pass || echo FAIL)  WALL $1 ${3:-}"
}
HERE=$(cd "$(dirname "$0")/.." && pwd)
docker build -q -f "$HERE/box/Dockerfile" -t vyre-wall:test "$HERE" >"$OUT/build.log" 2>&1 || { rec 0-build false "$(tail -5 "$OUT/build.log")"; exit 1; }
rec 0-build ok
docker rm -f wallpause wallbox wallbare >/dev/null 2>&1
docker run -d --name wallpause alpine sleep 3600 >/dev/null
box() { # box NAME CAPS: the vyre container the way compose runs it, in the holder's network namespace
  docker run -d --name "$1" --network container:wallpause --user 0:0 --cap-drop ALL $2 --security-opt no-new-privileges:true \
    -e VYRE_ONBOARD_HOST=127.0.0.1 vyre-wall:test >/dev/null
}
CAPS="--cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_ADMIN --cap-add SETPCAP"
box wallbox "$CAPS"
status() { docker exec "$1" cat /run/vyre/wall.json 2>/dev/null; }
waitwall() { i=0; until status "$1" | grep -q '"at"'; do i=$((i + 1)); [ $i -ge 60 ] && return 1; sleep 1; done; }
drv() { docker exec -u vyre "$1" node /tmp/watcher-wall-driver.mjs "$2" 2>&1; }
docker cp "$HERE/scripts/watcher-wall-driver.mjs" wallbox:/tmp/watcher-wall-driver.mjs
waitwall wallbox || { rec 1-wall-status false "no status after 60 s: $(docker logs wallbox 2>&1 | tail -5)"; exit 1; }
s=$(status wallbox); echo "$s" | grep -q '"ok":true' && rec 1-wall-installed ok "$s" || rec 1-wall-installed false "$s"

# 2 the serving spawner holds neither NET_ADMIN (bit 12) nor SETPCAP (bit 8)
pid=$(docker exec wallbox sh -c "pgrep -f 'spawner/main.js' | head -1")
bnd=$(docker exec wallbox sh -c "sed -n 's/^CapBnd:[[:space:]]*//p' /proc/$pid/status")
if [ -n "$bnd" ] && [ $(( (0x$bnd >> 12) & 1 )) -eq 0 ] && [ $(( (0x$bnd >> 8) & 1 )) -eq 0 ]; then rec 2-capabilities-dropped ok "CapBnd $bnd"; else rec 2-capabilities-dropped false "CapBnd '$bnd' of pid $pid"; fi
# vyred (uid vyre) has no capability at all
vp=$(docker exec wallbox sh -c "pgrep -u vyre -f 'core/daemon' | head -1")
veff=$(docker exec wallbox sh -c "sed -n 's/^CapEff:[[:space:]]*//p' /proc/${vp:-0}/status" 2>/dev/null)
[ -n "$vp" ] && [ "$((0x${veff:-1}))" -eq 0 ] && rec 2b-vyred-no-caps ok "CapEff $veff" || rec 2b-vyred-no-caps false "pid '$vp' CapEff '$veff'"

# 3 a watcher child: a pool uid, no groups, a near-empty environment, and every attempt refused
a=$(drv wallbox probe); echo "$a" >"$OUT/probe.json"
node -e '
const a=JSON.parse(process.argv[1]);const bad=[];
if(!(a.uid>=3000&&a.uid<=3031))bad.push("uid "+a.uid);
if(a.groups.length&&!(a.groups.length===1&&a.groups[0]===a.uid))bad.push("groups "+a.groups);
if(a.env.some(k=>!["HOME","TMPDIR","PWD","SHLVL","_","OLDPWD"].includes(k)))bad.push("env "+a.env);
for(const k of ["loopback","public"])if(a[k]!=="ECONNREFUSED")bad.push(k+" "+a[k]);
if(a.listenerSaw!==0)bad.push("the loopback listener saw "+a.listenerSaw+" connection(s)");
if(!["EACCES","EPERM","ENOENT"].includes(a.unix))bad.push("unix "+a.unix);
for(const k of ["work","vyreHome","vault"])if(a[k]==="yes")bad.push(k+" readable");
if(a.ownHome!=="yes")bad.push("its own folder: "+a.ownHome);
if(bad.length){console.log(bad.join("; "));process.exit(1)}' "$a" >"$OUT/probe.verdict" 2>&1 && rec 3-child-refused ok "$a" || rec 3-child-refused false "$(cat "$OUT/probe.verdict") :: $a"

# 4 two at once: two different uids, never shared
two=$(drv wallbox two)
u1=$(echo "$two" | sed -n 1p | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).uid)}catch{console.log("x")}})')
u2=$(echo "$two" | sed -n 2p | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).uid)}catch{console.log("x")}})')
[ "$u1" != x ] && [ "$u2" != x ] && [ "$u1" != "$u2" ] && rec 4-own-uid-each ok "$u1 and $u2" || rec 4-own-uid-each false "$two"

# 5 /work is closed to others
m=$(docker exec wallbox stat -c %a /work); [ "$m" = 2770 ] && rec 5-work-mode ok "$m" || rec 5-work-mode false "mode $m"

# 6 a restart reinstalls and re-probes before anything is spawned, and the rule is there exactly once
at1=$(status wallbox | sed -n 's/.*"at":\([0-9]*\).*/\1/p')
docker restart wallbox >/dev/null; sleep 1
docker cp "$HERE/scripts/watcher-wall-driver.mjs" wallbox:/tmp/watcher-wall-driver.mjs
waitwall wallbox
at2=$(status wallbox | sed -n 's/.*"at":\([0-9]*\).*/\1/p')
npid=$(docker inspect -f '{{.State.Pid}}' wallpause)
rules=$(sudo nsenter -t "$npid" -n iptables -S OUTPUT 2>&1 | grep -c 'uid-owner 3000-3031')
a2=$(drv wallbox probe)
if [ "${at2:-0}" -ge "${at1:-1}" ] && [ "$rules" = 1 ] && echo "$a2" | grep -q '"loopback":"ECONNREFUSED"'; then rec 6-restart-reprobed ok "status at $at1 then $at2, one rule, child refused"
else rec 6-restart-reprobed false "at $at1 then $at2, rules $rules: $a2"; fi

# 7 a box that was not given NET_ADMIN says so and refuses a watcher
docker rm -f wallbox >/dev/null; box wallbare "--cap-add SETUID --cap-add SETGID --cap-add KILL"
docker cp "$HERE/scripts/watcher-wall-driver.mjs" wallbare:/tmp/watcher-wall-driver.mjs
waitwall wallbare
b=$(drv wallbare probe)
if echo "$b" | grep -q 'REFUSED.*watcher wall is not in place' && status wallbare | grep -q '"ok":false'; then rec 7-no-netadmin-refuses ok "$(status wallbare)"; else rec 7-no-netadmin-refuses false "$b :: $(status wallbare)"; fi

docker rm -f wallpause wallbox wallbare >/dev/null 2>&1
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
