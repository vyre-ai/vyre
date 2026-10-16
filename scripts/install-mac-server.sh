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
STARTED=0
SYS_RAN=0
PATH_ADDED=0
BUSY=0
CODE=${VYRE_CODE:-}
unset VYRE_CODE
# The release files come from VYRE_BOX_URL, else from `box-url` beside this script (a prerelease app names its own tag's release assets there, the
# rc channel; the files are verified against the pinned release key either way, so the URL chooses a source and never a trust), else vyre.run/box.
_here=""; [ -f "$0" ] && _here=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
_boxurl=""; [ -n "$_here" ] && [ -f "$_here/box-url" ] && _boxurl=$(sed -n '1p' "$_here/box-url" | tr -d '\r')
case "$_boxurl" in https://*/) ;; *) _boxurl="" ;; esac
BASE=${VYRE_BOX_URL:-${_boxurl:-https://vyre.run/box/}}
# Overridable for tests only.
UNAME_S=${VYRE_UNAME_S:-$(uname -s)}
UNAME_M=${VYRE_UNAME_M:-$(uname -m)}
LAUNCHCTL=${VYRE_LAUNCHCTL:-launchctl}
FDESETUP=${VYRE_FDESETUP:-/usr/bin/fdesetup}
SUDO=${VYRE_SUDO:-sudo}
CORE_BASE=${VYRE_CORE_BASE:-/Library/Application Support/Vyre}
VHOME=${VYRE_HOME:-$HOME/.vyre}
SERVER_DIR=${VYRE_SERVER_DIR:-$HOME/.vyre-server}
CMD_DIR=$SERVER_DIR/cmd
AGENTS_DIR=${VYRE_LAUNCHAGENTS:-$HOME/Library/LaunchAgents}
# Where the PATH line goes so every shell finds `vyre`: ~/.zshenv (zsh reads it for login, interactive and script shells alike), and ~/.bash_profile when bash is the person's shell or the file exists.
# VYRE_PROFILE names the one file instead, for tests.
if [ -n "${VYRE_PROFILE:-}" ]; then PROFILE_FILES=$VYRE_PROFILE
else
  PROFILE_FILES=$HOME/.zshenv
  case "${SHELL:-}" in */bash) PROFILE_FILES="$PROFILE_FILES
$HOME/.bash_profile" ;; *) [ ! -f "$HOME/.bash_profile" ] || PROFILE_FILES="$PROFILE_FILES
$HOME/.bash_profile" ;; esac
fi
# one file per line, so a home folder with a space in its path works
NL='
'
PROFILE_FILE=${PROFILE_FILES%%"$NL"*}
profile_names() { printf '%s' "$PROFILE_FILES" | tr '\n' ' '; }
# folders already on a Mac's PATH where the vyre command is linked when the person can write there (Homebrew's); VYRE_LINK_DIRS overrides, for tests
LINK_DIRS=${VYRE_LINK_DIRS-/opt/homebrew/bin /usr/local/bin}
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

# The built-in network on a Mac server (core/wink/netd.js): Headscale and the Wink node program run NATIVELY beside vyred, not in the Colima VM (netd supervises them over
# unix sockets and files, which do not cross the VM boundary). Headscale: the pinned darwin release binary, sums from headscale_0.29.4's checksums.txt in the release itself.
# The node program (wink-forwarder) is a first-party file of the signed release, wink-forwarder-darwin-<arch>, listed in SHA256SUMS like every other.
# VYRE_HEADSCALE_URL / _SHA256 and VYRE_FORWARDER_FILE override, for tests.
HEADSCALE_VERSION=0.29.4
HEADSCALE_SHA256_ARM64=b5cfd0f81caaa1e8f71f830fd89fdf86a8719bb6e9f9a2ec5b47d9426c96986e
HEADSCALE_SHA256_AMD64=06e4c94a8b9397ed8c2714a4cd484c998604dc884e9b5d4a186aef05f14047b1
HEADSCALE_BIN=""
FORWARDER_BIN=""

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
# phase TITLE: the next numbered step, the same five as install-box.sh: "[1/5] Checking this Mac".
PHASE=0
phase() { PHASE=$((PHASE + 1)); [ "$PHASE" = 1 ] || say ""; say "[$PHASE/5] $1"; }
# cleanup: the temp folder always goes. A run that stopped half way says exactly what it left (only what was not there when it began) and one command that removes it.
cleanup() {
  rc=$?
  [ -z "$TMP" ] || rm -rf "$TMP"
  if [ "$rc" != 0 ] && [ "$STARTED" = 1 ] && [ "$UNINSTALL" = 0 ] && [ "$DRY" = 0 ]; then report_left; fi
  return 0
}

# snapshot_before: what already exists, so a failed install never claims or removes the person's own folders.
snapshot_before() {
  PRE_SERVER=0; [ ! -e "$SERVER_DIR" ] || PRE_SERVER=1
  PRE_VHOME=0; [ ! -e "$VHOME" ] || PRE_VHOME=1
  PRE_COLIMA=0; [ ! -e "$HOME/.colima" ] || PRE_COLIMA=1
  PRE_LIMA=0; [ ! -e "$HOME/.lima" ] || PRE_LIMA=1
  PRE_PLIST=0; [ ! -e "$AGENTS_DIR/$LABEL.plist" ] && [ ! -e "$AGENTS_DIR/$COLIMA_LABEL.plist" ] || PRE_PLIST=1
  PRE_SYSTEM=0; [ ! -f "$CORE_BASE/core.json" ] || PRE_SYSTEM=1
  STARTED=1
}

report_left() {
  left=""; cmd=""
  if [ "$PRE_PLIST" = 0 ]; then
    for l in "$LABEL" "$COLIMA_LABEL"; do
      [ -e "$AGENTS_DIR/$l.plist" ] || continue
      left="$left $AGENTS_DIR/$l.plist"; cmd="$cmd$LAUNCHCTL bootout gui/$(id -u)/$l >/dev/null 2>&1; rm -f '$AGENTS_DIR/$l.plist'; "
    done
  fi
  if [ "$PRE_COLIMA" = 0 ] && [ -e "$HOME/.colima" ]; then
    [ ! -x "$BIN/colima" ] || cmd="$cmd'$BIN/colima' delete --force >/dev/null 2>&1; "
    left="$left $HOME/.colima"; cmd="$cmd""rm -rf '$HOME/.colima'; "
  fi
  if [ "$PRE_LIMA" = 0 ] && [ -e "$HOME/.lima" ]; then left="$left $HOME/.lima"; cmd="$cmd""rm -rf '$HOME/.lima'; "; fi
  if [ "$PRE_SERVER" = 0 ] && [ -e "$SERVER_DIR" ]; then left="$left $SERVER_DIR"; cmd="$cmd""rm -rf '$SERVER_DIR'; "; fi
  if [ "$PRE_VHOME" = 0 ] && [ -e "$VHOME" ]; then left="$left $VHOME"; cmd="$cmd""rm -rf '$VHOME'; "; fi
  if [ "$SYS_RAN" = 1 ] && [ "$PRE_SYSTEM" = 0 ]; then
    left="$left the system service (its LaunchDaemons and the _vyre account)"
    if [ -f "$0" ]; then cmd="$cmd""sh '$0' --uninstall --yes; "; else cmd="$cmd""curl -fsSL ${BASE}install-mac-server.sh | sh -s -- --uninstall --yes; "; fi
  fi
  if [ "$PATH_ADDED" = 1 ]; then left="$left the vyre command (a line in $(profile_names))"; fi
  printf '\nvyre: the install did not finish.\n' >&2
  if [ -z "$left" ]; then printf '  Nothing was left on this Mac.\n' >&2; return 0; fi
  printf '  It left:%s\n  To remove all of it, run this one line:\n\n  %s\n\n  Then run the install line again.\n' "$left" "${cmd%; }" >&2
}

# store_gate: Records is always on (the same rule as install-box.sh). VYRE_STORE unset or auto is Records; sqlite (the small built-in store) is only for the CI install proof (VYRE_PROOF_BUILTIN_STORE=1), never offered.
store_gate() {
  case "${VYRE_STORE:-auto}" in
    auto) ;;
    sqlite) [ "${VYRE_PROOF_BUILTIN_STORE:-0}" = 1 ] || die "Vyre always uses Records, so VYRE_STORE=sqlite is not a choice any more. Run the install line again without VYRE_STORE (or with VYRE_STORE=auto)." ;;
    *) die "VYRE_STORE is auto (Records), not ${VYRE_STORE}. Run the install line again without it." ;;
  esac
}

# memory_gate: Records (Twenty, Postgres, Redis) and agents' computers run in Colima. Under about 4 GB the Mac cannot host them, and that is said before anything is laid out. VYRE_RAM_BYTES is for tests;
# a Mac whose memory cannot be read is not refused.
memory_gate() {
  ram=${VYRE_RAM_BYTES:-$(sysctl -n hw.memsize 2>/dev/null || true)}
  case "$ram" in ''|*[!0-9]*) return 0 ;; esac
  mb=$((ram / 1048576))
  if [ "$mb" -ge "${VYRE_MIN_MEM_MB:-3500}" ]; then
    [ "$mb" -ge "${VYRE_REC_MEM_MB:-7500}" ] || say "  note  This Mac has $((mb / 1024)) GB of memory. Vyre works, with room for one space; 8 GB or more is recommended."
    return 0
  fi
  if [ "$DRY" = 1 ]; then say "would stop: Vyre needs at least 4 GB of memory, 8 GB recommended ($mb MB here)."; return 0; fi
  die "Vyre needs at least 4 GB of memory, 8 GB recommended. This Mac has $mb MB. Use a larger server, then run this again."
}

# free_kb DIR: kilobytes free on the disk DIR is on (VYRE_FREE_KB is for tests).
free_kb() {
  [ -z "${VYRE_FREE_KB:-}" ] || { printf '%s' "$VYRE_FREE_KB"; return 0; }
  df -k "$1" 2>/dev/null | awk 'NR==2 { print $4 }'
}

# disk_gate: Vyre, its Linux image and its downloads need room. A full disk shows up as a curl write failure half way through, so it is checked first.
disk_gate() {
  need=${VYRE_MIN_FREE_KB:-4194304}
  for d in "$TMP" "$HOME"; do
    f=$(free_kb "$d"); case "$f" in ''|*[!0-9]*) continue ;; esac
    [ "$f" -ge "$need" ] || die "this Mac has only $((f / 1024)) MB free and Vyre needs about $((need / 1024)) MB (its downloads and its Linux image). Free some space, then run this line again."
  done
}

# dl URL DEST: a download that says why when it fails (a folder that is missing or not writable, or a full disk), not only curl's code.
dl() {
  curl -fsSL --retry 2 -o "$2" "$1" && return 0
  dd=$(dirname "$2")
  if [ ! -d "$dd" ]; then say "  note  the folder $dd does not exist, so the download of $1 could not be saved"
  elif [ ! -w "$dd" ]; then say "  note  the folder $dd is not writable, so the download of $1 could not be saved"
  else
    f=$(free_kb "$dd"); case "$f" in ''|*[!0-9]*) f="" ;; esac
    if [ -n "$f" ] && [ "$f" -lt 524288 ]; then say "  note  this Mac is nearly out of disk space ($((f / 1024)) MB free in $dd), so the download of $1 could not be saved"
    else say "  note  the download of $1 failed"; fi
  fi
  return 1
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else die "need shasum or sha256sum to verify downloads"; fi
}

fetch() {
  case "$BASE" in
    file://*) cp "${BASE#file://}$1" "$2" 2>/dev/null || die "could not read $BASE$1" ;;
    *) dl "$BASE$1" "$2" || die "could not download $BASE$1" ;;
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
  dl "$nu" "$TMP/node.tgz" || die "could not download $nu"
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

# filevault_gate: a Mac with FileVault on waits at the login window after any unplanned restart (a power cut, a crash) and runs nothing until someone types the password, so a server on it is offline until a
# person is there (a Mac mini server was offline for exactly this reason). Checked BEFORE anything is installed. The installer stops, in plain words, and goes on only when the line was run with
# VYRE_ACCEPT_FILEVAULT=1. It never changes FileVault itself. Whether automatic login is set is read too (FileVault turns it off, so it is said, not relied on).
filevault_gate() {
  [ "$SYSTEM" = 1 ] || return 0
  fv=$("$FDESETUP" status 2>/dev/null || true)
  case "$fv" in *"FileVault is On"*) ;; *) return 0 ;; esac
  auto=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)
  say ""
  say "  FileVault is on. After a power cut or a restart this Mac will wait for someone to type the password, and Vyre will be offline until then. For a server, turn FileVault off in System Settings, Privacy and Security, then run this line again. To keep FileVault anyway, run the line with VYRE_ACCEPT_FILEVAULT=1."
  if [ -z "$auto" ]; then say "  (Automatic login is not set, and FileVault does not allow it.)"; fi
  say ""
  if [ "${VYRE_ACCEPT_FILEVAULT:-}" = 1 ]; then say "  going on, because VYRE_ACCEPT_FILEVAULT=1"; return 0; fi
  if [ "$DRY" = 1 ]; then say "would stop here unless VYRE_ACCEPT_FILEVAULT=1"; return 0; fi
  die "stopped before installing anything: FileVault is on (see above)"
}

preflight() {
  [ "$UNAME_S" = Darwin ] || die "this installer is for a Mac; on Linux use the Docker install line"
  [ "$(id -u)" != 0 ] || die "run this as your own account, not root: Vyre never runs as root here"
  if [ "$SYSTEM" = 1 ]; then
    fetch_node
  elif [ -n "${VYRE_NODE_URL:-}" ]; then
    # The Mac app bundles the pinned Node and names it here: use it as the system install does (same
    # checksum, same place under Vyre's own folder), so nobody has to install Node first.
    fetch_node
    if [ "$DRY" = 0 ]; then PATH="$NODE_DIST/bin:$PATH"; export PATH; node_ok || die "the bundled Node does not run on this Mac"; fi
  elif ! node_ok; then
    if command -v brew >/dev/null 2>&1; then
      if [ "$DRY" = 1 ]; then say "would install Node 22 with Homebrew"
      else say "Installing Node 22 with Homebrew..."; brew install node@22 >/dev/null 2>&1 || die "brew could not install node@22"
        PATH="$(brew --prefix node@22)/bin:$PATH"; export PATH; node_ok || die "Node 22.5 or newer is still missing"
      fi
    else die "Vyre needs Node 22.5 or newer. Install it from https://nodejs.org, then run this line again."; fi
  fi
  if [ -n "$CODE" ]; then
    printf '%s' "$CODE" | grep -Eq '^[A-Za-z0-9_-]{43}$|^[A-Za-z0-9_-]{199}$' \
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
    # The release's signed list of first-party modules (modules.json), when it has one: it is a line of the signed SHA256SUMS, checked by get like every file.
    if awk '$2 == "modules.json" || $2 == "*modules.json" { x = 1 } END { exit !x }' "$TMP/SHA256SUMS"; then get modules.json; fi
    if awk '$2 == "appbuild.json" || $2 == "*appbuild.json" { x = 1 } END { exit !x }' "$TMP/SHA256SUMS"; then get appbuild.json; fi
    mkdir -p "$TMP/release"
    mv "$TMP/vyre.tgz" "$TMP/manifest.json" "$TMP/SHA256SUMS.sig" "$TMP/release/"; mv "$TMP/sums" "$TMP/release/SHA256SUMS"
    [ ! -f "$TMP/modules.json" ] || mv "$TMP/modules.json" "$TMP/release/modules.json"
    [ ! -f "$TMP/appbuild.json" ] || mv "$TMP/appbuild.json" "$TMP/release/appbuild.json"
    verify_release
    tar -xzf "$TMP/release/vyre.tgz" -C "$APP.new" --strip-components=1 || die "vyre.tgz did not unpack"
    # The three signed files go to the package root, where the kernel reads them (kernel/modules/release-list.js); verify_release has just checked the signature.
    for f in SHA256SUMS SHA256SUMS.sig modules.json appbuild.json; do [ -f "$TMP/release/$f" ] && cp "$TMP/release/$f" "$APP.new/$f"; done
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
  step "The download matches Vyre's signature"
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
  # The server install always uses its own pinned docker, whatever the person has (their Docker Desktop and Homebrew copies are never touched or used); the light --login-only install keeps theirs.
  [ "$SYSTEM" = 1 ] || ! command -v docker >/dev/null 2>&1 || need_docker=0
  if [ -z "$cs" ] || [ -z "$ls" ] || { [ "$need_docker" = 1 ] && [ -z "$ds" ]; }; then
    say "  note  no pinned Colima for this release; agents get no computer until Colima is installed"
    return 1
  fi
  say "Downloading Colima and Lima (checked against pinned checksums)..."
  mkdir -p "$TMP/cl"
  dl "$cu" "$TMP/cl/colima" || { say "  note  could not download Colima"; return 1; }
  dl "$lu" "$TMP/cl/lima.tgz" || { say "  note  could not download Lima"; return 1; }
  [ "$need_docker" = 0 ] || dl "$du" "$TMP/cl/docker.tgz" || { say "  note  could not download the docker client"; return 1; }
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
    <string>$BIN/vyre-runtime</string><string>run</string>
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

# write_runtime_helper: the account's own `vyre-runtime` in BIN, the one place Colima's VM size is decided and applied (the formula lives only here).
#   vyre-runtime run             what the Colima job runs: start Colima in the foreground at the size in <VYRE_HOME>/colima-size.env
#   vyre-runtime start           the same without the job (a Mac that runs Colima under brew services)
#   vyre-runtime room N          JSON: can this Mac host N spaces? { ok, spaces, cpus, memory_gib, max_spaces, message }
#   vyre-runtime resize N        make room for N spaces: prints "Making room for a new space", writes the size, restarts Colima (its job relaunches it at the new size)
# Memory is 2 GiB plus 2.5 GiB per space (rounded up, never under 4 GiB, the size Colima had before), capped at half of the Mac's RAM; 2 CPUs, 4 on a Mac with 8 or more
# cores; the disk stays 40 GiB (it is sparse). Nothing here needs root: Colima runs as the account, so its job is told to run this file and the size is a file the account owns.
write_runtime_helper() {
  mkdir -p "$BIN"
  cat >"$BIN/vyre-runtime" <<'EOF'
#!/bin/sh
set -eu
VHOME=${VYRE_HOME:-$HOME/.vyre}
SIZEF=$VHOME/colima-size.env
GIB=1073741824
ram=${VYRE_RAM_BYTES:-$(sysctl -n hw.memsize 2>/dev/null || echo 0)}
cores=${VYRE_CORES:-$(sysctl -n hw.ncpu 2>/dev/null || echo 2)}

# size N: sets CPUS, MEM (GiB), MAX (spaces this Mac can host), OK (1 when N fits under the cap)
size() {
  n=$1; [ "$n" -ge 1 ] 2>/dev/null || n=1
  gib=$((ram / GIB)); cap=$((gib / 2))
  CPUS=2; [ "$cores" -lt 8 ] || CPUS=4
  need=$((2 + (5 * n + 1) / 2)); [ "$need" -ge 4 ] || need=4
  if [ "$cap" -ge "$need" ]; then MEM=$need; OK=1; else MEM=$cap; OK=0; fi
  MAX=0; [ "$cap" -lt 2 ] || MAX=$(( (cap - 2) * 2 / 5 ))
  [ "$MEM" -ge 1 ] || MEM=1
}
# the spaces the VM was last sized for (1 before any is recorded)
spaces_now() { n=1; [ ! -f "$SIZEF" ] || n=$(sed -n 's/^SPACES=//p' "$SIZEF" | head -n 1); [ "$n" -ge 1 ] 2>/dev/null || n=1; echo "$n"; }
# JOB=1 means a launchd job runs Colima (`run`), so stopping Colima is the restart; JOB=0 means nothing relaunches it and `resize` starts it itself.
job_now() { j=0; [ ! -f "$SIZEF" ] || j=$(sed -n 's/^JOB=//p' "$SIZEF" | head -n 1); [ "$j" = 1 ] && echo 1 || echo 0; }
write_size() { mkdir -p "$VHOME"; printf 'SPACES=%s\nCPUS=%s\nMEMORY=%s\nDISK=40\nJOB=%s\n' "$1" "$CPUS" "$MEM" "${2:-$(job_now)}" >"$SIZEF.new"; mv "$SIZEF.new" "$SIZEF"; }
read_size() { CPUS=$(sed -n 's/^CPUS=//p' "$SIZEF" | head -n 1); MEM=$(sed -n 's/^MEMORY=//p' "$SIZEF" | head -n 1); }

case "${1:-}" in
  run|start)
    jobflag=0; [ "$1" != run ] || jobflag=1
    if [ -f "$SIZEF" ]; then read_size; else size 1; write_size 1 "$jobflag"; fi
    [ "$1" = run ] || exec colima start --cpu "$CPUS" --memory "$MEM" --disk 40
    # The job's own run. Stopping Colima for a resize ends the foreground `colima start` with exit 0, and launchd does not relaunch a job that exits 0, so this loop does it:
    # a restart flag left by `resize` means "start again at the size now on file"; anything else is the end of the job with Colima's own exit code (0: someone stopped it).
    while :; do
      read_size
      colima start --foreground --vm-type vz --cpu "$CPUS" --memory "$MEM" --disk 40 &
      pid=$!
      trap 'kill "$pid" 2>/dev/null' TERM INT
      rc=0; wait "$pid" || rc=$?
      trap - TERM INT
      if [ -f "$VHOME/colima-restart" ]; then rm -f "$VHOME/colima-restart"; continue; fi
      exit "$rc"
    done
    ;;
  room|resize)
    n=${2:-}; [ "$n" -ge 1 ] 2>/dev/null || { echo "usage: vyre-runtime $1 <spaces>" >&2; exit 2; }
    size "$n"
    if [ "$OK" = 1 ]; then msg="This Mac has room for $n spaces."
    else msg="This Mac has room for $MAX spaces. Another would need more memory than half of this Mac's RAM, so put it on your server instead."; fi
    json=$(printf '{"ok":%s,"spaces":%s,"cpus":%s,"memory_gib":%s,"max_spaces":%s,"message":"%s"}' "$([ "$OK" = 1 ] && echo true || echo false)" "$n" "$CPUS" "$MEM" "$MAX" "$msg")
    if [ "$1" = room ]; then echo "$json"; if [ "$OK" = 1 ]; then exit 0; else exit 3; fi; fi
    if [ "$OK" != 1 ]; then echo "$json"; exit 3; fi
    if [ -f "$SIZEF" ] && [ "$(sed -n 's/^MEMORY=//p' "$SIZEF" | head -n 1)" = "$MEM" ] && [ "$(sed -n 's/^CPUS=//p' "$SIZEF" | head -n 1)" = "$CPUS" ]; then
      write_size "$n"; echo "$json"; exit 0
    fi
    echo "Making room for a new space"
    write_size "$n"
    # Stopping Colima is the restart: its job (the LaunchDaemon, the LaunchAgent) brings it back through `run` at the size just written. Without a job (brew services) start it here.
    [ "$(job_now)" != 1 ] || : >"$VHOME/colima-restart"
    colima stop >/dev/null 2>&1 || true
    if [ "$(job_now)" = 1 ]; then i=0; until colima status >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 30 ] || break; sleep 2; done; fi
    colima status >/dev/null 2>&1 || colima start --cpu "$CPUS" --memory "$MEM" --disk 40 >/dev/null 2>&1 || { echo "$json" | sed 's/"ok":true/"ok":false/'; exit 4; }
    echo "$json"
    ;;
  *) echo "usage: vyre-runtime run | start | room <spaces> | resize <spaces>" >&2; exit 2 ;;
esac
EOF
  chmod 755 "$BIN/vyre-runtime"
}

# colima_system_args: the start command for the root installer's Colima LaunchDaemon (it runs as
# your account). A launchd job has no PATH worth the name, so it goes through /usr/bin/env with the
# pinned dirs (and the directories of the colima and docker found) in front.
colima_system_args() {
  # Vyre's own folder only: the pinned colima, lima and docker, then the system's.
  cpath=$BIN:$SERVER_DIR/lima/bin:/usr/bin:/bin:/usr/sbin:/sbin
  COLIMA_ARGS="/usr/bin/env
PATH=$cpath
HOME=$HOME
$BIN/vyre-runtime
run"
}

# setup_colima: agents' computers run in Colima (open source, headless), never Docker Desktop. An
# existing Docker Desktop is left alone and unused. With Homebrew it installs Colima there; without,
# it downloads pinned, checksummed binaries into SERVER_DIR and keeps Colima up with its own
# LaunchAgent. If neither works it says so and goes on: the server works, agents get no computer.
setup_colima() {
  if [ "$DRY" = 1 ]; then say "would install Colima (agents' computers) and $([ "$SYSTEM" = 1 ] && echo 'hand its start command to the root installer' || echo start it)"; return 0; fi
  write_runtime_helper
  # The server install always uses Vyre's own pinned, checksummed Colima, Lima and docker in its own folder: never `brew install` (unpinned), never the person's copies. A piece that cannot be
  # installed is a note with its fix (agents get no computer until it is), and the service still installs.
  # A VM Vyre will make is Vyre's to remove: noted now, while ~/.colima is known not to be the person's own. A reinstall keeps the note.
  if [ "$PRE_COLIMA" = 0 ] && [ "$PRE_LIMA" = 0 ]; then mkdir -p "$SERVER_DIR"; : >"$SERVER_DIR/colima-made"; fi
  if [ "$SYSTEM" = 1 ]; then
    colima_fallback || return 0
    colima_system_args; step "Colima is installed; it starts at boot"; return 0
  fi
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
  "$BIN/vyre-runtime" start >/dev/null 2>&1 || { say "  note  Colima did not start; run: $BIN/vyre-runtime start"; return 0; }
  brew services start colima >/dev/null 2>&1 || true
  step "Colima is running"
}

# setup_gh: the gh CLI. One already on PATH is used; else the pinned release zip (never Homebrew), checked against its
# sum, into Vyre's own bin. If none works it says so and goes on: GitHub sign-in waits for gh.
setup_gh() {
  if [ "$DRY" = 1 ]; then say "would make sure the gh CLI is installed (already on PATH, or a pinned, checksummed download into Vyre's own bin) and give vyred its path"; return 0; fi
  g=$(command -v gh 2>/dev/null || true)
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
    dl "$gu" "$TMP/gh.zip" || { say "  note  could not download gh; GitHub sign-in needs gh"; return 0; }
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

# setup_wink_net: Headscale and the Wink node program, for the built-in network. Either missing is not fatal: netd then says "no-binary" and the relay carries everything,
# which is correct; the person is told which one is missing.
setup_wink_net() {
  if [ "$DRY" = 1 ]; then say "would put the pinned Headscale and the release's wink-forwarder into Vyre's own bin (the built-in network; without them the relay carries everything)"; return 0; fi
  case "$UNAME_M" in
    arm64|aarch64) ha=arm64; hs=$HEADSCALE_SHA256_ARM64; fa=arm64 ;;
    x86_64|amd64) ha=amd64; hs=$HEADSCALE_SHA256_AMD64; fa=amd64 ;;
    *) say "  note  no pinned Headscale for this Mac ($UNAME_M); the relay carries everything"; return 0 ;;
  esac
  hs=${VYRE_HEADSCALE_SHA256-$hs}
  hu=${VYRE_HEADSCALE_URL:-https://github.com/juanfont/headscale/releases/download/v$HEADSCALE_VERSION/headscale_${HEADSCALE_VERSION}_darwin_$ha}
  if [ -z "$hs" ]; then say "  note  no pinned Headscale for this release; the relay carries everything"
  elif ! dl "$hu" "$TMP/headscale"; then say "  note  could not download Headscale; the relay carries everything"
  elif [ "$(sha256 "$TMP/headscale")" != "$hs" ]; then say "  note  the Headscale download does not match its pinned checksum; nothing was installed"
  else
    mkdir -p "$BIN"; cp "$TMP/headscale" "$BIN/headscale"; chmod 755 "$BIN/headscale"; HEADSCALE_BIN=$BIN/headscale
    step "Headscale $HEADSCALE_VERSION is $HEADSCALE_BIN"
  fi
  fname=wink-forwarder-darwin-$fa
  if [ -n "${VYRE_FORWARDER_FILE:-}" ]; then
    # a file you built yourself (a checkout install): used as it is, and said so
    if [ -f "$VYRE_FORWARDER_FILE" ]; then mkdir -p "$BIN"; cp "$VYRE_FORWARDER_FILE" "$BIN/wink-forwarder"; chmod 755 "$BIN/wink-forwarder"; FORWARDER_BIN=$BIN/wink-forwarder; step "the node program is $FORWARDER_BIN (your own build)"
    else say "  note  VYRE_FORWARDER_FILE is not a file; the relay carries everything"; fi
  elif [ -f "$TMP/SHA256SUMS" ] && awk -v p="$fname" '$2 == p || $2 == "*" p { x = 1 } END { exit !x }' "$TMP/SHA256SUMS"; then
    get "$fname"; mkdir -p "$BIN"; cp "$TMP/$fname" "$BIN/wink-forwarder"; chmod 755 "$BIN/wink-forwarder"; FORWARDER_BIN=$BIN/wink-forwarder
    step "the node program is $FORWARDER_BIN (from the signed release)"
  else
    say "  note  this release has no node program for this Mac ($fname); the relay carries everything"
  fi
}

# write_env: DOCKER_HOST at Colima's own socket, and the setup code with the time it was written,
# into VYRE_HOME/vyre.env (0600). The rest of the file is kept. The code is never an argument.
write_env() {
  f=$VHOME/vyre.env
  if [ "$DRY" = 1 ]; then say "would write $f (0600)${CODE:+ with the setup code; it is never shown}"; return 0; fi
  mkdir -p "$VHOME"; chmod 700 "$VHOME" 2>/dev/null || true
  : >"$TMP/vyre.env"
  [ ! -f "$f" ] || grep -v -e '^VYRE_SETUP_CODE=' -e '^VYRE_SETUP_CODE_AT=' "$f" >"$TMP/vyre.env" || true
  # The Records choice from the install line (VYRE_STORE=auto is Records, sqlite is the small built-in store). A choice named now replaces an older one; none named keeps it, or takes auto.
  if [ -n "${VYRE_STORE:-}" ]; then grep -v '^VYRE_STORE=' "$TMP/vyre.env" >"$TMP/vyre.env.x" || true; cat "$TMP/vyre.env.x" >"$TMP/vyre.env"; fi
  grep -q '^VYRE_STORE=' "$TMP/vyre.env" || printf 'VYRE_STORE=%s\n' "${VYRE_STORE:-auto}" >>"$TMP/vyre.env"
  grep -q '^DOCKER_HOST=' "$TMP/vyre.env" || printf 'DOCKER_HOST=unix://%s/.colima/default/docker.sock\n' "$HOME" >>"$TMP/vyre.env"
  if [ -n "$CODE" ]; then printf 'VYRE_SETUP_CODE_AT=%s\nVYRE_SETUP_CODE=%s\n' "$(date +%s)" "$CODE" >>"$TMP/vyre.env"; fi
  chmod 600 "$TMP/vyre.env"
  cat "$TMP/vyre.env" >"$f.new"; chmod 600 "$f.new"; mv "$f.new" "$f"
  step "settings are in $f"
}

# write_machine: this install is a server, so vyred must come up as one (config.json "machine": "server", the same job the Linux box has by default). Without it a Mac comes up as a
# solo Home: no wink.server.code, and only the fixed personal record types. A machine the person already chose is kept as it is; the rest of the file is kept too.
write_machine() {
  f=$VHOME/config.json
  if [ "$DRY" = 1 ]; then say "would set machine to server in $f"; return 0; fi
  mkdir -p "$VHOME"; chmod 700 "$VHOME" 2>/dev/null || true
  if [ ! -f "$f" ]; then
    printf '{\n  "machine": "server"\n}\n' >"$f.new"
  else
    "$(wrapper_node)" -e 'const fs=require("fs");const f=process.argv[1];let c;try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{process.stderr.write("vyre: "+f+" is not valid JSON; fix or remove it, then run this line again\n");process.exit(1)}if(c===null||typeof c!=="object"||Array.isArray(c)){process.stderr.write("vyre: "+f+" is not a JSON object\n");process.exit(1)}if(c.machine===undefined&&c.role===undefined)c.machine="server";fs.writeFileSync(f+".new",JSON.stringify(c,null,2)+"\n")' "$f" || die "could not set this Mac up as a server in $f"
  fi
  chmod 600 "$f.new"; mv "$f.new" "$f"
  step "this Mac is set up as a server ($f)"
}

# The wrapper launchd runs. It reads vyre.env line by line (never executes it), drops a setup code
# older than an hour (both lines, so a restart never arms an old one), and runs vyred under
# caffeinate so the Mac stays awake for exactly as long as vyred runs.
write_wrapper() {
  if [ "$DRY" = 1 ]; then say "would write $BIN/vyre-serve and $BIN/vyre"; return 0; fi
  mkdir -p "$BIN"
  WNODE=$(wrapper_node)
  GH_LINE=""; [ -z "$GH_BIN" ] || GH_LINE="export VYRE_GH_BIN=\"$GH_BIN\""
  [ -z "$HEADSCALE_BIN" ] || GH_LINE="$GH_LINE
export VYRE_HEADSCALE_BIN=\"$HEADSCALE_BIN\""
  [ -z "$FORWARDER_BIN" ] || GH_LINE="$GH_LINE
export VYRE_WINK_FORWARDER_BIN=\"$FORWARDER_BIN\""
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
# the system LaunchDaemon sets no output paths: vyred's output goes where "vyred did not start" points
mkdir -p "$VHOME/logs" && exec >>"$VHOME/logs/vyred.out" 2>&1
exec "$CAFF" -ims "$WNODE" --expose-gc --max-semi-space-size=5 "$APP/core/daemon/main.js"
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

# show_words: the four check words vyred computed for this code, on the terminal only. The app shows the same four from its own side; they match only if this Mac is the server the app is
# talking to. Words that still cannot be read are said so, with the one command that shows them.
show_words() {
  [ -n "$CODE" ] && [ "$DRY" = 0 ] || return 0
  if [ "${#CODE}" -eq 199 ]; then say "  This server pairs itself. Go back to the Vyre app."; return 0; fi
  n=0
  while [ "$n" -lt "${VYRE_WORDS_TRIES:-30}" ]; do
    out=$("$BIN/vyre" call relay.setup.status 2>/dev/null | tr -d '\n' || true)
    words=$(printf '%s' "$out" | sed -n 's/.*"words": *"\([a-z][a-z ]*\)".*/\1/p')
    if [ -n "$words" ]; then say "  Your four words: $words"; say "  Go back to the Vyre app. If it shows the same four, choose Same."; return 0; fi
    n=$((n + 1)); sleep 1
  done
  say "  The four words did not show yet. To see them, run: $BIN/vyre words"
}

# finish: what the person does next, the way install-box.sh ends. With the app's install line (a setup code) the app is where it finishes; without one, the space code (to a terminal only) is the way.
finish() {
  if [ "$DRY" = 1 ]; then return 0; fi
  say ""
  say "Vyre is running on this Mac."
  if [ -n "$CODE" ]; then
    show_words
    say "  Go back to the Vyre app to finish."
  elif [ "$BUSY" = 1 ]; then
    say "  Get your space code on this Mac once it is ready: vyre space up"
  elif ! show_space_code; then
    say "  Get your space code on this Mac: vyre space up"
  fi
}

# add_command: `vyre` typed in a Terminal. A link in a folder that is already on PATH and that this account can write (Homebrew's), else one marked line in the shell profile; both are removed by --uninstall.
add_command() {
  if [ "$DRY" = 1 ]; then say "would add the vyre command: a link in $LINK_DIRS if you can write there, else a line in $(profile_names)"; return 0; fi
  for d in $LINK_DIRS; do
    [ -d "$d" ] && [ -w "$d" ] || continue
    if [ -e "$d/vyre" ] && [ "$(readlink "$d/vyre" 2>/dev/null)" != "$BIN/vyre" ]; then continue; fi
    ln -sf "$BIN/vyre" "$d/vyre" || continue
    step "vyre is at $d/vyre"; return 0
  done
  # Only the command goes on PATH, from a folder of its own and after the person's own tools: $BIN also holds Vyre's pinned docker, gh and colima, which must never come ahead of theirs.
  mkdir -p "$CMD_DIR" && ln -sf "$BIN/vyre" "$CMD_DIR/vyre"
  oldifs=$IFS; IFS=$NL
  for pf in $PROFILE_FILES; do
    grep -q '# vyre: command' "$pf" 2>/dev/null && continue
    printf '# vyre: command (added by the Vyre installer; --uninstall removes it)\nexport PATH="$PATH:%s"  # vyre: command\n' "$CMD_DIR" >>"$pf" || { say "  note  could not write $pf; the command is $BIN/vyre"; continue; }
    PATH_ADDED=1
  done
  IFS=$oldifs
  step "vyre is at $CMD_DIR/vyre (every new shell finds it by name: $(profile_names))"
}

# remove_command: what add_command added, and nothing the person wrote.
remove_command() {
  for d in $LINK_DIRS; do
    [ "$(readlink "$d/vyre" 2>/dev/null)" = "$BIN/vyre" ] && rm -f "$d/vyre"
  done
  oldifs=$IFS; IFS=$NL
  for pf in $PROFILE_FILES${NL}$HOME/.zprofile; do
    if [ -f "$pf" ] && grep -q '# vyre: command' "$pf"; then
      # only a clean grep (0 or 1: lines kept, or none left) rewrites the file; an unreadable one is left as it is
      g=0; grep -v '# vyre: command' "$pf" >"$pf.vyre-new" || g=$?
      if [ "$g" = 0 ] || [ "$g" = 1 ]; then cat "$pf.vyre-new" >"$pf"; else say "  note  could not read $pf; remove its two '# vyre: command' lines by hand"; fi
      rm -f "$pf.vyre-new"
    fi
  done
  IFS=$oldifs
  return 0
}

# remove_colima_vm: Colima's VM goes only when Vyre made it (the note setup_colima left), never one that was there before.
remove_colima_vm() {
  [ -f "$SERVER_DIR/colima-made" ] || return 0
  c=$BIN/colima; [ -x "$c" ] || c=$(command -v colima 2>/dev/null || true)
  if [ -n "$c" ]; then PATH="$BIN:$SERVER_DIR/lima/bin:$PATH" "$c" delete --force >/dev/null 2>&1 || true; fi
  rm -rf "$HOME/.colima" "$HOME/.lima"
  say "  ok  Colima's Linux image is removed"
}

# show_space_code: the code that sets this Mac's space up from the app, from the same command a person runs later (`vyre space up`). Only to a terminal: an install run by a log collector
# or CI would leave a live code in a file others may read. VYRE_SPACE_CODE_PIPED=1 and VYRE_SPACE_TRIES are for the tests. Returns 1 when no code could be made yet.
show_space_code() {
  [ "$DRY" = 0 ] || return 1
  if ! [ -t 1 ] && [ "${VYRE_SPACE_CODE_PIPED:-0}" != 1 ]; then say "  Get your space code on this Mac: vyre space up"; return 0; fi
  n=0
  while [ "$n" -lt "${VYRE_SPACE_TRIES:-15}" ]; do
    sc=$("$BIN/vyre" space up 2>/dev/null || true)
    case "$sc" in
      *"Your space code:"*) printf '%s\n' "$sc"; say "  Get it again any time: vyre space up"; return 0 ;;
      *"already set up"*) return 1 ;;
    esac
    n=$((n + 1)); sleep 1
  done
  return 1
}

# verify_running: vyred answers `vyre status`. A first start sets itself up module by module and can take minutes, so a slow start is said to be setting up, never "not running"; the wait ends
# with the honest state and the one command that checks again. VYRE_STATUS_TRIES is for the tests (0 skips the wait).
verify_running() {
  [ "$DRY" = 0 ] || return 0
  [ "${VYRE_STATUS_TRIES:-120}" != 0 ] || return 0
  n=0
  while [ "$n" -lt "${VYRE_STATUS_TRIES:-120}" ]; do
    st=$("$BIN/vyre" status 2>/dev/null | tr -d '\033' || true)
    case "$st" in *answering*|*"modules running"*) return 0 ;; esac
    n=$((n + 1)); [ $((n % 15)) != 0 ] || say "  Vyre is busy setting up; this can take a few minutes..."
    sleep 2
  done
  BUSY=1
  say "  Vyre is installed and still setting up. It starts by itself; check again in a few minutes with: vyre status"
}

# check_git: Vyre reads repositories with git. On a Mac without the Command Line Tools /usr/bin/git is only a stub that opens an install window, so the tools' folder is asked first. Checked in step 1,
# before anything is installed, so waiting for the tools leaves nothing behind.
check_git() {
  if [ "$DRY" = 1 ]; then say "would check git (Apple's Command Line Tools)"; return 0; fi
  if { ! command -v xcode-select >/dev/null 2>&1 || xcode-select -p >/dev/null 2>&1; } && git --version >/dev/null 2>&1; then step "git runs ($(git --version | head -n 1))"; return 0; fi
  say "  git needs Apple's Command Line Tools, and this Mac does not have them. macOS shows one window to install them (it asks for no password); choose Install, then run this line again."
  xcode-select --install >/dev/null 2>&1 || true
  die "stopped before installing anything: waiting for the Command Line Tools"
}

# check_dependencies: everything a Mac server needs, each one checked and said in one plain line. Missing pieces were installed by the steps above (pinned and checksummed); this proves each one
# runs. A piece that did not install says so with its fix: nothing here stops the install, the service does not need Colima to start.
check_dependencies() {
  [ "$DRY" = 0 ] || return 0
  PATH="$BIN:$SERVER_DIR/lima/bin:$PATH"; export PATH
  nb=$(wrapper_node)
  v=$("$nb" -v 2>/dev/null || true); case "$v" in v22.*|v2[3-9].*) step "Node $v runs ($([ "$nb" = "$NODE_DIST/bin/node" ] && echo "the pinned one in $NODE_DIST" || echo "yours, $nb"))" ;; *) say "  note  Node did not run; Vyre needs Node 22.5 or newer" ;; esac
  c=$(command -v colima 2>/dev/null || true)
  if [ -n "$c" ]; then v=$("$c" version 2>/dev/null | head -n 1 || true); step "Colima runs${v:+ ($v)}"; else say "  note  Colima is not installed; agents get no computer until it is (see above)"; fi
  case "$UNAME_M" in arm64|aarch64) step "Rosetta is not needed: every image Vyre runs (vyre, Twenty, Postgres, Redis, Gotenberg and the Debian base of agents' computers) has a native arm64 build" ;; esac
  l=$(command -v limactl 2>/dev/null || true)
  if [ -n "$l" ]; then v=$("$l" --version 2>/dev/null | head -n 1 || true); step "Lima runs${v:+ ($v)}"; elif [ -n "$c" ] && command -v brew >/dev/null 2>&1; then step "Lima comes with Homebrew's Colima"; else say "  note  Lima is not installed; Colima needs it"; fi
  d=$(command -v docker 2>/dev/null || true)
  if [ -n "$d" ]; then v=$("$d" --version 2>/dev/null | head -n 1 || true); step "the Docker command runs${v:+ ($v)}; agents' computers are reached at unix://$HOME/.colima/default/docker.sock"; else say "  note  no docker command; agents get no computer until it is installed"; fi
  if [ -x "${VYRE_MAC_SIZE_HELPER:-$BIN/vyre-runtime}" ]; then
    rj=$("$BIN/vyre-runtime" room 1 2>/dev/null || true)
    cpus=$(printf '%s' "$rj" | sed -n 's/.*"cpus": *\([0-9][0-9]*\).*/\1/p'); mem=$(printf '%s' "$rj" | sed -n 's/.*"memory_gib": *\([0-9][0-9]*\).*/\1/p')
    [ -z "$cpus" ] || step "the Linux computer for agents is sized from this Mac: $cpus CPU, $mem GB memory, 40 GB disk"
  fi
  [ -z "$GH_BIN" ] || { v=$("$GH_BIN" --version 2>/dev/null | head -n 1 || true); step "gh runs${v:+ ($v)}"; }
  if [ -n "$HEADSCALE_BIN" ]; then v=$("$HEADSCALE_BIN" version 2>/dev/null | head -n 1 || true); step "Headscale runs${v:+ ($v)}"; fi
  if [ -n "$FORWARDER_BIN" ] && [ -x "$FORWARDER_BIN" ]; then step "the network node program is in place ($FORWARDER_BIN)"; fi
  return 0
}

# check_service: what the system install set up to keep the server up, each proved from the files launchd and pmset hold.
check_service() {
  [ "$DRY" = 0 ] || return 0
  [ "$SYSTEM" = 1 ] || return 0
  d=${VYRE_DAEMONS_DIR:-/Library/LaunchDaemons}
  for l in com.vyre.vyred com.vyre.colima; do
    if [ -f "$d/$l.plist" ] && grep -q 'RunAtLoad' "$d/$l.plist" 2>/dev/null; then
      case "$l" in com.vyre.vyred) step "Vyre is a system service that starts at boot, with nobody signed in" ;; *) step "Colima starts at boot ($l)" ;; esac
    else say "  note  $d/$l.plist is not in place; $l will not start at boot"; fi
  done
  pm=$(pmset -g 2>/dev/null || true)
  if [ -n "$pm" ]; then
    sl=$(printf '%s\n' "$pm" | awk '$1 == "sleep" { print $2; exit }'); ar=$(printf '%s\n' "$pm" | awk '$1 == "autorestart" { print $2; exit }')
    if [ "${sl:-0}" = 0 ] && [ "${ar:-1}" = 1 ]; then step "this Mac stays awake while it serves and starts again after a power cut"; else say "  note  energy settings are sleep $sl, autorestart $ar; a server wants sleep 0 and autorestart 1 (sudo pmset -a sleep 0 autorestart 1)"; fi
  fi
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
  # The full install is a server: core is told so by its own plist. With the app's install line, core is also told the fingerprint of the setup key that line carries
  # (the last 16 bytes of a 43-character code, or bytes 69 to 85 of a 199-character install code: public, never the secret) and takes that one key first, within the hour. The code goes to this node on its stdin, never on a command line.
  set -- install --owner-uid "$(id -u)" --owner-name "$(id -un)" --owner-home "$HOME" --vyred-wrapper "$BIN/vyre-serve" --server
  if [ -n "$CODE" ]; then
    fp=$(printf '%s' "$CODE" | "$(wrapper_node)" -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{const b=Buffer.from(s.trim(),"base64url");const fp=b.length===32?b.subarray(16):b.length===149&&b[0]===2?b.subarray(69,85):null;if(!fp||fp.length!==16)process.exit(1);process.stdout.write(fp.toString("hex"))})') || fp=""
    printf '%s' "$fp" | grep -Eq '^[0-9a-f]{32}$' || die "that setup code does not look right. Copy the install line from your browser again."
    set -- "$@" --first-key-fp "$fp"
  fi
  [ -z "$GH_BIN" ] || set -- "$@" --gh-bin "$GH_BIN"
  if [ -n "$COLIMA_ARGS" ]; then
    oldifs=$IFS; IFS='
'
    for a in $COLIMA_ARGS; do set -- "$@" --colima-program "$a"; done
    IFS=$oldifs
  fi
  say "Vyre now asks for your Mac password once, to install its system service."
  SYS_RAN=1
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
  remove_colima_vm
  remove_command
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
  say "Installing Vyre on this Mac as your server. This takes a few minutes."
  say "It asks for your Mac password once, so Vyre can start when the Mac starts."
  say "When it finishes, go back to the Vyre app."
  phase "Checking this Mac"
  filevault_gate
  store_gate
  memory_gate
  disk_gate
  check_git
  snapshot_before
  preflight
  phase "Downloading Vyre"
  install_app
  phase "Laying out"
  setup_colima
  setup_gh
  setup_wink_net
  write_env
  # only the full install is a server; the light --login-only install is My Home and stays local
  [ "$SYSTEM" = 0 ] || write_machine
  check_dependencies
  phase "Adding the vyre command"
  write_wrapper
  add_command
  phase "Starting Vyre"
  if [ "$SYSTEM" = 1 ]; then
    system_install
    wait_system
    check_service
    verify_running
    [ "$DRY" = 1 ] || say "It starts when this Mac boots, with nobody signed in, and stays awake while it runs. It also comes back by itself after a power cut (the Mac is set to start when power returns)."
    finish
  else
    write_plist
    start_service
    verify_running
    [ "$DRY" = 1 ] || say "It starts when you sign in to this Mac and stays awake while it runs."
    finish
  fi
}

main "$@"
