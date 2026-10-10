#!/bin/sh
# scripts/proof/pub-helper-proof.sh: a site's server on a REAL installer box (team/contracts/builder.md, the helper path). DESTRUCTIVE: it wipes /srv/vyre and installs a box from this checkout, so it runs only on a
# throwaway test box, only with VYRE_PROOF_WIPE=1, and it uninstalls the box again at the end (--keep to stay installed). The daemon's side runs inside the container as the daemon's user
# (pub-helper-inside.mjs); this script looks from root's side: the walls in the container's namespace, what the app can reach, the folder root took, the records root keeps.
#   VYRE_PROOF_WIPE=1 sh scripts/proof/pub-helper-proof.sh [--keep]
set -u
[ "${VYRE_PROOF_WIPE:-}" = 1 ] || { echo "this wipes /srv/vyre; set VYRE_PROOF_WIPE=1 on a throwaway test box" >&2; exit 64; }
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DIR=${VYRE_DIR:-/srv/vyre}
KEEP=0; [ "${1:-}" = --keep ] && KEEP=1
FAILS=0
ok() { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
inside() { docker exec -u vyre vyre-vyre-1 node /opt/vyre/scripts/proof/pub-helper-inside.mjs "$@"; }
tally() { while IFS= read -r l; do printf '%s\n' "$l"; case "$l" in FAIL*) FAILS=$((FAILS + 1)) ;; esac; done; }
pid() { docker inspect -f '{{.State.Pid}}' vyre-vyre-1; }
rules() { sudo nsenter -t "$(pid)" -n iptables -w -S "$1" 2>/dev/null | grep -- "vyre-app:proofsite" || true; }

echo "== wipe the old box"
sudo -n true || { echo "needs passwordless sudo" >&2; exit 64; }
if [ -f "$DIR/compose.yml" ]; then VYRE_DIR=$DIR sh "$REPO/scripts/install-box.sh" --uninstall --purge --yes >/dev/null 2>&1 || true; fi
for p in $(docker ps -a --format '{{.Names}}' | grep -E '^vyre-spc-.*-twenty-' | sed -E 's/-(worker|server|db|redis|restore)-1$//' | sort -u); do
  docker ps -aq --filter "name=$p-" | xargs -r docker rm -f >/dev/null
  docker volume ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker volume rm >/dev/null
  docker network ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker network rm >/dev/null 2>&1 || true
done
check "no vyre container is left" '[ -z "$(docker ps -aq --filter name=vyre-vyre-1)" ]'

echo "== install a box from this checkout"
VYRE_DIR=$DIR sh "$REPO/scripts/install-box.sh" --yes --from "$REPO" >/tmp/pub-proof-install.log 2>&1 || { tail -5 /tmp/pub-proof-install.log; bad "the installer finished"; exit 1; }
ok "the installer finished"
n=0; until [ "$(docker inspect -f '{{.State.Health.Status}}' vyre-vyre-1 2>/dev/null)" = healthy ] || [ $n -ge 60 ]; do sleep 5; n=$((n + 1)); done
check "the box is healthy" '[ "$(docker inspect -f "{{.State.Health.Status}}" vyre-vyre-1)" = healthy ]'
sudo vyre space-helper install >/tmp/pub-proof-helper.log 2>&1 || true
check "the Space helper is installed (its spool is the daemon's)" '[ -d /var/lib/vyre-spaces/spool ] && systemctl is-active vyre-spaces.path >/dev/null'
check "the box carries this build's proof script" 'docker exec vyre-vyre-1 test -f /opt/vyre/scripts/proof/pub-helper-inside.mjs'

echo "== a base that is not allowed is refused by root itself"
inside refuse | tally

echo "== build, start, and look at it"
inside build | tally
inside up proofsite first-secret | tally
inside get proofsite first-secret | tally
inside ws | tally
C=vyre-app-proofsite
check "the container is up with its limits" '[ "$(docker inspect -f "{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}}" $C)" = "536870912 256 true false" ]'
check "all capabilities dropped and no new privileges" 'docker inspect -f "{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}" $C | grep -q "\[ALL\] \[no-new-privileges"'
check "no bind mount of the host, no published port, no host network" '[ "$(docker inspect -f "{{range .Mounts}}{{.Type}} {{end}}" $C)" = "volume " ] && [ -z "$(docker inspect -f "{{json .HostConfig.PortBindings}}" $C | grep -v "{}\|null")" ] && [ "$(docker inspect -f "{{.HostConfig.NetworkMode}}" $C)" != host ]'
check "its network is internal (no way out)" '[ "$(docker network inspect vyre-app-proofsite_net -f "{{.Internal}}")" = true ]'
check "the app cannot reach the internet" '! docker exec $C sh -c "wget -T3 -qO- http://1.1.1.1/ >/dev/null 2>&1"'
VIP=$(docker inspect -f '{{with index .NetworkSettings.Networks "vyre-app-proofsite_net"}}{{.IPAddress}}{{end}}' vyre-vyre-1)
check "the app cannot open the vyre container on its daemon port (dropped, not refused)" '! docker exec $C sh -c "wget -T3 -qO- http://$VIP:7443/ >/dev/null 2>&1"'
check "the app has no secret on its command line or in its image environment but the one granted" '[ "$(docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" $C | grep -c "^GREETING_PHRASE=first-secret$")" = 1 ]'
check "INPUT: the answers to the daemon, then drop; no hook port" '[ "$(rules INPUT | grep -c ACCEPT)" = 1 ] && [ "$(rules INPUT | grep -c DROP)" = 1 ] && ! rules INPUT | grep -q dport'
check "OUTPUT: the app network is rejected for every user but the daemon" '[ "$(rules OUTPUT | grep -c REJECT)" -ge 2 ]'
check "root keeps its own record, root-only" 'sudo test "$(sudo stat -c %a /var/lib/vyre-spaces/private/pub/dep_00000000000000a1/rec)" = 600'
check "root's env file for the secret is root-only and the compose is root's" 'sudo test "$(sudo stat -c %a /var/lib/vyre-spaces/private/apps/proofsite/secrets.env)" = 600 && sudo grep -q "^GREETING_PHRASE=.first-secret.$" /var/lib/vyre-spaces/private/apps/proofsite/secrets.env'
check "the daemon cannot read root's folders" '! docker exec -u vyre vyre-vyre-1 sh -c "ls /var/lib/vyre-spaces/private" >/dev/null 2>&1'

echo "== rotate the secret: down, then up with the new one"
inside down | tally
check "down removed the container and the rules, and kept the data" '[ -z "$(docker ps -aq --filter name=^vyre-app-proofsite$)" ] && [ -z "$(rules INPUT)" ] && [ -z "$(rules OUTPUT)" ] && docker volume inspect vyre-app-proofsite_data >/dev/null'
inside up proofsite second-secret | tally
inside get proofsite second-secret | tally

echo "== an update: the vyre container is made again, and the helper walls the server again"
( cd "$DIR" && docker compose up -d --force-recreate vyre >/dev/null 2>&1 )
n=0; until [ "$(docker inspect -f '{{.State.Health.Status}}' vyre-vyre-1 2>/dev/null)" = healthy ] || [ $n -ge 60 ]; do sleep 5; n=$((n + 1)); done
sudo vyre space-helper reattach >/tmp/pub-proof-reattach.log 2>&1 || true
n=0; until [ -n "$(rules INPUT)" ] || [ $n -ge 12 ]; do sleep 5; n=$((n + 1)); done
check "the server is walled again in the new container (answers, then drop)" '[ "$(rules INPUT | grep -c ACCEPT)" = 1 ] && [ "$(rules INPUT | grep -c DROP)" = 1 ]'
inside get proofsite second-secret | tally

echo "== retire"
inside stop | tally
inside down | tally
check "the server and its rules are gone, the data stays" '[ -z "$(docker ps -aq --filter name=^vyre-app-proofsite$)" ] && [ -z "$(rules INPUT)" ] && docker volume inspect vyre-app-proofsite_data >/dev/null'
check "the daemon's folder for it is empty" '[ -z "$(docker exec vyre-vyre-1 sh -c "ls /home/vyre/.vyre/publish/spc_proofproof1/servers 2>/dev/null")" ]'

echo "== clean up"
docker volume rm vyre-app-proofsite_data >/dev/null 2>&1 || true
docker rmi "$(sudo cat /var/lib/vyre-spaces/private/pub/dep_00000000000000a1/rec 2>/dev/null | awk '{print $2}')" >/dev/null 2>&1 || true
if [ "$KEEP" = 0 ]; then
  VYRE_DIR=$DIR sh "$REPO/scripts/install-box.sh" --uninstall --purge --yes >/dev/null 2>&1 || true
  check "the box is uninstalled and $DIR is empty of containers" '[ -z "$(docker ps -aq --filter name=vyre-vyre-1)" ]'
fi
echo "== $FAILS failed"
[ "$FAILS" = 0 ]
