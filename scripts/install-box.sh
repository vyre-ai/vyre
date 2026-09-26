#!/bin/sh
# install-box.sh: put Vyre on a Linux box. This is what `curl -fsSL https://vyre.run/install.sh | sh`
# runs.
#
#   --dry-run          print every change, make none (read-only checks still run)
#   --yes              answer yes to every install prompt
#   --user NAME        the login vyred runs as (default: whoever ran sudo, or you)
#   --uninstall        take Vyre off this box; add --purge to delete ~/.vyre and its vault too
#
# It never installs anything without asking. vyred runs as the owner's own account, never root.
# Everything lives inside main(), called on the last line, so the shell has read the whole
# script before anything runs: when piped from curl, a command that reads stdin would otherwise
# eat the rest of the script.

set -eu

DRY=0
YES=0
TARGET=""
UNINSTALL=0
PURGE=0
SUDO=""
CREATED=0

say() { printf '%s\n' "$*"; }
die() { printf 'vyre: %s\n' "$*" >&2; exit 1; }

# show CMD...: the command as one line, for "would run:" and prompts.
show() {
  line=""
  for a in "$@"; do
    case "$a" in
      *[!A-Za-z0-9_@%+=:,./-]*|"") line="$line '$a'" ;;
      *) line="$line $a" ;;
    esac
  done
  printf '%s' "${line# }"
}

# run CMD...: a change made as the current user.
run() {
  if [ "$DRY" = 1 ]; then say "would run: $(show "$@")"; else "$@"; fi
}

# priv CMD...: a change made as root, through sudo when we are not root.
priv() {
  if [ "$DRY" = 1 ]; then
    if [ -n "$SUDO" ]; then say "would run: sudo $(show "$@")"; else say "would run: $(show "$@")"; fi
  elif [ -n "$SUDO" ]; then sudo "$@"
  else "$@"
  fi
}

# as_user CMD...: run as the box owner, with their HOME.
as_user() {
  if [ "$(id -un)" = "$TARGET" ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo -H -u "$TARGET" "$@"
  elif command -v runuser >/dev/null 2>&1; then runuser -u "$TARGET" -- "$@"
  else die "need sudo or runuser to run as $TARGET"
  fi
}

# ask QUESTION: yes or no, read from the terminal (stdin may be the script itself).
ask() {
  [ "$YES" = 1 ] && return 0
  if ! (: </dev/tty) 2>/dev/null; then return 1; fi
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

# offer WHAT COMMAND: install something with a shell pipeline, as root, if the person agrees.
offer() {
  what=$1
  cmd=$2
  if ask "$what is not installed. Install it now with: $cmd ?"; then
    priv sh -c "$cmd"
  else
    say "$what is needed. Install it with:"
    say "  $cmd"
    say "then run this installer again."
    exit 1
  fi
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  v=$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')
  [ -n "$v" ] || return 1
  major=${v% *}
  minor=${v#* }
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 5 ]; }
}

need_node() {
  node_ok && return 0
  if [ -f /etc/debian_version ]; then
    offer "Node 22.5 or newer" "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
  else
    say "Vyre needs Node 22.5 or newer, and this installer only knows how to add it on Debian or Ubuntu."
    say "Install Node 22.5+ with your system's package manager (or from https://nodejs.org), then run this again."
    exit 1
  fi
}

need_tailscale() {
  command -v tailscale >/dev/null 2>&1 && return 0
  offer "Tailscale" "curl -fsSL https://tailscale.com/install.sh | sh"
}

need_claude() {
  command -v claude >/dev/null 2>&1 && return 0
  offer "Claude Code" "npm install -g @anthropic-ai/claude-code"
}

pick_user() {
  me=$(id -un)
  if [ -n "$TARGET" ]; then :
  elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then TARGET=$SUDO_USER
  elif [ "$(id -u)" != 0 ]; then TARGET=$me
  else TARGET=vyre
  fi
  [ "$TARGET" = root ] && die "vyred does not run as root. Pass --user with the login that owns this box."
  if ! id "$TARGET" >/dev/null 2>&1; then
    [ "$TARGET" = vyre ] || die "there is no user $TARGET on this box"
    # Root with nobody else in sight: give vyred a regular login account of its own.
    priv useradd --create-home --home-dir /home/vyre --shell /bin/bash vyre
    CREATED=1
  fi
}

# vyre_cmd AS ARGS...: run the vyre CLI; in a dry run pass --dry-run through if it is installed.
vyre_cmd() {
  who=$1
  shift
  if [ "$DRY" = 1 ]; then
    if [ "$who" = root ] && command -v vyre >/dev/null 2>&1; then vyre "$@" --dry-run
    elif [ "$who" = root ]; then priv vyre "$@"
    elif [ "$CREATED" = 0 ] && command -v vyre >/dev/null 2>&1; then as_user vyre "$@" --dry-run
    else say "would run (as $TARGET): vyre $(show "$@")"
    fi
    return 0
  fi
  # sudo's secure_path may not include npm's global bin, so hand it the full path.
  bin=$(command -v vyre 2>/dev/null || true)
  [ -n "$bin" ] || die "vyre is not on PATH after npm install -g vyre; check npm's global bin folder"
  if [ "$who" = root ]; then priv "$bin" "$@"
  else as_user "$bin" "$@"
  fi
}

install_vyre() {
  latest=$(npm view vyre version 2>/dev/null || true)
  have=$(npm ls -g --depth=0 vyre 2>/dev/null | sed -n 's/.*vyre@\([0-9][0-9.a-z-]*\).*/\1/p' | head -n 1 || true)
  if [ -n "$latest" ] && [ "$have" = "$latest" ]; then
    say "vyre $have is already installed"
  elif [ -n "$latest" ]; then
    priv npm install -g "vyre@$latest"
  else
    priv npm install -g vyre
  fi
}

uninstall() {
  if [ "$PURGE" = 1 ]; then vyre_cmd root uninstall --system --purge
  else vyre_cmd root uninstall --system
  fi
  priv npm rm -g vyre
  say "Vyre is off this box."
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --yes|-y) YES=1 ;;
      --user) [ $# -ge 2 ] || die "--user needs a name"; TARGET=$2; shift ;;
      --user=*) TARGET=${1#--user=} ;;
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      -h|--help) sed -n '2,9p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  [ "$PURGE" = 1 ] && [ "$UNINSTALL" = 0 ] && die "--purge goes with --uninstall"

  case "$(uname -s)" in
    Linux) ;;
    Darwin) say "on a Mac: npm install -g vyre && vyre up"; exit 0 ;;
    *) die "this installer is for Linux boxes; on a Mac: npm install -g vyre && vyre up" ;;
  esac

  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "run this as root, or install sudo"
    SUDO=sudo
  fi
  [ "$DRY" = 1 ] && say "dry run: nothing on this box will change"

  if [ "$UNINSTALL" = 1 ]; then uninstall; exit 0; fi

  pick_user
  say "vyred will run as $TARGET"
  need_node
  need_tailscale
  need_claude
  install_vyre
  vyre_cmd root up --system --user "$TARGET"
  vyre_cmd user up

  if [ "$CREATED" = 1 ]; then
    say ""
    say "Created the login user vyre for Vyre to run as. Give it your ssh key"
    say "(copy your key into /home/vyre/.ssh/authorized_keys), then ssh as vyre to use the vyre CLI."
  fi
}

main "$@"
