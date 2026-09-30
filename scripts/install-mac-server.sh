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
# SHA256SUMS from the same place; installs it under ~/.vyre-server/app; installs Colima (Homebrew)
# for agents' computers, and starts it; puts the setup code and its time in vyre.env (0600) as
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
LAUNCHCTL=${VYRE_LAUNCHCTL:-launchctl}
VHOME=${VYRE_HOME:-$HOME/.vyre}
SERVER_DIR=${VYRE_SERVER_DIR:-$HOME/.vyre-server}
AGENTS_DIR=${VYRE_LAUNCHAGENTS:-$HOME/Library/LaunchAgents}
LABEL=run.vyre.server
CAFF=${VYRE_CAFFEINATE:-/usr/bin/caffeinate}
APP=$SERVER_DIR/app
BIN=$SERVER_DIR/bin

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

# setup_colima: agents' computers run in Colima (open source, headless), never Docker Desktop. An
# existing Docker Desktop is left alone and unused. Without Homebrew this says so and goes on: the
# server works, agents get no computer until Colima is there.
setup_colima() {
  if [ "$DRY" = 1 ]; then say "would install and start Colima (agents' computers)"; return 0; fi
  if ! command -v colima >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      say "Installing Colima with Homebrew..."
      brew install colima docker >/dev/null 2>&1 || { say "  note  Colima did not install; agents get no computer until it does (brew install colima docker)"; return 0; }
    else
      say "  note  Colima needs Homebrew (https://brew.sh); agents get no computer until it is there"
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
  rm -f "$AGENTS_DIR/$LABEL.plist"
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
