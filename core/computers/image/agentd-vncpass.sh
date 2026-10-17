#!/bin/sh
# agentd-vncpass PLAIN OUT UID: turn a plain VNC password file into Xvnc's password file, owned by the agent's uid and 0600, and delete the plain one.
set -eu
plain="$1"; out="$2"; uid="$3"
vncpasswd -f < "$plain" > "$out"
chown "$uid:$uid" "$out"
chmod 0600 "$out"
rm -f "$plain"
