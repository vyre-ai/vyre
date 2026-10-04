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
# L-3: the list is made from the tarball, the image from a build context: the kernel's own check, run on BOTH, must find no difference at all.
unpacked="$WORK/tgz-root"; mkdir -p "$unpacked"; tar -xzf "$SRC/site/box/vyre.tgz" -C "$unpacked" --strip-components=1
node "$SRC/scripts/verify-list-trees.mjs" "$unpacked" "$SRC/site/box/modules.json"

# DP-1: the packed tree says release, and its own isPackaged() agrees; the development stand-in file is refused there.
grep -qx 'export const BUILD_KIND = "release";' "$unpacked/lib/build-kind.js" || { echo "the packed lib/build-kind.js does not say release"; exit 1; }
node --input-type=module -e 'const { isPackaged } = await import(process.argv[1] + "/kernel/devbuild.js"); if (isPackaged(process.argv[1]) !== true) { console.error("the packed tree is not a packaged build"); process.exit(1); }' "$unpacked" || exit 1

( cd "$SRC/site/box" && python3 -m http.server 18090 --bind 127.0.0.1 >/dev/null 2>&1 & echo $! >"$WORK/http.pid" )
trap 'kill "$(cat "$WORK/http.pid" 2>/dev/null)" 2>/dev/null || true; vyre uninstall --delete-data --yes >/dev/null 2>&1 || true' EXIT
i=0; until curl -fs http://127.0.0.1:18090/SHA256SUMS >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 30 ] || { echo "no local release server" >&2; exit 1; }; sleep 1; done

# The install, as a person runs it (the installer from the release, VYRE_BUILD=tgz because this release has no pushed image).
VYRE_BOX_URL=http://127.0.0.1:18090/ VYRE_BUILD=tgz sh "$SRC/site/box/install-box.sh" --yes </dev/null >"$WORK/install.log" 2>&1 || { tail -40 "$WORK/install.log"; docker logs vyre-vyre-1 2>&1 | tail -30; exit 1; }
env=$(docker exec vyre-vyre-1 env)
printf '%s\n' "$env" | grep -qx 'VYRE_KERNEL=1' || { echo "the installer did not turn the kernel on"; exit 1; }
if printf '%s\n' "$env" | grep -E '^VYRE_(KERNEL_PATH_RULE|KERNEL_FILE_KEY|SEAL_DEV)='; then echo "a development variable is set"; exit 1; fi

# L-3 again, on the image that was built and is running: its /opt/vyre against the same signed list.
rm -rf "$WORK/image-root"; mkdir -p "$WORK/image-root"
docker cp vyre-vyre-1:/opt/vyre/. "$WORK/image-root/"
node "$SRC/scripts/verify-list-trees.mjs" "$WORK/image-root" "$SRC/site/box/modules.json"

ready() { i=0; until vyre status 2>/dev/null | grep -q "modules running"; do i=$((i + 1)); [ $i -lt 60 ] || return 1; sleep 2; done; }
ready || { docker logs vyre-vyre-1 2>&1 | tail -30; echo "vyred did not come up"; exit 1; }
sleep 5
st=$(vyre status)
echo "$st"
check_modules() {
# By name, not by count: the running set must be exactly the listed modules minus the ones that are off by default (scripts/packaged-boot-expected.txt), and none may be failed.
vyre modules >"$WORK/modules.txt" 2>&1 || true
node -e '
const fs = require("fs");
const listed = Object.keys(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).modules).sort();
const off = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(l => l && !l.startsWith("#")).sort();
const state = {};
for (const l of fs.readFileSync(process.argv[3], "utf8").split("\n")) { const m = /^\s+(\S+)\s+\S+\s+(\S+)/.exec(l); if (m) state[m[1]] = m[2]; }
const running = listed.filter(n => state[n] === "running").sort(), offNow = listed.filter(n => state[n] === "off").sort(), failed = listed.filter(n => state[n] === "failed");
const want = listed.filter(n => !off.includes(n)).sort();
const problems = [];
if (failed.length) problems.push("failed: " + failed.join(", "));
if (JSON.stringify(offNow) !== JSON.stringify(off)) problems.push("off by default should be [" + off.join(", ") + "], is [" + offNow.join(", ") + "]");
if (JSON.stringify(running) !== JSON.stringify(want)) problems.push("running should be every listed module but the off ones; missing: " + want.filter(n => !running.includes(n)).join(", ") + "; unexpected: " + running.filter(n => !want.includes(n)).join(", "));
const unlisted = Object.keys(state).filter(n => !listed.includes(n) && state[n] === "running");
if (unlisted.length) problems.push("running but not in the signed list: " + unlisted.join(", "));
if (problems.length) { console.error("packaged-boot-proof: " + problems.join("; ")); process.exit(1); }
console.log("ok: " + running.length + " modules run, " + offNow.length + " are off by default, none failed (the list names " + listed.length + ")");
' "$SRC/site/box/modules.json" "$HERE/scripts/packaged-boot-expected.txt" "$WORK/modules.txt" || { cat "$WORK/modules.txt"; exit 1; }

}
st=$(vyre status)
echo "$st"
check_modules
# A root-run update passes the daemon only the settings it checks (box/vyre prepare_run). Run one as root (`sudo vyre up` recreates the container from root's own env file), then the
# kernel must still be on and the same modules must run: a box must not fall back to kernel off after its first update.
sudo -n vyre up >"$WORK/rootrun.log" 2>&1 || { tail -20 "$WORK/rootrun.log"; echo "the root-run up failed"; exit 1; }
ready || { docker logs vyre-vyre-1 2>&1 | tail -30; echo "vyred did not come back after a root-run update"; exit 1; }
sleep 5
docker exec vyre-vyre-1 env | grep -qx 'VYRE_KERNEL=1' || { echo "after a root-run update the daemon lost VYRE_KERNEL=1"; exit 1; }
docker exec vyre-vyre-1 env | grep -qx 'VYRE_STORE=auto' || { echo "after a root-run update the daemon lost VYRE_STORE=auto"; exit 1; }
check_modules

# A box is a server: the daemon reports machine server, so no server module is switched off by a wrong config.
docker exec -u 1000 vyre-vyre-1 sh -c 'cat /home/vyre/.vyre/config.json 2>/dev/null' | grep -q '"machine": *"\(device\|solo\|local\)"' && { echo "the box's config says it is not a server"; exit 1; }
vyre status | grep -q ' box' || { echo "vyre status does not say this is a box"; exit 1; }
# DP-1 on the running image: the container's build is a release build, and a dev-presence-stand-in file in its home does not make it a development one.
docker exec -u 0 vyre-vyre-1 grep -qx 'export const BUILD_KIND = "release";' /opt/vyre/lib/build-kind.js || { echo "the image's lib/build-kind.js does not say release"; exit 1; }
docker exec -u 0 vyre-vyre-1 node --input-type=module -e 'const d = await import("/opt/vyre/kernel/devbuild.js"); if (!d.isPackaged() || d.devSwitch("1")) process.exit(1)' || { echo "the running image honours a developer switch"; exit 1; }

# MW-5: the web app build is signed too. /app/ answers 200 from the signed build, and one changed file under it is refused (503, app_build_changed) by the daemon that serves it.
sock=$(docker exec -u 1000 vyre-vyre-1 sh -c 'ls /home/vyre/.vyre/*.sock 2>/dev/null | head -n 1')
appcode() { docker exec -u 1000 vyre-vyre-1 node -e 'require("http").get({socketPath:process.argv[1],path:"/app/",headers:{"x-vyre-caller":"anonymous"}},r=>{console.log(r.statusCode);r.resume()}).on("error",()=>console.log("err"))' "$sock"; }
appwhy() { docker exec -u 1000 vyre-vyre-1 node -e 'let b="";require("http").get({socketPath:process.argv[1],path:"/app/",headers:{"x-vyre-caller":"anonymous"}},r=>{r.on("data",d=>b+=d);r.on("end",()=>console.log(b.slice(0,300)))})' "$sock"; }
[ "$(appcode)" = 200 ] || { echo "the signed web app is not served (/app/ answered $(appcode)): $(appwhy)"; docker exec vyre-vyre-1 ls -l /opt/vyre/appbuild.json /opt/vyre/SHA256SUMS 2>&1 | head -3; exit 1; }
docker exec -u 0 vyre-vyre-1 sh -c 'echo "<!-- tampered -->" >> /opt/vyre/apps/app/dist/index.html'
[ "$(appcode)" = 503 ] || { echo "a changed file of the web app was served (/app/ answered $(appcode))"; exit 1; }
docker exec -u 0 vyre-vyre-1 sh -c 'sed -i "$ d" /opt/vyre/apps/app/dist/index.html'

# One module file changed after it was signed: refused, plainly, and nothing else is.
docker exec -u 0 vyre-vyre-1 sh -c 'echo "// tampered" >> /opt/vyre/core/work/index.js'
docker restart vyre-vyre-1 >/dev/null
ready || { echo "vyred did not come back after the tamper"; exit 1; }
sleep 5
docker exec -u 1000 vyre-vyre-1 sh -c 'cat /home/vyre/.vyre/logs/*.log' | grep -q 'kernel: work is not first party: it was changed after it was signed' || { echo "the tampered module was not refused with the kernel's line"; exit 1; }
after=$(vyre status | sed -n 's/.*· \([0-9][0-9]*\) failed.*/\1/p' | head -n 1)
[ "${after:-0}" = 1 ] || { echo "expected exactly one module refused after the tamper, saw ${after:-0}"; vyre modules 2>&1 | grep failed; exit 1; }
echo "ok: the tampered module is refused and the rest run"
