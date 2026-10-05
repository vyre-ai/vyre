#!/bin/sh
# rc-update-proof: the release candidate's update path, end to end, on a throwaway CI runner only (never a Mac, never a real server):
#   sh scripts/rc-update-proof.sh            (OLD_TAG, default v0.2.2: the release line being updated FROM)
# A throwaway Ed25519 key is made here; it replaces the pinned release key in a COPY of the candidate and in a copy of the old tag, both are built the way a release is (scripts/build-site.sh) and
# served from two local web servers. Then: (1) the old release is installed with the real installer and given data; (2) `vyre update` takes it to the candidate: the candidate's version runs, the kernel
# is on (VYRE_KERNEL=1) and the store setting kept (VYRE_STORE), the signed modules run, the data written before is still there; (3) `vyre update --rollback` puts the old release back and the data is
# still there (the old line has no module list, so no phone approval is asked). The real key never appears.
# DEV_KIND=1: the same run with the candidate built development-kind and the owner a stand-in at the terminal (dev-presence-stand-in in the home, as the walks use), so the reads and writes go through the product
# as the owner (a release-kind box in CI has no owner: personal memory is then proven at the home's database files).
set -eu
[ -n "${CI:-}" ] || { echo "rc-update-proof: runs on a CI runner only (CI is unset)" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
OLD_TAG=${OLD_TAG:-v0.2.2}
WORK=${RUNNER_TEMP:-/tmp}/rc-update
rm -rf "$WORK"; mkdir -p "$WORK/new" "$WORK/old"
fail() { echo "rc-update-proof FAILED: $*" >&2; exit 1; }
say() { echo "rc-update-proof: $*"; }
trap 'for p in $(cat "$WORK/pids" 2>/dev/null); do kill "$p" 2>/dev/null || true; done; vyre uninstall --delete-data --yes >/dev/null 2>&1 || true' EXIT
: >"$WORK/pids"

node -e '
const c=require("crypto"),fs=require("fs");const k=c.generateKeyPairSync("ed25519");
fs.writeFileSync(process.argv[1]+"/proof.pem",k.privateKey.export({type:"pkcs8",format:"pem"}));
fs.writeFileSync(process.argv[1]+"/proof.pub",k.publicKey.export({type:"spki",format:"der"}).toString("base64"));' "$WORK"
NEWPUB=$(cat "$WORK/proof.pub")

# The candidate: this checkout, its pinned key swapped (as packaged-boot-proof does), built like a release.
tar -C "$HERE" --exclude=.git --exclude=node_modules --exclude=site/box -cf - . | tar -C "$WORK/new" -xf -
# The candidate must be above the old line (the updater never goes back): the copy is stamped as a release candidate of the next minor.
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));p.version=process.argv[2];fs.writeFileSync(process.argv[1],JSON.stringify(p,null,2)+"\n")' "$WORK/new/package.json" "${NEW_VERSION:-0.3.0-rc.1}"
CANDKEY=$(sed -n 's/^export const RELEASE_KEY = "\(.*\)";/\1/p' "$HERE/lib/release-sig.js")
[ -n "$CANDKEY" ] || fail "could not read the candidate's pinned key"
for f in core/vyre-core/release.js box/vyre lib/release-sig.js scripts/install-mac-server.sh deck/sw.js; do [ -f "$WORK/new/$f" ] && sed -i "s#$CANDKEY#$NEWPUB#g" "$WORK/new/$f"; done
( cd "$WORK/new" && npm ci --no-audit --no-fund >/dev/null && (cd apps/app && npm ci --no-audit --no-fund >/dev/null) \
  && VYRE_SIGNING_KEY="$(cat "$WORK/proof.pem")" VYRE_CHANNEL=beta VYRE_TEST_UNSTRIPPED_WRAPPER=1 VYRE_TEST_DEV_KIND="${DEV_KIND:-0}" sh scripts/build-site.sh >"$WORK/new-build.log" 2>&1 ) || { tail -30 "$WORK/new-build.log"; fail "the candidate did not build"; }
NEWV=$(tr -d ' \r\n' <"$WORK/new/site/box/VERSION")

# The old line: the tag, its pinned key swapped to the same throwaway key, built the way it was released.
git -C "$HERE" archive "$OLD_TAG" | tar -C "$WORK/old" -xf - || fail "no tag $OLD_TAG in this checkout (fetch tags)"
OLDKEY=$(sed -n 's/^RELEASE_KEY=${VYRE_RELEASE_KEY:-\(.*\)}$/\1/p' "$WORK/old/box/vyre" | head -n 1)
[ -n "$OLDKEY" ] || fail "could not read $OLD_TAG's pinned key"
for f in $(grep -rl "$OLDKEY" "$WORK/old" --include=vyre --include='*.js' --include='*.sh' 2>/dev/null | grep -v node_modules); do sed -i "s#$OLDKEY#$NEWPUB#g" "$f"; done
( cd "$WORK/old" && npm ci --no-audit --no-fund >/dev/null \
  && VYRE_SIGNING_KEY="$(cat "$WORK/proof.pem")" VYRE_CHANNEL=beta VYRE_TEST_UNSTRIPPED_WRAPPER=1 sh scripts/build-site.sh >"$WORK/old-build.log" 2>&1 ) || { tail -30 "$WORK/old-build.log"; fail "$OLD_TAG did not build"; }
OLDV=$(tr -d ' \r\n' <"$WORK/old/site/box/VERSION")
[ "$OLDV" != "$NEWV" ] || fail "the old and the new release have the same version ($OLDV)"
say "built $OLDV (old) and $NEWV (candidate)"

serve() { ( cd "$1" && python3 -m http.server "$2" --bind 127.0.0.1 >/dev/null 2>&1 & echo $! >>"$WORK/pids" ); i=0; until curl -fs "http://127.0.0.1:$2/VERSION" >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 40 ] || fail "no local release server on $2"; sleep 0.5; done; }
serve "$WORK/old/site/box" 18181
serve "$WORK/new/site/box" 18182
ready() { i=0; until vyre status 2>/dev/null | grep -q 'modules running\|vyred running'; do i=$((i + 1)); [ $i -lt 90 ] || return 1; sleep 2; done; }
hostv() { if [ -f /srv/vyre/VERSION ]; then tr -d ' \r\n' </srv/vyre/VERSION; else docker exec vyre-vyre-1 node -p 'require("/opt/vyre/package.json").version'; fi; }

# 1. the old release, installed as a person does, with data in its home.
VYRE_BOX_URL=http://127.0.0.1:18181/ VYRE_BUILD=tgz VYRE_DEV_SIGN=0 VYRE_MODULES_TRIES=0 sh "$WORK/old/site/box/install-box.sh" --yes </dev/null >"$WORK/old-install.log" 2>&1 || { tail -40 "$WORK/old-install.log"; fail "the old release did not install"; }
ready || fail "the old release did not come up"
[ "$(docker exec vyre-vyre-1 node -p 'require("/opt/vyre/package.json").version')" = "$OLDV" ] || fail "the old install is not $OLDV"
docker exec -u 1000 vyre-vyre-1 sh -c 'echo rc-marker-1 > /home/vyre/.vyre/rc-marker' || fail "could not write data into the old home"
# Reads. With the kernel on, personal memory is read only by a person (a device or a signed-in terminal): a CI server has no owner, so the host's `vyre call` is a plain cli and is refused ("no kernel chain"), which is the design.
# A fact is then proven present by what the home's own database files hold (the same text, found in the files), which is where a lost record would show.
home_has() { docker exec -u 1000 vyre-vyre-1 sh -c 'find /home/vyre/.vyre -type f \( -name "*.db" -o -name "*.db-wal" -o -name "*.sqlite*" \) -exec grep -la -- "$0" {} + 2>/dev/null | head -n 1' "$1" | grep -q .; }
# DEV_KIND: a `vyre` call through docker exec is not a person until its terminal signs in, so a person-only call runs as the child of a signed-in terminal (signin-approve.mjs: `vyre signin`, the owner's software key signs the
# card, then the call). enrol_owner is done once, the first time a person-only call is needed (the box is stopped to enrol, then started with the two developer switches that let its sealing process accept the software key).
OWNER=0
enrol_owner() {
  [ "$OWNER" = 0 ] || return 0
  img=$(docker inspect -f '{{.Config.Image}}' vyre-vyre-1)
  docker stop vyre-vyre-1 >/dev/null || fail "could not stop the box to enrol the owner's key"
  docker run --rm -u 1000 --volumes-from vyre-vyre-1 -v "$HERE/scripts/dev-enrol-software-key.mjs:/opt/vyre/scripts/dev-enrol-software-key.mjs:ro" -e VYRE_HOME=/home/vyre/.vyre --entrypoint node "$img" /opt/vyre/scripts/dev-enrol-software-key.mjs --home /home/vyre/.vyre >"$WORK/enrol.log" 2>&1 || { cat "$WORK/enrol.log"; fail "the owner's software key could not be enrolled"; }
  grep -q '^VYRE_SEAL_DEV=1' /srv/vyre/vyre.env || printf 'VYRE_SEAL_DEV=1\nVYRE_SEAL_SOFTWARE=1\n' >>/srv/vyre/vyre.env
  vyre up >"$WORK/up-owner.log" 2>&1 || { tail -20 "$WORK/up-owner.log"; fail "the box did not start with the developer switches"; }
  ready || fail "the box did not come back with the owner's key"
  sleep 10
  OWNER=1
}
put_probes() { # the package carries no developer scripts: the signer and the sign-in probe are copied into the running box (as root, readable by the box user)
  docker exec vyre-vyre-1 mkdir -p /opt/vyre/scripts || fail "could not make the scripts folder in the box"
  docker cp "$HERE/scripts/dev-sign-proof.mjs" vyre-vyre-1:/opt/vyre/scripts/dev-sign-proof.mjs
  docker cp "$HERE/scripts/packaged-probes/signin-approve.mjs" vyre-vyre-1:/tmp/signin-approve.mjs
}
person_call() { # TOOL JSON: the call from a signed-in terminal inside the box; prints the call's answer
  enrol_owner
  put_probes
  docker exec -u 1000 -e VYRE_HOME=/home/vyre/.vyre vyre-vyre-1 node /tmp/signin-approve.mjs /opt/vyre "$1" "$2" >"$WORK/person.out" 2>&1 || true
  if grep -q '^RESULT:' "$WORK/person.out"; then sed '1,/^RESULT:/d' "$WORK/person.out"; else cat "$WORK/person.out"; fi
}
read_back() { # TEXT TOOL
  if [ "${DEV_KIND:-0}" = 1 ]; then rb=$(person_call "$2" '{}'); else rb=$(vyre call "$2" '{}' 2>&1 || true); fi
  printf '%s' "$rb" | grep -q "$1" && return 0
  [ "${DEV_KIND:-0}" != 1 ] || return 1 # an owned box reads through the product, no fallback
  printf '%s' "$rb" | grep -Eq 'no kernel chain|presence|sign ?in|not a signed-in person|denied' && home_has "$1"
}
# An untouched 0.2 server: no VYRE_STORE (a 0.2 install never wrote one; the default is the built-in store). Real records are written through the 0.2 tools the data is read back with.
vyre call memory.remember '{"text":"My wife is Robin"}' >/dev/null 2>&1 || fail "could not write a memory fact into the old release"
vyre call planner.add '{"kind":"note","text":"Marlow and Finch retainer draft"}' >/dev/null 2>&1 || fail "could not write a planner note into the old release"
vyre call memory.me '{}' 2>&1 | grep -q Robin && vyre call planner.list '{}' 2>&1 | grep -q 'retainer draft' || fail "the seed is not readable on the old release"
home_has Robin && home_has 'retainer draft' || fail "the seed is not in the old home's database files (the file check cannot see it)"
# What the person's own config already enabled (a module off by default that the old home turned on stays on after an update: that is their choice, not a difference from a fresh install).
docker exec -u 1000 vyre-vyre-1 cat /home/vyre/.vyre/config.json >"$WORK/old-config.json" 2>/dev/null || echo '{}' >"$WORK/old-config.json"
docker exec vyre-vyre-1 env | grep -q '^VYRE_STORE=' && fail "the old install already has VYRE_STORE (this proof starts from an untouched 0.2 box)"
say "1 ok: $OLDV installed untouched (no VYRE_STORE), data written and read back"

# every_module STEP: after an update the candidate must run exactly what a fresh install runs: every module its signed list names but the off-by-default ones (scripts/packaged-boot-expected.txt), none failed
# (a module whose migration fails on an upgraded home would vanish with its tools while the daemon stays up), and no "migration ... failed" line in the daemon's log.
every_module() {
  vyre modules >"$WORK/modules.txt" 2>&1 || true
  node -e '
const fs = require("fs");
const listed = Object.keys(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).modules).sort();
let kept = []; try { const c = JSON.parse(fs.readFileSync(process.argv[4], "utf8")); kept = (c.modules && Array.isArray(c.modules.enable)) ? c.modules.enable : []; } catch {}
const off = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(l => l && !l.startsWith("#") && !kept.includes(l)).sort();
const state = {};
for (const l of fs.readFileSync(process.argv[3], "utf8").split("\n")) { const m = /^\s+(\S+)\s+\S+\s+(\S+)/.exec(l); if (m) state[m[1]] = m[2]; }
const running = listed.filter(n => state[n] === "running").sort(), failed = listed.filter(n => state[n] === "failed" || state[n] === "invalid");
const want = listed.filter(n => !off.includes(n)).sort();
const problems = [];
if (failed.length) problems.push("failed: " + failed.join(", "));
if (JSON.stringify(running) !== JSON.stringify(want)) problems.push("running " + running.length + " of " + want.length + " expected; missing: " + want.filter(n => !running.includes(n)).join(", ") + "; unexpected: " + running.filter(n => !want.includes(n)).join(", "));
if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
console.log(running.length + " modules run, none failed");
' "$WORK/new/site/box/modules.json" "$HERE/scripts/packaged-boot-expected.txt" "$WORK/modules.txt" "$WORK/old-config.json" || { cat "$WORK/modules.txt" | head -80; fail "$1: the modules that run are not the candidate's fresh-install set"; }
  ! docker logs vyre-vyre-1 2>&1 | grep -Ei 'migration .* failed' || { docker logs vyre-vyre-1 2>&1 | grep -Ei 'migration .* failed' | head -5; fail "$1: a migration failed"; }
  # core/store repairs a duplicate-column migration and says so; on a box upgraded from a RELEASED version that repair must never be needed (only a dev home that ran a mis-ordered list needs it).
  ! docker logs vyre-vyre-1 2>&1 | grep -E 'migration .* v[0-9]+: column already present, treated as applied' || { docker logs vyre-vyre-1 2>&1 | grep -E 'column already present' | head -5; fail "$1: an upgrade from a released version needed the duplicate-column repair"; }
}
# do_update LABEL: the update to the candidate, the way the root unit does it (a hand run of its step), with the throwaway key trusted for this run.
do_update() { # LABEL STORE: STORE is none (an untouched box: no VYRE_STORE appears, no Twenty stack starts) or kept (VYRE_STORE is still there)
  # The installer's own update unit is stopped first: it would pick the request up itself, with the pinned (real) key, and the hand run below would find nothing to do.
  sudo systemctl stop vyre-update.path vyre-update.service >/dev/null 2>&1 || true
  sudo sh -c 'printf "update\n" >/var/lib/vyre-update/request/request' 2>/dev/null || true
  sudo env VYRE_DIR=/srv/vyre VYRE_BOX_URL=http://127.0.0.1:18182/ VYRE_RELEASES_API= "VYRE_RELEASE_KEY=$NEWPUB" VYRE_UPDATE_MIN_GAP=0 VYRE_UPDATE_WAIT=300 "$(command -v vyre)" update-from-request >"$WORK/update.log" 2>&1 || { tail -40 "$WORK/update.log"; fail "$1: the update to $NEWV failed"; }
  ready || fail "$1: the candidate did not come up after the update"
  # A server an OLD updater updated starts the new image before that updater publishes the release's files: the daemon says "Finishing the update", takes the module list from the published
  # shell.json when it arrives and restarts once by itself. Wait for that (bounded), never for a manual restart.
  # A development-kind candidate (CI only) counts as packaged only once the release's signature sits at its root, which place-release does at a container's start: started before the old updater
  # published, it is a development tree with no list and no watcher. Real releases are always packaged, so the release run proves the self-restart; here the container is restarted once the files exist.
  if [ "${DEV_KIND:-0}" = 1 ]; then
    i=0; until docker exec -u 1000 vyre-vyre-1 test -s /opt/vyre/deck/release/shell.json 2>/dev/null; do i=$((i + 1)); [ $i -lt 60 ] || fail "$1: the release's files were never published to the box"; sleep 2; done
    docker restart vyre-vyre-1 >/dev/null; ready || fail "$1: the candidate did not come back after its first restart"
  fi
  i=0; until vyre status 2>/dev/null | grep -q '[1-9][0-9]* modules running'; do i=$((i + 1)); [ $i -lt 75 ] || { vyre status | tail -4; echo '--- update.log:'; tail -25 "$WORK/update.log"; echo '--- daemon log:'; docker logs vyre-vyre-1 2>&1 | tail -50; echo '--- vyred log:'; docker exec -u 1000 vyre-vyre-1 sh -c 'grep -v ancestry /home/vyre/.vyre/logs/*.log | tail -60' 2>&1 | cut -c1-300; echo '--- modules:'; vyre modules 2>&1 | head -12; echo '--- shell.json and modules.json in the image:'; docker exec -u 1000 vyre-vyre-1 sh -c 'ls -l /opt/vyre/shell.json /opt/vyre/modules.json /opt/vyre/appbuild.json' 2>&1; echo '--- env:'; docker exec vyre-vyre-1 env | grep '^VYRE_' | sed 's/KEY=.*/KEY=.../'; fail "$1: the box never started its modules by itself after the update"; }; sleep 2; done
  sleep 5
  [ "$(hostv)" = "$NEWV" ] || fail "$1: after the update the box holds $(hostv), not $NEWV"
  docker exec vyre-vyre-1 env | grep -qx 'VYRE_KERNEL=1' || fail "$1: after the update the kernel is not on (VYRE_KERNEL=1 is missing)"
  case "$2" in
    kept) docker exec vyre-vyre-1 env | grep -qx 'VYRE_STORE=auto' || fail "$1: after the update VYRE_STORE=auto is not kept" ;;
    none) docker exec vyre-vyre-1 env | grep -q '^VYRE_STORE=' && fail "$1: the update added a VYRE_STORE the box never had (a silent switch of store)"
          # (a shared test box may hold other people's Twenty stacks, so the question is whether THIS box asked for one: its helper has recorded no Space store)
          [ -z "$(sudo ls /var/lib/vyre-spaces/private/spaces 2>/dev/null)" ] || fail "$1: a Space store was set up on a box that never chose one" ;;
  esac
  every_module "$1"
  if [ "${DEV_KIND:-0}" = 1 ]; then
    docker exec -u 1000 vyre-vyre-1 sh -c 'grep -q "development" /opt/vyre/lib/build-kind.js' || fail "$1: DEV_KIND=1 but the candidate is not development-kind"
    docker exec -u 1000 vyre-vyre-1 touch /home/vyre/.vyre/dev-presence-stand-in || fail "$1: could not place the owner stand-in"
    enrol_owner # here, not inside person_call: that runs in a subshell, and a flag set there is lost (the key would be enrolled twice)
  fi
  # records' store line (/v1/health records_store, when this candidate carries it): an untouched box is on the built-in store by default and it answers.
  if [ "$2" = none ]; then
    rs=$(vyre status --json 2>/dev/null | tr -d '\n ' || true)
    case "$rs" in
      *'"records_store"'*) printf '%s' "$rs" | grep -q '"records_store":{[^}]*"store":"builtin"' && printf '%s' "$rs" | grep -q '"from":"default"' && printf '%s' "$rs" | grep -q '"reachable":true' || fail "$1: the records store line is not built-in, default and reachable: $rs" ;;
    esac
  fi
  # The records written before the update are read back, and the box is still on the store they live in (the built-in one: there is no status line for the store, so: no Twenty stack, and the data reads).
  read_back Robin memory.me || { echo "--- memory.me:"; { [ "${DEV_KIND:-0}" = 1 ] && person_call memory.me '{}' || vyre call memory.me '{}' 2>&1; } | head -5; fail "$1: the memory fact written before the update is not read back"; }
  read_back 'retainer draft' planner.list || fail "$1: the planner note written before the update is not read back"
  [ "$(docker exec -u 1000 vyre-vyre-1 cat /home/vyre/.vyre/rc-marker 2>/dev/null)" = rc-marker-1 ] || fail "$1: the data written before the update is gone"
}
do_update "2 update" none
# A record written after the update is read back after a restart.
# A record written after the update is read back after a restart. A release box in CI has no owner, so a plain terminal's write is refused (a person writes personal memory): there the facts written before the update
# must survive the restart instead; the owned run writes and reads the new record through the product.
if [ "${DEV_KIND:-0}" = 1 ]; then wr=$(person_call memory.remember '{"text":"My daughter is Lina"}'); else wr=$(vyre call memory.remember '{"text":"My daughter is Lina"}' 2>&1 || true); fi
if printf '%s' "$wr" | grep -Eq 'denied|no kernel chain|caller_unknown'; then
  [ "${DEV_KIND:-0}" != 1 ] || { echo "$wr"; fail "2: the owner could not write a record after the update"; }
  say "2: a record cannot be written by a plain terminal on a release box (no owner in CI); the facts from before the update are checked after a restart instead"
  WROTE=0
else WROTE=1; fi
docker restart vyre-vyre-1 >/dev/null; ready || fail "2: the box did not come back after a restart"; sleep 15
[ "$WROTE" = 0 ] || read_back Lina memory.me || fail "2: the record written after the update is gone after a restart"
read_back Robin memory.me || fail "2: the memory fact from before the update is gone after a restart"
say "2 ok: updated to $NEWV with no VYRE_STORE added, kernel on, every module runs, records before and after the update read back"

# 3. the rollback to the old release: the old line has no module list, so there is nothing to approve.
vyre update --rollback >"$WORK/rollback.log" 2>&1 || { tail -30 "$WORK/rollback.log"; fail "the rollback failed"; }
ready || fail "the old release did not come back after the rollback"
[ "$(docker exec vyre-vyre-1 node -p 'require("/opt/vyre/package.json").version')" = "$OLDV" ] || fail "after the rollback the box does not run $OLDV"
[ "$(docker exec -u 1000 vyre-vyre-1 cat /home/vyre/.vyre/rc-marker 2>/dev/null)" = rc-marker-1 ] || fail "the data is gone after the rollback"
say "3 ok: rolled back to $OLDV, data intact"

# 4. the update again, from the rolled-back home, now on a box that HAS a VYRE_STORE (as a 0.3 install writes it): the setting is kept, and the same set runs (a migration that is not repeatable fails here).
printf 'VYRE_STORE=auto\n' >>/srv/vyre/vyre.env
do_update "4 second update" kept
say "4 ok: updated again with VYRE_STORE=auto kept, every module runs, records intact"

# 5. (dev-owned run only) the owner's software key, `vyre signin` and a call after it: the whole presence path of a terminal on a box, with a signed proof made by the owner's key. The daemon is stopped to enrol (the sealing
# process owns its folder), then started with the two developer switches that let its own sealing process accept the software key.
if [ "${DEV_KIND:-0}" = 1 ]; then
  enrol_owner # (normally done already by the person reads of step 2)
  put_probes
  docker exec -u 1000 -e VYRE_HOME=/home/vyre/.vyre vyre-vyre-1 node /tmp/signin-approve.mjs /opt/vyre >"$WORK/signin.log" 2>&1 || { cat "$WORK/signin.log"; docker logs vyre-vyre-1 2>&1 | grep -Ei 'signin|presence|sealer|software' | tail -15; fail "5: the sign-in with the owner's signed proof did not work"; }
  cat "$WORK/signin.log"
  say "5 ok: the owner's software key signed vyre signin, and a person-only call answered after it"
fi
echo "rc-update-proof: OK ($OLDV -> $NEWV -> $OLDV -> $NEWV)"
