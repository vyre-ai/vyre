#!/bin/sh
# agentd-vncpass OUT: read a plain VNC password on standard input and write Xvnc's password file to OUT (0600). agentd runs this AS the agent's uid, so the file is
# the agent's own and the password never exists as an argument or as a plain file.
set -eu
out="$1"
umask 077
vncpasswd -f > "$out"
