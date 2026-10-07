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
# Listeners in this network namespace, read twice 0.3 s apart and reported only when present both times: a resolver's short-lived UDP socket must not look like a service.
#   TCP (state 0A), UDP (07) and ABSTRACT unix sockets (names starting with @: no file mode protects them); a session shares the box's namespace, so all of them are reachable.
# 127.0.0.11 (0B00007F, little-endian) is Docker's embedded DNS resolver in every container's namespace (found by the hosted run: root-owned, TCP and UDP, ephemeral ports). A session needs it to resolve
# names, it is not ours, and it is skipped by address and only when root owns the socket.
listeners() {
  for f in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$f" ] || continue
    while read -r _ local _ st _ _ _ luid _; do [ "$st" = 0A ] && ! { [ "${local%%:*}" = 0B00007F ] && [ "$luid" = 0 ]; } && echo "listen $((0x${local##*:}))"; done < "$f"
  done
  for f in /proc/net/udp /proc/net/udp6; do
    [ -r "$f" ] || continue
    while read -r _ local _ st _ _ _ luid _; do [ "$st" = 07 ] && ! { [ "${local%%:*}" = 0B00007F ] && [ "$luid" = 0 ]; } && echo "udp $((0x${local##*:}))"; done < "$f"
  done
  if [ -r /proc/net/unix ]; then
    while read -r _ _ _ _ _ _ _ name; do case "$name" in @*) echo "abstract $name" ;; esac; done < /proc/net/unix
  fi
}
first=$(listeners); sleep 0.3; second=$(listeners)
printf '%s\n' "$first" | while read -r line; do
  [ -n "$line" ] && printf '%s\n' "$second" | grep -qxF -- "$line" && echo "$line"
done
exit 0
