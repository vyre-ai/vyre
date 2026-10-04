#!/bin/sh
# i.sh: `curl -fsSL vyre.run/i | sh`. Put Vyre on a server and pair it to you (DESIGN-wink.md, section 4).
#
#   1. Checks the system and the CPU, and says plainly when it is not one Vyre runs on.
#   2. Installs Docker if it is missing and starts the Vyre box. That is the signed release installer (box/install-box.sh from the same
#      site): it checks every file against the release's signature before anything is written, installs Docker when it is missing, and
#      leaves a box that is already running alone. This script adds nothing to what it installs.
#   3. Prints a QR code and the same thing as a long code to paste. Scan the QR with the Vyre app on your phone, or paste the long code into the Vyre app on a
#      computer, and choose where the server goes under "Pair to:". The QR carries a fresh 128-bit secret (a ticket's own), so nothing short is typed anywhere.
#      It is drawn by `qrencode` when this server has it, otherwise by the Vyre box itself (a small vendored encoder), never by a download.
#   4. Waits for the app. When a device asks, this terminal shows who is asking and three words, made from both sides' keys, and asks
#      "Pair this server to <name>? Words: amber coral seven. [y/N]". The app shows the same three words. Answer y only if they match. No answer in 5 minutes pairs
#      nothing. A device that was scanned by someone else cannot become the owner without your yes.
#
# An unattended install (cloud-init) names the identity up front: --pair-to <identity id or name>. Only that identity can complete the pairing, and nobody is asked
# (this script prints the code and exits; the server finishes the pairing by itself). The flag is not passed on to the release installer.
#
# Run it again at any time: a server that is already installed is not touched, and a fresh code is shown. It never prints a secret other than the pairing code, never
# takes the setup code as an argument, and writes nothing outside what the release installer writes.
#
# Environment: VYRE_SITE (default https://vyre.run), VYRE_INSTALLER (a local copy of install-box.sh, used instead of downloading),
# VYRE_WRAPPER (the vyre command, default vyre), VYRE_CODE_TRIES (how many 3-second tries the server gets to answer, default 40), VYRE_ASK_TRIES (how many 3-second looks for a pairing question, default 100), VYRE_NO_PROMPT=1 (print the code and the next commands, do not wait),
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
# json_choice N: the Nth of the three sets of words in choices
json_choice() { tr -d '\n' | sed -n "s/.*\"choices\" *: *\\[ *\"\\([^\"]*\\)\" *, *\"\\([^\"]*\\)\" *, *\"\\([^\"]*\\)\".*/\\$1/p"; }

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
  say "    1. Scan this with the Vyre app on your phone:"
  say ""
  if command -v qrencode >/dev/null 2>&1; then
    drawn=$(qrencode -t ANSIUTF8 -m 2 -o - "$qr" 2>/dev/null || true)
    [ -z "$drawn" ] || { printf '%s\n' "$drawn" | sed 's/^/      /'; return 0; }
  fi
  [ -n "$art" ] || { say "      (this terminal cannot draw it; use the long code below)"; return 0; }
  printf '%s' "$art" | awk '{ gsub(/\\n/, "\n"); print }' | while IFS= read -r line; do
    if [ -t 1 ]; then printf '      \033[30;47m%s\033[0m\n' "$line"; else printf '      %s\n' "$line"; fi
  done
}

# show_code: wait for the server to answer, print the QR and the long code, then (unless the identity was named up front) wait for the app and ask who is asking.
show_code() {
  n=0; made=""; args='{"qr":true}'
  [ -z "$PAIR_TO" ] || args="{\"qr\":true,\"pairTo\":\"$PAIR_TO\"}"
  while [ "$n" -lt "${VYRE_CODE_TRIES:-40}" ]; do
    made=$(vyre_call wink.server.code "$args" || true)
    [ -n "$(printf '%s' "$made" | json_field qr)" ] && break
    # An answer that says what is wrong (the tool is not there) will not change by waiting; only a server still starting does.
    case "$(last_error)" in no_such_tool*) break ;; esac
    n=$((n + 1)); sleep 3
  done
  qr=$(printf '%s' "$made" | json_field qr)
  art=$(printf '%s' "$made" | json_field art)
  if [ -z "$qr" ]; then
    why=$(last_error)
    case "$why" in
      no_such_tool*) die "this version of Vyre cannot be paired by a scan yet (it has no wink.server.code). Update it with: $WRAPPER update, then run this line again." ;;
      *) die "the server did not give a pairing code${why:+ ($why)}. Run this line again, or run: $WRAPPER call wink.server.code '{\"qr\":true}'" ;;
    esac
  fi
  say ""
  say "  Pair this server."
  show_qr
  say ""
  say "    2. Or, on a computer, open the Vyre app, choose Add a server, and paste this long code:"
  say ""
  say "         $qr"
  say ""
  say "    Then choose where the server goes under \"Pair to:\". Good for 5 minutes."
  say "    Keep the code to yourself: anyone who has it can start pairing this server. Nobody can finish without your yes here."
  if [ -n "$PAIR_TO" ]; then
    say ""
    say "  This server will only pair to $PAIR_TO. Nobody has to answer here: when that identity scans or pastes the code, the pairing finishes by itself."
    return 0
  fi
  if [ "${VYRE_NO_PROMPT:-0}" = 1 ] || ! [ -r /dev/tty ]; then
    say ""
    say "  When the app asks, this server shows who is asking and three sets of three words. See them with:"
    say "    $WRAPPER call wink.server.pairing '{}'"
    say "  and answer by picking the set that matches the three words the app shows (1, 2 or 3):"
    say "    $WRAPPER call wink.server.pair.answer '{\"yes\":true,\"pick\":1}'"
    say "  A bare yes is refused. To say no: $WRAPPER call wink.server.pair.answer '{\"yes\":false}'"
    return 0
  fi
  say ""
  say "  Waiting for the app. When it asks, this screen shows who is asking and three words."
  tries=0
  while [ "$tries" -lt "${VYRE_ASK_TRIES:-100}" ]; do
    res=$(vyre_call wink.server.pairing '{}' || true)
    case "$res" in
      *'"asking":true'*|*'"asking": true'*)
        who=$(printf '%s' "$res" | json_field name)
        c1=$(printf '%s' "$res" | json_choice 1); c2=$(printf '%s' "$res" | json_choice 2); c3=$(printf '%s' "$res" | json_choice 3)
        printf '\n  Pair this server to %s?\n  Which three words does the app show?\n    1) %s\n    2) %s\n    3) %s\n  Type 1, 2 or 3 (anything else is no): ' "$who" "$c1" "$c2" "$c3" >/dev/tty
        ans=""
        read -r ans </dev/tty || ans=""
        case "$ans" in
          1|2|3)
            if vyre_call wink.server.pair.answer "{\"yes\":true,\"pick\":$ans}" | grep -q '"yes": *true'; then
              say "  Yes. The app finishes the pairing and tells you when this server is added; if it says it could not, follow what it says."
            else say "  Those are not the words the app shows, or the question had run out. Nothing was paired. Run this line again."; return 1; fi ;;
          *) vyre_call wink.server.pair.answer '{"yes":false}' >/dev/null || true; say "  No. Nothing was paired." ;;
        esac
        return 0 ;;
    esac
    tries=$((tries + 1)); sleep 3
  done
  say "  Nobody asked within the time. Nothing was paired. Run this line again for a new code."
  return 1
}

# --pair-to NAME (or --pair-to=NAME): who an unattended install pairs to. It is taken out of the arguments before the rest go to the release installer.
PAIR_TO=""
main() {
  n=$#; skip=0
  while [ "$n" -gt 0 ]; do
    a=$1; shift; n=$((n - 1))
    if [ "$skip" = 1 ]; then PAIR_TO=$a; skip=0; continue; fi
    case "$a" in
      --pair-to) skip=1; continue ;;
      --pair-to=*) PAIR_TO=${a#--pair-to=}; continue ;;
    esac
    set -- "$@" "$a"
  done
  [ "$skip" = 0 ] || die "--pair-to needs an identity id or name"
  case "$PAIR_TO" in *[!A-Za-z0-9._@:\ -]*) die "--pair-to takes an identity id or name (letters, digits, space and . _ @ : -)" ;; esac
  [ "${#PAIR_TO}" -le 64 ] || die "--pair-to is too long"
  check_system
  TMP=$(mktemp -d)
  trap cleanup EXIT
  install_box "$@"
  show_code
}

main "$@"
