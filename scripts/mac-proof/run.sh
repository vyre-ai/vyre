#!/bin/sh
# The Mac server proof, on a GitHub macOS runner (.github/workflows/mac-server.yml). It runs the REAL
# scripts/install-mac-server.sh with the runner's real passwordless sudo, against a test release signed
# with a throwaway key (release.mjs), and checks what a Mac server must have:
#   the _vyre account, a root-owned code tree, core.json, the three LaunchDaemons in launchd's SYSTEM
#   domain (RunAtLoad, so they start at boot with nobody signed in), core answering on its socket,
#   the relay keys made and used through core, vyred running, the pinned Node and pinned Colima/Lima/
#   docker binaries that the script checks against their pins (no Homebrew on its PATH), and a clean
#   uninstall.
# It cannot reboot the runner and it cannot run Colima's VM (hosted macOS has no nested virtualization).
# Never run this on a person's Mac: it installs a system service and creates an account.
set -eu

[ "${GITHUB_ACTIONS:-}" = true ] || { echo "mac-proof: only on a GitHub runner" >&2; exit 2; }
repo=$(pwd)
work=${RUNNER_TEMP:-/tmp}/mac-proof
rm -rf "$work"; mkdir -p "$work"
ok() { echo "PASS  $*"; }
# On any failure, show what launchd and the logs know, so a red run explains itself.
dump() {
  [ "$?" = 0 ] && return 0
  echo "::group::state at failure"
  for l in com.vyre.core com.vyre.vyred com.vyre.colima; do echo "--- $l"; sudo launchctl print "system/$l" 2>&1 | head -n 40 || true; done
  ls -la "/Library/Application Support/Vyre" 2>&1 || true
  for f in "${VYRE_HOME:-/nonexistent}"/logs/*; do [ -f "$f" ] && { echo "--- $f"; tail -n 30 "$f"; }; done 2>/dev/null || true
  # the service writes its output here (vyre: "its output is in ~/.vyre-proof/logs"), not under VYRE_HOME
  ls -la "$HOME/.vyre-proof/logs" 2>&1 || true
  for f in "$HOME/.vyre-proof/logs"/*; do [ -f "$f" ] && { echo "--- $f"; tail -n 40 "$f"; }; done 2>/dev/null || true
  echo "::endgroup::"
}
trap dump EXIT
bad() { echo "FAIL  $*" >&2; exit 1; }

node scripts/mac-proof/release.mjs "$work"
node_bin=$(command -v node)
# The install script verifies the first install against the release key embedded in itself, so the
# test runs a COPY of it with the throwaway public key put in (the real script has no override).
key=$(cat "$work/release-key.pub")
sed "s|^RELEASE_KEY=.*|RELEASE_KEY=$key|" "$repo/scripts/install-mac-server.sh" >"$work/install-mac-server.sh"
grep -q "^RELEASE_KEY=$key\$" "$work/install-mac-server.sh" || bad "the key did not patch in"
script=$work/install-mac-server.sh

# No Homebrew, no node on PATH: what a fresh Mac has. The script bundles its own Node and Colima.
PATH_MIN=/usr/bin:/bin:/usr/sbin:/sbin
export VYRE_BOX_URL="file://$work/site/"
export VYRE_HOME="$HOME/.vyre-proof"
export VYRE_SERVER_DIR="$HOME/.vyre-server"

echo "::group::install"
env PATH="$PATH_MIN" VYRE_CODE="" sh "$script" --yes
echo "::endgroup::"

# Account and tree.
dscl . -read /Users/_vyre UniqueID >/dev/null || bad "no _vyre account"
[ "$(dscl . -read /Users/_vyre UserShell | awk '{print $2}')" = /usr/bin/false ] || bad "_vyre has a login shell"
ok "the _vyre account exists with no login shell"
base="/Library/Application Support/Vyre"
[ "$(stat -f %Su "$base")" = root ] || bad "$base is not root's"
[ "$(stat -f %Su "$base/current/core/vyre-core/main.js")" = root ] || bad "core's code is not root's"
[ "$(stat -f %Su "$base/data")" = _vyre ] || bad "core's data is not _vyre's"
[ "$(stat -f %Lp "$base/data")" = 700 ] || bad "core's data is not 0700"
ok "the code tree is root's and the data folder is _vyre's, 0700"
cat "$base/core.json" | grep -q '"socket"' || bad "no core.json"
[ "$(stat -f %Su "$base/core.json")" = root ] || bad "core.json is not root's"

# LaunchDaemons: system domain, at load.
for l in com.vyre.core com.vyre.core.update com.vyre.vyred com.vyre.colima; do
  [ -f "/Library/LaunchDaemons/$l.plist" ] || bad "no plist for $l"
  [ "$(stat -f %Su "/Library/LaunchDaemons/$l.plist")" = root ] || bad "$l.plist is not root's"
  sudo launchctl print "system/$l" >"$work/$l.print" 2>&1 || bad "$l is not loaded in the system domain"
done
grep -q 'runatload' "$work/com.vyre.core.print" || grep -q 'RunAtLoad' /Library/LaunchDaemons/com.vyre.core.plist || bad "core does not start at load"
grep -q 'RunAtLoad' /Library/LaunchDaemons/com.vyre.vyred.plist || bad "vyred does not start at load"
ok "core, update, vyred and colima are LaunchDaemons in the system domain, started at load"

# core answers.
sock=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).socket' "$base/core.json")
i=0; until [ -S "$sock" ] || [ $i -ge 30 ]; do sleep 1; i=$((i+1)); done
[ -S "$sock" ] || bad "core's socket is missing"
cat >"$work/probe.mjs" <<'JS'
import { coreHello, coreTool, readCoreConfig } from "/Library/Application Support/Vyre/current/lib/vyre-core-client.js";
import { createCoreKeys } from "/Library/Application Support/Vyre/current/lib/vyre-core-keys.js";
import crypto from "node:crypto";
const cfg = readCoreConfig();
if (!cfg) { console.error("core.json is not trusted"); process.exit(1); }
const hello = await coreHello(cfg.socket);
if (!hello) { console.error("core did not say hello"); process.exit(1); }
const keys = createCoreKeys();
if (await keys.exists()) { console.error("keys existed before ensure"); process.exit(1); }
if (!(await keys.ensure())) { console.error("ensure made nothing"); process.exit(1); }
const pub = await keys.boxPub();
const peer = crypto.generateKeyPairSync("x25519");
const remote = peer.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const secret = await keys.boxDh(Buffer.from(remote));
const theirs = crypto.diffieHellman({ privateKey: peer.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), pub]), format: "der", type: "spki" }) });
if (!secret.equals(Buffer.from(theirs))) { console.error("dh disagrees"); process.exit(1); }
const sig = await keys.routeSign(Buffer.from("hello"));
const rp = await keys.routePub();
if (!crypto.verify(null, Buffer.from("hello"), crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rp]), format: "der", type: "spki" }), sig)) { console.error("signature does not verify"); process.exit(1); }
const peerVerdict = await coreTool("keys.exists", {}, { socket: cfg.socket });
console.log(JSON.stringify({ name: hello.name, version: hello.version, keys: peerVerdict.data }));
JS
"$node_bin" "$work/probe.mjs" || bad "core did not answer as it should"
# A model's process gets nothing: the same call from a process named claude is refused by core.
cat >"$work/neg.mjs" <<'JS'
import { coreTool, readCoreConfig } from "/Library/Application Support/Vyre/current/lib/vyre-core-client.js";
const cfg = readCoreConfig();
for (const tool of ["keys.box.pub", "keys.box.dh", "keys.route.sign", "keys.ensure"]) {
  const r = await coreTool(tool, { remote: "AA", message: "AA" }, { socket: cfg.socket });
  if (!r.error || r.error.code !== "not_person_side") { console.error(tool + " was not refused: " + JSON.stringify(r)); process.exit(1); }
}
JS
cp "$node_bin" "$work/claude"
"$work/claude" "$work/neg.mjs" || bad "a process named claude was not refused"
ok "a process running as claude is refused every key call"
sudo test -f "$base/data/keys.json" || bad "core stored no keys"
[ "$(sudo stat -f %Su "$base/data/keys.json")" = _vyre ] || bad "keys.json is not _vyre's"
[ "$(sudo stat -f %Lp "$base/data/keys.json")" = 600 ] || bad "keys.json is not 0600"
if cat "$base/data/keys.json" >/dev/null 2>&1; then bad "the owner can read core's keys"; fi
ok "core answers on its socket; the relay keys are made, used and readable by _vyre alone"

# vyred.
i=0; until [ -f "$VYRE_HOME/vyred.pid" ] && kill -0 "$(cat "$VYRE_HOME/vyred.pid")" 2>/dev/null || [ $i -ge 60 ]; do sleep 1; i=$((i+1)); done
kill -0 "$(cat "$VYRE_HOME/vyred.pid")" 2>/dev/null || { tail -n 30 "$VYRE_HOME"/logs/* 2>/dev/null || true; bad "vyred is not running"; }
ok "vyred is running under launchd"

# The pinned downloads were checked by the script itself; make sure they are the real thing.
[ -x "$VYRE_SERVER_DIR/node-dist/bin/node" ] && "$VYRE_SERVER_DIR/node-dist/bin/node" -v | grep -q '^v22\.' || bad "the bundled Node is not 22"
"$VYRE_SERVER_DIR/bin/colima" version | head -n 1 || bad "the pinned colima does not run"
"$VYRE_SERVER_DIR/lima/bin/limactl" --version | head -n 1 || bad "the pinned limactl does not run"
"$VYRE_SERVER_DIR/bin/docker" --version | head -n 1 || bad "the pinned docker client does not run"
"$VYRE_SERVER_DIR/bin/gh" --version | head -n 1 || bad "the pinned gh does not run"
ok "the pinned Node, Colima, Lima, docker client and gh matched their sums and run"

# A second run repairs: same release, nothing breaks, still one core.
echo "::group::reinstall"
env PATH="$PATH_MIN" sh "$script" --yes
echo "::endgroup::"
sudo launchctl print system/com.vyre.core >/dev/null || bad "core is gone after a second install"
"$node_bin" "$work/probe.mjs" 2>/dev/null && bad "the second install should find the keys already there" || true
ok "installing again repairs and keeps core's keys"

# Uninstall.
echo "::group::uninstall"
env PATH="$PATH_MIN" sh "$script" --uninstall --purge --yes
echo "::endgroup::"
if sudo launchctl print system/com.vyre.core >/dev/null 2>&1; then bad "core is still loaded"; fi
if dscl . -read /Users/_vyre >/dev/null 2>&1; then bad "_vyre is still there"; fi
[ ! -e "/Library/LaunchDaemons/com.vyre.core.plist" ] || bad "core's plist is still there"
[ ! -e "$VYRE_SERVER_DIR" ] || bad "the app folder is still there"
ok "uninstall --purge removed the daemons, the account and the files"
echo "mac-proof: all checks passed"
