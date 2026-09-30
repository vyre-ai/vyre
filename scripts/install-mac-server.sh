#!/bin/sh
# install-mac-server.sh: put Vyre on a Mac that is the always-on server (the Mac mini case).
# install-box.sh hands a Darwin `curl -fsSL https://vyre.run/install.sh | sh` to this script.
#
#   --dry-run          print every change, make none (read-only checks still run)
#   --yes              answer yes to every prompt
#   --from DIR         use a local checkout DIR instead of downloading vyre.tgz
#   --uninstall        stop and remove the service, the wrapper and the app; ~/.vyre stays
#   --purge            with --uninstall: also delete ~/.vyre, after asking
#
# Environment: VYRE_CODE (the setup code from the install line: never an argument), VYRE_BOX_URL
# (default https://vyre.run/box/), VYRE_HOME (default ~/.vyre, where vyre.env lives).
#
# What it does, in order: checks the Mac and Node; downloads vyre.tgz and checks it against
# SHA256SUMS from the same place; installs it under ~/.vyre-server/app; installs Colima (Homebrew, or pinned
# checksummed binaries without it) for agents' computers, and starts it; puts the setup code and its time in vyre.env (0600) as
# VYRE_SETUP_CODE and VYRE_SETUP_CODE_AT; installs one LaunchAgent that runs vyred under
# `caffeinate` (the Mac stays awake while vyred runs, and nothing system-wide changes, so there is
# nothing to restore); waits for vyred to answer.
#
# Never root: everything is in the person's own account, and it asks for no password. The system
# service (a root vyre-core, starting with nobody signed in) is ADR 0040's, not built here.
# Everything lives inside main(), called on the last line, so a piped script is read whole first.

set -eu

DRY=0
YES=0
FROM=""
UNINSTALL=0
PURGE=0
TMP=""
CODE=${VYRE_CODE:-}
BASE=${VYRE_BOX_URL:-https://vyre.run/box/}
# Overridable for tests only.
UNAME_S=${VYRE_UNAME_S:-$(uname -s)}
UNAME_M=${VYRE_UNAME_M:-$(uname -m)}
LAUNCHCTL=${VYRE_LAUNCHCTL:-launchctl}
VHOME=${VYRE_HOME:-$HOME/.vyre}
SERVER_DIR=${VYRE_SERVER_DIR:-$HOME/.vyre-server}
AGENTS_DIR=${VYRE_LAUNCHAGENTS:-$HOME/Library/LaunchAgents}
LABEL=run.vyre.server
COLIMA_LABEL=run.vyre.colima
CAFF=${VYRE_CAFFEINATE:-/usr/bin/caffeinate}
APP=$SERVER_DIR/app
BIN=$SERVER_DIR/bin

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

preflight() {
  [ "$UNAME_S" = Darwin ] || die "this installer is for a Mac; on Linux use the Docker install line"
  [ "$(id -u)" != 0 ] || die "run this as your own account, not root: Vyre never runs as root here"
  if ! node_ok; then
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
  step "this Mac is ready (Node $(node -p 'process.versions.node' 2>/dev/null || echo 22))"
}

install_app() {
  if [ "$DRY" = 1 ]; then say "would install Vyre into $APP"; return 0; fi
  mkdir -p "$SERVER_DIR"
  rm -rf "$APP.new"
  mkdir -p "$APP.new"
  if [ -n "$FROM" ]; then
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
  rm -rf "$APP.old"
  [ ! -d "$APP" ] || mv "$APP" "$APP.old"
  mv "$APP.new" "$APP"
  rm -rf "$APP.old"
  step "Vyre is in $APP"
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

# setup_colima: agents' computers run in Colima (open source, headless), never Docker Desktop. An
# existing Docker Desktop is left alone and unused. With Homebrew it installs Colima there; without,
# it downloads pinned, checksummed binaries into SERVER_DIR and keeps Colima up with its own
# LaunchAgent. If neither works it says so and goes on: the server works, agents get no computer.
setup_colima() {
  if [ "$DRY" = 1 ]; then say "would install and start Colima (agents' computers)"; return 0; fi
  if ! command -v colima >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      say "Installing Colima with Homebrew..."
      brew install colima docker >/dev/null 2>&1 || { say "  note  Colima did not install; agents get no computer until it does (brew install colima docker)"; return 0; }
    else
      colima_fallback || return 0
      write_colima_plist
      uid=$(id -u)
      "$LAUNCHCTL" bootout "gui/$uid/$COLIMA_LABEL" >/dev/null 2>&1 || true
      "$LAUNCHCTL" bootstrap "gui/$uid" "$AGENTS_DIR/$COLIMA_LABEL.plist" || { say "  note  launchctl could not start Colima; run: $BIN/colima start"; return 0; }
      step "Colima is starting (its first start downloads a small Linux image)"
      return 0
    fi
  fi
  colima start --cpu 2 --memory 4 --disk 40 >/dev/null 2>&1 || { say "  note  Colima did not start; run: colima start"; return 0; }
  brew services start colima >/dev/null 2>&1 || true
  step "Colima is running"
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
exec "$CAFF" -ims "$(command -v node)" "$APP/core/daemon/main.js"
EOF
  cat >"$BIN/vyre" <<EOF
#!/bin/sh
# vyre on a Mac server: written by install-mac-server.sh
export VYRE_HOME="$VHOME"
exec "$(command -v node)" "$APP/bin/vyre" "\$@"
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

uninstall() {
  if [ "$DRY" = 1 ]; then say "would stop the service and remove $AGENTS_DIR/$LABEL.plist, $SERVER_DIR"; [ "$PURGE" = 0 ] || say "and, asking first, $VHOME"; return 0; fi
  "$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  "$LAUNCHCTL" bootout "gui/$(id -u)/$COLIMA_LABEL" >/dev/null 2>&1 || true
  rm -f "$AGENTS_DIR/$LABEL.plist" "$AGENTS_DIR/$COLIMA_LABEL.plist"
  rm -rf "$SERVER_DIR"
  if [ "$PURGE" = 1 ]; then
    ok=$YES
    if [ "$ok" = 0 ]; then printf 'Delete %s, your Vyre data? Type delete: ' "$VHOME"; read -r a </dev/tty || a=""; [ "$a" = delete ] && ok=1; fi
    if [ "$ok" = 1 ]; then rm -rf "$VHOME"; say "your data is deleted"; else say "your data is kept in $VHOME"; fi
  else say "your data is kept in $VHOME"; fi
  say "Vyre is off this Mac. Colima and Node were left as they are: brew services stop colima, if you want it off too."
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --yes) YES=1 ;;
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
  TMP=$(mktemp -d)
  trap cleanup EXIT
  if [ "$UNINSTALL" = 1 ]; then uninstall; return 0; fi
  say "Installing Vyre on this Mac as your server."
  preflight
  install_app
  setup_colima
  write_env
  write_wrapper
  write_plist
  start_service
  say "Vyre is running. Back in your browser, it will find this Mac."
  say "It starts when you sign in to this Mac and stays awake while it runs. Its command is $BIN/vyre"
}

main "$@"
