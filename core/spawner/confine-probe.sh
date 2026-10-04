#!/bin/sh
# The box's session confinement self-test, run by the spawner AS THE SESSION'S OWN UID (never by vyred) before each session starts (core/spawner/confine.js).
# It reports facts only: who it is, whether it can read and write the project it was started in, and for each path it was told is out of reach, whether it can reach it.
#   confine-probe.sh allow <project folder> deny <path> <path> ...
# Output, one line each: `uid N`, `project rw` or `project no`, then `denied I` or `reached I` for the I-th deny path (counting from 0).
echo "uid $(id -u)"
mode=""; i=0
for a in "$@"; do
  case "$a" in
    allow) mode=allow; continue ;;
    deny) mode=deny; continue ;;
  esac
  if [ "$mode" = allow ]; then
    f="$a/.vyre-selftest-$$"
    if echo x > "$f" 2>/dev/null && [ "$(cat "$f" 2>/dev/null)" = x ]; then echo "project rw"; else echo "project no"; fi
    rm -f "$f" 2>/dev/null
  elif [ "$mode" = deny ]; then
    if [ -r "$a" ] || [ -w "$a" ] || ls "$a" >/dev/null 2>&1; then echo "reached $i"; else echo "denied $i"; fi
    i=$((i + 1))
  fi
done
