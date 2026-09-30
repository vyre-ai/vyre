#!/bin/sh
# install-box.sh: put Vyre on a Linux box with Docker Compose. This is what
# `curl -fsSL https://vyre.run/install.sh | sh` runs.
#
#   --dry-run          print every change, make none (read-only checks still run)
#   --yes              answer yes to every prompt
#   --from DIR         use the box files in a local checkout DIR and build the image from it
#   --print-link       end with only VYRE_LINK=<url> (and VYRE_SSH=<line>) on stdout, for a
#                      program to read; everything else goes to stderr (or VYRE_LINK_ONLY=1)
#   --uninstall        stop the stack and remove /usr/local/bin/vyre; volumes stay
#   --purge            with --uninstall: also delete the volumes, after asking
#
# Environment: VYRE_DIR (default /srv/vyre), VYRE_BOX_URL (default https://vyre.run/box/),
# VYRE_IMAGE (default ghcr.io/vyre-ai/vyre:latest), VYRE_BUILD=tgz to build from vyre.tgz even
# when the image can be pulled.
#
# Every downloaded file is checked against SHA256SUMS from the same place, and a file without a
# line there, or with a different hash, stops the install.
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
TGZ=0
LINK_ONLY=${VYRE_LINK_ONLY:-0}
IMAGE=${VYRE_IMAGE:-ghcr.io/vyre-ai/vyre:latest}
DIR=${VYRE_DIR:-/srv/vyre}
BASE=${VYRE_BOX_URL:-https://vyre.run/box/}
# Overridable for tests only.
WRAPPER=${VYRE_WRAPPER:-/usr/local/bin/vyre}
TUN=${VYRE_TUN:-/dev/net/tun}
DOCKER_SOCK=${VYRE_DOCKER_SOCK:-/var/run/docker.sock}
# A line only our wrapper carries, so we never replace or remove someone else's vyre.
MARK="vyre on a Docker box"

# In --print-link mode stdout carries only the machine-readable lines, so the talk goes to stderr.
say() { if [ "$LINK_ONLY" = 1 ]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi; }
die() { printf 'vyre: %s\n' "$*" >&2; exit 1; }

# The look. Colour and Unicode only on a terminal, with NO_COLOR and CI unset and TERM not dumb;
# plain ASCII otherwise, so a CI log reads cleanly. Set once in main() by pick_look. The words are
# the same either way: only escape codes and the check mark differ.
COLOR=0
BONE=""
SIGNAL=""
ASH=""
BEACON=""
BOLD=""
RESET=""
OK="ok"
STEP=0
STEPS=5

pick_look() {
  fd=1
  [ "$LINK_ONLY" = 1 ] && fd=2
  [ -t "$fd" ] || return 0
  [ -z "${NO_COLOR+x}" ] || return 0
  [ -z "${CI+x}" ] || return 0
  [ "${TERM:-dumb}" != dumb ] || return 0
  COLOR=1
  e=$(printf '\033')
  BONE="${e}[38;2;241;238;230m"
  SIGNAL="${e}[38;2;198;243;107m"
  ASH="${e}[38;2;140;135;125m"
  BEACON="${e}[38;2;184;164;255m"
  BOLD="${e}[1m"
  RESET="${e}[0m"
  OK=$(printf '\342\234\223')
}

# hello: the mark, the name, the version when the checkout has one, and what is about to happen.
hello() {
  v=""
  if [ -n "$FROM" ] && [ -f "$FROM/package.json" ]; then
    v=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$FROM/package.json" | head -n 1)
  fi
  if [ "$COLOR" = 1 ]; then
    dot=$(printf '\342\200\242')
    say ""
    say "  $BOLD${BONE}v$RESET$SIGNAL$dot$RESET  $BOLD${BONE}Vyre$RESET${v:+ $ASH$v$RESET}"
  else
    say "  Vyre${v:+ $v}"
  fi
  say "  Let's set up your server. A few minutes, and nothing changes without asking."
  say ""
}

# step TITLE: the next numbered step, as "[1/5] Checking Docker".
step() {
  STEP=$((STEP + 1))
  [ "$STEP" = 1 ] || say ""
  say "${ASH}[$STEP/$STEPS]$RESET $BOLD$1$RESET"
}

# done_step TEXT: the step finished, with a check mark (or "ok" in plain text).
done_step() { say "  $SIGNAL$OK$RESET $1"; }

# WAITS: one quiet line for the one real wait in this installer (Docker's own script). Picked by
# pid, not by odds, since something has to show while it's genuinely quiet: this is look only,
# never invented data, never a name or anything a person typed.
WAITS="this part is Docker's own installer, not ours
nothing is stuck: it's just quiet before apt gets going
the next lines on screen are curl's, not ours
a fine moment for a coffee"

wait_line() {
  n=$(printf '%s\n' "$WAITS" | wc -l)
  i=$(( ($$ % n) + 1 ))
  printf '%s\n' "$WAITS" | sed -n "${i}p"
}

# rule: a short line across, before the finish.
rule() {
  if [ "$COLOR" = 1 ]; then
    r=$(printf '\342\224\200')
    say "  $ASH$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$RESET"
  else
    say "  ------------------------"
  fi
}

# finish: what just happened, the one next step, and a sign-off.
finish() {
  say ""
  rule
  if [ "$DRY" = 1 ]; then
    say "  $BOLD${BONE}That's the whole plan.$RESET Nothing on this server changed."
    say "  Run it again without --dry-run when you're ready."
  elif [ "${VYRE_NO_UP:-0}" = 1 ]; then
    say "  $BOLD${BONE}Installed.$RESET Start it when you're ready: ${SIGNAL}vyre up$RESET"
  else
    say "  $BOLD${BONE}Your server is ready.$RESET"
    if [ "$LINK_ONLY" = 1 ]; then
      say "  The setup link went to stdout for the program that asked."
    else
      say "  Next: open the link above. If it came with an ssh -L line,"
      say "  run that on your own computer first, then open the link there."
    fi
  fi
  say ""
  say "  Go do your best work. We'll keep the thread."
  if [ "$COLOR" = 1 ] && [ "$(date +%u 2>/dev/null || true)" = 5 ]; then
    say "  ${ASH}Nice way to end the week.$RESET"
  fi
  say ""
}

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
  printf '%s%s%s [y/N] ' "$BEACON" "$1" "$RESET" >/dev/tty
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
      # The one real silent gap in this installer: Docker's own script takes a minute or two
      # before it says anything. One quiet line so it doesn't look stuck; --dry-run never gets
      # here for real, so it stays out of that output.
      [ "$DRY" = 1 ] || say "  $ASH$(wait_line)...$RESET"
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
      say "Vyre needs Docker Compose 2.24 or newer; this server has $(docker compose version --short)."
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
  say "This server has no /dev/net/tun, which the Tailscale container needs."
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

# sha256 FILE: its hex digest.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else die "need sha256sum or shasum to verify downloads"
  fi
}

# get_sums: SHA256SUMS first. Cloudflare Pages answers a missing file with 200 and a web page,
# so curl -f proves nothing: every line must look like "<64 hex>  <path>".
get_sums() {
  fetch SHA256SUMS "$TMP/SHA256SUMS"
  if [ ! -s "$TMP/SHA256SUMS" ] || grep -vqE '^[0-9a-f]{64} [ *][^ ]+$' "$TMP/SHA256SUMS"; then
    die "$BASE""SHA256SUMS is not a checksum list; is VYRE_BOX_URL right?"
  fi
}

# get NAME: download a box file into TMP and check it against its line in SHA256SUMS.
get() {
  mkdir -p "$TMP/$(dirname "$1")"
  fetch "$1" "$TMP/$1"
  want=$(awk -v p="$1" '$2 == p || $2 == "*" p { print $1; exit }' "$TMP/SHA256SUMS")
  [ -n "$want" ] || die "SHA256SUMS has no line for $1"
  got=$(sha256 "$TMP/$1")
  [ "$got" = "$want" ] || die "checksum mismatch for $BASE$1 (want $want, got $got)"
}

# pick_build: without --from, pull the image when the registry has it, else build from
# vyre.tgz (VYRE_BUILD=tgz forces that).
pick_build() {
  [ -n "$FROM" ] && return 0
  if [ "${VYRE_BUILD:-}" = tgz ]; then
    TGZ=1
    say "building the image from vyre.tgz (VYRE_BUILD=tgz)"
  elif ! dk_quiet manifest inspect "$IMAGE" >/dev/null 2>&1; then
    TGZ=1
    say "cannot pull $IMAGE; building it from vyre.tgz instead"
  fi
}

# unpack: vyre.tgz into DIR/src, replacing what was there, for compose.build.yml to build.
unpack() {
  if mine "$DIR"; then x=run; else x=priv; fi
  $x rm -rf "$DIR/src.new"
  $x mkdir -p "$DIR/src.new"
  $x tar -xzf "$TMP/vyre.tgz" -C "$DIR/src.new" --strip-components=1
  # npm pack pins every mtime to 1985, and BuildKit skips a changed file whose size and mtime
  # match what it synced before, so the image would keep stale files: give them today's.
  $x find "$DIR/src.new" -exec touch {} +
  if [ "$DRY" = 0 ] && [ ! -f "$DIR/src.new/box/Dockerfile" ]; then
    $x rm -rf "$DIR/src.new"
    die "vyre.tgz has no box/Dockerfile"
  fi
  $x rm -rf "$DIR/src"
  $x mv "$DIR/src.new" "$DIR/src"
  [ "$x" = priv ] && priv chown -R "$OWNER:$GROUP" "$DIR/src"
  return 0
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
  if [ -n "$FROM" ]; then
    done_step "using the box files in $FROM"
    step "Laying out $DIR"
    say "the stack goes in $DIR, owned by $OWNER"
    mkdir_owned "$DIR"
    put "$FROM/box/compose.yml" "$DIR/compose.yml" 0644
    put "$FROM/box/compose.build.yml" "$DIR/compose.build.yml" 0644
    put "$FROM/box/vyre.env.example" "$DIR/vyre.env.example" 0644
    WRAPPER_SRC="$FROM/box/vyre"
  else
    TMP=$(mktemp -d)
    files="compose.yml compose.build.yml vyre.env.example vyre"
    [ "$TGZ" = 1 ] && files="$files vyre.tgz"
    if [ "$DRY" = 1 ]; then
      say "would download: $BASE""SHA256SUMS"
      for f in $files; do say "would download and verify: $BASE$f"; done
      done_step "nothing downloaded (dry run)"
    else
      get_sums
      for f in $files; do get "$f"; done
      done_step "every file matches SHA256SUMS"
    fi
    step "Laying out $DIR"
    say "the stack goes in $DIR, owned by $OWNER"
    # Only once everything has verified, so a failed run leaves no empty stack folder behind.
    mkdir_owned "$DIR"
    for f in compose.yml compose.build.yml vyre.env.example; do
      put "$TMP/$f" "$DIR/$f" 0644
    done
    WRAPPER_SRC="$TMP/vyre"
    [ "$TGZ" = 0 ] || unpack
  fi
}

# docker_gid: the group that owns the host's Docker socket, which the docker-api proxy joins
# (group_add) so it never runs as root. Empty when there is no socket to read.
docker_gid() {
  [ -S "$DOCKER_SOCK" ] || [ -f "$DOCKER_SOCK" ] || return 0
  stat -c %g "$DOCKER_SOCK" 2>/dev/null || stat -f %g "$DOCKER_SOCK" 2>/dev/null || true
}

# /srv/vyre/.env names the project and its compose files. Written once, never overwritten:
# it is where the person adds TS_AUTHKEY, COMPOSE_PROFILES and anything else of theirs. The one
# exception is DOCKER_GID: added to an existing .env that lacks it, and nothing else touched.
write_env() {
  gid=$(docker_gid)
  if [ -e "$DIR/.env" ]; then
    if [ -n "$gid" ] && ! grep -q '^DOCKER_GID=' "$DIR/.env" 2>/dev/null; then
      say "$DIR/.env exists; adding DOCKER_GID=$gid and leaving the rest as it is"
      TMP=${TMP:-$(mktemp -d)}
      # A read, so it runs even in a dry run; sudo only when the .env is not ours to read.
      # sudo reads the root-only file; the copy is written as this user on purpose.
      # shellcheck disable=SC2024
      if [ -r "$DIR/.env" ] || [ -z "$SUDO" ]; then cat "$DIR/.env" >"$TMP/env"; else sudo cat "$DIR/.env" >"$TMP/env"; fi
      [ -z "$(tail -c 1 "$TMP/env")" ] || printf '\n' >>"$TMP/env"
      printf 'DOCKER_GID=%s\n' "$gid" >>"$TMP/env"
      put "$TMP/env" "$DIR/.env" 0600
    else
      say "$DIR/.env exists; leaving it as it is"
    fi
    if { [ -n "$FROM" ] || [ "$TGZ" = 1 ]; } && ! grep -q '^COMPOSE_FILE=.*compose.build.yml' "$DIR/.env" 2>/dev/null; then
      say "  (it does not list compose.build.yml, so the image is pulled, not built from source)"
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
    elif [ "$TGZ" = 1 ]; then
      say "COMPOSE_FILE=compose.yml:compose.build.yml"
      say "VYRE_SOURCE=$DIR/src"
    else
      say "COMPOSE_FILE=compose.yml"
    fi
    # The Docker socket's group, for the computers profile's docker-api proxy.
    [ -z "$gid" ] || say "DOCKER_GID=$gid"
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
  [ -d "$(dirname "$WRAPPER")" ] || priv mkdir -p "$(dirname "$WRAPPER")"
  priv install -m 0755 "$WRAPPER_SRC" "$WRAPPER"
}

# Start the stack. VYRE_DIR and SSH_CONNECTION are passed on because sudo drops them, and the
# wrapper needs SSH_CONNECTION to print the ssh -L line.
start() {
  say ""
  if [ "$LINK_ONLY" = 1 ]; then
    dk env "VYRE_DIR=$DIR" "SSH_CONNECTION=${SSH_CONNECTION:-}" "$WRAPPER" up --print-link
  else
    dk env "VYRE_DIR=$DIR" "SSH_CONNECTION=${SSH_CONNECTION:-}" "$WRAPPER" up
  fi
  if [ -n "$DOCKER_SUDO" ]; then
    say ""
    say "Your account cannot reach Docker, so the vyre command needs sudo: sudo vyre up."
    say "Adding yourself to the docker group avoids that, and makes your account root-equivalent."
  fi
}

uninstall() {
  if [ -f "$DIR/compose.yml" ]; then
    # $1 expands in the inner shell, which is the point.
    # shellcheck disable=SC2016
    dk sh -c 'cd "$1" && docker compose down --remove-orphans' sh "$DIR"
  else
    dk docker compose -p vyre down --remove-orphans
  fi
  if [ -e "$WRAPPER" ]; then
    if grep -q "$MARK" "$WRAPPER" 2>/dev/null; then priv rm -f "$WRAPPER"
    else say "$WRAPPER is not the server wrapper; leaving it"
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
  say "Vyre is off this server. $DIR stays (with its .env); remove it with: sudo rm -rf $DIR"
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
      --print-link) LINK_ONLY=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      -h|--help) sed -n '2,14p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  [ "$PURGE" = 1 ] && [ "$UNINSTALL" = 0 ] && die "--purge goes with --uninstall"

  case "$(uname -s)" in
    Linux) ;;
    Darwin)
      say "This installer is for a Linux server. On a Mac, Vyre installs with npm:"
      say "  npm install -g https://vyre.run/box/vyre.tgz && vyre up"
      exit 0 ;;
    *) die "this installer is for Linux boxes; on a Mac: npm install -g https://vyre.run/box/vyre.tgz && vyre up" ;;
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
  pick_look
  [ "$UNINSTALL" = 1 ] || hello
  [ "$DRY" = 1 ] && say "dry run: nothing on this server will change"

  if [ "$UNINSTALL" = 1 ]; then
    command -v docker >/dev/null 2>&1 || die "Docker is not installed, so there is no stack to stop"
    need_docker
    uninstall
    exit 0
  fi

  [ "${VYRE_NO_UP:-0}" = 1 ] && STEPS=4
  step "Checking Docker"
  pick_owner
  need_docker
  need_tun
  pick_build
  if command -v docker >/dev/null 2>&1; then done_step "Docker, Compose and the TUN device are there"
  else done_step "Docker would be installed first (dry run)"
  fi
  if [ -n "$FROM" ]; then step "Reading the box files"; else step "Downloading and verifying"; fi
  write_stack
  write_env
  if [ "$DRY" = 1 ]; then done_step "nothing written (dry run)"; else done_step "$DIR is laid out"; fi
  step "Installing the vyre command"
  install_wrapper
  if [ "$DRY" = 1 ]; then done_step "nothing installed (dry run)"; else done_step "vyre is at $WRAPPER"; fi
  # VYRE_NO_UP=1: everything but starting it, for `vyre box move`, which streams the volumes in first.
  if [ "${VYRE_NO_UP:-0}" = 1 ]; then say "installed in $DIR; not started (VYRE_NO_UP=1). Start it with: vyre up"
  else
    step "Starting Vyre"
    start
    if [ "$DRY" = 1 ]; then done_step "nothing started (dry run)"; else done_step "Vyre is up"; fi
  fi
  finish
}

main "$@"
