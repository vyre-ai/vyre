#!/bin/sh
# install-mac-server.sh: put Vyre on a Mac that is the always-on server (the Mac mini case).
# install-box.sh hands a Darwin `curl -fsSL https://vyre.run/install.sh | sh` to this script.
#
#   --dry-run          print every change, make none (read-only checks still run)
#   --yes              answer yes to every prompt
#   --login-only       the old mode: a LaunchAgent in your own account, no password, starts when you sign in
#   --from DIR         use a local checkout DIR instead of downloading a release (needs --login-only:
#                      a checkout has no signed release for the system service to verify)
#   --uninstall        stop and remove the service, the wrapper and the app; ~/.vyre stays
#   --purge            with --uninstall: also delete ~/.vyre and Vyre's system data, after asking
#
# Environment: VYRE_CODE (the setup code from the install line: never an argument), VYRE_BOX_URL
# (default https://vyre.run/box/), VYRE_HOME (default ~/.vyre, where vyre.env lives).
#
# DEFAULT (system service, ADR 0040 section 5): Vyre starts at boot with nobody signed in. This
# script never runs as root. It downloads vyre.tgz, manifest.json, SHA256SUMS and SHA256SUMS.sig, verifies the
# signature on SHA256SUMS against the release key embedded below, and checks the other two against it, fetches a pinned standalone Node 22 to
# bundle (Homebrew's node is not used for that: its libraries are person-writable), installs Colima
# for agents' computers, writes vyre.env (0600) and the vyred wrapper, then runs the root installer
# (core/vyre-core/install-main.js) under ONE sudo. The root installer checks the release's signature;
# it creates vyre-core, and the LaunchDaemons for vyre-core, vyred and Colima (vyred and Colima run
# as your account). The script then waits for vyred and for vyre-core's socket file to exist.
#
# --login-only: checks Node 22.5+, downloads vyre.tgz (or copies --from), installs Colima, writes
# vyre.env, and installs one LaunchAgent that runs vyred under `caffeinate`. Nothing system-wide changes.
#
# Test seams: VYRE_SUDO (default sudo), VYRE_INSTALL_MAIN (the root installer's path; default the
# extracted app for install, the installed tree for uninstall), VYRE_CORE_BASE (default
# /Library/Application Support/Vyre, where core.json lives), VYRE_NODE_URL / VYRE_NODE_SHA256, the
# Colima ones below, VYRE_UNAME_S / _M, VYRE_LAUNCHCTL, VYRE_CAFFEINATE, VYRE_SERVER_DIR, VYRE_LAUNCHAGENTS.
# Everything lives inside main(), called on the last line, so a piped script is read whole first.

set -eu

DRY=0
YES=0
FROM=""
UNINSTALL=0
PURGE=0
SYSTEM=1
TMP=""
CODE=${VYRE_CODE:-}
BASE=${VYRE_BOX_URL:-https://vyre.run/box/}
# Overridable for tests only.
UNAME_S=${VYRE_UNAME_S:-$(uname -s)}
UNAME_M=${VYRE_UNAME_M:-$(uname -m)}
LAUNCHCTL=${VYRE_LAUNCHCTL:-launchctl}
SUDO=${VYRE_SUDO:-sudo}
CORE_BASE=${VYRE_CORE_BASE:-/Library/Application Support/Vyre}
VHOME=${VYRE_HOME:-$HOME/.vyre}
SERVER_DIR=${VYRE_SERVER_DIR:-$HOME/.vyre-server}
AGENTS_DIR=${VYRE_LAUNCHAGENTS:-$HOME/Library/LaunchAgents}
LABEL=run.vyre.server
COLIMA_LABEL=run.vyre.colima
CAFF=${VYRE_CAFFEINATE:-/usr/bin/caffeinate}
APP=$SERVER_DIR/app
BIN=$SERVER_DIR/bin
NODE_DIST=$SERVER_DIR/node-dist
COLIMA_ARGS=""

# Pinned release binaries for the no-Homebrew Colima install. Each sum was read from the release
# itself and checked against a second source: Colima's colima-Darwin-*.sha256sum files (v0.10.3) and
# Lima's signed-release SHA256SUMS (v2.2.0). Docker publishes no sums file: the two Docker sums below
# were computed by downloading each docker-29.8.1.tgz once into a temp dir and running shasum -a 256.
# An empty sum means "no pinned build for this release": the fallback refuses rather than run unverified.
# VYRE_COLIMA_URL / _SHA256, VYRE_LIMA_URL / _SHA256 and VYRE_DOCKER_URL / _SHA256 override, for tests.
COLIMA_VERSION=v0.10.3
COLIMA_SHA256_ARM64=980ad8bf61a4ca370243f4cb41401a61276dcd2c2502bee7b9b86f9250169f34
COLIMA_SHA256_AMD64=3082737fe8a98afda11cba7d9a20b6e56fe80c6153464beda04bec630758770b
LIMA_VERSION=2.2.0
LIMA_SHA256_ARM64=bbdef91774885a0d05f7b048c4eb89ae2bcf3a0c252ae7ca7934e63df76d93c3
LIMA_SHA256_AMD64=0d6f99c19f6e4bc3c92730c4c29d929e6927f0cb0a0ba1a84383367135a8ff31
DOCKER_VERSION=29.8.1
DOCKER_SHA256_ARM64=5a8f5604d7673202b2af925229d15eb4bbb86f7f542e4ac8cd7aa3f14cfa0f8b
DOCKER_SHA256_AMD64=de42b6bb38d0ea08333cdddc18b054d61d4c9f003b3616ae55d85ccea72c47c9

# gh, for GitHub sign-in (vyred runs the real gh through VYRE_GH_BIN). The pinned release zips, sums
# from gh_2.102.0_checksums.txt in the release itself. VYRE_GH_URL / VYRE_GH_SHA256 override, for tests.
GH_VERSION=2.102.0
GH_SHA256_ARM64=da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e
GH_SHA256_AMD64=b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3
GH_BIN=""

# The Node bundled for the system service: the official Node 22 LTS darwin tarball, pinned by version
# and sha256. Both sums are the lines for node-v22.23.3-darwin-{arm64,x64}.tar.gz in
# https://nodejs.org/dist/v22.23.3/SHASUMS256.txt, read with curl on 2026-09-30.
# VYRE_NODE_URL / VYRE_NODE_SHA256 override, for tests (file:// is fine).
NODE_VERSION=v22.23.3
NODE_SHA256_ARM64=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53
NODE_SHA256_X64=8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8

# The release public key (Ed25519, base64 SPKI), the same constant as RELEASE_KEY in
# core/vyre-core/release.js (scripts/check-release-key.mjs keeps them equal). This script is the
# thing the person already trusts, so the first install is checked against THIS key, before sudo,
# and never against a key inside the tarball.
RELEASE_KEY=MCowBQYDK2VwAyEAKXSdujH7tO/gscXCJZmYCjB+Cv1sVlOfdgLNedMR7FU=
NODE_TGZ_SHA=""
RELEASE_VERSION=""
TGZ_SHA=""

say() { printf '%s\n' "$*"; }
die() { printf 'vyre: %s\n' "$*" >&2; exit 1; }
step() { say "  ok  $*"; }
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else die "need shasum or sha256sum to verify downloads"; fi
}

fetch() {
  case "$BASE" in
    file://*) cp "${BASE#file://}$1" "$2" 2>/dev/null || die "could not read $BASE$1" ;;
    *) curl -fsSL --retry 2 -o "$2" "$BASE$1" || die "could not download $BASE$1" ;;
  esac
}

# get NAME: a release file into TMP, checked against its line in SHA256SUMS.
get() {
  want=$(awk -v p="$1" '$2 == p || $2 == "*" p { print $1; exit }' "$TMP/SHA256SUMS")
  [ -n "$want" ] || die "SHA256SUMS has no line for $1"
  fetch "$1" "$TMP/$1"
  [ "$(sha256 "$TMP/$1")" = "$want" ] || die "$1 does not match SHA256SUMS; nothing was installed"
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 5 ]; }
}

# fetch_node: the pinned Node into NODE_DIST (person-side, root copies it into its own tree). A bad
# download installs nothing.
fetch_node() {
  case "$UNAME_M" in
    arm64|aarch64) na=arm64; ns=$NODE_SHA256_ARM64 ;;
    x86_64|amd64) na=x64; ns=$NODE_SHA256_X64 ;;
    *) die "no pinned Node for this Mac ($UNAME_M)" ;;
  esac
  ns=${VYRE_NODE_SHA256-$ns}
  nu=${VYRE_NODE_URL:-https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$na.tar.gz}
  [ -n "$ns" ] || die "no pinned Node checksum for this release; nothing was installed"
  if [ "$DRY" = 1 ]; then say "would download Node $NODE_VERSION from $nu into $NODE_DIST"; return 0; fi
  say "Downloading Node $NODE_VERSION (checked against its pinned checksum)..."
  curl -fsSL --retry 2 -o "$TMP/node.tgz" "$nu" || die "could not download $nu"
  [ "$(sha256 "$TMP/node.tgz")" = "$ns" ] || die "the Node download does not match its pinned checksum; nothing was installed"
  NODE_TGZ_SHA=$ns
  rm -rf "$TMP/node-x"; mkdir -p "$TMP/node-x"
  tar -xzf "$TMP/node.tgz" -C "$TMP/node-x" --strip-components=1 || die "the Node download did not unpack"
  [ -f "$TMP/node-x/bin/node" ] || die "the Node download has no bin/node in it; nothing was installed"
  chmod 755 "$TMP/node-x/bin/node"
  mkdir -p "$SERVER_DIR"
  rm -rf "$NODE_DIST.new" "$NODE_DIST"
  mv "$TMP/node-x" "$NODE_DIST.new"; mv "$NODE_DIST.new" "$NODE_DIST"
  step "Node $NODE_VERSION is in $NODE_DIST"
}

# wrapper_node: the node vyred runs on. Login-only: yours. System: yours if it is 22.5+, else the bundled one.
wrapper_node() {
  if [ "$SYSTEM" = 0 ] || node_ok; then command -v node; else printf '%s' "$NODE_DIST/bin/node"; fi
}

preflight() {
  [ "$UNAME_S" = Darwin ] || die "this installer is for a Mac; on Linux use the Docker install line"
  [ "$(id -u)" != 0 ] || die "run this as your own account, not root: Vyre never runs as root here"
  if [ "$SYSTEM" = 1 ]; then
    fetch_node
  elif ! node_ok; then
    if command -v brew >/dev/null 2>&1; then
      if [ "$DRY" = 1 ]; then say "would install Node 22 with Homebrew"
      else say "Installing Node 22 with Homebrew..."; brew install node@22 >/dev/null 2>&1 || die "brew could not install node@22"
        PATH="$(brew --prefix node@22)/bin:$PATH"; export PATH; node_ok || die "Node 22.5 or newer is still missing"
      fi
    else die "Vyre needs Node 22.5 or newer. Install it from https://nodejs.org, then run this line again."; fi
  fi
  if [ -n "$CODE" ]; then
    printf '%s' "$CODE" | grep -Eq '^[A-Za-z0-9_-]{43}$' \
      || die "that setup code does not look right. Copy the install line from your browser again."
  fi
  if [ "$SYSTEM" = 1 ]; then step "this Mac is ready"
  else step "this Mac is ready (Node $(node -p 'process.versions.node' 2>/dev/null || echo 22))"; fi
}

install_app() {
  if [ "$DRY" = 1 ]; then
    if [ "$SYSTEM" = 1 ]; then say "would download vyre.tgz, manifest.json, SHA256SUMS and SHA256SUMS.sig from $BASE and verify the signature"; fi
    say "would install Vyre into $APP"; return 0
  fi
  mkdir -p "$SERVER_DIR"
  rm -rf "$APP.new"
  mkdir -p "$APP.new"
  if [ "$SYSTEM" = 1 ]; then
    fetch SHA256SUMS "$TMP/SHA256SUMS"
    if [ ! -s "$TMP/SHA256SUMS" ] || grep -vqE '^[0-9a-f]{64} [ *][^ ]+$' "$TMP/SHA256SUMS"; then
      die "$BASE""SHA256SUMS is not a checksum list; is VYRE_BOX_URL right?"
    fi
    # SHA256SUMS is signed (SHA256SUMS.sig, the one signature Linux and Mac both use): verify_release
    # checks it here before sudo and root checks it again on its own copies.
    get vyre.tgz; get manifest.json; fetch SHA256SUMS.sig "$TMP/SHA256SUMS.sig"; cp "$TMP/SHA256SUMS" "$TMP/sums"
    mkdir -p "$TMP/release"
    mv "$TMP/vyre.tgz" "$TMP/manifest.json" "$TMP/SHA256SUMS.sig" "$TMP/release/"; mv "$TMP/sums" "$TMP/release/SHA256SUMS"
    verify_release
    tar -xzf "$TMP/release/vyre.tgz" -C "$APP.new" --strip-components=1 || die "vyre.tgz did not unpack"
  elif [ -n "$FROM" ]; then
    (cd "$FROM" && tar --exclude .git --exclude node_modules -cf - .) | (cd "$APP.new" && tar -xf -)
  else
    fetch SHA256SUMS "$TMP/SHA256SUMS"
    if [ ! -s "$TMP/SHA256SUMS" ] || grep -vqE '^[0-9a-f]{64} [ *][^ ]+$' "$TMP/SHA256SUMS"; then
      die "$BASE""SHA256SUMS is not a checksum list; is VYRE_BOX_URL right?"
    fi
    get vyre.tgz
    tar -xzf "$TMP/vyre.tgz" -C "$APP.new" --strip-components=1 || die "vyre.tgz did not unpack"
  fi
  [ -f "$APP.new/core/daemon/main.js" ] || die "the download has no vyred in it; nothing was installed"
  [ "$SYSTEM" = 0 ] || [ -f "$APP.new/core/vyre-core/install-main.js" ] || die "the download has no root installer in it; nothing was installed"
  rm -rf "$APP.old"
  [ ! -d "$APP" ] || mv "$APP" "$APP.old"
  mv "$APP.new" "$APP"
  rm -rf "$APP.old"
  step "Vyre is in $APP"
}

# The one signature check, run twice: here before sudo (a friendly early failure) and again by root
# with the root-owned node, on the root-owned copies, which is the one that counts.
VERIFY_JS='
const c = require("crypto"), f = require("fs");
const [key, sf, gf, mf, tf] = process.argv.slice(1);
const fail = (m) => { console.error(m); process.exit(1); };
const sums = f.readFileSync(sf), sig = f.readFileSync(gf, "utf8").trim();
const pub = c.createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(sig) || !c.verify(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), pub, Buffer.from(sig, "base64"))) fail("the SHA256SUMS signature does not verify");
const want = new Map();
for (const line of sums.toString().split("\n")) {
  if (!line.trim()) continue;
  const m = /^([0-9a-f]{64}) [ *]([^\s\/\\][^\/\\]*)$/i.exec(line);
  if (!m) fail("SHA256SUMS has a line that is not sha256 and a name");
  want.set(m[2], m[1].toLowerCase());
}
const sha = (b) => c.createHash("sha256").update(b).digest("hex");
const mb = f.readFileSync(mf), tb = f.readFileSync(tf);
if (want.get("manifest.json") !== sha(mb) || want.get("vyre.tgz") !== sha(tb)) fail("the download does not match the signed SHA256SUMS");
let j; try { j = JSON.parse(mb.toString()); } catch { fail("the release manifest is not JSON"); }
if (typeof j.version !== "string" || String(j.sha256).toLowerCase() !== sha(tb)) fail("the release manifest does not match the tarball");
console.log(j.version + " " + sha(tb));
'

# verify_release: BEFORE sudo, the signature on SHA256SUMS against the key embedded above, with
# the pinned Node and a check written here (no code from the download), then the tarball against the
# signed manifest. Early, friendly failure only: root repeats the same check (ROOT_SH) with its own node.
verify_release() {
  out=$("$NODE_DIST/bin/node" -e "$VERIFY_JS" "$RELEASE_KEY" "$TMP/release/SHA256SUMS" "$TMP/release/SHA256SUMS.sig" "$TMP/release/manifest.json" "$TMP/release/vyre.tgz") || die "the release did not verify; nothing was installed"
  RELEASE_VERSION=${out%% *}
  TGZ_SHA=${out##* }
  step "release $RELEASE_VERSION is signed by the Vyre release key"
}

# colima_fallback: no Homebrew. Downloads pinned Colima, Lima and (if there is no docker yet) the
# static docker client into TMP, checks every one against its pinned sha256, and only then installs
# them under SERVER_DIR, so a bad download installs nothing. Returns 1 with a plain note if it cannot.
colima_fallback() {
  case "$UNAME_M" in
    arm64|aarch64) ca=arm64; da=aarch64; cs=$COLIMA_SHA256_ARM64; ls=$LIMA_SHA256_ARM64; ds=$DOCKER_SHA256_ARM64 ;;
    x86_64|amd64) ca=x86_64; da=x86_64; cs=$COLIMA_SHA256_AMD64; ls=$LIMA_SHA256_AMD64; ds=$DOCKER_SHA256_AMD64 ;;
    *) say "  note  no pinned Colima for this release ($UNAME_M); agents get no computer until Colima is installed"; return 1 ;;
  esac
  cs=${VYRE_COLIMA_SHA256-$cs}; ls=${VYRE_LIMA_SHA256-$ls}; ds=${VYRE_DOCKER_SHA256-$ds}
  cu=${VYRE_COLIMA_URL:-https://github.com/abiosoft/colima/releases/download/$COLIMA_VERSION/colima-Darwin-$ca}
  lu=${VYRE_LIMA_URL:-https://github.com/lima-vm/lima/releases/download/v$LIMA_VERSION/lima-$LIMA_VERSION-Darwin-$ca.tar.gz}
  du=${VYRE_DOCKER_URL:-https://download.docker.com/mac/static/stable/$da/docker-$DOCKER_VERSION.tgz}
  need_docker=1
  ! command -v docker >/dev/null 2>&1 || need_docker=0
  if [ -z "$cs" ] || [ -z "$ls" ] || { [ "$need_docker" = 1 ] && [ -z "$ds" ]; }; then
    say "  note  no pinned Colima for this release; agents get no computer until Colima is installed"
    return 1
  fi
  say "Downloading Colima and Lima (checked against pinned checksums)..."
  mkdir -p "$TMP/cl"
  curl -fsSL --retry 2 -o "$TMP/cl/colima" "$cu" || { say "  note  could not download Colima"; return 1; }
  curl -fsSL --retry 2 -o "$TMP/cl/lima.tgz" "$lu" || { say "  note  could not download Lima"; return 1; }
  [ "$need_docker" = 0 ] || curl -fsSL --retry 2 -o "$TMP/cl/docker.tgz" "$du" || { say "  note  could not download the docker client"; return 1; }
  [ "$(sha256 "$TMP/cl/colima")" = "$cs" ] || { say "  note  the Colima download does not match its pinned checksum; nothing was installed"; return 1; }
  [ "$(sha256 "$TMP/cl/lima.tgz")" = "$ls" ] || { say "  note  the Lima download does not match its pinned checksum; nothing was installed"; return 1; }
  if [ "$need_docker" = 1 ]; then
    [ "$(sha256 "$TMP/cl/docker.tgz")" = "$ds" ] || { say "  note  the docker client download does not match its pinned checksum; nothing was installed"; return 1; }
  fi
  mkdir -p "$TMP/cl/lima" "$TMP/cl/docker"
  tar -xzf "$TMP/cl/lima.tgz" -C "$TMP/cl/lima" || { say "  note  the Lima download did not unpack; nothing was installed"; return 1; }
  [ -f "$TMP/cl/lima/bin/limactl" ] || { say "  note  the Lima download has no limactl in it; nothing was installed"; return 1; }
  if [ "$need_docker" = 1 ]; then
    tar -xzf "$TMP/cl/docker.tgz" -C "$TMP/cl/docker" || { say "  note  the docker client did not unpack; nothing was installed"; return 1; }
    [ -f "$TMP/cl/docker/docker/docker" ] || { say "  note  the docker download has no client in it; nothing was installed"; return 1; }
  fi
  mkdir -p "$BIN"
  cp "$TMP/cl/colima" "$BIN/colima"; chmod 755 "$BIN/colima"
  rm -rf "$SERVER_DIR/lima"; cp -R "$TMP/cl/lima" "$SERVER_DIR/lima"
  [ "$need_docker" = 0 ] || { cp "$TMP/cl/docker/docker/docker" "$BIN/docker"; chmod 755 "$BIN/docker"; }
  PATH="$BIN:$SERVER_DIR/lima/bin:$PATH"; export PATH
  step "Colima $COLIMA_VERSION and Lima $LIMA_VERSION are in $SERVER_DIR"
}

# write_colima_plist: without brew services, a second LaunchAgent keeps Colima up (vz needs only Lima).
write_colima_plist() {
  p=$AGENTS_DIR/$COLIMA_LABEL.plist
  mkdir -p "$AGENTS_DIR" "$VHOME/logs"
  cat >"$p" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$COLIMA_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$BIN/colima</string><string>start</string><string>--foreground</string>
    <string>--vm-type</string><string>vz</string>
    <string>--cpu</string><string>2</string><string>--memory</string><string>4</string><string>--disk</string><string>40</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$BIN:$SERVER_DIR/lima/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$VHOME/logs/colima.out</string>
  <key>StandardErrorPath</key><string>$VHOME/logs/colima.out</string>
</dict></plist>
EOF
  chmod 644 "$p"
}

# colima_system_args: the start command for the root installer's Colima LaunchDaemon (it runs as
# your account). A launchd job has no PATH worth the name, so it goes through /usr/bin/env with the
# pinned dirs (and the directories of the colima and docker found) in front.
colima_system_args() {
  cbin=$(command -v colima 2>/dev/null || true)
  [ -n "$cbin" ] || cbin=$BIN/colima
  dbin=$(command -v docker 2>/dev/null || true)
  cpath=$BIN:$SERVER_DIR/lima/bin:$(dirname "$cbin")
  [ -z "$dbin" ] || cpath=$cpath:$(dirname "$dbin")
  cpath=$cpath:/usr/bin:/bin:/usr/sbin:/sbin
  COLIMA_ARGS="/usr/bin/env
PATH=$cpath
HOME=$HOME
$cbin
start
--foreground
--vm-type
vz
--cpu
2
--memory
4
--disk
40"
}

# setup_colima: agents' computers run in Colima (open source, headless), never Docker Desktop. An
# existing Docker Desktop is left alone and unused. With Homebrew it installs Colima there; without,
# it downloads pinned, checksummed binaries into SERVER_DIR and keeps Colima up with its own
# LaunchAgent. If neither works it says so and goes on: the server works, agents get no computer.
setup_colima() {
  if [ "$DRY" = 1 ]; then say "would install Colima (agents' computers) and $([ "$SYSTEM" = 1 ] && echo 'hand its start command to the root installer' || echo start it)"; return 0; fi
  if ! command -v colima >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      say "Installing Colima with Homebrew..."
      brew install colima docker >/dev/null 2>&1 || { say "  note  Colima did not install; agents get no computer until it does (brew install colima docker)"; return 0; }
    else
      colima_fallback || return 0
      if [ "$SYSTEM" = 1 ]; then colima_system_args; step "Colima is installed; it starts at boot"; return 0; fi
      write_colima_plist
      uid=$(id -u)
      "$LAUNCHCTL" bootout "gui/$uid/$COLIMA_LABEL" >/dev/null 2>&1 || true
      "$LAUNCHCTL" bootstrap "gui/$uid" "$AGENTS_DIR/$COLIMA_LABEL.plist" || { say "  note  launchctl could not start Colima; run: $BIN/colima start"; return 0; }
      step "Colima is starting (its first start downloads a small Linux image)"
      return 0
    fi
  fi
  if [ "$SYSTEM" = 1 ]; then colima_system_args; step "Colima is installed; it starts at boot"; return 0; fi
  colima start --cpu 2 --memory 4 --disk 40 >/dev/null 2>&1 || { say "  note  Colima did not start; run: colima start"; return 0; }
  brew services start colima >/dev/null 2>&1 || true
  step "Colima is running"
}

# setup_gh: the gh CLI. One already on PATH is used; else Homebrew; else the pinned release zip,
# checked against its sum, into BIN. If none works it says so and goes on: GitHub sign-in waits for gh.
setup_gh() {
  if [ "$DRY" = 1 ]; then say "would make sure the gh CLI is installed (Homebrew, or a pinned download) and give vyred its path"; return 0; fi
  g=$(command -v gh 2>/dev/null || true)
  if [ -z "$g" ] && command -v brew >/dev/null 2>&1; then
    say "Installing gh with Homebrew..."
    brew install gh >/dev/null 2>&1 && g=$(command -v gh 2>/dev/null || true)
  fi
  if [ -z "$g" ]; then
    case "$UNAME_M" in
      arm64|aarch64) ga=arm64; gs=$GH_SHA256_ARM64 ;;
      x86_64|amd64) ga=amd64; gs=$GH_SHA256_AMD64 ;;
      *) say "  note  no pinned gh for this Mac ($UNAME_M); GitHub sign-in needs gh"; return 0 ;;
    esac
    gs=${VYRE_GH_SHA256-$gs}
    gu=${VYRE_GH_URL:-https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_macOS_$ga.zip}
    [ -n "$gs" ] || { say "  note  no pinned gh for this release; GitHub sign-in needs gh"; return 0; }
    say "Downloading gh (checked against its pinned checksum)..."
    curl -fsSL --retry 2 -o "$TMP/gh.zip" "$gu" || { say "  note  could not download gh; GitHub sign-in needs gh"; return 0; }
    [ "$(sha256 "$TMP/gh.zip")" = "$gs" ] || { say "  note  the gh download does not match its pinned checksum; nothing was installed"; return 0; }
    mkdir -p "$TMP/gh-x"
    unzip -q -o "$TMP/gh.zip" -d "$TMP/gh-x" || { say "  note  the gh download did not unpack; nothing was installed"; return 0; }
    gf=$(find "$TMP/gh-x" -type f -name gh -path '*/bin/*' | head -n 1)
    [ -n "$gf" ] || { say "  note  the gh download has no gh in it; nothing was installed"; return 0; }
    mkdir -p "$BIN"; cp "$gf" "$BIN/gh"; chmod 755 "$BIN/gh"
    g=$BIN/gh
  fi
  GH_BIN=$g
  step "gh is $g"
}

# write_env: DOCKER_HOST at Colima's own socket, and the setup code with the time it was written,
# into VYRE_HOME/vyre.env (0600). The rest of the file is kept. The code is never an argument.
write_env() {
  f=$VHOME/vyre.env
  if [ "$DRY" = 1 ]; then say "would write $f (0600)${CODE:+ with the setup code; it is never shown}"; return 0; fi
  mkdir -p "$VHOME"; chmod 700 "$VHOME" 2>/dev/null || true
  : >"$TMP/vyre.env"
  [ ! -f "$f" ] || grep -v -e '^VYRE_SETUP_CODE=' -e '^VYRE_SETUP_CODE_AT=' "$f" >"$TMP/vyre.env" || true
  grep -q '^DOCKER_HOST=' "$TMP/vyre.env" || printf 'DOCKER_HOST=unix://%s/.colima/default/docker.sock\n' "$HOME" >>"$TMP/vyre.env"
  if [ -n "$CODE" ]; then printf 'VYRE_SETUP_CODE_AT=%s\nVYRE_SETUP_CODE=%s\n' "$(date +%s)" "$CODE" >>"$TMP/vyre.env"; fi
  chmod 600 "$TMP/vyre.env"
  cat "$TMP/vyre.env" >"$f.new"; chmod 600 "$f.new"; mv "$f.new" "$f"
  step "settings are in $f"
}

# The wrapper launchd runs. It reads vyre.env line by line (never executes it), drops a setup code
# older than an hour (both lines, so a restart never arms an old one), and runs vyred under
# caffeinate so the Mac stays awake for exactly as long as vyred runs.
write_wrapper() {
  if [ "$DRY" = 1 ]; then say "would write $BIN/vyre-serve and $BIN/vyre"; return 0; fi
  mkdir -p "$BIN"
  WNODE=$(wrapper_node)
  GH_LINE=""; [ -z "$GH_BIN" ] || GH_LINE="export VYRE_GH_BIN=\"$GH_BIN\""
  cat >"$BIN/vyre-serve" <<EOF
#!/bin/sh
# vyre on a Mac server: written by install-mac-server.sh
ENVF="$VHOME/vyre.env"
if [ -f "\$ENVF" ]; then
  at=\$(sed -n 's/^VYRE_SETUP_CODE_AT=\([0-9][0-9]*\)\$/\1/p' "\$ENVF" | head -n 1)
  if [ -n "\$at" ] && [ \$(( \$(date +%s) - at )) -gt 3600 ]; then
    grep -v -e '^VYRE_SETUP_CODE=' -e '^VYRE_SETUP_CODE_AT=' "\$ENVF" >"\$ENVF.new" || true
    cat "\$ENVF.new" >"\$ENVF"; rm -f "\$ENVF.new"
  fi
  while IFS= read -r line || [ -n "\$line" ]; do
    case "\$line" in [A-Z_]*=*) export "\$line" ;; esac
  done <"\$ENVF"
fi
export VYRE_HOME="$VHOME"
$GH_LINE
exec "$CAFF" -ims "$WNODE" "$APP/core/daemon/main.js"
EOF
  cat >"$BIN/vyre" <<EOF
#!/bin/sh
# vyre on a Mac server: written by install-mac-server.sh
export VYRE_HOME="$VHOME"
exec "$WNODE" "$APP/bin/vyre" "\$@"
EOF
  chmod 755 "$BIN/vyre-serve" "$BIN/vyre"
  step "the service wrapper is in $BIN"
}

write_plist() {
  p=$AGENTS_DIR/$LABEL.plist
  if [ "$DRY" = 1 ]; then say "would install the LaunchAgent $p"; return 0; fi
  mkdir -p "$AGENTS_DIR" "$VHOME/logs"
  cat >"$p" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN/vyre-serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$VHOME/logs/vyred.out</string>
  <key>StandardErrorPath</key><string>$VHOME/logs/vyred.out</string>
</dict></plist>
EOF
  chmod 644 "$p"
}

start_service() {
  if [ "$DRY" = 1 ]; then say "would start it with launchctl and wait for vyred to answer"; return 0; fi
  uid=$(id -u)
  "$LAUNCHCTL" bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
  "$LAUNCHCTL" bootstrap "gui/$uid" "$AGENTS_DIR/$LABEL.plist" || die "launchctl could not start Vyre"
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -f "$VHOME/vyred.pid" ] && kill -0 "$(cat "$VHOME/vyred.pid" 2>/dev/null)" 2>/dev/null; then step "vyred is running"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  die "vyred did not start; its output is in $VHOME/logs/vyred.out"
}

# system_install: the one sudo (ROOT_SH above). The root installer's stdout ends with VYRE_CORE_ENROL=<code>. It is
# read into a shell variable that is never printed, written or passed on: the output is captured by
# command substitution, every other line is shown, and the variable is dropped. The Capsule
# enrolment consumes the code in a later step; nothing does yet.
# ROOT_SH is what runs as root, a fixed literal written here and never read from the download. It
# gets the two expected sums as arguments, copies the release files and the Node tarball out of the
# person's folders into a fresh root-owned 0700 folder, hashes the root-owned Node copy, and runs the
# signature check with that node on the ROOT-OWNED COPIES of the release, then extracts with
# /usr/bin/tar and runs the installer from that root-owned tree with that root-owned node.
# Nothing root runs is read again from a path the person can write. (sudo drops the environment, so
# VYRE_ROOT_TMP only reaches this in the tests, whose fake sudo does not.)
ROOT_SH='set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077
nsha=$1; rel=$2; ntgz=$3; key=$4; vjs=$5; shift 5
d=$(mktemp -d "${VYRE_ROOT_TMP:-/private/var/tmp}/vyre-install.XXXXXX")
trap '"'"'rm -rf "$d"'"'"' EXIT
mkdir "$d/rel" "$d/node" "$d/app"
for f in vyre.tgz manifest.json SHA256SUMS SHA256SUMS.sig; do cat "$rel/$f" >"$d/rel/$f"; done
cat "$ntgz" >"$d/node.tgz"
[ "$(shasum -a 256 "$d/node.tgz" | cut -d" " -f1)" = "$nsha" ] || { echo "vyre-install: the Node download changed after it was checked; nothing was installed" >&2; exit 1; }
tar -xzf "$d/node.tgz" -C "$d/node" --strip-components=1 --no-same-owner
nb=$d/node/bin/node
"$nb" -e "$vjs" "$key" "$d/rel/SHA256SUMS" "$d/rel/SHA256SUMS.sig" "$d/rel/manifest.json" "$d/rel/vyre.tgz" >/dev/null || { echo "vyre-install: the release does not verify against the release key; nothing was installed" >&2; exit 1; }
tar -xzf "$d/rel/vyre.tgz" -C "$d/app" --strip-components=1 --no-same-owner
ns=$(shasum -a 256 "$nb" | cut -d" " -f1)
"$nb" "$d/app/core/vyre-core/install-main.js" "$@" --release-dir "$d/rel" --node "$nb" --node-sha256 "$ns"'

system_install() {
  if [ "$DRY" = 1 ]; then say "would run, under one sudo: a fixed root step that copies the verified release into a root-owned folder and runs the installer from there (it asks for your password)"; return 0; fi
  set -- install --owner-uid "$(id -u)" --owner-name "$(id -un)" --owner-home "$HOME" --vyred-wrapper "$BIN/vyre-serve"
  [ -z "$GH_BIN" ] || set -- "$@" --gh-bin "$GH_BIN"
  if [ -n "$COLIMA_ARGS" ]; then
    oldifs=$IFS; IFS='
'
    for a in $COLIMA_ARGS; do set -- "$@" --colima-program "$a"; done
    IFS=$oldifs
  fi
  say "Vyre now asks for your Mac password once, to install its system service."
  # && / || rather than `;`: `set -e` reaches into the substitution in some shells and would end it before the status is read.
  out=$("$SUDO" /bin/sh -c "$ROOT_SH" vyre-root "$NODE_TGZ_SHA" "$TMP/release" "$TMP/node.tgz" "$RELEASE_KEY" "$VERIFY_JS" "$@" && printf 'rc:0' || printf 'rc:%s' "$?")
  rc=${out##*rc:}
  out=${out%rc:*}
  [ "$rc" = 0 ] || { out=""; die "the root installer failed (exit $rc); its message is above"; }
  case "$out" in *VYRE_CORE_ENROL=*) ;; *) out=""; die "the root installer did not finish; nothing was enrolled" ;; esac
  printf '%s\n' "$out" | grep -v '^VYRE_CORE_ENROL=' || true
  out=""
  step "the system service is installed"
}

# wait_system: vyred answers (its pid file, as in login-only) and vyre-core's socket file exists
# (the path is in core.json; it is checked, never connected to).
wait_system() {
  if [ "$DRY" = 1 ]; then say "would wait for vyred and for vyre-core's socket named in $CORE_BASE/core.json"; return 0; fi
  i=0; pid_ok=0; sock_ok=0
  while [ "$i" -lt 90 ]; do
    if [ "$pid_ok" = 0 ] && [ -f "$VHOME/vyred.pid" ] && kill -0 "$(cat "$VHOME/vyred.pid" 2>/dev/null)" 2>/dev/null; then pid_ok=1; step "vyred is running"; fi
    if [ "$sock_ok" = 0 ] && [ -f "$CORE_BASE/core.json" ]; then
      sock=$(sed -n 's/.*"socket" *: *"\([^"]*\)".*/\1/p' "$CORE_BASE/core.json" | head -n 1)
      if [ -n "$sock" ] && [ -e "$sock" ]; then sock_ok=1; step "vyre-core is up"; fi
    fi
    [ "$pid_ok" = 1 ] && [ "$sock_ok" = 1 ] && return 0
    sleep 1; i=$((i + 1))
  done
  [ "$pid_ok" = 1 ] || die "vyred did not start; its output is in $VHOME/logs"
  die "vyre-core did not come up: its socket named in $CORE_BASE/core.json is missing"
}

# system_uninstall: the root installer from the installed tree, with its own node.
system_uninstall() {
  im=${VYRE_INSTALL_MAIN:-$CORE_BASE/current/core/vyre-core/install-main.js}
  if [ ! -f "$im" ]; then say "  note  no system service is installed here"; return 0; fi
  rn=$CORE_BASE/node
  [ -x "$rn" ] || rn=$NODE_DIST/bin/node
  [ -x "$rn" ] || rn=$(command -v node || true)
  [ -n "$rn" ] || die "no Node to run the root installer with"
  say "Vyre now asks for your Mac password once, to remove its system service."
  if [ "$1" = 1 ]; then "$SUDO" "$rn" "$im" uninstall --purge || die "the root uninstaller failed"
  else "$SUDO" "$rn" "$im" uninstall || die "the root uninstaller failed"; fi
  step "the system service is removed"
}

uninstall() {
  if [ "$DRY" = 1 ]; then
    [ "$SYSTEM" = 0 ] || say "would run the root uninstaller under one sudo"
    say "would stop the service and remove $AGENTS_DIR/$LABEL.plist, $SERVER_DIR"; [ "$PURGE" = 0 ] || say "and, asking first, $VHOME"; return 0
  fi
  ok=0
  if [ "$PURGE" = 1 ]; then
    ok=$YES
    if [ "$ok" = 0 ]; then printf 'Delete %s, your Vyre data%s? Type delete: ' "$VHOME" "$([ "$SYSTEM" = 1 ] && echo ' and Vyre'"'"'s system data')"; read -r a </dev/tty || a=""; [ "$a" = delete ] && ok=1; fi
  fi
  [ "$SYSTEM" = 0 ] || system_uninstall "$ok"
  "$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  "$LAUNCHCTL" bootout "gui/$(id -u)/$COLIMA_LABEL" >/dev/null 2>&1 || true
  rm -f "$AGENTS_DIR/$LABEL.plist" "$AGENTS_DIR/$COLIMA_LABEL.plist"
  rm -rf "$SERVER_DIR"
  if [ "$PURGE" = 1 ]; then
    if [ "$ok" = 1 ]; then rm -rf "$VHOME"; say "your data is deleted"; else say "your data is kept in $VHOME"; fi
  else say "your data is kept in $VHOME"; fi
  say "Vyre is off this Mac. Colima and Node were left as they are: brew services stop colima, if you want it off too."
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --yes) YES=1 ;;
      --login-only) SYSTEM=0 ;;
      --from) shift; FROM=${1:-}; [ -d "$FROM" ] || die "--from needs a folder" ;;
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      --code|--code=*) die "the setup code is never a command-line argument, because a process list shows arguments; it comes in VYRE_CODE" ;;
      -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  [ "$PURGE" = 0 ] || [ "$UNINSTALL" = 1 ] || die "--purge goes with --uninstall"
  [ "$UNAME_S" = Darwin ] || die "this installer is for a Mac; on Linux use the Docker install line"
  [ "$(id -u)" != 0 ] || die "run this as your own account, not root: Vyre never runs as root here"
  [ -z "$FROM" ] || [ "$SYSTEM" = 0 ] || [ "$UNINSTALL" = 1 ] || die "--from installs a checkout, which has no signed release for the system service to verify; add --login-only to install it for your own account"
  TMP=$(mktemp -d)
  trap cleanup EXIT
  if [ "$UNINSTALL" = 1 ]; then uninstall; return 0; fi
  say "Installing Vyre on this Mac as your server."
  preflight
  install_app
  setup_colima
  setup_gh
  write_env
  write_wrapper
  if [ "$SYSTEM" = 1 ]; then
    system_install
    wait_system
    say "Vyre is running. Back in your browser, it will find this Mac."
    say "It starts when this Mac boots, with nobody signed in, and stays awake while it runs. Its command is $BIN/vyre"
  else
    write_plist
    start_service
    say "Vyre is running. Back in your browser, it will find this Mac."
    say "It starts when you sign in to this Mac and stays awake while it runs. Its command is $BIN/vyre"
  fi
}

main "$@"
