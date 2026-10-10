#!/bin/sh
# Builds the two releases the update proof moves between, on a throwaway CI runner only: the OLD tag (default v0.2.11) and the CANDIDATE (this checkout), each built the way a release is (scripts/build-site.sh), both signed with ONE
# throwaway Ed25519 key that replaces the pinned release key in the COPIES (the real key never appears and a build that is not Vyre's cannot be signed with it). The same recipe as scripts/rc-update-proof.sh. Both builds keep the development kind (VYRE_TEST_DEV_KIND=1): a release-kind box refuses the stand-in relay's plain ws:// address (lib/relay-url.js).
#   sh build-update-releases.sh WORKDIR [OLD_TAG]   ->  WORKDIR/{old,new}/site/box, WORKDIR/proof.pub, WORKDIR/{old,new}.version
set -eu
[ -n "${CI:-}" ] || [ "${VYRE_JOURNEY_BOX:-}" = 1 ] || { echo "build-update-releases: runs on a CI runner only (CI is unset), or on a test box that holds nothing of its own, which says so with VYRE_JOURNEY_BOX=1" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")/../../.." && pwd)
WORK=$1
OLD_TAG=${2:-v0.2.12}
CAND_TAG=${3:-}   # a released tag as the candidate (the control run); empty: this checkout
rm -rf "$WORK"; mkdir -p "$WORK/new" "$WORK/old"
fail() { echo "build-update-releases FAILED: $*" >&2; exit 1; }
node -e '
const c=require("crypto"),fs=require("fs");const k=c.generateKeyPairSync("ed25519");
fs.writeFileSync(process.argv[1]+"/proof.pem",k.privateKey.export({type:"pkcs8",format:"pem"}));
fs.writeFileSync(process.argv[1]+"/proof.pub",k.publicKey.export({type:"spki",format:"der"}).toString("base64"));' "$WORK"
NEWPUB=$(cat "$WORK/proof.pub")

if [ -n "$CAND_TAG" ]; then git -C "$HERE" archive "$CAND_TAG" | tar -C "$WORK/new" -xf - || fail "no tag $CAND_TAG in this checkout (fetch tags)"
else tar -C "$HERE" --exclude=.git --exclude=node_modules --exclude=site/box -cf - . | tar -C "$WORK/new" -xf -; fi
# The candidate's COPY gets one debug line in presence.person.pair-challenge (what peer and caller the box saw); this build is only ever served by this proof, never released.
node -e 'const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");const k=s.indexOf("presence.person.pair-challenge");const m="const peer = meta.peer;";const i=s.indexOf(m,k);if(k<0||i<0){console.error("debug line: anchor not found");process.exit(0)}s=s.slice(0,i+m.length)+"\n        ctx.log(\"DEBUG pair-challenge peer=\" + JSON.stringify(peer) + \" caller=\" + String(meta.caller));"+s.slice(i+m.length);fs.writeFileSync(f,s)' "$WORK/new/core/presence/module.js"
# and one in renewGrant: what the device record says, which decides whether a grant is renewed (proof builds only)
node -e 'const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");const k=s.indexOf("const renewGrant");const m="const rec = r && r.data;";const i=s.indexOf(m,k);if(k<0||i<0){console.error("debug line 2: anchor not found");process.exit(0)}s=s.slice(0,i+m.length)+"\n      ctx.log(\"DEBUG renewGrant device=\" + device + \" rec=\" + JSON.stringify(rec ? { ...rec, key: rec.key ? \"present\" : null } : rec) + \" err=\" + String(r && r.error && r.error.message));"+s.slice(i+m.length);fs.writeFileSync(f,s)' "$WORK/new/core/presence/module.js"
# The candidate must be above the old line (the updater never goes back): the copy is stamped one patch above the OLD tag (v0.3.0 -> 0.3.1), not a fixed number.
[ -n "$CAND_TAG" ] || node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));p.version=process.argv[2];fs.writeFileSync(process.argv[1],JSON.stringify(p,null,2)+"\n")' "$WORK/new/package.json" "${NEW_VERSION:-$(printf %s "${OLD_TAG#v}" | awk -F. '{ printf "%d.%d.%d", $1, $2, $3 + 1 }')}"
CANDKEY=$(sed -n 's/^export const RELEASE_KEY = "\(.*\)";/\1/p' "$HERE/lib/release-sig.js")
[ -n "$CANDKEY" ] || fail "could not read the candidate's pinned key"
for f in core/vyre-core/release.js box/vyre lib/release-sig.js scripts/install-mac-server.sh; do [ -f "$WORK/new/$f" ] && sed -i "s#$CANDKEY#$NEWPUB#g" "$WORK/new/$f"; done
( cd "$WORK/new" && npm ci --no-audit --no-fund >/dev/null && (cd apps/app && npm ci --no-audit --no-fund >/dev/null) \
  && VYRE_SIGNING_KEY="$(cat "$WORK/proof.pem")" VYRE_CHANNEL=stable VYRE_TEST_UNSTRIPPED_WRAPPER=1 VYRE_TEST_DEV_KIND=1 sh scripts/build-site.sh >"$WORK/new-build.log" 2>&1 ) || { tail -30 "$WORK/new-build.log"; fail "the candidate did not build"; }

git -C "$HERE" archive "$OLD_TAG" | tar -C "$WORK/old" -xf - || fail "no tag $OLD_TAG in this checkout (fetch tags)"
OLDKEY=$(sed -n 's/^RELEASE_KEY=${VYRE_RELEASE_KEY:-\(.*\)}$/\1/p' "$WORK/old/box/vyre" | head -n 1)
[ -n "$OLDKEY" ] || fail "could not read $OLD_TAG's pinned key"
for f in $(grep -rl "$OLDKEY" "$WORK/old" --include=vyre --include='*.js' --include='*.sh' 2>/dev/null | grep -v node_modules); do sed -i "s#$OLDKEY#$NEWPUB#g" "$f"; done
( cd "$WORK/old" && npm ci --no-audit --no-fund >/dev/null \
  && VYRE_SIGNING_KEY="$(cat "$WORK/proof.pem")" VYRE_CHANNEL=stable VYRE_TEST_UNSTRIPPED_WRAPPER=1 VYRE_TEST_DEV_KIND=1 sh scripts/build-site.sh >"$WORK/old-build.log" 2>&1 ) || { tail -30 "$WORK/old-build.log"; fail "$OLD_TAG did not build"; }
tr -d ' \r\n' <"$WORK/old/site/box/VERSION" >"$WORK/old.version"
tr -d ' \r\n' <"$WORK/new/site/box/VERSION" >"$WORK/new.version"
[ "$(cat "$WORK/old.version")" != "$(cat "$WORK/new.version")" ] || fail "the old and the new release have the same version"
echo "built $(cat "$WORK/old.version") (old) and $(cat "$WORK/new.version") (candidate)"
