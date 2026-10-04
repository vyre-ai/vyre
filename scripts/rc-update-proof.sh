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
say "1 ok: $OLDV installed, data written"

# 2. the update to the candidate, the way the root unit does it (a hand run of its step), with the throwaway key trusted for this run.
sudo sh -c 'printf "update\n" >/var/lib/vyre-update/request/request' 2>/dev/null || true
sudo env VYRE_DIR=/srv/vyre VYRE_BOX_URL=http://127.0.0.1:18182/ VYRE_RELEASES_API= "VYRE_RELEASE_KEY=$NEWPUB" VYRE_UPDATE_MIN_GAP=0 VYRE_UPDATE_WAIT=300 "$(command -v vyre)" update-from-request >"$WORK/update.log" 2>&1 || { tail -40 "$WORK/update.log"; fail "the update to $NEWV failed"; }
ready || fail "the candidate did not come up after the update"
sleep 10
[ "$(hostv)" = "$NEWV" ] || fail "after the update the box holds $(hostv), not $NEWV"
docker exec vyre-vyre-1 env | grep -qx 'VYRE_KERNEL=1' || fail "after the update the kernel is not on (VYRE_KERNEL=1 is missing)"
docker exec vyre-vyre-1 env | grep -q '^VYRE_STORE=' || fail "after the update VYRE_STORE is not kept"
mods=$(vyre status | sed -n 's/.*[^0-9]\([0-9][0-9]*\) modules running.*/\1/p' | head -n 1)
[ "${mods:-0}" -gt 0 ] || fail "after the update no module runs"
vyre status | grep -q ' failed' && fail "after the update a module failed: $(vyre status | tail -2)"
[ "$(docker exec vyre-vyre-1 cat /home/vyre/.vyre/rc-marker 2>/dev/null)" = rc-marker-1 ] || fail "the data written before the update is gone"
say "2 ok: updated to $NEWV, kernel on, $mods modules running, data intact"

# 3. the rollback to the old release: the old line has no module list, so there is nothing to approve.
vyre update --rollback >"$WORK/rollback.log" 2>&1 || { tail -30 "$WORK/rollback.log"; fail "the rollback failed"; }
ready || fail "the old release did not come back after the rollback"
[ "$(docker exec vyre-vyre-1 node -p 'require("/opt/vyre/package.json").version')" = "$OLDV" ] || fail "after the rollback the box does not run $OLDV"
[ "$(docker exec vyre-vyre-1 cat /home/vyre/.vyre/rc-marker 2>/dev/null)" = rc-marker-1 ] || fail "the data is gone after the rollback"
say "3 ok: rolled back to $OLDV, data intact"
echo "rc-update-proof: OK ($OLDV -> $NEWV -> $OLDV)"
