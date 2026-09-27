#!/bin/sh
# The uid split in the box image (ADR 0032 part 3), checked in a throwaway container: no
# tailscale, no network, its own volumes. Never /srv/vyre. Usage: check.sh <image>
set -u
IMG=${1:-vyre-e2e-split:local}
C=vyre-e2e-split-$$
V=vyre-e2e-split-work-$$
fail=0
# A /work volume from before the split: uid 1000's, 755, with a private folder in it.
docker volume create "$V" >/dev/null
docker run --rm --user 1000:1000 -v "$V":/work --entrypoint sh "$IMG" -c 'mkdir -p /work/harlow/notes && echo x > /work/harlow/notes/a.md && chmod 700 /work/harlow/notes && chgrp -R 1000 /work && chmod -R g-s /work && chmod 755 /work' >/dev/null
ok() { echo "ok   $1"; }
no() { echo "FAIL $1"; fail=1; }
docker run -d --name "$C" --network none --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --security-opt no-new-privileges:true -e VYRE_HOME=/home/vyre/.vyre -e VYRE_SUPERVISOR=docker \
  -e VYRE_SPAWNER_ALLOW=/usr/bin/id:/bin/sh -v "$V":/work "$IMG" >/dev/null
trap 'docker rm -f "$C" >/dev/null 2>&1; docker volume rm "$V" >/dev/null 2>&1' EXIT
i=0; until docker exec "$C" test -S /home/vyre/.vyre/vyred.sock 2>/dev/null || [ $i -ge 60 ]; do i=$((i+1)); sleep 1; done
x() { docker exec "$C" "$@" 2>&1; }

[ "$(x ps -o user= -p 1 | tr -d ' ')" = root ] && ok "the first process is root (the spawner)" || no "the first process is not root"
x ps -eo user,args | grep -q '^vyre .*core/daemon/main.js' && ok "vyred runs as vyre" || no "vyred is not uid vyre: $(x ps -eo user,args | grep daemon)"
S=$(x vyre status); echo "$S" | grep -qi running && ! echo "$S" | grep -qi "not running" && ok "vyre status from a root exec drops to vyre" || no "vyre status: $(x vyre status | head -2)"
VW=$(docker exec -u vyre "$C" sh -c 'cat /proc/$(pgrep -f core/daemon/main.js | head -1)/status | grep -i umask' 2>&1 | tr -s ' \t' ' ')
echo "$VW" | grep -q 0002 && ok "vyred's umask is 002" || no "vyred umask: $VW"
[ "$(x stat -c %a /home/vyre)" = 700 ] && ok "/home/vyre is 700" || no "/home/vyre is $(x stat -c %a /home/vyre)"
[ "$(x stat -c %G /work)" = vyre-work ] && ok "/work belongs to vyre-work" || no "/work group $(x stat -c %G /work)"

# One child through the spawner, as vyred would start it.
OUT=$(docker exec -u vyre -w /opt/vyre "$C" node -e '
import("/opt/vyre/core/spawner/client.js").then(async ({ spawnAsAgent }) => {
  const run = async (argv) => { const p = await spawnAsAgent(argv, { cwd: "/work", env: { PATH: "/usr/local/bin:/usr/bin:/bin", LD_PRELOAD: "/x.so" } });
    let out = ""; p.stdout.setEncoding("utf8"); p.stdout.on("data", d => (out += d)); p.stdin.end();
    await new Promise(r => p.once("exit", r)); await new Promise(r => setTimeout(r, 200)); return out.trim(); };
  console.log("ID " + await run(["/usr/bin/id", "-u"]));
  console.log("SOCK " + await run(["/bin/sh", "-c", "cat /home/vyre/.vyre/config.json >/dev/null 2>&1 && echo readable || echo refused"]));
  console.log("VYRED " + await run(["/bin/sh", "-c", "VYRE_HOME=/home/vyre/.vyre vyre status >/dev/null 2>&1 && echo reached || echo refused"]));
  console.log("WORK " + await run(["/bin/sh", "-c", "mkdir -p /work/northwind && echo hi > /work/northwind/a.txt && stat -c %G:%a /work/northwind/a.txt"]));
  console.log("ENV " + await run(["/bin/sh", "-c", "echo ${LD_PRELOAD:-none} $HOME"]));
  try { await spawnAsAgent(["/bin/bash", "-c", "id"], { cwd: "/work" }); console.log("OTHER allowed"); } catch (e) { console.log("OTHER " + e.message); }
});' 2>&1)
echo "$OUT" | grep -q '^ID 1001$' && ok "the child runs as vyre-agent (1001)" || no "child uid: $OUT"
echo "$OUT" | grep -q '^SOCK refused$' && ok "the agent cannot read vyred's home" || no "home: $(echo "$OUT" | grep SOCK)"
echo "$OUT" | grep -q '^VYRED refused$' && ok "the agent cannot reach vyred's socket" || no "socket: $(echo "$OUT" | grep VYRED)"
echo "$OUT" | grep -q '^WORK vyre-work:664$' && ok "the agent writes /work, shared by group" || no "work: $(echo "$OUT" | grep WORK)"
echo "$OUT" | grep -q '^ENV none /home/vyre-agent$' && ok "the child's env is cut down, HOME is its own" || no "env: $(echo "$OUT" | grep ENV)"
echo "$OUT" | grep -q '^OTHER spawner: /bin/bash is not a program' && ok "another program is refused" || no "other: $(echo "$OUT" | grep OTHER)"
OLD=$(docker exec -u vyre-agent "$C" sh -c 'stat -c %G:%a /work/harlow/notes/a.md && echo more >> /work/harlow/notes/a.md && echo written' 2>&1 | tr '\n' ' ')
[ "$OLD" = "vyre-work:664 written " ] && ok "an old /work was shared on first start" || no "old work: $OLD"
docker exec -u vyre-agent "$C" sh -c 'ls /run/vyre' >/dev/null 2>&1 && no "vyre-agent can enter /run/vyre" || ok "vyre-agent cannot reach the spawner's socket"
T0=$(date +%s); docker stop -t 20 "$C" >/dev/null; T=$(( $(date +%s) - T0 ))
[ "$(docker inspect -f '{{.State.ExitCode}}' "$C")" = 0 ] && [ $T -lt 15 ] && ok "docker stop ends vyred cleanly (${T}s)" || no "stop: exit $(docker inspect -f '{{.State.ExitCode}}' "$C") after ${T}s"
exit $fail
