#!/bin/sh
# packaged-boot-proof: the release line's packaged box, end to end, on a throwaway CI runner only (never a Mac, never a real server):
#   sh scripts/packaged-boot-proof.sh [--drop <folder>]...
# Builds the package the way a release does (scripts/build-site.sh, so vyre.tgz, modules.json and a signed SHA256SUMS) with a THROWAWAY Ed25519 key made here, in a copy of the
# checkout whose pinned release keys are replaced by that key (the real key never appears). Installs it with the real installer from a local web server, with VYRE_KERNEL=1 as the
# installer writes it and NO development variable, then checks (1) every module of the signed list runs and none failed, and (2) one tampered module file is refused, with the
# kernel's plain line, and nothing else fails. It caught two bugs no unit test could: packed folders missing from package.json "files", and two modules with one name.
# --drop FOLDER removes a folder from the copy before the build (for a known, open problem only; say which in the job).
# DEV_KIND=1: the candidate is built development-kind and the terminal is the owner (dev-presence-stand-in in the home, as the walks use); only that run does the session blocks (own-server sealing, kill and resume).
# The release run asserts the release-kind rules (DP-1) instead.
set -eu
# Checks that do not stop the run: each failure is said where it happens and collected, so one broken check never hides the ones after it; the run fails at the end if any did.
FAILS=""
soft() { FAILS="$FAILS x"; }
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
  && VYRE_SIGNING_KEY="$(cat "$WORK/proof.pem")" VYRE_CHANNEL=beta VYRE_TEST_DEV_KIND="${DEV_KIND:-0}" sh scripts/build-site.sh >"$WORK/build.log" 2>&1 ) || { tail -30 "$WORK/build.log"; exit 1; }
[ -s "$SRC/site/box/modules.json" ] || { echo "packaged-boot-proof: the build made no modules.json" >&2; exit 1; }
listed=$(node -p 'Object.keys(require(process.argv[1]).modules).length' "$SRC/site/box/modules.json")
echo "the signed list names $listed modules"
# L-3: the list is made from the tarball, the image from a build context: the kernel's own check, run on BOTH, must find no difference at all.
unpacked="$WORK/tgz-root"; mkdir -p "$unpacked"; tar -xzf "$SRC/site/box/vyre.tgz" -C "$unpacked" --strip-components=1
node "$SRC/scripts/verify-list-trees.mjs" "$unpacked" "$SRC/site/box/modules.json"

if [ "${DEV_KIND:-0}" != 1 ]; then # (a dev-kind run is the owned box for the session blocks: it is not a release build)
# DP-1: the packed tree says release, and its own isPackaged() agrees; the development stand-in file is refused there.
grep -qx 'export const BUILD_KIND = "release";' "$unpacked/lib/build-kind.js" || { echo "the packed lib/build-kind.js does not say release"; exit 1; }
node --input-type=module -e 'const { isPackaged } = await import(process.argv[1] + "/kernel/devbuild.js"); if (isPackaged(process.argv[1]) !== true) { console.error("the packed tree is not a packaged build"); process.exit(1); }' "$unpacked" || exit 1
fi

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
# A migration that fails on a module takes its tools away while the daemon stays up: the log says so.
! docker logs vyre-vyre-1 2>&1 | grep -Ei 'migration .* failed' || { docker logs vyre-vyre-1 2>&1 | grep -Ei 'migration .* failed' | head -5; echo "a migration failed at boot"; soft; }
# A fresh install never needs the duplicate-column repair either.
! docker logs vyre-vyre-1 2>&1 | grep -qE 'migration .* v[0-9]+: column already present, treated as applied' || { docker logs vyre-vyre-1 2>&1 | grep -E 'column already present' | head -3; echo "a fresh install needed the duplicate-column migration repair"; soft; }
# A root-run update passes the daemon only the settings it checks (box/vyre prepare_run). Run one as root (`sudo vyre up` recreates the container from root's own env file), then the
# kernel must still be on and the same modules must run: a box must not fall back to kernel off after its first update.
sudo -n vyre up >"$WORK/rootrun.log" 2>&1 || { tail -20 "$WORK/rootrun.log"; echo "the root-run up failed"; exit 1; }
ready || { docker logs vyre-vyre-1 2>&1 | tail -30; echo "vyred did not come back after a root-run update"; exit 1; }
sleep 5
docker exec vyre-vyre-1 env | grep -qx 'VYRE_KERNEL=1' || { echo "after a root-run update the daemon lost VYRE_KERNEL=1"; exit 1; }
docker exec vyre-vyre-1 env | grep -qx 'VYRE_STORE=auto' || { echo "after a root-run update the daemon lost VYRE_STORE=auto"; exit 1; }
check_modules

# A box is a server: the daemon reports machine server, so no server module is switched off by a wrong config.
docker exec -u 1000 vyre-vyre-1 sh -c 'cat /home/vyre/.vyre/config.json 2>/dev/null' | grep -q '"machine": *"\(device\|solo\|local\)"' && { echo "the box's config says it is not a server"; soft; }
vyre status | grep -q ' box' || { echo "vyre status does not say this is a box"; soft; }
# No first-run page on a server (0.3): nothing listens on the onboarding port inside the container, and the compose publishes nothing on the host.
for port in 7300 7301; do
  docker exec -u 1000 vyre-vyre-1 node -e 'const s=require("net").connect({host:process.argv[1],port:Number(process.argv[2])});s.on("connect",()=>{console.log("LISTENING");process.exit(0)});s.on("error",()=>process.exit(1))' 127.0.0.1 "$port" | grep -q LISTENING && { echo "something listens on port $port inside the box: a server has no setup page"; soft; }
done
docker ps --format '{{.Ports}}' --filter name=vyre-vyre-1 | grep -q 7300 && { echo "the box publishes the onboarding port on the host"; soft; }
if [ "${DEV_KIND:-0}" != 1 ]; then
# DP-1 on the running image: the container's build is a release build, and a dev-presence-stand-in file in its home does not make it a development one.
docker exec -u 0 vyre-vyre-1 grep -qx 'export const BUILD_KIND = "release";' /opt/vyre/lib/build-kind.js || { echo "the image's lib/build-kind.js does not say release"; soft; }
docker exec -u 0 vyre-vyre-1 node --input-type=module -e 'const d = await import("/opt/vyre/kernel/devbuild.js"); if (!d.isPackaged() || d.devSwitch("1")) process.exit(1)' || { echo "the running image honours a developer switch"; soft; }
fi

# The host's `vyre call` is answered as a plain terminal caller (the wrapper execs as the vyre user, with a terminal when there is one): never caller_unknown. Personal memory then says "no kernel chain" (only a person reads it: a signed-in terminal or a device; a CI server has no owner to sign in).
hc=$(vyre call memory.me '{}' 2>&1 || true)
printf '%s' "$hc" | grep -Eq 'caller_unknown|could not tell who is calling' && { echo "host vyre call is not read as the person at the terminal: $hc"; soft; }

# The admin steps refuse for the RIGHT reason on the packaged image (not "no such step" or "no Vyre home"): a wrong typed word, and a bad proof for the anchor reset (the daemon is stopped for it
# and started again either way). VYRE_ADMIN_NO_TTY stands in for the terminal the real command needs.
# (the real command needs a terminal: the checks give it one with script(1); the test override for "no terminal" is refused in a root run, as it should be)
out=$(printf 'not-the-word\n' | timeout 120 script -qec "sudo -n vyre admin wipe" /dev/null 2>&1 || true)
printf '%s' "$out" | grep -q "that was not the word; nothing was done" || { echo "admin wipe with a wrong word did not refuse plainly: $out"; soft; }
out=$( { printf 'anchor-reset\n'; sleep 30; printf '{}\n'; sleep 10; } | timeout 100 script -qec "sudo -n vyre admin anchor-reset" /dev/null 2>&1 || true)
# Whatever happened above (a timeout kill included), the daemon is started again so the blocks after this one run.
docker start vyre-vyre-1 >/dev/null 2>&1 || true
printf '%s' "$out" | grep -Eq 'refused: (unknown_key|no_proof|bad_proof|needs_presence)' || { echo "admin anchor-reset with a bad proof did not refuse for the right reason: $out"; soft; }
printf '%s' "$out" | grep -Eq 'no Vyre home|no_home|has no anchor-reset step|has no admin' && { echo "admin anchor-reset could not even start its step: $out"; soft; }
ready || { docker logs vyre-vyre-1 2>&1 | tail -20; echo "vyred did not come back after the anchor-reset refusal"; exit 1; }
sleep 5
if [ "${DEV_KIND:-0}" != 1 ]; then
# DP-1 and the software signer: a REAL sealing process from a release-kind tree refuses a software presence key even with the variable and the dev flag set. The probe runs on a COPY of the
# image's tree (kernel/seal/testing.js and test/scratch.mjs are not shipped and are added to the copy only), so the signed tree under test is not touched.
docker exec -u 1000 vyre-vyre-1 sh -c 'rm -rf /tmp/probe && mkdir /tmp/probe && cp -a /opt/vyre/lib /opt/vyre/kernel /opt/vyre/package.json /tmp/probe/ && mkdir /tmp/probe/test'
docker cp "$HERE/kernel/seal/testing.js" vyre-vyre-1:/tmp/probe/kernel/seal/testing.js
docker cp "$HERE/test/scratch.mjs" vyre-vyre-1:/tmp/probe/test/scratch.mjs
docker cp "$HERE/scripts/packaged-probes/software-release.mjs" vyre-vyre-1:/tmp/software-release.mjs
docker exec -u 1000 vyre-vyre-1 node /tmp/software-release.mjs /tmp/probe || { echo "a release-kind build accepted a software key (or the probe could not run)"; soft; }
# The copy keeps the image's read-only folders (the owner makes them writable first; root here has no DAC_OVERRIDE), and the probe script docker cp left in sticky /tmp is root's own to remove.
docker exec -u 1000 vyre-vyre-1 sh -c 'chmod -R u+w /tmp/probe 2>/dev/null; rm -rf /tmp/probe'
docker exec -u 0 vyre-vyre-1 rm -f /tmp/software-release.mjs || true
fi

# MW-5: the web app build is signed too. /app/ answers 200 from the signed build, and one changed file under it is refused (503, app_build_changed) by the daemon that serves it.
sock=$(docker exec -u 1000 vyre-vyre-1 sh -c 'ls /home/vyre/.vyre/*.sock 2>/dev/null | head -n 1')
appcode() { docker exec -u 1000 vyre-vyre-1 node -e 'require("http").get({socketPath:process.argv[1],path:"/app/",headers:{"x-vyre-caller":"anonymous"}},r=>{console.log(r.statusCode);r.resume()}).on("error",()=>console.log("err"))' "$sock"; }
appwhy() { docker exec -u 1000 vyre-vyre-1 node -e 'let b="";require("http").get({socketPath:process.argv[1],path:"/app/",headers:{"x-vyre-caller":"anonymous"}},r=>{r.on("data",d=>b+=d);r.on("end",()=>console.log(b.slice(0,300)))})' "$sock"; }
[ "$(appcode)" = 200 ] || { echo "the signed web app is not served (/app/ answered $(appcode)): $(appwhy)"; docker exec vyre-vyre-1 ls -l /opt/vyre/appbuild.json /opt/vyre/SHA256SUMS 2>&1 | head -3; soft; }
swcode() { docker exec -u 1000 vyre-vyre-1 node -e 'require("http").get({socketPath:process.argv[1],path:"/app/"+process.argv[2],headers:{"x-vyre-caller":"anonymous"}},r=>{console.log(r.statusCode);r.resume()}).on("error",()=>console.log("err"))' "$sock" "$1"; }
[ "$(swcode sw.js)" = 200 ] || { echo "the signed sw.js is not served (answered $(swcode sw.js))"; soft; }
[ "$(swcode manifest.webmanifest)" = 200 ] || { echo "the signed manifest is not served (answered $(swcode manifest.webmanifest))"; soft; }
docker exec -u 0 vyre-vyre-1 sh -c 'echo "<!-- tampered -->" >> /opt/vyre/apps/app/dist/index.html'
[ "$(appcode)" = 503 ] || { echo "a changed file of the web app was served (/app/ answered $(appcode))"; soft; }
docker exec -u 0 vyre-vyre-1 sh -c 'sed -i "$ d" /opt/vyre/apps/app/dist/index.html'

if [ "${DEV_KIND:-0}" = 1 ]; then # an owned box: the session blocks need the person at the terminal (a release box in CI has no owner)
docker exec -u 1000 vyre-vyre-1 touch /home/vyre/.vyre/dev-presence-stand-in
# The runner on a server (own-server sealing): the module runs on the box, says what the box does, and a session on the server is SEALED AT EVERY TURN into the home's checkpoint store
# (core/runner/ownserver.js, the daemon's core/daemon/ownserver-host.js). A stand-in `claude` (the repo's fake, copied in like the probes above) writes the transcript the way Claude Code does.
rs=$(vyre call runner.status 2>&1) || { echo "$rs"; echo "runner.status did not answer on the box"; exit 1; }
printf '%s\n' "$rs" | grep -Eq '"?ownServer"?[: ]+true' || { echo "$rs"; echo "the runner on a box does not say it seals its own sessions"; exit 1; }
# The box's root has no capability to read or change files in uid 1000's home (cap_drop ALL): stage through /tmp, finish as uid 1000, and only /usr/local/bin as root.
docker cp "$HERE/core/switchboard/testing/fake-claude.js" vyre-vyre-1:/tmp/fake-claude-src.mjs
docker exec -u 1000 vyre-vyre-1 sh -c 'cp /tmp/fake-claude-src.mjs /home/vyre/fake-claude.mjs && chmod 755 /home/vyre/fake-claude.mjs && mkdir -p /home/vyre/.claude/projects && (umask 002; mkdir -p /work/sealwork) && chmod g+rwx /work/sealwork'
docker exec -u 0 vyre-vyre-1 sh -c 'printf "#!/bin/sh\nexport FAKE_CLAUDE_TRANSCRIPTS=/home/vyre/.claude/projects\nexec node /home/vyre/fake-claude.mjs \"\$@\"\n" > /usr/local/bin/claude && chmod 755 /usr/local/bin/claude'
# The fake claude is the account's provider: a login account, no credential of anyone's in CI. A box session needs an account (no account is refused at once, no_account).
acct=$(vyre call sessions.accounts.add '{"provider":"claude","label":"proof","kind":"login","is_default":true}' 2>&1) || { echo "$acct"; echo "an account could not be added to the box"; exit 1; }
tid=$(vyre call threads.start '{"cwd":"/work/sealwork","prompt":"first","surface":"deck"}' 2>&1 | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$tid" ] || { echo "a session could not be started on the box (is its sandbox refusing?)"; vyre call threads.start '{"cwd":"/work/sealwork","prompt":"first","surface":"deck"}' 2>&1 | tail -5; exit 1; }
sealed() { docker exec -u 1000 vyre-vyre-1 sh -c 'cat /home/vyre/.vyre/checkpoints/*/CURRENT 2>/dev/null' | grep -o '"turn":[0-9]*' | grep -o '[0-9]*' | sort -n | tail -n 1; }
i=0; until [ "$(sealed)" = 1 ]; do i=$((i + 1)); [ $i -lt 40 ] || { echo "turn 1 was not sealed (sealed: $(sealed))"; docker exec -u 1000 vyre-vyre-1 sh -c 'tail -5 /home/vyre/.vyre/logs/*.log'; exit 1; }; sleep 1; done
sleep 3
vyre call threads.send "{\"thread\":\"$tid\",\"text\":\"second\",\"surface\":\"deck\"}" >/dev/null 2>&1
i=0; until [ "$(sealed)" = 2 ]; do i=$((i + 1)); [ $i -lt 40 ] || { echo "turn 2 was not sealed (sealed: $(sealed))"; exit 1; }; sleep 1; done
echo "ok: a session on the server is sealed at every turn (turn 1 and turn 2 are checkpoints in the home's store)"

# A session on the server SURVIVES A CRASH (sessions): kill the whole container with SIGKILL after turn 2 is sealed, leave a torn line and an unfinished turn in the transcript (what a kill leaves),
# start it again: the thread is stopped for the restart, the next message puts the transcript back to exactly the last sealed turn (runner.recover, called by the Switchboard before it resumes) and the
# session answers, and the third turn is sealed after it.
tfile=$(docker exec -u 1000 vyre-vyre-1 sh -c "ls /home/vyre/.claude/projects/*/$tid.jsonl" 2>/dev/null | head -n 1)
[ -n "$tfile" ] || { echo "the session's transcript was not found on the box"; exit 1; }
docker exec -u 1000 vyre-vyre-1 sh -c "cp $tfile /tmp/sealed-copy.jsonl"
docker kill vyre-vyre-1 >/dev/null
docker exec -u 0 vyre-vyre-1 true 2>/dev/null && { echo "the container is still running after docker kill"; exit 1; }
docker start vyre-vyre-1 >/dev/null
ready || { echo "vyred did not come back after the kill"; exit 1; }
docker exec -u 1000 vyre-vyre-1 sh -c "printf '%s\n%s' '{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"UNFINISHED\"}}' '{\"type\":\"assistant\",\"mess' >> $tfile"
docker exec -u 1000 vyre-vyre-1 sh -c "grep -q UNFINISHED $tfile" || { echo "could not leave the kill's leftovers in the transcript"; exit 1; }
vyre call threads.send "{\"thread\":\"$tid\",\"text\":\"back after the crash\",\"surface\":\"deck\"}" >/dev/null 2>&1
i=0; until [ "$(sealed)" = 3 ]; do i=$((i + 1)); [ $i -lt 60 ] || { echo "the resumed turn was not sealed (sealed: $(sealed)); status:"; vyre call threads.get "{\"thread\":\"$tid\"}" 2>&1 | tail -5; exit 1; }; sleep 1; done
docker exec -u 1000 vyre-vyre-1 sh -c "grep -q UNFINISHED $tfile" && { echo "the killed turn's leftovers reached the resumed session"; exit 1; }
docker exec -u 1000 vyre-vyre-1 sh -c "head -c \$(wc -c < /tmp/sealed-copy.jsonl) $tfile | cmp -s - /tmp/sealed-copy.jsonl" || { echo "the resumed transcript does not start with the last sealed turns"; exit 1; }
echo "ok: a session on the server survives a crash (killed, restarted, put back to its last sealed turn, resumed, and the next turn sealed)"
# Confinement in the box (ruling b): the session ran as its own uid, and the box says so on its record. The self-test itself, run as that uid through the real spawner: it passes for the protected
# set the daemon uses, and it FAILS (naming the check) when told a folder the agent can reach is protected (the shared /work group folder), so a hole cannot pass.
cb=$(vyre call threads.get "{\"thread\":\"$tid\"}" 2>&1 | sed -n 's/.*"confined_by": *"\([^"]*\)".*/\1/p' | head -n 1)
[ "$cb" = uid ] || { echo "the session's record does not say confined_by uid (it says: ${cb:-nothing})"; vyre call threads.get "{\"thread\":\"$tid\"}" 2>&1 | tail -8; exit 1; }
docker exec -u 1000 vyre-vyre-1 sh -c 'ls /home/vyre/.vyre/logs/*.log >/dev/null && grep -h "start step sandbox self-test" /home/vyre/.vyre/logs/*.log | tail -1' >/dev/null || true
cat > "$WORK/confine-proof.mjs" <<'EOF'
import { confineSelfTest } from "/opt/vyre/core/spawner/confine.js";
import fs from "node:fs";
const base = { cwd: "/work", vyreUid: process.getuid(), account: null, shared: true, timeoutMs: 20000 };
const good = await confineSelfTest({ ...base, out: [{ name: "Vyre's own home", path: "/home/vyre" }, { name: "the vault and keys", path: "/home/vyre/.vyre/kernel" }] });
if (!good.ok) { console.log("GOOD-FAILED " + JSON.stringify(good)); process.exit(1); }
const hole = await confineSelfTest({ ...base, out: [{ name: "the shared work folder", path: "/work" }] });
if (hole.ok || !hole.failures.some(f => /can reach the shared work folder/.test(f))) { console.log("HOLE-PASSED " + JSON.stringify(hole)); process.exit(1); }
console.log("CONFINED uid=" + good.results.uid + " hole refused: " + hole.failures[0]);
EOF
docker cp "$WORK/confine-proof.mjs" vyre-vyre-1:/tmp/confine-proof.mjs
cp_out=$(docker exec -u 1000 vyre-vyre-1 node /tmp/confine-proof.mjs 2>&1) || { echo "$cp_out"; echo "the box's confinement self-test did not hold"; exit 1; }
echo "ok: $cp_out"
docker exec -u 0 vyre-vyre-1 rm -f /usr/local/bin/claude; docker exec -u 1000 vyre-vyre-1 rm -f /home/vyre/fake-claude.mjs
fi

# One module file changed after it was signed: refused, plainly, and nothing else is.
docker exec -u 0 vyre-vyre-1 sh -c 'echo "// tampered" >> /opt/vyre/core/work/index.js'
docker restart vyre-vyre-1 >/dev/null
ready || { echo "vyred did not come back after the tamper"; exit 1; }
sleep 5
docker exec -u 1000 vyre-vyre-1 sh -c 'cat /home/vyre/.vyre/logs/*.log' | grep -q 'kernel: work is not first party: it was changed after it was signed' || { echo "the tampered module was not refused with the kernel's line"; exit 1; }
after=$(vyre status | sed -n 's/.*· \([0-9][0-9]*\) failed.*/\1/p' | head -n 1)
[ "${after:-0}" = 1 ] || { echo "expected exactly one module refused after the tamper, saw ${after:-0}"; vyre modules 2>&1 | grep failed; exit 1; }
echo "ok: the tampered module is refused and the rest run"
[ -z "$FAILS" ] || { echo "packaged-boot-proof: $(printf '%s' "$FAILS" | wc -w) check(s) failed (see the lines above)"; exit 1; }
