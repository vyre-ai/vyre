#!/bin/sh
# install-box.sh: put Vyre on a Linux box with Docker Compose. This is what
# `curl -fsSL https://vyre.run/install.sh | sh` runs.
#
#   --dry-run          print every change, make none (read-only checks still run)
#   --yes              answer yes to every prompt
#   --from DIR         use the box files in a local checkout DIR and build the image from it
#   --print-link       end with only VYRE_PAIRED=<space> or VYRE_PAIR=<command> on stdout, for a
#                      program to read; everything else goes to stderr (or VYRE_LINK_ONLY=1)
#   --uninstall        stop the stack and remove /usr/local/bin/vyre; volumes stay
#   --purge            with --uninstall: also delete the volumes, after asking
#
#   --version V        install release V (the app that runs `vyre box add` passes its own); latest takes whatever
#                      the release site serves. A site serving another version stops the install, saying which.
#
# Environment: VYRE_DIR (default /srv/vyre), VYRE_BOX_URL (default https://vyre.run/box/),
# VYRE_IMAGE (default ghcr.io/vyre-ai/vyre:latest), VYRE_BUILD=tgz to build from vyre.tgz even
# when the image can be pulled, VYRE_STORE (auto, the default: each space on Records when this server has room; or sqlite: the small built-in store, 2 GB is enough),
# and VYRE_CODE: the one-time setup code the Vyre app makes when a server is added, for the
# install line `curl -fsSL https://vyre.run/i | VYRE_CODE=... VYRE_STORE=auto sh` (the variable goes on sh, the reader
# of the script: on curl it would never reach it, and sudo drops it, so run it as yourself). The code is never a command-line
# argument (a process list shows arguments); without one, and on a terminal, it is asked for and
# Enter skips it. It goes only into $VYRE_DIR/vyre.env (0600) as VYRE_SETUP_CODE (VYRE_CODE stays the host-side pipe), which the box reads once
# at start, and is never printed. With a code, each step is also sent, sealed under a key only the
# app that made the code can derive from it, to the relay's progress mailbox (VYRE_RELAY, default
# https://relay.vyre.run) so the app shows the install as it happens. That needs curl and openssl; without
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
WANT=${VYRE_VERSION:-}
DEVSIGNED=0
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
  say "  Installing Vyre on this server. This takes about two minutes."
  say "  It checks the download against Vyre's signature before it installs anything."
  say "  When it finishes, go back to the Vyre app."
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

# rule: a short line across, before the finish.
rule() {
  if [ "$COLOR" = 1 ]; then
    r=$(printf '\342\224\200')
    say "  $ASH$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$r$RESET"
  else
    say "  ------------------------"
  fi
}

# finish: what just happened and the one next step. It ends on that step, with no sign-off.
finish() {
  say ""
  rule
  if [ "$DRY" = 1 ]; then
    say "  $BOLD${BONE}That's the whole plan.$RESET Nothing on this server changed."
    say "  Run it again without --dry-run when you're ready."
  elif [ "${VYRE_NO_UP:-0}" = 1 ]; then
    say "  $BOLD${BONE}Installed.$RESET Start it when you're ready: ${SIGNAL}vyre up$RESET"
  else
    say "  $BOLD${BONE}Vyre is running on this server.$RESET"
    # The custody notice the user approved (kernel/seal/process.js custodyNote, server profile): said where the install says what it set up.
    say "  About your keys: $CUSTODY_NOTE"
    if [ "$LINK_ONLY" = 1 ]; then
      say "  Whether it is paired went to stdout for the program that asked."
    else
      if [ -n "$CODE" ]; then
        say "  Go back to the Vyre app to finish."
      else
        say "  Open the Vyre app, choose \"Add a server\", and run the line it shows on this server."
      fi
    fi
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

# docker_apt_install: Docker from Docker's own signed apt repository, for a root run on Ubuntu or Debian (the most common server there is): no question, no piped script.
# Returns 1 when this is not that kind of server (the caller then keeps the older message), and stops with the log's path when the packages did not install.
docker_apt_install() {
  [ "${VYRE_APT_AS_ROOT:-$(id -u)}" = 0 ] || return 1
  osr=${VYRE_OS_RELEASE:-/etc/os-release}
  aroot=${VYRE_APT_ROOT:-}   # tests only: a folder standing in for /
  [ -r "$osr" ] || return 1
  # shellcheck source=/dev/null
  os_id=$(. "$osr"; printf '%s' "${ID:-}")
  case "$os_id" in ubuntu|debian) ;; *) return 1 ;; esac
  command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1 || return 1
  # shellcheck source=/dev/null
  os_code=$(. "$osr"; if [ "$ID" = ubuntu ]; then printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"; else printf '%s' "${VERSION_CODENAME:-}"; fi)
  [ -n "$os_code" ] || return 1
  if [ "$DRY" = 1 ]; then say "would install Docker from Docker's apt repository for $os_id $os_code"; return 0; fi
  dlog=$(mktemp "${TMPDIR:-/tmp}/vyre-docker-install.XXXXXX")
  say "  ${ASH}Installing Docker (about a minute).$RESET"
  if ! {
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y && apt-get install -y ca-certificates curl \
      && install -m 0755 -d "$aroot/etc/apt/keyrings" "$aroot/etc/apt/sources.list.d" \
      && curl -fsSL "https://download.docker.com/linux/$os_id/gpg" -o "$aroot/etc/apt/keyrings/docker.asc" \
      && chmod a+r "$aroot/etc/apt/keyrings/docker.asc" \
      && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$os_id" "$os_code" >"$aroot/etc/apt/sources.list.d/docker.list" \
      && apt-get update -y \
      && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  } >"$dlog" 2>&1; then
    die "Docker did not install. Its own output is in $dlog; after fixing that, run this installer again."
  fi
  rm -f "$dlog"
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
  return 0
}

need_docker() {
  cmd="curl -fsSL https://get.docker.com | sh"
  if ! command -v docker >/dev/null 2>&1 && docker_apt_install; then [ "$DRY" != 1 ] || return 0
  elif ! command -v docker >/dev/null 2>&1; then
    if ask "Docker is not installed. Install it now with: $cmd ?"; then
      if [ "$DRY" = 1 ]; then priv sh -c "$cmd"; return 0; fi
      # Docker's own script is long and loud (rootless notes, API warnings). Its output goes to a log; the screen gets one line, and the log's path only if it fails.
      dlog=$(mktemp "${TMPDIR:-/tmp}/vyre-docker-install.XXXXXX")
      say "  ${ASH}Installing Docker. This takes a minute or two.$RESET"
      if ! priv sh -c "$cmd" >"$dlog" 2>&1; then
        die "Docker did not install. Its own output is in $dlog; after fixing that, run this installer again."
      fi
      rm -f "$dlog"
    else
      say "Vyre runs in Docker. Install it with:"
      say "  $cmd"
      say "then run this installer again."
      exit 1
    fi
  fi
  if ! compose_ok; then
    if docker compose version >/dev/null 2>&1; then
      say "This server needs a newer Docker (Compose 2.24 or newer; this server has $(docker compose version --short))."
    else
      say "This server needs a newer Docker (the \`docker compose\` plugin, version 2)."
    fi
    say "Update Docker with its own packages (docker-ce, docker-compose-plugin), or with:"
    say "  $cmd"
    say "then run the line again."
    exit 1
  fi
  if docker info >/dev/null 2>&1; then DOCKER_SUDO=""
  elif [ -n "$SUDO" ] && sudo docker info >/dev/null 2>&1; then DOCKER_SUDO=sudo
  else die "Docker is installed but not running. Start it (sudo systemctl start docker) and run this again."
  fi
  docker_at_boot
}

# docker_at_boot: the box's containers carry restart: unless-stopped, but they only come back after a reboot if Docker itself starts at boot. Docker's own install script enables it; a Docker that
# was installed another way may not be. Turn it on (and containerd, which Docker needs) so the server returns by itself after a restart or a power cut, with nobody logged in.
docker_at_boot() {
  command -v systemctl >/dev/null 2>&1 || return 0
  for u in docker containerd; do
    systemctl cat "$u" >/dev/null 2>&1 || continue
    if [ "$(systemctl is-enabled "$u" 2>/dev/null || true)" != enabled ]; then
      if [ "$DRY" = 1 ]; then priv systemctl enable "$u"; else priv systemctl enable "$u" >/dev/null 2>&1 || say "  note: could not make $u start at boot; run: sudo systemctl enable $u"; fi
    fi
  done
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

# check_version: the version this install was asked for (--version, or VYRE_VERSION) against the one the release site serves. The release
# site holds one release, so a different version is refused with both named, never installed quietly. "latest" and no version take what is served.
check_version() {
  case "$WANT" in ""|latest) return 0 ;; esac
  case "$WANT" in *[!0-9A-Za-z.-]*) die "--version $WANT is not a version like 0.2.9" ;; esac
  awk '$2 == "VERSION" || $2 == "*VERSION" { f = 1 } END { exit !f }' "$TMP/SHA256SUMS" || die "this release site does not say which version it serves, so $WANT cannot be checked. Nothing was installed. (Run with --version latest to install what it serves, or install a build that is not published from a checkout with --from <folder>.)"
  get VERSION
  have=$(tr -d '[:space:]' <"$TMP/VERSION")
  [ "$have" = "$WANT" ] || die "this install was asked for Vyre $WANT, but $BASE serves $have. Nothing was installed. Install $have with --version $have (or --version latest), point VYRE_BOX_URL at a site that serves $WANT, or, for a build that is not published yet, install from a checkout of it with --from <folder>."
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

# dev_sign: an install from a checkout has no release to verify, so it makes its own, in a throwaway container of the pinned node image: the checkout is packed like a release is (npm pack),
# unpacked, a throwaway key (never kept) replaces the pinned release key in THAT copy only, and the copy's module list is signed with it (scripts/dev-sign.mjs). The box is then built from the
# copy and published the list, so it boots its signed modules with no path rule and no development switch. The checkout and the real release key are never touched. A tampered module is refused as in a release.
dev_sign() {
  TMP=$(mktemp -d)
  nodeimg=$(sed -n 's/^FROM \(node:[^ ]*\).*/\1/p' "$FROM/box/Dockerfile" | head -n 1)
  [ -n "$nodeimg" ] || die "$FROM/box/Dockerfile names no node image to pack and sign with"
  say "packing the checkout and signing it with a throwaway key (this install only)"
  dk docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$FROM:/from:ro" -v "$TMP:/out" "$nodeimg" sh -c '
    set -e
    mkdir /tmp/w /tmp/u && cd /from && tar --exclude=.git --exclude=node_modules --exclude=./site/box -cf - . | tar -C /tmp/w -xf -
    cd /tmp/w && npm pack --silent --pack-destination /tmp >/dev/null
    tar -xzf /tmp/*.tgz -C /tmp/u --strip-components=1
    node /from/scripts/dev-sign.mjs --root /tmp/u --out /out
    cp /tmp/u/box/vyre /out/vyre
    tar -czf /out/vyre.tgz --transform "s,^\./,package/," -C /tmp/u .
  ' || die "could not pack and sign the checkout (see the lines above); nothing was installed"
  # shellcheck disable=SC2015 # A && B || C on purpose: C is the refusal
  [ -s "$TMP/vyre.tgz" ] && [ -s "$TMP/SHA256SUMS.sig" ] || die "the packed checkout is incomplete; nothing was installed"
  TGZ=1; DEVSIGNED=1
  # An image left from an earlier install is used as it is (compose never rebuilds a present vyre:local), so it would run the OLD tree with none of this signing: remove it, and the box is built fresh.
  dk docker image rm -f vyre:local >/dev/null 2>&1 || true
  unpack
  WRAPPER_SRC="$TMP/vyre"
  done_step "the checkout is signed for this server only"
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
    # VYRE_DEV_SIGN=0 skips it (the tests' stub docker makes no files); the box then needs VYRE_KERNEL_PATH_RULE=1 to run its modules.
    { [ "$DRY" = 1 ] || [ "${VYRE_DEV_SIGN:-1}" = 0 ]; } || dev_sign
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
      check_version
      if awk '$2 == "release.json" || $2 == "*release.json" { f = 1 } END { exit !f }' "$TMP/SHA256SUMS"; then
        get release.json
      fi
      # compose.yml first: read_release checks it pins the digests release.json names.
      get compose.yml
      read_release
      pick_build
      [ "$TGZ" = 1 ] && files="$files vyre.tgz"
      for f in $files; do [ -f "$TMP/$f" ] || get "$f"; done
      # The signed list of first-party modules (and shell.json) the release carries: checked against SHA256SUMS like every file, and placed for the box by
      # publish_signed_files once the wrapper is installed.
      for f in modules.json shell.json appbuild.json; do
        if awk -v p="$f" '$2 == p || $2 == "*" p { x = 1 } END { exit !x }' "$TMP/SHA256SUMS"; then get "$f"; fi
      done
      fetch SHA256SUMS.sig "$TMP/SHA256SUMS.sig" 2>/dev/null || rm -f "$TMP/SHA256SUMS.sig"
      done_step "The download matches Vyre's signature"
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
# it is where the person adds COMPOSE_PROFILES and anything else of theirs. The one
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
      if [ "${DEVSIGNED:-0}" = 1 ]; then printf '%s\n' "VYRE_SOURCE=$DIR/src"; else printf '%s\n' "VYRE_SOURCE=$FROM"; fi
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
# publish_signed_files: the release's SHA256SUMS, its signature, modules.json and shell.json go where the box reads them (the wrapper's publish-release checks the
# signature with the pinned release key and publishes nothing for an unsigned release). Not for an install from a checkout, which has none of them.
publish_signed_files() {
  [ "$DRY" != 1 ] && { [ -z "$FROM" ] || [ "${DEVSIGNED:-0}" = 1 ]; } && [ -s "$TMP/SHA256SUMS.sig" ] || return 0
  if ! priv env "VYRE_DIR=$DIR" "$WRAPPER" publish-release "$TMP"; then
    # A release with a signed module list that cannot be placed would start a box whose modules the kernel refuses: stop here, plainly.
    [ ! -f "$TMP/modules.json" ] || die "the release's signed files could not be placed, so the box would start with no modules; nothing was started. See the line above, then run this again."
    say "note: could not place the release's signed files; vyre update will"
  fi
}
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

# The Space helper (box/vyre `space-helper`): the root path unit that starts a Space's Twenty store and firewalls it from the agents, on vyred's request. It records the
# image vyre runs, so it is installed once the container is up. It is required: a space on a server runs on Twenty, and without the helper (or its images) it
# would have no store. A failure stops the install with the helper's own cause (an image that could not be pulled names the image and the registry's reason).
install_space_helper() {
  [ "$DRY" != 1 ] && [ -z "${VYRE_WRAPPER:-}" ] || return 0
  priv env "VYRE_DIR=$DIR" "$WRAPPER" space-helper install || die "the Space helper could not be set up (the cause is the line above), so a space on this server would have no records store. Vyre is running but unfinished; fix the cause, then run: sudo vyre space-helper install, and pair the server after it"
}

# Start the stack. VYRE_DIR and SSH_CONNECTION are passed on because sudo drops them, and the
# wrapper needs SSH_CONNECTION to print the ssh -L line.
# verify_up: the installer says it is done only when the vyre container is running. `vyre up` can end without starting it (a root run
# refuses a box built from a checkout, see box/vyre prepare_run), and an exit status alone must not read as an installed box.
verify_up() {
  i=0
  until [ -n "$(dk_quiet ps -q --filter name=vyre-vyre-1 --filter status=running 2>/dev/null | head -n 1)" ]; do
    i=$((i + 1))
    [ $i -lt "${VYRE_VERIFY_TRIES:-30}" ] || die "the install finished but Vyre is not running; see: docker compose -p vyre ps (in $DIR), then run: vyre up"
    sleep 2
  done
  # The Space helper goes in now, before the wait for modules: the container's entry holds the daemon back until the helper has proved the firewall for this start (core/spawner/space-wall.sh), so
  # waiting for modules first can never end. A reinstall also finds the helper's record of the old image here, and replaces it with this one (no `sudo vyre space-helper install` by hand).
  install_space_helper
  # Running is not enough: a box whose modules did not start (a build the kernel does not recognise as signed) answers its socket with nothing behind it. Say so, loudly, with the reason.
  [ "${VYRE_MODULES_TRIES:-60}" != 0 ] || return 0   # a test seam: the tests' stub docker runs no daemon
  j=0; mods=0
  while [ "$j" -lt "${VYRE_MODULES_TRIES:-60}" ]; do
    st=$(dk env "VYRE_DIR=$DIR" "$WRAPPER" status 2>/dev/null | tr -d '\033' || true)
    mods=$(printf '%s\n' "$st" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) modules running.*/\1/p' | head -n 1)
    [ "${mods:-0}" -gt 0 ] && return 0
    j=$((j + 1)); sleep 2
  done
  why=$(dk_quiet logs --tail 40 vyre-vyre-1 2>&1 | sed -n 's/.*\(modules from outside Vyre run only under[^"]*\).*/\1/p' | head -n 1)
  die "Vyre is running but none of its modules started${why:+ ($why)}. A box built from a checkout (--from) has no signed module list, so it cannot run them: install a release, or build one with scripts/build-site.sh and install from that. Nothing is set up on this server."
}
# verify_running_build: the container that is running must be the build just laid out. An install from a tree (--from, or a tgz) builds its image from DIR/src; a stale image left by an earlier
# install would otherwise run the OLD tree while this installer reports the new one. The kind and the pinned key (lib/build-kind.js, lib/release-sig.js) and the version are compared byte for byte.
verify_running_build() {
  [ -d "$DIR/src/lib" ] || return 0
  [ "$TGZ" = 1 ] || [ -n "$FROM" ] || return 0
  for f in lib/build-kind.js lib/release-sig.js package.json; do
    [ -f "$DIR/src/$f" ] || continue
    want=$(sha256 "$DIR/src/$f")
    got=$(dk docker exec vyre-vyre-1 sha256sum "/opt/vyre/$f" 2>/dev/null | cut -d' ' -f1)
    [ "$want" = "$got" ] || die "the server is running an older build than the one installed ($f differs from the copy in $DIR/src). Remove the old image (docker image rm -f vyre:local), then run this installer again. Nothing is set up."
  done
}
start() {
  say ""
  # A root run of `vyre up` refuses a box built from a checkout (--from) once the updater has recorded it, so when the installer runs as
  # root for someone else's account, the first start is that account's own.
  as_owner=0
  if [ "$(id -u)" = 0 ] && [ -n "$FROM" ] && [ -n "$OWNER" ] && [ "$OWNER" != root ] && sudo -n -u "$OWNER" docker info >/dev/null 2>&1; then as_owner=1; fi
  # --quiet: the installer says what happens next itself (the pairing, or the check words), so `vyre up` adds no "already running" and no command.
  upflag="--quiet"
  [ "$LINK_ONLY" = 1 ] && upflag="--print-link"
  if [ "$as_owner" = 1 ]; then
    dk sudo -n -u "$OWNER" env "VYRE_DIR=$DIR" "SSH_CONNECTION=${SSH_CONNECTION:-}" "$WRAPPER" up ${upflag:+"$upflag"}
  else
    dk env "VYRE_DIR=$DIR" "SSH_CONNECTION=${SSH_CONNECTION:-}" "$WRAPPER" up ${upflag:+"$upflag"}
  fi
  if [ -n "$DOCKER_SUDO" ]; then
    say ""
    say "Your account cannot use Docker, so run vyre commands with sudo, like: sudo vyre up."
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
    409) printf 'vyre: Another server already used this code. Run the install line again to get a new code.\n' >&2; exit 1 ;;
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
# never go through the relay mailbox. The call goes the way `vyre up` went (through sudo when this account cannot reach Docker); when
# that gives nothing, sudo is tried once more, since the box answers a root caller the account itself may not be. Words that still
# cannot be read are said so, with the one command that shows them: the page asks for them either way.
show_words() {
  [ -n "$CODE" ] && [ "$DRY" = 0 ] || return 0
  n=0; told=
  # A first start (the record store, the relay link) can take a few minutes: wait up to three, saying so once, before giving the fallback (the 0.2.12 live walk saw both).
  while [ "$n" -lt "${VYRE_WORDS_TRIES:-180}" ]; do
    [ "$n" != 10 ] || say "  Waiting for the four words while Vyre starts (this can take a few minutes the first time)..."
    out=$(dk env "VYRE_DIR=$DIR" "$WRAPPER" call relay.setup.status 2>/dev/null | tr -d '\n' || true)
    words=$(printf '%s' "$out" | sed -n 's/.*"words": *"\([a-z][a-z ]*\)".*/\1/p')
    if [ -z "$words" ] && [ -z "$DOCKER_SUDO" ] && [ -n "$SUDO" ] && [ "$n" -ge 2 ]; then
      out=$(sudo -n env "VYRE_DIR=$DIR" "$WRAPPER" call relay.setup.status 2>/dev/null | tr -d '\n' || true)
      words=$(printf '%s' "$out" | sed -n 's/.*"words": *"\([a-z][a-z ]*\)".*/\1/p')
    fi
    if [ -n "$words" ]; then say "  Your four words: $BOLD$words$RESET"; say "  Go back to the Vyre app. If it shows the same four, choose Same."; return 0; fi
    # the box says why it did not use the code (a code older than an hour, a box that already has an owner): say it now, not after three minutes of waiting
    why=$(printf '%s' "$out" | sed -n 's/.*"failed": *true.*"why": *"\([^"]*\)".*/\1/p')
    if [ -n "$why" ]; then say "  Vyre could not start the pairing: $why"; say "  Make a new install line in the Vyre app and run it again."; return 0; fi
    # a busy relay is waited out by the box itself; say so once, and keep waiting
    if [ -z "$told" ]; then
      busy=$(printf '%s' "$out" | sed -n 's/.*"retrying": *true.*"why": *"\([^"]*\)".*/\1/p')
      if [ -n "$busy" ]; then told=1; say "  The relay is busy right now: Vyre keeps trying on its own ($busy)."; fi
    fi
    n=$((n + 1)); sleep 1
  done
  say "  The four words did not show yet. To see them, run: ${BOLD}${SUDO:+sudo }vyre words${RESET}"
}

# intake_code: the setup code from VYRE_CODE, for a program that installs for someone (the old browser setup page). It is never asked for on the terminal any more: the only
# thing this installer asks a person is nothing: the Vyre app does the pairing (the four words), by the ruling that setup is one place. Never an argument, never echoed. The shape is base64url of 32 bytes: 43 characters.
intake_code() {
  CODE=${VYRE_CODE:-}
  unset VYRE_CODE
  [ "$UNINSTALL" = 1 ] && { CODE=""; return 0; }
  [ -n "$CODE" ] || return 0
  printf '%s' "$CODE" | grep -Eq '^[A-Za-z0-9_-]{43}$' \
    || die "that setup code does not look right. Copy the install line from your browser again."
}

# write_code: VYRE_SETUP_CODE into DIR/vyre.env (0600), which the vyre service already reads, with the time it
# was written so `vyre` can remove both lines once the hour is over (the box reads the code once, at
# start, and never keeps it). The rest of the file is kept as it is, and put installs from a temp file
# so the code is never an argument.
# write_kernel_env: the 0.3 settings, put into vyre.env once on a fresh install: the kernel on, and each Space on Twenty when this server has
# room for it; only a server too small for Twenty gets the small built-in store. Never touches a vyre.env that already names either (a person's choice stays), and never the setup code lines.
write_kernel_env() {
  [ "$DRY" = 1 ] && { say "would write the 0.3 settings to $DIR/vyre.env"; return 0; }
  TMP=${TMP:-$(mktemp -d)}
  : >"$TMP/vyre.kernel"
  if [ -e "$DIR/vyre.env" ]; then
    # shellcheck disable=SC2024
    if [ -r "$DIR/vyre.env" ] || [ -z "$SUDO" ]; then cat "$DIR/vyre.env" >"$TMP/vyre.kernel"; else sudo cat "$DIR/vyre.env" >"$TMP/vyre.kernel"; fi
    [ ! -s "$TMP/vyre.kernel" ] || [ -z "$(tail -c 1 "$TMP/vyre.kernel")" ] || printf '\n' >>"$TMP/vyre.kernel"
  fi
  chmod 600 "$TMP/vyre.kernel"
  grep -q '^VYRE_KERNEL=' "$TMP/vyre.kernel" || printf 'VYRE_KERNEL=1\n' >>"$TMP/vyre.kernel"
  grep -q '^VYRE_STORE=' "$TMP/vyre.kernel" || printf 'VYRE_STORE=%s\n' "${STORE_CHOICE:-${VYRE_STORE:-auto}}" >>"$TMP/vyre.kernel"
  put "$TMP/vyre.kernel" "$DIR/vyre.env" 0600
}

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
  say "Vyre is already running here, so nothing was changed."
  say "  To update it, run: vyre update"
  say "  To start over, run: vyre uninstall, then run the line again."
  exit 0
}

# early_one_install: the same check before the mailbox opens. A second paste of the same line must
# post nothing: its lines would restart at position 0 and the page would reject them as out of order.
early_one_install() {
  [ "$DRY" = 1 ] && return 0
  [ "$UNINSTALL" = 1 ] && return 0
  [ -f "$DIR/compose.yml" ] || return 0
  command -v docker >/dev/null 2>&1 || return 0
  if docker info >/dev/null 2>&1; then DOCKER_SUDO=""
  elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then DOCKER_SUDO=sudo
  else return 0
  fi
  one_install
  DOCKER_SUDO=""
}

# The memory one Space's larger (Twenty) store needs on this server, in MB: the same number as stores/twenty/space-store.js REQUIRE.memoryMb
# (test/install-box-v2.test.js keeps the two equal; records sets it). Disk is the images and one Space's volumes.
# The sealing key's custody on a server, word for word as kernel/seal/process.js custodyNote("server") says it (test/install-box-v2.test.js keeps them equal).
CUSTODY_NOTE="The sealing key is a file owned by the sealing process's own user. Root on this server, or a stolen disk, can read it."
SPACE_MEM_MB=${VYRE_SPACE_MEM_MB:-3212}
# A server under 6 GB of memory (TINY_BELOW_MB in stores/twenty/provision.js) gets the tiny profile, whose measured need is stores/twenty/space-store.js requireFor(4096).memoryMb; the test keeps both equal.
SPACE_MEM_TINY_MB=${VYRE_SPACE_MEM_TINY_MB:-2521}
TINY_BELOW_MB=6144
SPACE_DISK_MB=${VYRE_SPACE_DISK_MB:-6144}
# preflight: say plainly what this server can host. A box too small for Twenty runs on the small built-in store, which is a choice the person
# should hear before installing, not after. Reads MemAvailable and the free disk under $DIR; never fails the install.
preflight() {
  mem=""; disk=""
  if [ -r /proc/meminfo ]; then mem=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo); fi
  d="$DIR"; [ -d "$d" ] || d=$(dirname "$DIR")
  [ -d "$d" ] || d=/
  disk=$(df -Pk "$d" 2>/dev/null | awk 'NR == 2 {print int($4 / 1024)}')
  if [ -z "$mem" ]; then say "  Memory could not be read here. Vyre uses Records if there is room, and the small built-in store if not."; return 0; fi
  # the same rule the daemon uses: a machine under 6 GB is measured against the tiny profile's need, not the small one's
  total=""; if [ -r /proc/meminfo ]; then total=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo); fi
  SPACE_MEM_MB_USED=$SPACE_MEM_MB
  if [ -n "$total" ] && [ "$total" -gt 0 ] && [ "$total" -lt "$TINY_BELOW_MB" ]; then SPACE_MEM_MB_USED=$SPACE_MEM_TINY_MB; fi
  fit=$(( (mem - 300) / (SPACE_MEM_MB_USED - 300) )); [ "$fit" -ge 0 ] || fit=0
  if [ -n "$disk" ] && [ "$disk" -lt "$SPACE_DISK_MB" ]; then
    say "  This server has $((mem / 1024)).$(( (mem % 1024) * 10 / 1024 )) GB of memory free but only $disk MB of disk, and Records needs $SPACE_DISK_MB MB. Vyre will use the small built-in store."
  elif [ "$fit" -ge 1 ]; then
    say "  This server has $((mem / 1024)).$(( (mem % 1024) * 10 / 1024 )) GB of memory free: room for $fit space$([ "$fit" = 1 ] || printf s) with Records (each needs about $((SPACE_MEM_MB_USED / 1024)).$(( (SPACE_MEM_MB_USED % 1024) * 10 / 1024 )) GB)."
  else
    say "  This server has $((mem / 1024)).$(( (mem % 1024) * 10 / 1024 )) GB of memory free. Records needs about $((SPACE_MEM_MB_USED / 1024)).$(( (SPACE_MEM_MB_USED % 1024) * 10 / 1024 )) GB. That is more than this server has, so Vyre will use the small built-in store. Everything works; very large record sets are slower."
  fi
}

# docker_flavor: the Docker this installer knows. Snap, rootless and Podman each break something
# specific (the socket group, compose.yml itself), so they stop here in plain words.
docker_flavor() {
  command -v docker >/dev/null 2>&1 || return 0
  case "$(command -v docker)" in
    /snap/*|*/snap/bin/*) die "this Docker came from snap, whose confinement keeps the box from its Docker socket group. Install Docker Engine from docker.com instead: curl -fsSL https://get.docker.com | sh" ;;
  esac
  if docker --version 2>/dev/null | grep -qi podman; then
    die "this is Podman answering as docker. Vyre needs Docker Engine with Compose v2: curl -fsSL https://get.docker.com | sh"
  fi
  if dk_quiet info --format '{{.SecurityOptions}}' 2>/dev/null | grep -qi rootless; then
    die "this Docker runs rootless, which cannot give the box's Docker proxy the socket group it needs. Install the regular Docker Engine: curl -fsSL https://get.docker.com | sh"
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
  # Every image line of the compose file is exactly `image: <name>@sha256:<64 hex>` (no variable a .env can replace, no comment trick, no
  # tag), and the images release.json names are among those lines, whole.
  if [ -n "$BOX_REF" ]; then
    imgs=$(grep -E '^[[:space:]]*image:' "$TMP/compose.yml" || true)
    badimg=$(printf '%s\n' "$imgs" | grep -Ev '^[[:space:]]*image: [A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$' | grep -v '^$' || true)
    [ -z "$badimg" ] || die "compose.yml starts an image that is not pinned by digest ($(printf '%s' "$badimg" | head -n 1 | sed 's/^[[:space:]]*//')). Nothing was installed."
  fi
  for ref in $BOX_REF $COMPUTER_REF; do
    printf '%s' "$ref" | grep -Eq '^ghcr\.io/vyre-ai/[a-z-]+@sha256:[0-9a-f]{64}$' \
      || die "release.json names an image that is not a ghcr.io/vyre-ai digest"
  done
  # The box ref is one of the image lines, whole. The computer image is not a service of the stack: compose.yml carries its ref as the default of
  # VYRE_COMPUTERS_IMAGE, on a line that is not a comment.
  if [ -n "$BOX_REF" ]; then
    printf '%s\n' "$imgs" | awk -v r="$BOX_REF" '{ sub(/^[ \t]*image:[ \t]*/, ""); if ($0 == r) f = 1 } END { exit !f }' || die "compose.yml does not pin $BOX_REF, which release.json names"
  fi
  if [ -n "$COMPUTER_REF" ]; then
    cdef=$(grep -v '^[[:space:]]*#' "$TMP/compose.yml" | sed -n 's/.*VYRE_COMPUTERS_IMAGE:-\([^}[:space:]]*\)}.*/\1/p')
    if [ -z "$cdef" ] || printf '%s\n' "$cdef" | grep -qvxF "$COMPUTER_REF"; then die "every default of VYRE_COMPUTERS_IMAGE in compose.yml must be $COMPUTER_REF, which release.json names"; fi
  fi
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
  [ "${MAC_FROM:-0}" = 1 ] || check_version
  get install-mac-server.sh
  sh "$TMP/install-mac-server.sh" "$@"
  return $?
}

main() {
  if [ "$(uname -s)" = Darwin ]; then
    # The Mac server script takes no version, so it is taken out here and checked against the site before that script runs (the check is on every
    # path). The other arguments are passed on as they came: rotated through "$@", never word-split, so an argument with a space stays one.
    MAC_FROM=0
    n=$#
    while [ "$n" -gt 0 ]; do
      x=$1; shift; n=$((n - 1))
      case "$x" in
        --version) [ "$#" -ge 1 ] || die "--version needs a version (or latest)"; WANT=$1; shift; n=$((n - 1)) ;;
        --version=*) WANT=${x#--version=} ;;
        --from|--from=*) MAC_FROM=1; set -- "$@" "$x" ;;
        *) set -- "$@" "$x" ;;
      esac
    done
    mac_server "$@"; exit $?
  fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --yes|-y) YES=1 ;;
      --from) [ $# -ge 2 ] || die "--from needs a folder"; FROM=$2; shift ;;
      --from=*) FROM=${1#--from=} ;;
      --version) [ $# -ge 2 ] || die "--version needs a version (or latest)"; WANT=$2; shift ;;
      --version=*) WANT=${1#--version=} ;;
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
  case "${VYRE_STORE:-auto}" in auto|sqlite) ;; *) die "VYRE_STORE is auto (Records) or sqlite (the small built-in store), not ${VYRE_STORE}" ;; esac
  # kept in our own variable and taken out of the environment: this script runs as root on most servers (a fresh droplet logs in as root), and a root run of the vyre command refuses any VYRE_ setting it inherits (its root_guard)
  STORE_CHOICE=${VYRE_STORE:-auto}; unset VYRE_STORE
  early_one_install
  [ "$DRY" = 1 ] || mbx_init
  [ "$DRY" = 1 ] && say "dry run: nothing on this server will change"

  if [ "$UNINSTALL" = 1 ]; then
    command -v docker >/dev/null 2>&1 || die "Docker is not installed, so there is no stack to stop"
    need_docker
    uninstall
    exit 0
  fi

  [ "${VYRE_NO_UP:-0}" = 1 ] && STEPS=4
  step "Checking this server"
  pick_owner
  need_docker
  docker_flavor
  one_install
  preflight
  # An install from a checkout (--from) starts as the person, never as root (a root `vyre up` refuses a box built from a checkout), so that person
  # must reach Docker themselves. Say what to do now, before anything is laid out, instead of stopping later with the box half installed.
  if [ -n "$FROM" ] && [ "$DRY" != 1 ] && [ "$(id -u)" != 0 ] && [ -n "$DOCKER_SUDO" ]; then
    die "this account cannot reach Docker without sudo, and an install from a checkout starts as you. Run: sudo usermod -aG docker $(id -un), sign in again, then run this installer again (the docker group is root-equivalent on this server)."
  fi
  if command -v docker >/dev/null 2>&1; then done_step "This server is ready"
  else done_step "Docker would be installed first (dry run)"
  fi
  if [ -n "$FROM" ]; then step "Reading the box files"; else step "Downloading Vyre"; fi
  write_stack
  write_env
  write_kernel_env
  write_code
  if [ "$DRY" = 1 ]; then done_step "nothing written (dry run)"; else done_step "$DIR is laid out"; fi
  step "Adding the vyre command"
  install_wrapper
  publish_signed_files
  if [ "$DRY" = 1 ]; then done_step "nothing installed (dry run)"; else done_step "vyre is at $WRAPPER"; fi
  # VYRE_NO_UP=1: everything but starting it, for `vyre box move`, which streams the volumes in first.
  if [ "${VYRE_NO_UP:-0}" = 1 ]; then say "installed in $DIR; not started (VYRE_NO_UP=1). Start it with: vyre up"
  else
    step "Starting Vyre"
    start
    if [ "$DRY" = 1 ]; then done_step "nothing started (dry run)"; else verify_up; verify_running_build; done_step "Vyre is running";  fi
    show_words
  fi
  finish
}

main "$@"
