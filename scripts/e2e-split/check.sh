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

# One init: tini is PID 1, the spawner (root) its child, the loop and vyred as vyre under it.
[ "$(x cat /proc/1/comm)" = tini ] && ok "tini is PID 1" || no "PID 1 is $(x cat /proc/1/comm)"
SP=$(x pgrep -f '^node /opt/vyre/core/spawner/main.js' | head -1)
[ "$(x ps -o user=,ppid= -p "$SP" | tr -s ' ' | sed 's/^ //')" = "root 1" ] && ok "the spawner is root, under tini" || no "spawner: $(x ps -o user=,ppid=,args= -p "$SP")"
x ps -eo user,args | grep -q '^vyre .*core/daemon/loop.sh' && ok "the loop runs as vyre" || no "loop: $(x ps -eo user,args | grep loop)"
x ps -eo user,args | grep -q '^vyre .*core/daemon/main.js' && ok "vyred runs as vyre" || no "vyred is not uid vyre: $(x ps -eo user,args | grep daemon)"
[ "$(x ps -eo comm | grep -c '^tini$')" = 1 ] && ok "one init: no second tini at rest" || no "tinis: $(x ps -eo pid,user,args | grep tini)"
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
# A session's child: tini -s as vyre-agent, a subreaper under the spawner, not a second PID 1.
docker exec -u vyre -w /opt/vyre "$C" node -e '
import("/opt/vyre/core/spawner/client.js").then(async ({ spawnAsAgent }) => {
  const p = await spawnAsAgent(["/bin/sh", "-c", "sleep 30"], { cwd: "/work" }); p.stdin.end(); console.log(p.pid);
  setTimeout(() => { p.kill("SIGTERM"); setTimeout(() => process.exit(0), 500); }, 3000);
});' >/dev/null 2>&1 &
sleep 1.5
TS=$(x ps -eo pid,ppid,uid,args | awk '$4 ~ /tini$/ && $5 == "-s" {print $2, $3}' | head -1)
[ "$TS" = "$SP 1001" ] && ok "a session runs under tini -s, as vyre-agent, a child of the spawner" || no "session tini: '$TS' (spawner $SP): $(x ps -eo pid,ppid,user,args | grep -E 'tini|sleep')"
wait
docker exec -u vyre-agent "$C" sh -c 'ls /run/vyre' >/dev/null 2>&1 && no "vyre-agent can enter /run/vyre" || ok "vyre-agent cannot reach the spawner's socket"
# A Vyre-owned session as vyred starts one (core/sessions/spawn.js): through the spawner, as
# vyre-agent, the API key on fd 3 and not in its env, no way to vyred's socket; and the Agent
# SDK's own Claude Code binary runs that way too.
SESS=$(docker exec -u vyre -w /opt/vyre -e VYRE_HOME=/home/vyre/.vyre "$C" node -e '
import("/opt/vyre/core/sessions/spawn.js").then(async ({ spawnSession }) => {
  const run = (cmd, args) => new Promise(res => { let out = "", g = null;
    const c = spawnSession(cmd, args, { cwd: "/home/vyre/.vyre/agents/kit", env: { PATH: "/usr/local/bin:/usr/bin:/bin", ANTHROPIC_API_KEY: "sk-test-northwind" }, onSpawn: x => (g = x) });
    c.stdout.setEncoding("utf8"); c.stdout.on("data", d => (out += d)); c.on("error", e => res("ERR " + e.message)); c.stdin.end();
    c.on("exit", code => res(`${out.trim()} | code=${code} group=${g && g.pid === g.pgid}`)); });
  console.log("SH " + await run("/bin/sh", ["-c", "echo uid=$(id -u) key=$(cat <&3) env=${ANTHROPIC_API_KEY:-none} cwd=$(pwd); if ls /home/vyre/.vyre/vyred.sock >/dev/null 2>&1; then echo sock=open; else echo sock=EACCES; fi"]));
  const sdk = require("fs").readdirSync("/opt/vyre/node_modules/@anthropic-ai").find(n => /^claude-agent-sdk-linux-/.test(n));
  console.log("SDK " + (sdk ? await run(`/opt/vyre/node_modules/@anthropic-ai/${sdk}/claude`, ["--version"]) : "no bundled binary"));
});' 2>&1)
echo "$SESS" | grep -q '^SH uid=1001 key=sk-test-northwind env=none cwd=/home/vyre-agent/agents/kit' && ok "a session runs as vyre-agent in its own home, the key on fd 3 only" || no "session: $(echo "$SESS" | grep '^SH\|ERR')"
echo "$SESS" | grep -q 'sock=EACCES' && ok "a session cannot open vyred's socket" || no "socket from a session: $(echo "$SESS" | grep -o 'sock=[A-Za-z]*')"
echo "$SESS" | grep -qE '^SDK .*code=0 group=true' && ok "the Agent SDK's Claude Code runs through the spawner" || no "sdk: $(echo "$SESS" | grep '^SDK')"

# ci's smoke (box-image.yml): a killed vyred comes back and the container stays up.
V1=$(x pgrep -f 'node /opt/vyre/core/daemon/main.js' | head -1)
x kill -KILL "$V1" >/dev/null
i=0; V2=""; while [ $i -lt 30 ]; do V2=$(x pgrep -f 'node /opt/vyre/core/daemon/main.js' | head -1); [ -n "$V2" ] && [ "$V2" != "$V1" ] && break; i=$((i+1)); sleep 1; done
[ -n "$V2" ] && [ "$V2" != "$V1" ] && [ "$(docker inspect -f '{{.RestartCount}}' "$C")" = 0 ] && ok "a killed vyred comes back in ${i}s, the container stays up" || no "restart: $V1 -> '$V2'"
i=0; until docker exec "$C" vyre status 2>/dev/null | grep -qi running || [ $i -ge 30 ]; do i=$((i+1)); sleep 1; done
[ "$(x ps -o user= -p "$(x pgrep -f 'node /opt/vyre/core/daemon/main.js' | head -1)" | tr -d ' ')" = vyre ] && ok "the new vyred is vyre too" || no "new vyred user"
T0=$(date +%s); docker stop -t 20 "$C" >/dev/null; T=$(( $(date +%s) - T0 ))
[ "$(docker inspect -f '{{.State.ExitCode}}' "$C")" = 0 ] && [ $T -lt 15 ] && ok "docker stop ends vyred cleanly (${T}s)" || no "stop: exit $(docker inspect -f '{{.State.ExitCode}}' "$C") after ${T}s"
# And as ci runs it: a plain `docker run` (the image's own user, vyre), where the spawner runs the
# loop itself and there is no split.
P=vyre-e2e-plain-$$
docker run -d --name "$P" --network none "$IMG" >/dev/null
i=0; until docker exec "$P" vyre status 2>/dev/null | grep -qi running || [ $i -ge 60 ]; do i=$((i+1)); sleep 1; done
[ "$(docker exec "$P" cat /proc/1/comm)" = tini ] && docker exec "$P" vyre status 2>/dev/null | grep -qi running && ok "plain docker run: tini is PID 1 and vyred is up" || no "plain: $(docker logs "$P" 2>&1 | tail -3)"
PV=$(docker exec "$P" pgrep -f 'node /opt/vyre/core/daemon/main.js' | head -1); docker exec "$P" kill -KILL "$PV"
i=0; PV2=""; while [ $i -lt 30 ]; do PV2=$(docker exec "$P" pgrep -f 'node /opt/vyre/core/daemon/main.js' | head -1); [ -n "$PV2" ] && [ "$PV2" != "$PV" ] && break; i=$((i+1)); sleep 1; done
[ -n "$PV2" ] && [ "$PV2" != "$PV" ] && ok "plain docker run: a killed vyred comes back" || no "plain restart"
# Stop only once the new vyred is up: a SIGTERM while vyred is still starting kills it outright.
i=0; until docker exec "$P" vyre status 2>/dev/null | grep -qi running || [ $i -ge 30 ]; do i=$((i+1)); sleep 1; done; sleep 3
T0=$(date +%s); docker stop -t 30 "$P" >/dev/null; T=$(( $(date +%s) - T0 ))
[ "$(docker inspect -f '{{.State.ExitCode}}' "$P")" = 0 ] && [ $T -lt 30 ] && ok "plain docker run: docker stop drains (${T}s)" || no "plain stop: exit $(docker inspect -f '{{.State.ExitCode}}' "$P")"
docker rm -f "$P" >/dev/null 2>&1
exit $fail
