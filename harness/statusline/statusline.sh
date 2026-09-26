#!/bin/sh
# Vyre's line for Claude Code's status line. `vyre statusline install` copies this file to
# <home>/statusline.sh with the home below filled in, so it never depends on where the package
# lives. It reads a file vyred keeps current and runs no node and no network: Claude Code runs it
# on every update. Anything wrong prints nothing and exits 0; a status line is never an error.
home='@VYRE_HOME@'

# A status line the person had before Vyre's, kept by `install --chain`: it gets Claude Code's
# JSON on stdin as before, and its output comes first.
if [ -s "$home/statusline.prev" ]; then
  prev=$(cat "$home/statusline.prev" 2>/dev/null)
  theirs=$(sh -c "$prev" 2>/dev/null)
  [ -n "$theirs" ] && printf '%s\n' "$theirs"
fi

# Line 1 is vyred's pid, line 2 the line. A dead pid means the line is stale: show nothing.
if [ -r "$home/statusline" ]; then
  { IFS= read -r pid; IFS= read -r line; } < "$home/statusline" 2>/dev/null
  case "$pid" in ''|*[!0-9]*|0*) pid= ;; esac
  if [ -n "$pid" ] && [ -n "$line" ] && kill -0 "$pid" 2>/dev/null; then printf '%s\n' "$line"; fi
fi
exit 0
