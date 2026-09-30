#!/bin/sh
# Rerun the computers proof on the test server, from the repo root of a synced copy.
#   sh scripts/computers-proof/run.sh <proof-folder> [proxy-port]
# Everything is named csproof-, lives under <proof-folder>, and is removed at the end (trap).
# Never touches the live Vyre containers or folder. Heavy commands run under nice/ionice.
set -u
DIR=${1:?proof folder (absolute)}
PORT=${2:-47111}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NI="nice -n 19 ionice -c3"
mkdir -p "$DIR/run" "$DIR/out"
PROXY_PID=
cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  for c in $(docker ps -a --filter name=csproof- --format '{{.Names}}'); do docker rm -f "$c" >/dev/null 2>&1; done
  for v in $(docker volume ls --format '{{.Name}}' | grep '^csproof-'); do docker volume rm "$v" >/dev/null 2>&1; done
  docker network rm csproof-net >/dev/null 2>&1
  [ "${KEEP_IMAGE:-0}" = 1 ] || docker rmi csproof-computer:test >/dev/null 2>&1
}
trap cleanup EXIT INT TERM
echo "load: $(cut -d' ' -f1 /proc/loadavg)"
ss -ltn | grep -q ":$PORT " && { echo "port $PORT is taken; pick another"; exit 2; }
cd "$REPO" && DOCKER_BUILDKIT=1 $NI docker build -t csproof-computer:test core/computers/image || exit 1
docker network create --internal csproof-net >/dev/null || exit 1
$NI node scripts/computers-proof/proxy-up.mjs "$PORT" "$DIR/run/bearer" > "$DIR/run/proxy.log" 2>&1 &
PROXY_PID=$!
sleep 3
PROOF_HOLD="${PROOF_HOLD:-0}" PROOF_DIR="$DIR" PROXY_URL="http://127.0.0.1:$PORT" BEARER_FILE="$DIR/run/bearer" $NI node scripts/computers-proof/proof.mjs
RC=$?
echo "proof exit code $RC"
exit $RC
