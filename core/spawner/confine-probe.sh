#!/bin/sh
# The box's session confinement self-test, run by the spawner AS THE SESSION'S OWN UID (never by vyred) before each session starts (core/spawner/confine.js).
# It reports facts only: who it is, whether it can read and write each project folder it was started with, whether it can reach each path it was told is out of reach,
# and which TCP ports are listening in this container (a session shares the box's network, so any listener is something it could connect to).
#   confine-probe.sh allow <project folder>... deny <path>... list <path>...
# Output, one line each: `uid N`, `project rw` or `project no` (per allowed folder, in order), `denied I` or `reached I` (per deny and then list path, counting from 0), `listen PORT`.
#   deny: reached when the uid can read, write, list OR ENTER it (a folder with x for others reaches whatever inside has loose modes, so x counts).
#   list: reached only when the uid can read or list it (the folder may be entered: it holds the account homes, each closed to everyone else).
echo "uid $(id -u)"
mode=""; i=0
for a in "$@"; do
  case "$a" in
    allow) mode=allow; continue ;;
    deny) mode=deny; continue ;;
    list) mode=list; continue ;;
  esac
  if [ "$mode" = allow ]; then
    f="$a/.vyre-selftest-$$"
    if echo x > "$f" 2>/dev/null && [ "$(cat "$f" 2>/dev/null)" = x ]; then echo "project rw"; else echo "project no"; fi
    rm -f "$f" 2>/dev/null
  elif [ "$mode" = deny ]; then
    if [ -r "$a" ] || [ -w "$a" ] || { [ -d "$a" ] && [ -x "$a" ]; } || ls "$a" >/dev/null 2>&1; then echo "reached $i"; else echo "denied $i"; fi
    i=$((i + 1))
  elif [ "$mode" = list ]; then
    if [ -r "$a" ] || ls "$a" >/dev/null 2>&1; then echo "reached $i"; else echo "denied $i"; fi
    i=$((i + 1))
  fi
done
# TCP listeners in this network namespace (state 0A): the port is the hex after the last colon of the local address.
for f in /proc/net/tcp /proc/net/tcp6; do
  [ -r "$f" ] || continue
  while read -r _ local _ st _; do
    [ "$st" = 0A ] || continue
    echo "listen $((0x${local##*:}))"
  done < "$f"
done
# UDP listeners (state 07) and ABSTRACT unix sockets (names starting with @: no file mode protects them): the session shares the box's network namespace, so both are reachable.
for f in /proc/net/udp /proc/net/udp6; do
  [ -r "$f" ] || continue
  while read -r _ local _ st _; do
    [ "$st" = 07 ] || continue
    echo "udp $((0x${local##*:}))"
  done < "$f"
done
if [ -r /proc/net/unix ]; then
  while read -r _ _ _ _ _ _ _ name; do
    case "$name" in @*) echo "abstract $name" ;; esac
  done < /proc/net/unix
fi
