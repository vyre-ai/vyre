#!/bin/sh
# packaged-boot-proof: the release line's packaged box, end to end, on a throwaway CI runner only (never a Mac, never a real server):
#   sh scripts/packaged-boot-proof.sh [--drop <folder>]...
# Builds the package the way a release does (scripts/build-site.sh, so vyre.tgz, modules.json and a signed SHA256SUMS) with a THROWAWAY Ed25519 key made here, in a copy of the
# checkout whose pinned release keys are replaced by that key (the real key never appears). Installs it with the real installer from a local web server, with VYRE_KERNEL=1 as the
# installer writes it and NO development variable, then checks (1) every module of the signed list runs and none failed, and (2) one tampered module file is refused, with the
# kernel's plain line, and nothing else fails. It caught two bugs no unit test could: packed folders missing from package.json "files", and two modules with one name.
# --drop FOLDER removes a folder from the copy before the build (for a known, open problem only; say which in the job).
set -eu
[ -n "${CI:-}" ] || { echo "packaged-boot-proof: runs on a CI runner only (CI is unset)" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=${RUNNER_TEMP:-/tmp}/packaged-boot
rm -rf "$WORK"; mkdir -p "$WORK"
SRC="$WORK/src"; mkdir -p "$SRC"
tar -C "$HERE" --exclude=.git --exclude=node_modules --exclude=site/box -cf - . | tar -C "$SRC" -xf -
while [ $# -gt 0 ]; do case "$1" in --drop) rm -rf "$SRC/$2"; shift 2 ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done
# Known open problems, listed in scripts/packaged-boot-known.txt: said loudly, never silently.
if [ -f "$HERE/scripts/packaged-boot-known.txt" ]; then
  grep -v '^#' "$HERE/scripts/packaged-boot-known.txt" | grep -v '^$' | while read -r d; do
    echo "packaged-boot-proof: KNOWN OPEN PROBLEM, leaving $d out of the package for this proof (scripts/packaged-boot-known.txt)"
    [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "Known open problem: $d is left out of this proof (scripts/packaged-boot-known.txt)" >> "$GITHUB_STEP_SUMMARY"
    rm -rf "${SRC:?}/$d"
  done
fi

# A throwaway key: the private half signs, the public half replaces every pinned copy of the release key in the copy.
node -e '
const c=require("crypto"),fs=require("fs");const k=c.generateKeyPairSync("ed25519");
fs.writeFileSync(process.argv[1]+"/proof.pem",k.privateKey.export({type:"pkcs8",format:"pem"}));
fs.writeFileSync(process.argv[1]+"/proof.pub",k.publicKey.export({type:"spki",format:"der"}).toString("base64"));' "$WORK"
OLD=$(sed -n 's/^export const RELEASE_KEY = "\(.*\)";/\1/p' "$HERE/lib/release-sig.js")
NEW=$(cat "$WORK/proof.pub")
[ -n "$OLD" ] || { echo "packaged-boot-proof: could not read the pinned key" >&2; exit 1; }
for f in core/vyre-core/release.js box/vyre lib/release-sig.js scripts/install-mac-server.sh deck/sw.js; do [ -f "$SRC/$f" ] && sed -i "s#$OLD#$NEW#g" "$SRC/$f"; done
grep -q "$NEW" "$SRC/lib/release-sig.js" "$SRC/box/vyre"

( cd "$SRC" && npm ci --no-audit --no-fund >/dev/null && (cd apps/app && npm ci --no-audit --no-fund >/dev/null) \
  && VYRE_SIGNING_KEY="$(cat "$WORK/proof.pem")" VYRE_CHANNEL=beta sh scripts/build-site.sh >"$WORK/build.log" 2>&1 ) || { tail -30 "$WORK/build.log"; exit 1; }
[ -s "$SRC/site/box/modules.json" ] || { echo "packaged-boot-proof: the build made no modules.json" >&2; exit 1; }
listed=$(node -p 'Object.keys(require(process.argv[1]).modules).length' "$SRC/site/box/modules.json")
echo "the signed list names $listed modules"

( cd "$SRC/site/box" && python3 -m http.server 18090 --bind 127.0.0.1 >/dev/null 2>&1 & echo $! >"$WORK/http.pid" )
trap 'kill "$(cat "$WORK/http.pid" 2>/dev/null)" 2>/dev/null || true; vyre uninstall --delete-data --yes >/dev/null 2>&1 || true' EXIT
i=0; until curl -fs http://127.0.0.1:18090/SHA256SUMS >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 30 ] || { echo "no local release server" >&2; exit 1; }; sleep 1; done

# The install, as a person runs it (the installer from the release, VYRE_BUILD=tgz because this release has no pushed image).
VYRE_BOX_URL=http://127.0.0.1:18090/ VYRE_BUILD=tgz sh "$SRC/site/box/install-box.sh" --yes </dev/null >"$WORK/install.log" 2>&1 || { tail -40 "$WORK/install.log"; docker logs vyre-vyre-1 2>&1 | tail -30; exit 1; }
env=$(docker exec vyre-vyre-1 env)
printf '%s\n' "$env" | grep -qx 'VYRE_KERNEL=1' || { echo "the installer did not turn the kernel on"; exit 1; }
if printf '%s\n' "$env" | grep -E '^VYRE_(KERNEL_PATH_RULE|KERNEL_FILE_KEY|SEAL_DEV)='; then echo "a development variable is set"; exit 1; fi

ready() { i=0; until vyre status 2>/dev/null | grep -q "modules running"; do i=$((i + 1)); [ $i -lt 60 ] || return 1; sleep 2; done; }
ready || { docker logs vyre-vyre-1 2>&1 | tail -30; echo "vyred did not come up"; exit 1; }
sleep 5
st=$(vyre status)
echo "$st"
running=$(printf '%s\n' "$st" | sed -n 's/.* \([0-9][0-9]*\) modules running.*/\1/p' | head -n 1)
failed=$(printf '%s\n' "$st" | sed -n 's/.*· \([0-9][0-9]*\) failed.*/\1/p' | head -n 1)
[ -n "$running" ] && [ "$running" -ge 1 ] || { echo "no module is running"; exit 1; }
[ -z "$failed" ] || { echo "$failed module(s) failed on a packaged box:"; vyre modules 2>&1 | grep failed; exit 1; }
echo "ok: $running modules run, none failed (the list names $listed)"

# One module file changed after it was signed: refused, plainly, and nothing else is.
docker exec -u 0 vyre-vyre-1 sh -c 'echo "// tampered" >> /opt/vyre/core/work/index.js'
docker restart vyre-vyre-1 >/dev/null
ready || { echo "vyred did not come back after the tamper"; exit 1; }
sleep 5
docker exec -u 1000 vyre-vyre-1 sh -c 'cat /home/vyre/.vyre/logs/*.log' | grep -q 'kernel: work is not first party: it was changed after it was signed' || { echo "the tampered module was not refused with the kernel's line"; exit 1; }
after=$(vyre status | sed -n 's/.*· \([0-9][0-9]*\) failed.*/\1/p' | head -n 1)
[ "${after:-0}" = 1 ] || { echo "expected exactly one module refused after the tamper, saw ${after:-0}"; vyre modules 2>&1 | grep failed; exit 1; }
echo "ok: the tampered module is refused and the rest run"
