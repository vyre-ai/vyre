#!/bin/sh
# rc-update-proof: the release candidate's update path, end to end, on a throwaway CI runner only (never a Mac, never a real server):
#   sh scripts/rc-update-proof.sh            (OLD_TAG, default v0.2.2: the release line being updated FROM)
# A throwaway Ed25519 key is made here; it replaces the pinned release key in a COPY of the candidate and in a copy of the old tag, both are built the way a release is (scripts/build-site.sh) and
# served from two local web servers. Then: (1) the old release is installed with the real installer and given data; (2) `vyre update` takes it to the candidate: the candidate's version runs, the kernel
# is on (VYRE_KERNEL=1) and the store setting kept (VYRE_STORE), the signed modules run, the data written before is still there; (3) `vyre update --rollback` puts the old release back and the data is
# still there (the old line has no module list, so no phone approval is asked). The real key never appears.
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
  && VYRE_SIGNING_KEY="$(cat "$WORK/proof.pem")" VYRE_CHANNEL=beta VYRE_TEST_UNSTRIPPED_WRAPPER=1 sh scripts/build-site.sh >"$WORK/new-build.log" 2>&1 ) || { tail -30 "$WORK/new-build.log"; fail "the candidate did not build"; }
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
# An untouched 0.2 server: no VYRE_STORE (a 0.2 install never wrote one; the default is the built-in store). Real records are written through the 0.2 tools the data is read back with.
vyre call memory.remember '{"text":"My wife is Robin"}' >/dev/null 2>&1 || fail "could not write a memory fact into the old release"
vyre call planner.add '{"kind":"note","text":"Marlow and Finch retainer draft"}' >/dev/null 2>&1 || fail "could not write a planner note into the old release"
vyre call memory.me '{}' 2>&1 | grep -q Robin && vyre call planner.list '{}' 2>&1 | grep -q 'retainer draft' || fail "the seed is not readable on the old release"
docker exec vyre-vyre-1 env | grep -q '^VYRE_STORE=' && fail "the old install already has VYRE_STORE (this proof starts from an untouched 0.2 box)"
say "1 ok: $OLDV installed untouched (no VYRE_STORE), data written and read back"

# every_module STEP: after an update the candidate must run exactly what a fresh install runs: every module its signed list names but the off-by-default ones (scripts/packaged-boot-expected.txt), none failed
# (a module whose migration fails on an upgraded home would vanish with its tools while the daemon stays up), and no "migration ... failed" line in the daemon's log.
every_module() {
  vyre modules >"$WORK/modules.txt" 2>&1 || true
  node -e '
const fs = require("fs");
const listed = Object.keys(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).modules).sort();
const off = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(l => l && !l.startsWith("#")).sort();
const state = {};
for (const l of fs.readFileSync(process.argv[3], "utf8").split("\n")) { const m = /^\s+(\S+)\s+\S+\s+(\S+)/.exec(l); if (m) state[m[1]] = m[2]; }
const running = listed.filter(n => state[n] === "running").sort(), failed = listed.filter(n => state[n] === "failed" || state[n] === "invalid");
const want = listed.filter(n => !off.includes(n)).sort();
const problems = [];
if (failed.length) problems.push("failed: " + failed.join(", "));
if (JSON.stringify(running) !== JSON.stringify(want)) problems.push("running " + running.length + " of " + want.length + " expected; missing: " + want.filter(n => !running.includes(n)).join(", "));
if (problems.length) { console.error(problems.join("; ")); process.exit(1); }
console.log(running.length + " modules run, none failed");
' "$WORK/new/site/box/modules.json" "$HERE/scripts/packaged-boot-expected.txt" "$WORK/modules.txt" || { cat "$WORK/modules.txt" | head -80; fail "$1: the modules that run are not the candidate's fresh-install set"; }
  ! docker logs vyre-vyre-1 2>&1 | grep -Ei 'migration .* failed' || { docker logs vyre-vyre-1 2>&1 | grep -Ei 'migration .* failed' | head -5; fail "$1: a migration failed"; }
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
  i=0; until vyre status 2>/dev/null | grep -q '[1-9][0-9]* modules running'; do i=$((i + 1)); [ $i -lt 75 ] || { vyre status | tail -4; fail "$1: the box never started its modules by itself after the update"; }; sleep 2; done
  sleep 5
  [ "$(hostv)" = "$NEWV" ] || fail "$1: after the update the box holds $(hostv), not $NEWV"
  docker exec vyre-vyre-1 env | grep -qx 'VYRE_KERNEL=1' || fail "$1: after the update the kernel is not on (VYRE_KERNEL=1 is missing)"
  case "$2" in
    kept) docker exec vyre-vyre-1 env | grep -qx 'VYRE_STORE=auto' || fail "$1: after the update VYRE_STORE=auto is not kept" ;;
    none) docker exec vyre-vyre-1 env | grep -q '^VYRE_STORE=' && fail "$1: the update added a VYRE_STORE the box never had (a silent switch of store)"
          [ -z "$(docker ps -q --filter name=twenty)" ] || fail "$1: a Twenty store started on a box that never chose one" ;;
  esac
  every_module "$1"
  # records' store line (/v1/health records_store, when this candidate carries it): an untouched box is on the built-in store by default and it answers.
  if [ "$2" = none ]; then
    rs=$(vyre status --json 2>/dev/null | tr -d '\n ' || true)
    case "$rs" in
      *'"records_store"'*) printf '%s' "$rs" | grep -q '"records_store":{[^}]*"store":"builtin"' && printf '%s' "$rs" | grep -q '"from":"default"' && printf '%s' "$rs" | grep -q '"reachable":true' || fail "$1: the records store line is not built-in, default and reachable: $rs" ;;
    esac
  fi
  # The records written before the update are read back, and the box is still on the store they live in (the built-in one: there is no status line for the store, so: no Twenty stack, and the data reads).
  vyre call memory.me '{}' 2>&1 | grep -q Robin || fail "$1: the memory fact written before the update is not read back"
  vyre call planner.list '{}' 2>&1 | grep -q 'retainer draft' || fail "$1: the planner note written before the update is not read back"
  [ "$(docker exec vyre-vyre-1 cat /home/vyre/.vyre/rc-marker 2>/dev/null)" = rc-marker-1 ] || fail "$1: the data written before the update is gone"
}
do_update "2 update" none
# A record written after the update is read back after a restart.
vyre call memory.remember '{"text":"My daughter is Lina"}' >/dev/null 2>&1 || fail "2: could not write a record after the update"
docker restart vyre-vyre-1 >/dev/null; ready || fail "2: the box did not come back after a restart"; sleep 15
vyre call memory.me '{}' 2>&1 | grep -q Lina || fail "2: the record written after the update is gone after a restart"
say "2 ok: updated to $NEWV with no VYRE_STORE added, kernel on, every module runs, records before and after the update read back"

# 3. the rollback to the old release: the old line has no module list, so there is nothing to approve.
vyre update --rollback >"$WORK/rollback.log" 2>&1 || { tail -30 "$WORK/rollback.log"; fail "the rollback failed"; }
ready || fail "the old release did not come back after the rollback"
[ "$(docker exec vyre-vyre-1 node -p 'require("/opt/vyre/package.json").version')" = "$OLDV" ] || fail "after the rollback the box does not run $OLDV"
[ "$(docker exec vyre-vyre-1 cat /home/vyre/.vyre/rc-marker 2>/dev/null)" = rc-marker-1 ] || fail "the data is gone after the rollback"
say "3 ok: rolled back to $OLDV, data intact"

# 4. the update again, from the rolled-back home, now on a box that HAS a VYRE_STORE (as a 0.3 install writes it): the setting is kept, and the same set runs (a migration that is not repeatable fails here).
printf 'VYRE_STORE=auto\n' >>/srv/vyre/vyre.env
do_update "4 second update" kept
say "4 ok: updated again with VYRE_STORE=auto kept, every module runs, records intact"
echo "rc-update-proof: OK ($OLDV -> $NEWV -> $OLDV -> $NEWV)"
