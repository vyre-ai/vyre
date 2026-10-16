#!/bin/sh
# i.sh: `curl -fsSL vyre.run/i | sh`. Put Vyre on a server and pair it to you.
#
#   1. Checks the system and the CPU, and says plainly when it is not one Vyre runs on.
#   2. Installs Docker if it is missing and starts the Vyre box. That is the signed release installer (box/install-box.sh from the same
#      site): it checks every file against the release's signature before anything is written, installs Docker when it is missing, and
#      leaves a box that is already running alone. This script adds nothing to what it installs.
#   3. With VYRE_CODE (the app's install line, or an agent's), the server installs and pairs itself. On a Mac the same line is handed to the Mac server installer. Without one, it prints the setup
#      page, where the person pastes the code the app shows. The code is an environment variable, never an argument.
#
# Run it again at any time: a server that is already installed is not touched. It never prints a secret, never takes the setup code as an
# argument, and writes nothing outside what the release installer writes.
#
# Environment: VYRE_SITE (default https://vyre.run), VYRE_INSTALLER (a local copy of install-box.sh, used instead of downloading),
# VYRE_WRAPPER (the vyre command, default vyre), VYRE_UNAME_S / VYRE_UNAME_M (tests). Every other variable and every argument goes to the
# release installer unchanged.
# Everything is inside main(), called on the last line, so a piped script is read whole before anything runs.

set -eu

SITE=${VYRE_SITE:-https://vyre.run}
WRAPPER=${VYRE_WRAPPER:-vyre}
UNAME_S=${VYRE_UNAME_S:-$(uname -s)}
UNAME_M=${VYRE_UNAME_M:-$(uname -m)}
TMP=""

say() { printf '%s\n' "$*"; }
die() { printf 'vyre: %s\n' "$*" >&2; exit 1; }
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }

# check_system: the systems Vyre's server runs on, the answer in plain words.
check_system() {
  case "$UNAME_S" in
    Linux|Darwin) ;;
    *) die "this is $UNAME_S. Vyre's server runs on Linux or a Mac. On Windows, use the Windows installer at $SITE." ;;
  esac
  case "$UNAME_M" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "this computer's processor ($UNAME_M) is not one Vyre runs on. It needs a 64-bit Intel, AMD or Arm processor." ;;
  esac
}

# fetch URL FILE: curl or wget, https only, no redirect to anything else.
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q --https-only -O "$2" "$1"
  else die "needs curl or wget to download Vyre"; fi
}

# host_addr: an address the person can open. A missing one is said as this-server.
host_addr() {
  ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  [ -n "$ip" ] || ip="this-server"
  printf '%s' "$ip"
}

install_box() {
  if command -v "$WRAPPER" >/dev/null 2>&1 && "$WRAPPER" call system.info '{}' >/dev/null 2>&1; then
    say "Vyre is already installed here. Leaving it as it is."
    return 0
  fi
  # An install from a checkout (--from DIR) uses that checkout's own installer, never the live one from the site.
  from_dir=""; prev=""
  for a in "$@"; do [ "$prev" = --from ] && from_dir=$a; case "$a" in --from=*) from_dir=${a#--from=} ;; esac; prev=$a; done
  if [ -n "${VYRE_INSTALLER:-}" ]; then cp "$VYRE_INSTALLER" "$TMP/install-box.sh"
  elif [ -n "$from_dir" ] && [ -f "$from_dir/scripts/install-box.sh" ]; then cp "$from_dir/scripts/install-box.sh" "$TMP/install-box.sh"
  else
    say "Downloading the Vyre installer from $SITE"
    fetch "$SITE/box/install-box.sh" "$TMP/install-box.sh"
  fi
  [ -s "$TMP/install-box.sh" ] || die "the installer came back empty"
  # The release installer checks Docker (and installs it when it is missing), then every file it fetches against the release signature.
  # VYRE_CODE stays in the environment for that installer. It is never an argument.
  sh "$TMP/install-box.sh" "$@"
}

main() {
  for a in "$@"; do
    case "$a" in
      --pair-to|--pair-to=*) die "Add the server from the Vyre app. It shows one install line." ;;
    esac
  done
  check_system
  TMP=$(mktemp -d)
  trap cleanup EXIT
  install_box "$@"
  if [ -n "${VYRE_CODE:-}" ]; then
    say "Go back to the Vyre app. This server pairs itself."
    return 0
  fi
  say "Open http://$(host_addr)/setup and paste the code the Vyre app shows. The page locks after pairing."
}

main "$@"
