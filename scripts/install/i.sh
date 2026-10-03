#!/bin/sh
# i.sh: `curl -fsSL vyre.run/i | sh`. Put Vyre on a server and pair it to you (DESIGN-wink.md, section 4).
#
#   1. Checks the system and the CPU, and says plainly when it is not one Vyre runs on.
#   2. Installs Docker if it is missing and starts the Vyre box. That is the signed release installer (box/install-box.sh from the same
#      site): it checks every file against the release's signature before anything is written, installs Docker when it is missing, and
#      leaves a box that is already running alone. This script adds nothing to what it installs.
#   3. Prints a pairing code (WINK-XXXX-XXXX). Type it in the Vyre app on any device you are signed in on, choose where the server goes
#      under "Pair to:", and the app shows a code. Type that one back here.
#      It also prints a QR code. A phone that scans it pairs the server with nothing to type: the QR carries a fresh 128-bit secret (a
#      ticket's own), so it needs no short code and no PAKE. It is drawn by `qrencode` when this server has it, otherwise by the Vyre box
#      itself (a small vendored encoder), never by a download.
#
# Run it again at any time: a server that is already installed is not touched, and a fresh code is shown. It never prints a secret, never
# takes the setup code as an argument, and writes nothing outside what the release installer writes.
#
# Environment: VYRE_SITE (default https://vyre.run), VYRE_INSTALLER (a local copy of install-box.sh, used instead of downloading),
# VYRE_WRAPPER (the vyre command, default vyre), VYRE_CODE_TRIES (how many 3-second tries the server gets to answer, default 40), VYRE_NO_PROMPT=1 (print the code and the next command, do not wait),
# VYRE_UNAME_S / VYRE_UNAME_M (tests). Every other variable and every argument goes to the release installer unchanged.
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

# vyre_call TOOL JSON: run a Vyre tool on this server; sudo only if this account cannot reach Docker. The answer goes to stdout; what the
# command said when it failed is kept in $TMP/err, so the person is told the real reason and not only "did not answer".
vyre_call() {
  # The wrapper prints a refusal ("unavailable: ...") on stdout, other failures on stderr: keep whichever said something in $TMP/err.
  if out=$("$WRAPPER" call "$1" "$2" 2>"$TMP/err"); then printf '%s' "$out"; return 0; fi
  [ -s "$TMP/err" ] || printf '%s\n' "$out" >"$TMP/err"
  if command -v sudo >/dev/null 2>&1; then
    if out=$(sudo "$WRAPPER" call "$1" "$2" 2>"$TMP/err2"); then printf '%s' "$out"; return 0; fi
    [ -s "$TMP/err2" ] || printf '%s\n' "$out" >"$TMP/err2"
    # The first answer is the real reason unless it was only that this account cannot reach Docker (then sudo's answer is the real one). Sudo's
    # own complaint (no terminal, no password) says nothing about Vyre, and neither does the wrapper's refusal to update a build from a folder.
    if grep -qi 'permission denied\|cannot connect to the docker\|got permission' "$TMP/err" 2>/dev/null || ! grep -q '[^[:space:]]' "$TMP/err" 2>/dev/null; then
      grep -q '^sudo:' "$TMP/err2" 2>/dev/null || cat "$TMP/err2" >"$TMP/err" 2>/dev/null || true
    fi
  fi
  return 1
}
# last_error: the first line the last failed call said, without colour codes.
last_error() { esc=$(printf '\033'); sed "s/$esc\\[[0-9;]*m//g" "$TMP/err" 2>/dev/null | head -n 1 | sed 's/^ *//'; }

# json_field NAME: a string field out of the JSON on stdin (the answers here are flat).
json_field() { tr -d '\n' | sed -n "s/.*\"$1\" *: *\"\\([^\"]*\\)\".*/\\1/p"; }

install_box() {
  if command -v "$WRAPPER" >/dev/null 2>&1 && "$WRAPPER" call system.info '{}' >/dev/null 2>&1; then
    say "Vyre is already installed here. Leaving it as it is."
    return 0
  fi
  if [ -n "${VYRE_INSTALLER:-}" ]; then cp "$VYRE_INSTALLER" "$TMP/install-box.sh"
  else
    say "Downloading the Vyre installer from $SITE"
    fetch "$SITE/box/install-box.sh" "$TMP/install-box.sh"
  fi
  [ -s "$TMP/install-box.sh" ] || die "the installer came back empty"
  # The release installer checks Docker (and installs it when it is missing), then every file it fetches against the release signature.
  sh "$TMP/install-box.sh" "$@"
}

# show_qr: the QR from wink.server.code, drawn for this terminal: by qrencode when it is installed, else the box's own drawing (the `art` field,
# two QR rows per text row in four block glyphs), printed black on white so it scans on any theme. Nothing here is fetched.
show_qr() {
  [ -n "$qr" ] || return 0
  say ""
  say "  Or scan this with the Vyre app on your phone. Nothing to type, good for 5 minutes:"
  say ""
  if command -v qrencode >/dev/null 2>&1; then
    drawn=$(qrencode -t ANSIUTF8 -m 2 -o - "$qr" 2>/dev/null || true)
    [ -z "$drawn" ] || { printf '%s\n' "$drawn" | sed 's/^/    /'; return 0; }
  fi
  [ -n "$art" ] || { say "    (this terminal cannot draw it; the Vyre app can also take this text: $qr)"; return 0; }
  printf '%s' "$art" | awk '{ gsub(/\\n/, "\n"); print }' | while IFS= read -r line; do
    if [ -t 1 ]; then printf '    \033[30;47m%s\033[0m\n' "$line"; else printf '    %s\n' "$line"; fi
  done
}

# show_code: wait for the server to answer, open a code, print it, and take the code the app shows.
show_code() {
  n=0; made=""
  while [ "$n" -lt "${VYRE_CODE_TRIES:-40}" ]; do
    # Ask for the QR too; a release that does not know the option gets the plain call.
    made=$(vyre_call wink.server.code '{"qr":true}' || vyre_call wink.server.code '{}' || true)
    [ -n "$(printf '%s' "$made" | json_field code)" ] && break
    # An answer that says what is wrong (the tool is not there) will not change by waiting; only a server still starting does.
    case "$(last_error)" in no_such_tool*) break ;; esac
    n=$((n + 1)); sleep 3
  done
  code=$(printf '%s' "$made" | json_field code)
  offer=$(printf '%s' "$made" | json_field offer)
  qr=$(printf '%s' "$made" | json_field qr)
  art=$(printf '%s' "$made" | json_field art)
  if [ -z "$code" ]; then
    why=$(last_error)
    case "$why" in
      no_such_tool*) die "this version of Vyre cannot be paired by a code yet (it has no wink.server.code). Update it with: $WRAPPER update, then run this line again." ;;
      *) die "the server did not give a pairing code${why:+ ($why)}. Run this line again, or run: $WRAPPER call wink.server.code '{}'" ;;
    esac
  fi
  say ""
  say "  Pair this server."
  say ""
  say "    1. Open the Vyre app on a device you are signed in on."
  say "    2. Add a server, and choose where it goes under \"Pair to:\"."
  say "    3. Type this code:"
  say ""
  say "         $code"
  say ""
  say "  The code is good for 5 minutes. The app then shows a code of its own."
  show_qr
  if [ "${VYRE_NO_PROMPT:-0}" = 1 ] || ! [ -r /dev/tty ]; then
    say "  Type that code back here with:"
    say "    $WRAPPER call wink.server.confirm '{\"offer\":\"$offer\",\"typed\":\"WINK-XXXX-XXXX\"}'"
    return 0
  fi
  while :; do
    printf '  Type the code the app shows: ' >/dev/tty
    typed=""
    read -r typed </dev/tty || return 0
    if [ -z "$typed" ]; then
      [ -z "$qr" ] || { say "  If you scanned the QR, the app finishes the pairing by itself."; return 0; }
      continue
    fi
    case "$typed" in *[!A-Za-z0-9\ -]*) say "  That is not a Vyre code." ; continue ;; esac
    res=$(vyre_call wink.server.confirm "{\"offer\":\"$offer\",\"typed\":\"$typed\"}" || true)
    case "$res" in
      *'"ok":true'*|*'"ok": true'*) say ""; say "  That code matched. The app finishes the pairing and tells you when this server is added; if it says it could not, follow what it says."; return 0 ;;
      *) say "  That code did not match, so the code above stopped working. A new one is showing: run this line again."; return 1 ;;
    esac
  done
}

main() {
  check_system
  TMP=$(mktemp -d)
  trap cleanup EXIT
  install_box "$@"
  show_code
}

main "$@"
