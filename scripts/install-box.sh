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
# when the image can be pulled, and VYRE_CODE: the setup code the browser shows, for the
# install line `curl -fsSL https://vyre.run/i | VYRE_CODE=... sh` (the variable goes on sh, the reader
# of the script: on curl it would never reach it, and sudo drops it, so run it as yourself). The code is never a command-line
# argument (a process list shows arguments); without one, and on a terminal, it is asked for and
# Enter skips it. It goes only into $VYRE_DIR/vyre.env (0600) as VYRE_SETUP_CODE (VYRE_CODE stays the host-side pipe), which the box reads once
# at start, and is never printed. With a code, each step is also sent, sealed under a key only the
# browser's setup page can derive from the code, to the relay's progress mailbox (VYRE_RELAY, default
# https://relay.vyre.run) so the page shows the install as it happens. That needs curl and openssl; without
# them the terminal is the only place it shows.
#
# A release that carries image digests (release.json) is pulled by digest, after cosign has verified
# the signature against this repo's release workflow, with cosign itself run from a container pinned
# by digest below. A failed check stops the install; there is no switch to skip it.
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
# The cosign that checks our images, pinned by digest so a moved tag cannot swap it. The identity
# is the release workflow of this repo on a version tag, and nothing else.
COSIGN_IMAGE=${VYRE_COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign@sha256:b03690aa52bfe94054187142fba24dc54137650682810633901767d8a3e15b31}
COSIGN_ID='^https://github\.com/vyre-ai/vyre/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$'
COSIGN_ISSUER=https://token.actions.githubusercontent.com
CODE=""
MBX=0
MBXT=""
MBX_SEQ=0
RELAY_HTTP=${VYRE_RELAY:-https://relay.vyre.run}
BOX_REF=""
COMPUTER_REF=""
# A line only our wrapper carries, so we never replace or remove someone else's vyre.
MARK="vyre on a Docker box"

# In --print-link mode stdout carries only the machine-readable lines, so the talk goes to stderr.
say() { if [ "$LINK_ONLY" = 1 ]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi; }
die() { printf 'vyre: %s\n' "$*" >&2; mbx_send "stopped: $*"; exit 1; }

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
  mbx_send "[$STEP/$STEPS] $1"
}

# done_step TEXT: the step finished, with a check mark (or "ok" in plain text).
done_step() { say "  $SIGNAL$OK$RESET $1"; mbx_send "done: $1"; }

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
      if [ -n "$CODE" ]; then
        say "  Done. Back to your browser."
      else
        say "  Next: open the link above. If it came with an ssh -L line,"
        say "  run that on your own computer first, then open the link there."
      fi
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

cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; [ -n "$MBXT" ] && rm -rf "$MBXT"; return 0; }


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
  want=$(awk -v p="$1" '$2 == p || $2 == "*" p { print $1; exit }' "$TMP/SHA256SUMS")
  [ -n "$want" ] || die "SHA256SUMS has no line for $1"
  fetch "$1" "$TMP/$1" || die "could not download $BASE$1"
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
  elif [ -n "$BOX_REF" ]; then
    # A release that names its image by digest is pulled by that digest, never built or pulled by tag.
    :
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
    if [ "$DRY" = 1 ]; then
      pick_build
      [ "$TGZ" = 1 ] && files="$files vyre.tgz"
      say "would download: $BASE""SHA256SUMS"
      for f in $files; do say "would download and verify: $BASE$f"; done
      say "would read release.json and, when it names image digests, check each with cosign and pull it by digest"
      done_step "nothing downloaded (dry run)"
    else
      get_sums
      if awk '$2 == "release.json" || $2 == "*release.json" { f = 1 } END { exit !f }' "$TMP/SHA256SUMS"; then
        get release.json
      fi
      # compose.yml first: read_release checks it pins the digests release.json names.
      get compose.yml
      read_release
      pick_build
      [ "$TGZ" = 1 ] && files="$files vyre.tgz"
      for f in $files; do [ -f "$TMP/$f" ] || get "$f"; done
      done_step "every file matches SHA256SUMS"
      verify_images
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
  # printf, not say: in --print-link mode say writes to stderr, and the file came out empty.
  {
    printf '%s\n' "# Read by docker compose in $DIR. Written once by install-box.sh; yours to edit."
    printf '%s\n' "COMPOSE_PROJECT_NAME=vyre"
    if [ -n "$FROM" ]; then
      printf '%s\n' "COMPOSE_FILE=compose.yml:compose.build.yml"
      printf '%s\n' "VYRE_SOURCE=$FROM"
    elif [ "$TGZ" = 1 ]; then
      printf '%s\n' "COMPOSE_FILE=compose.yml:compose.build.yml"
      printf '%s\n' "VYRE_SOURCE=$DIR/src"
    else
      printf '%s\n' "COMPOSE_FILE=compose.yml"
    fi
    # The Docker socket's group, for the computers profile's docker-api proxy.
    [ -z "$gid" ] || printf '%s\n' "DOCKER_GID=$gid"
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
  # Updates asked for from Vyre's own Settings: the two folders the stack mounts and a root path unit that runs the signed
  # `vyre update` when vyred drops its request (box/vyre, `vyre updater`). No systemd, or a wrapper somewhere else (a test):
  # nothing is written, and an update is the `vyre update` command.
  if [ "$DRY" != 1 ] && [ -z "${VYRE_WRAPPER:-}" ]; then
    priv env "VYRE_DIR=$DIR" "$WRAPPER" updater install || say "note: could not set up updates from Settings; vyre update still works"
  fi
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

# ---- the progress mailbox (tailnet plan 3.6b, N6) ----
# b64u: base64url on stdin, no padding.
b64u() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
# mbx_derive TAG: sha256("TAG\n" || the code's 16-byte secret), raw, as core/relay/wire.js setupDerive.
mbx_derive() { { printf '%s\n' "$1"; cat "$MBXT/secret.bin"; } | openssl dgst -sha256 -binary; }
hexof() { od -An -tx1 | tr -d ' \n'; }

# mbx_post JSON: one POST to the relay mailbox, the body on stdin so nothing secret rides in argv.
# Prints the HTTP status, or 000 when the relay cannot be reached.
mbx_post() {
  printf '%s' "$1" | curl -sS -o /dev/null -w '%{http_code}' --max-time 6 -X POST -H 'content-type: application/json' \
    --data-binary @- "$(printf '%s' "${RELAY_HTTP%/}" | sed 's|^ws|http|')/v1/setup/mbx" 2>/dev/null || printf '000'
}

# mbx_pads KEYHEX: the two HMAC pads for a 32-byte key (zero-padded to the 64-byte block): key xor 0x36 and key xor 0x5c,
# as raw bytes in ipad.bin and opad.bin. Plain sh arithmetic and printf, so it runs on dash, bash and a Mac's sh alike.
mbx_pads() {
  : >"$MBXT/ipad.bin"; : >"$MBXT/opad.bin"
  i=0
  while [ "$i" -lt 64 ]; do
    b=$(printf '%s' "$1" | cut -c$((i * 2 + 1))-$((i * 2 + 2)))
    v=0
    [ -z "$b" ] || v=$((0x$b))
    # shellcheck disable=SC2059 # octal escapes are the point
    printf "\\$(printf '%03o' $((v ^ 54)))" >>"$MBXT/ipad.bin"
    # shellcheck disable=SC2059
    printf "\\$(printf '%03o' $((v ^ 92)))" >>"$MBXT/opad.bin"
    i=$((i + 1))
  done
}

# mbx_init: derive the mailbox keys from the code and open the mailbox. Quiet when curl or openssl
# is missing, or the relay cannot be reached: the terminal still shows everything.
mbx_init() {
  [ -n "$CODE" ] || return 0
  command -v curl >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1 || return 0
  MBXT=$(mktemp -d) || return 0
  chmod 700 "$MBXT"
  printf '%s=' "$CODE" | tr '_-' '/+' | { base64 -d 2>/dev/null || base64 -D 2>/dev/null; } >"$MBXT/code.bin" || { MBXT=""; return 0; }
  [ "$(wc -c <"$MBXT/code.bin" | tr -d ' ')" = 32 ] || return 0
  head -c 16 "$MBXT/code.bin" >"$MBXT/secret.bin"
  tail -c 16 "$MBXT/code.bin" >"$MBXT/fp.bin"
  MBX_LOC=$(mbx_derive vyre-pair-loc | b64u)
  MBX_FP=$(b64u <"$MBXT/fp.bin")
  MBX_WTOK=$(mbx_derive vyre-setup-mbx-w | b64u)
  MBX_ENC=$(mbx_derive vyre-setup-mbx-enc | hexof)
  MBX_MAC=$(mbx_derive vyre-setup-mbx-mac | hexof)
  mbx_pads "$MBX_MAC"
  # The first write creates the mailbox and fixes who may write to it; a 409 means another server used
  # this code first, and nothing here may go on to look like the page's server.
  body=$(printf '{"loc":"%s","fp":"%s","wtok":"%s"}' "$MBX_LOC" "$MBX_FP" "$MBX_WTOK")
  case "$(mbx_post "$body")" in
    200) MBX=1 ;;
    409) printf 'vyre: Another server already used this code. Your browser is not connected to this server. Start again at https://vyre.run/setup.\n' >&2; exit 1 ;;
    *) MBX=0 ;;
  esac
}

# mbx_send TEXT: one plain line for the browser: AES-256-CTR under the mailbox key, its HMAC over the
# line's position, the IV and the ciphertext (core/relay/wire.js mbxSeal). Never blocks the install.
mbx_send() {
  [ "$MBX" = 1 ] || return 0
  text=$(printf '%s' "$1" | tr -d '\000-\037' | cut -c1-900)
  openssl rand 16 >"$MBXT/iv.bin" 2>/dev/null || return 0
  printf '%s' "$text" | openssl enc -aes-256-ctr -K "$MBX_ENC" -iv "$(hexof <"$MBXT/iv.bin")" >"$MBXT/ct.bin" 2>/dev/null || return 0
  b1=$((MBX_SEQ / 16777216 % 256)); b2=$((MBX_SEQ / 65536 % 256)); b3=$((MBX_SEQ / 256 % 256)); b4=$((MBX_SEQ % 256))
  # shellcheck disable=SC2059 # the octal escapes are the point
  printf "\\$(printf '%03o' "$b1")\\$(printf '%03o' "$b2")\\$(printf '%03o' "$b3")\\$(printf '%03o' "$b4")" >"$MBXT/seq.bin"
  # HMAC-SHA256 by hand from plain sha256, which every openssl has (LibreSSL on a Mac has no `dgst -mac`).
  { cat "$MBXT/ipad.bin" "$MBXT/seq.bin" "$MBXT/iv.bin" "$MBXT/ct.bin" | openssl dgst -sha256 -binary >"$MBXT/inner.bin"; } 2>/dev/null || return 0
  cat "$MBXT/opad.bin" "$MBXT/inner.bin" | openssl dgst -sha256 -binary >"$MBXT/mac.bin" 2>/dev/null || return 0
  line=$(cat "$MBXT/iv.bin" "$MBXT/ct.bin" "$MBXT/mac.bin" | b64u)
  body=$(printf '{"loc":"%s","fp":"%s","wtok":"%s","line":"%s"}' "$MBX_LOC" "$MBX_FP" "$MBX_WTOK" "$line")
  if [ "$(mbx_post "$body")" = 200 ]; then MBX_SEQ=$((MBX_SEQ + 1)); fi
  return 0
}

# show_words: the four check words the box computed for this code, on the terminal only. The page shows
# the same four from its own side; they match only if this box is the one the page is talking to, so they
# never go through the relay mailbox. Best effort: a box that is slow to answer just leaves them out.
show_words() {
  [ -n "$CODE" ] && [ "$DRY" = 0 ] || return 0
  n=0
  while [ "$n" -lt 20 ]; do
    out=$(dk env "VYRE_DIR=$DIR" "$WRAPPER" call relay.setup.status 2>/dev/null | tr -d '\n' || true)
    words=$(printf '%s' "$out" | sed -n 's/.*"words": *"\([a-z][a-z ]*\)".*/\1/p')
    if [ -n "$words" ]; then say "  Check words: $BOLD$words$RESET"; say "  They should match the four on your screen."; return 0; fi
    n=$((n + 1)); sleep 1
  done
}

# intake_code: the setup code, from VYRE_CODE or asked for on a terminal (hidden, Enter skips it).
# Never an argument, never echoed. The shape is base64url of 32 bytes: 43 characters.
intake_code() {
  CODE=${VYRE_CODE:-}
  unset VYRE_CODE
  [ "$UNINSTALL" = 1 ] && { CODE=""; return 0; }
  if [ -z "$CODE" ] && [ "$DRY" = 0 ] && [ "$YES" = 0 ] && [ "$LINK_ONLY" = 0 ] && (: </dev/tty) 2>/dev/null; then
    printf '%sPaste the setup code from your browser (Enter to skip): %s' "$BEACON" "$RESET" >/dev/tty
    stty -echo </dev/tty 2>/dev/null || true
    read -r CODE </dev/tty || CODE=""
    stty echo </dev/tty 2>/dev/null || true
    printf '\n' >/dev/tty
  fi
  [ -n "$CODE" ] || return 0
  printf '%s' "$CODE" | grep -Eq '^[A-Za-z0-9_-]{43}$' \
    || die "that setup code does not look right. Copy the install line from your browser again."
}

# write_code: VYRE_SETUP_CODE into DIR/vyre.env (0600), which the vyre service already reads, with the time it
# was written so `vyre` can remove both lines once the hour is over (the box reads the code once, at
# start, and never keeps it). The rest of the file is kept as it is, and put installs from a temp file
# so the code is never an argument.
write_code() {
  [ -n "$CODE" ] || return 0
  if [ "$DRY" = 1 ]; then say "would put the setup code in $DIR/vyre.env (0600); it is never shown"; return 0; fi
  TMP=${TMP:-$(mktemp -d)}
  : >"$TMP/vyre.env"
  if [ -e "$DIR/vyre.env" ]; then
    # shellcheck disable=SC2024
    if [ -r "$DIR/vyre.env" ] || [ -z "$SUDO" ]; then grep -v -e '^VYRE_SETUP_CODE=' -e '^VYRE_SETUP_CODE_AT=' "$DIR/vyre.env" >"$TMP/vyre.env" || true
    else sudo cat "$DIR/vyre.env" | grep -v -e '^VYRE_SETUP_CODE=' -e '^VYRE_SETUP_CODE_AT=' >"$TMP/vyre.env" || true
    fi
  fi
  chmod 600 "$TMP/vyre.env"
  printf 'VYRE_SETUP_CODE_AT=%s\nVYRE_SETUP_CODE=%s\n' "$(date +%s)" "$CODE" >>"$TMP/vyre.env"
  put "$TMP/vyre.env" "$DIR/vyre.env" 0600
}

# one_install: an install that is already running here is updated, never replaced.
one_install() {
  [ -f "$DIR/compose.yml" ] || return 0
  command -v docker >/dev/null 2>&1 || return 0
  up=$(dk_quiet compose -p vyre ps -q 2>/dev/null | head -n 1 || true)
  [ -n "$up" ] || return 0
  say "Vyre is already running in $DIR, so this installer leaves it alone."
  say "  Update it:    vyre update"
  say "  Start over:   vyre uninstall, then run this line again"
  exit 0
}

# docker_flavor: the Docker this installer knows. Snap, rootless and Podman each break something
# specific (the TUN device, the socket group, compose.yml itself), so they stop here in plain words.
docker_flavor() {
  command -v docker >/dev/null 2>&1 || return 0
  case "$(command -v docker)" in
    /snap/*|*/snap/bin/*) die "this Docker came from snap, which cannot give the Tailscale container a TUN device. Install Docker Engine from docker.com instead: curl -fsSL https://get.docker.com | sh" ;;
  esac
  if docker --version 2>/dev/null | grep -qi podman; then
    die "this is Podman answering as docker. Vyre needs Docker Engine with Compose v2: curl -fsSL https://get.docker.com | sh"
  fi
  if dk_quiet info --format '{{.SecurityOptions}}' 2>/dev/null | grep -qi rootless; then
    die "this Docker runs rootless, which cannot run the Tailscale container's network. Install the regular Docker Engine: curl -fsSL https://get.docker.com | sh"
  fi
}

# read_release: the image digests release.json names (its SHA256SUMS line already matched), and a
# check that the released compose.yml pins the same ones.
read_release() {
  # Fail closed: a release that names no image digests cannot be checked, so it does not install
  # (VYRE_BUILD=tgz builds from the verified vyre.tgz instead and never pulls an image).
  if [ ! -f "$TMP/release.json" ]; then
    [ "${VYRE_BUILD:-}" = tgz ] && return 0
    die "this release has no release.json in its SHA256SUMS, so its image cannot be verified. Nothing was installed. (VYRE_BUILD=tgz builds from source instead.)"
  fi
  j=$(tr -d '\n' <"$TMP/release.json")
  BOX_REF=$(printf '%s' "$j" | sed -n 's/.*"box": *{[^}]*"ref": *"\([^"]*\)".*/\1/p')
  COMPUTER_REF=$(printf '%s' "$j" | sed -n 's/.*"computer": *{[^}]*"ref": *"\([^"]*\)".*/\1/p')
  if [ -z "$BOX_REF" ] && [ "${VYRE_BUILD:-}" != tgz ]; then
    die "release.json names no image digest for the box, so it cannot be verified. Nothing was installed. (VYRE_BUILD=tgz builds from source instead.)"
  fi
  # Every image the compose file starts is pinned by digest, so an edit cannot slip in a moving tag.
  if [ -n "$BOX_REF" ]; then
    unpinned=$(sed -n 's/^ *image: *//p' "$TMP/compose.yml" | grep -v '@sha256:[0-9a-f]\{64\}' || true)
    [ -z "$unpinned" ] || die "compose.yml starts an image that is not pinned by digest ($(printf '%s' "$unpinned" | head -n 1)). Nothing was installed."
  fi
  for ref in $BOX_REF $COMPUTER_REF; do
    printf '%s' "$ref" | grep -Eq '^ghcr\.io/vyre-ai/[a-z-]+@sha256:[0-9a-f]{64}$' \
      || die "release.json names an image that is not a ghcr.io/vyre-ai digest"
    grep -qF "$ref" "$TMP/compose.yml" || die "compose.yml does not pin $ref, which release.json names"
  done
}

# verify_images: each named image is signed by our release workflow, then the box image is
# pulled by digest. Fail closed, and never skippable.
verify_images() {
  [ -n "$BOX_REF" ] || return 0
  say "checking the image signature"
  for ref in $BOX_REF $COMPUTER_REF; do
    if ! dk docker run --rm "$COSIGN_IMAGE" verify --certificate-identity-regexp "$COSIGN_ID" \
      --certificate-oidc-issuer "$COSIGN_ISSUER" "$ref" >/dev/null 2>"$TMP/cosign.err"; then
      sed 's/^/  /' "$TMP/cosign.err" >&2
      die "cosign could not verify $ref against Vyre's release workflow. Nothing was installed."
    fi
  done
  dk docker pull -q "$BOX_REF" >/dev/null
  done_step "signed by Vyre's release workflow, and pulled by digest"
}

uninstall() {
  # The wrapper is the one uninstall (box/vyre): it lists every volume and asks once. --purge asks
  # (or deletes with --yes); plain --uninstall keeps the data.
  if [ -f "$DIR/compose.yml" ] && [ -e "$WRAPPER" ] && grep -q "$MARK" "$WRAPPER" 2>/dev/null; then
    flag=--keep-data
    if [ "$PURGE" = 1 ]; then flag=""; [ "$YES" = 0 ] || flag=--delete-data; fi
    # shellcheck disable=SC2086 # flag is one option or nothing
    dk env "VYRE_DIR=$DIR" "VYRE_WRAPPER=$WRAPPER" "$WRAPPER" uninstall $flag
    return 0
  fi
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

# mac_server "$@": on a Mac the same line installs the Mac as the server: the script for it comes from the release site,
# is checked against SHA256SUMS like every file here, and runs with the same arguments and VYRE_CODE still in its environment.
mac_server() {
  case "$BASE" in */) ;; *) BASE="$BASE/" ;; esac
  TMP=$(mktemp -d)
  trap cleanup EXIT
  get_sums
  get install-mac-server.sh
  sh "$TMP/install-mac-server.sh" "$@"
  return $?
}

main() {
  if [ "$(uname -s)" = Darwin ]; then mac_server "$@"; exit $?; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --yes|-y) YES=1 ;;
      --from) [ $# -ge 2 ] || die "--from needs a folder"; FROM=$2; shift ;;
      --from=*) FROM=${1#--from=} ;;
      --print-link) LINK_ONLY=1 ;;
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      --code|--code=*) die "the setup code is never a command-line argument, since a process list shows arguments. Set VYRE_CODE for sh instead: curl -fsSL https://vyre.run/i | VYRE_CODE=... sh" ;;
      -h|--help) sed -n '2,14p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  [ "$PURGE" = 1 ] && [ "$UNINSTALL" = 0 ] && die "--purge goes with --uninstall"

  case "$(uname -s)" in
    Linux) ;;
    *) die "this installer is for a Linux server, or a Mac (which runs install-mac-server.sh from the same site)" ;;
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
  intake_code
  [ "$DRY" = 1 ] || mbx_init
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
  docker_flavor
  one_install
  if command -v docker >/dev/null 2>&1; then done_step "Docker, Compose and the TUN device are there"
  else done_step "Docker would be installed first (dry run)"
  fi
  if [ -n "$FROM" ]; then step "Reading the box files"; else step "Downloading and verifying"; fi
  write_stack
  write_env
  write_code
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
    show_words
  fi
  finish
}

main "$@"
