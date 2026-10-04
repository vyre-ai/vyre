#!/bin/bash
# Test-box check (no secrets printed): the user vyred and any agent session run as must have no passwordless ssh to this machine, no key of its own in its own authorized_keys, and no
# forwarded agent. On a dev box with the presence stand-in file, an ssh login counts as the owner, so a way in without a person would count as the owner too.
bad=0
for t in localhost 127.0.0.1 "$(hostname)"; do
  ssh -o LogLevel=ERROR -o BatchMode=yes -o ConnectTimeout=5 -o PasswordAuthentication=no -o StrictHostKeyChecking=no "$t" true >/dev/null 2>&1
  if [ $? -eq 0 ]; then echo "BAD: passwordless ssh to $t works"; bad=1; else echo "ok: ssh $t refused"; fi
done
ak=""; [ -f "$HOME/.ssh/authorized_keys" ] && ak=$(cut -d" " -f1-2 "$HOME/.ssh/authorized_keys" | sort -u)
for p in "$HOME"/.ssh/*.pub; do
  [ -f "$p" ] || continue
  k=$(cut -d" " -f1-2 "$p")
  if echo "$ak" | grep -qF "$k"; then echo "BAD: a key held here is authorized here: $(basename "$p")"; bad=1; fi
done
[ -n "$SSH_AUTH_SOCK" ] && echo "note: an ssh agent is forwarded into this shell (an agent session inheriting it could ssh as an authorized key)"
[ $bad -eq 0 ] && echo "RESULT: clean"
exit $bad
