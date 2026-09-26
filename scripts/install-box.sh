#!/bin/sh
# install-box.sh: put Vyre on a Linux box with Docker Compose. This is what
# `curl -fsSL https://vyre.run/install.sh | sh` runs.
#
#   --dry-run          print every change, make none (read-only checks still run)
#   --yes              answer yes to every prompt
#   --from DIR         use the box files in a local checkout DIR and build the image from it
#   --uninstall        stop the stack and remove /usr/local/bin/vyre; volumes stay
#   --purge            with --uninstall: also delete the volumes, after asking
#
# Environment: VYRE_DIR (default /srv/vyre), VYRE_BOX_URL (default https://vyre.run/box/).
#
# It never installs anything without asking, and uses sudo only for what needs root: Docker,
# the stack folder when its parent is root's, and /usr/local/bin/vyre. Everything lives inside
# main(), called on the last line, so the shell has read the whole script before anything runs:
# when piped from curl, a command that reads stdin would otherwise eat the rest of the script.

set -eu

DRY=0
YES=0
FROM=""
UNINSTALL=0
PURGE=0
SUDO=""
DOCKER_SUDO=""
OWNER=""
GROUP=""
TMP=""
DIR=${VYRE_DIR:-/srv/vyre}
BASE=${VYRE_BOX_URL:-https://vyre.run/box/}
# Overridable for tests only.
WRAPPER=${VYRE_WRAPPER:-/usr/local/bin/vyre}
TUN=${VYRE_TUN:-/dev/net/tun}
# A line only our wrapper carries, so we never replace or remove someone else's vyre.
MARK="vyre on a Docker box"

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

# dk CMD...: a command that talks to Docker, through sudo only when this user cannot.
dk() {
  if [ -n "$DOCKER_SUDO" ]; then priv "$@"; else run "$@"; fi
}

# ask QUESTION: yes or no, read from the terminal (stdin may be the script itself).
ask() {
  [ "$YES" = 1 ] && return 0
  if ! (: </dev/tty) 2>/dev/null; then return 1; fi
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; return 0; }

# The person who owns the stack folder: whoever ran sudo, or you.
pick_owner() {
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then OWNER=$SUDO_USER
  else OWNER=$(id -un)
  fi
  GROUP=$(id -gn "$OWNER")
}

# Docker Engine with Compose v2.24 or newer (env_file with `required:` needs it).
compose_ok() {
  v=$(docker compose version --short 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')
  [ -n "$v" ] || return 1
  major=${v% *}
  minor=${v#* }
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 24 ]; }
}

need_docker() {
  cmd="curl -fsSL https://get.docker.com | sh"
  if ! command -v docker >/dev/null 2>&1; then
    if ask "Docker is not installed. Install it now with: $cmd ?"; then
      priv sh -c "$cmd"
      [ "$DRY" = 1 ] && return 0
    else
      say "Vyre runs in Docker. Install it with:"
      say "  $cmd"
      say "then run this installer again."
      exit 1
    fi
  fi
  if ! compose_ok; then
    if docker compose version >/dev/null 2>&1; then
      say "Vyre needs Docker Compose 2.24 or newer; this box has $(docker compose version --short)."
    else
      say "Vyre needs Docker Compose v2 (the \`docker compose\` plugin)."
    fi
    say "Update Docker with its own packages (docker-ce, docker-compose-plugin), or with:"
    say "  $cmd"
    say "then run this installer again."
    exit 1
  fi
  if docker info >/dev/null 2>&1; then DOCKER_SUDO=""
  elif [ -n "$SUDO" ] && sudo docker info >/dev/null 2>&1; then DOCKER_SUDO=sudo
  else die "Docker is installed but not running. Start it (sudo systemctl start docker) and run this again."
  fi
}

# Tailscale runs in its own container with kernel networking, which needs the TUN device.
need_tun() {
  [ -c "$TUN" ] && return 0
  say "This box has no /dev/net/tun, which the Tailscale container needs."
  say "Try: sudo modprobe tun. On a VPS or LXC container, enable TUN in the provider's panel."
  exit 1
}

# fetch NAME DEST: a box file from BASE.
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$BASE$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$BASE$1"
  else die "need curl or wget to download $BASE$1"
  fi
}

# mine PATH: true when PATH, or the nearest folder above it that exists, is OWNER's to write
# (a dry run has not created the stack folder yet).
mine() {
  [ "$(id -un)" = "$OWNER" ] || return 1
  p=$1
  while [ ! -e "$p" ]; do p=$(dirname "$p"); done
  [ -w "$p" ]
}

# put SRC DEST MODE: install a file into the stack folder, owned by OWNER.
put() {
  if mine "$(dirname "$2")"; then
    run install -m "$3" "$1" "$2"
  else
    priv install -m "$3" -o "$OWNER" -g "$GROUP" "$1" "$2"
  fi
}

# mkdir_owned DIR: create a folder owned by OWNER, with sudo only when its parent is not ours.
mkdir_owned() {
  [ -d "$1" ] && return 0
  if mine "$(dirname "$1")"; then run mkdir -p "$1"
  else
    priv mkdir -p "$1"
    priv chown "$OWNER:$GROUP" "$1"
  fi
}

# The box files: from a checkout with --from, else downloaded from BASE.
write_stack() {
  mkdir_owned "$DIR"
  mkdir_owned "$DIR/chat"
  if [ -n "$FROM" ]; then
    put "$FROM/box/compose.yml" "$DIR/compose.yml" 0644
    put "$FROM/box/compose.chat.yml" "$DIR/compose.chat.yml" 0644
    put "$FROM/box/compose.build.yml" "$DIR/compose.build.yml" 0644
    put "$FROM/box/vyre.env.example" "$DIR/vyre.env.example" 0644
    put "$FROM/modules/chat/compose.yml" "$DIR/chat/compose.yml" 0644
    WRAPPER_SRC="$FROM/box/vyre"
  else
    TMP=$(mktemp -d)
    for f in compose.yml compose.chat.yml vyre.env.example vyre chat/compose.yml; do
      if [ "$DRY" = 1 ]; then say "would download: $BASE$f"; continue; fi
      mkdir -p "$TMP/$(dirname "$f")"
      fetch "$f" "$TMP/$f"
    done
    for f in compose.yml compose.chat.yml vyre.env.example chat/compose.yml; do
      put "$TMP/$f" "$DIR/$f" 0644
    done
    WRAPPER_SRC="$TMP/vyre"
  fi
}

# /srv/vyre/.env names the project and its compose files. Written once, never overwritten:
# it is where the person adds Chat, TS_AUTHKEY and anything else of theirs.
write_env() {
  if [ -e "$DIR/.env" ]; then
    say "$DIR/.env exists; leaving it as it is"
    if [ -n "$FROM" ] && ! grep -q '^COMPOSE_FILE=.*compose.build.yml' "$DIR/.env"; then
      say "  (it does not list compose.build.yml, so the image is pulled, not built from $FROM)"
    fi
    return 0
  fi
  TMP=${TMP:-$(mktemp -d)}
  {
    say "# Read by docker compose in $DIR. Written once by install-box.sh; yours to edit."
    say "COMPOSE_PROJECT_NAME=vyre"
    if [ -n "$FROM" ]; then
      say "COMPOSE_FILE=compose.yml:compose.build.yml"
      say "VYRE_SOURCE=$FROM"
    else
      say "COMPOSE_FILE=compose.yml"
    fi
  } >"$TMP/env"
  if [ "$DRY" = 1 ]; then
    say "would write $DIR/.env (0600):"
    sed 's/^/  /' "$TMP/env"
  fi
  put "$TMP/env" "$DIR/.env" 0600
}

# /usr/local/bin/vyre: ours, or ask before replacing whatever is there.
install_wrapper() {
  if [ -e "$WRAPPER" ] && ! grep -q "$MARK" "$WRAPPER" 2>/dev/null; then
    ask "$WRAPPER exists and is not the box wrapper. Replace it?" \
      || die "left $WRAPPER alone. The stack is in $DIR; move that file aside and run this again."
  fi
  priv install -m 0755 "$WRAPPER_SRC" "$WRAPPER"
}

# Start the stack. VYRE_DIR and SSH_CONNECTION are passed on because sudo drops them, and the
# wrapper needs SSH_CONNECTION to print the ssh -L line.
start() {
  say ""
  dk env "VYRE_DIR=$DIR" "SSH_CONNECTION=${SSH_CONNECTION:-}" "$WRAPPER" up
  if [ -n "$DOCKER_SUDO" ]; then
    say ""
    say "Your account cannot reach Docker, so the vyre command needs sudo: sudo vyre up."
    say "Adding yourself to the docker group avoids that, and makes your account root-equivalent."
  fi
}

uninstall() {
  if [ -f "$DIR/compose.yml" ]; then
    dk sh -c 'cd "$1" && docker compose down --remove-orphans' sh "$DIR"
  else
    dk docker compose -p vyre down --remove-orphans
  fi
  if [ -e "$WRAPPER" ]; then
    if grep -q "$MARK" "$WRAPPER" 2>/dev/null; then priv rm -f "$WRAPPER"
    else say "$WRAPPER is not the box wrapper; leaving it"
    fi
  fi
  if [ "$PURGE" = 1 ]; then
    vols=$(dk_quiet volume ls -q --filter label=run.vyre=1 --filter label=com.docker.compose.project=vyre)
    if [ -z "$vols" ]; then
      say "no Vyre volumes to delete"
    else
      say "These volumes hold the vault, Claude's sign-in, the store and /work:"
      for v in $vols; do say "  $v"; done
      if ask "Delete them for good?"; then
        # shellcheck disable=SC2086 # one volume name per word
        dk docker volume rm $vols
      else
        say "kept the volumes"
      fi
    fi
  fi
  say "Vyre is off this box. $DIR stays (with its .env); remove it with: sudo rm -rf $DIR"
  [ "$PURGE" = 1 ] || say "The volumes stay too, so a reinstall picks up where it left off."
}

# dk_quiet ARGS...: a read-only docker query, run even in a dry run.
dk_quiet() {
  if [ -n "$DOCKER_SUDO" ]; then sudo docker "$@"; else docker "$@"; fi
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --yes|-y) YES=1 ;;
      --from) [ $# -ge 2 ] || die "--from needs a folder"; FROM=$2; shift ;;
      --from=*) FROM=${1#--from=} ;;
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
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
  if [ -n "$FROM" ]; then
    [ -f "$FROM/box/compose.yml" ] || die "$FROM is not a Vyre checkout (no box/compose.yml)"
    FROM=$(cd "$FROM" && pwd)
  fi
  case "$BASE" in */) ;; *) BASE="$BASE/" ;; esac
  trap cleanup EXIT
  [ "$DRY" = 1 ] && say "dry run: nothing on this box will change"

  if [ "$UNINSTALL" = 1 ]; then
    command -v docker >/dev/null 2>&1 || die "Docker is not installed, so there is no stack to stop"
    need_docker
    uninstall
    exit 0
  fi

  pick_owner
  need_docker
  need_tun
  say "the stack goes in $DIR, owned by $OWNER"
  write_stack
  write_env
  install_wrapper
  start
}

main "$@"
