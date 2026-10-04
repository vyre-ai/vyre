#!/bin/bash
# The boot gate: run BEFORE a trunk push. Syncs the merged tree (or `git archive <commit>` with BOOTCOMMIT=<sha>) to a test box and
#  1. runs test/daemon-smoke.test.js (a real vyred, kernel on, system.info over the socket) and kernel/boot.test.js (createKernel) one file at a time with a hard timeout (process group killed),
#  2. boots a throwaway vyred in a fresh temp home (kernel on, the presence stand-in file, machine server), waits for "up ... N modules", calls system.echo and records.me, stops it.
# Exit 1 on any failure and prints the last 20 daemon log lines (send them to the branch's owner). Usage: scripts/devbox-boot-check.sh [testbox2]
cd "$(dirname "$0")/.." || exit 2
BOX=${1:-testbox2}; DIR=boot-check
if [ -n "$BOOTCOMMIT" ]; then git archive "$BOOTCOMMIT" | ssh "$BOX" "rm -rf ~/$DIR && mkdir ~/$DIR && tar -x -C ~/$DIR" || exit 2
else rsync -a --delete --exclude node_modules --exclude .git ./ "$BOX":~/$DIR/ >/dev/null || exit 2; fi
ssh "$BOX" 'bash -s' <<'REMOTE'
cd ~/boot-check || exit 2
export PATH=$HOME/node24/bin:$PATH
bad=0
for f in test/daemon-smoke.test.js kernel/boot.test.js; do
  setsid nice -n 10 node --test --test-timeout=80000 "$f" > /tmp/bc.out 2>&1 &
  pid=$!; w=0
  while kill -0 $pid 2>/dev/null && [ $w -lt 100 ]; do sleep 1; w=$((w+1)); done
  if kill -0 $pid 2>/dev/null; then kill -TERM -- -$pid 2>/dev/null; sleep 2; kill -KILL -- -$pid 2>/dev/null; echo "BOOT-CHECK FAIL $f: HUNG (killed after 100s)"; bad=1
  else wait $pid; rc=$?; if [ $rc -eq 0 ]; then echo "boot-check ok   $f ($(grep -E '^ℹ pass' /tmp/bc.out | awk '{print $3}') pass)"; else echo "BOOT-CHECK FAIL $f (rc=$rc)"; grep -E "^✖|Error" /tmp/bc.out | head -6; bad=1; fi; fi
done
# throwaway daemon
H=$(mktemp -d /tmp/bc-home.XXXXXX); mkdir -p $H/.vyre; echo '{"name":"bootcheck","machine":"server"}' > $H/.vyre/config.json; : > $H/.vyre/dev-presence-stand-in
( HOME=$H VYRE_KERNEL=1 VYRE_KERNEL_PATH_RULE=1 setsid node core/daemon/main.js > $H/d.log 2>&1 & echo $! > $H/pid )
up=""; for i in $(seq 1 60); do sleep 1; L=$(ls $H/.vyre/logs/*.log 2>/dev/null | head -1); if [ -n "$L" ] && grep -q " up .* modules" "$L" 2>/dev/null; then up=$(grep " up .* modules" "$L" | tail -1); break; fi; if ! kill -0 $(cat $H/pid) 2>/dev/null; then break; fi; done
if [ -z "$up" ]; then echo "BOOT-CHECK FAIL: the daemon did not come up in 60 s"; bad=1; else
  echo "boot-check ok   daemon: $up" | cut -c1-140
  e=$(HOME=$H node bin/vyre call system.echo '{"text":"hi"}' 2>&1 | tr -d '\n '); echo "$e" | grep -q '"text":"hi"' && echo "boot-check ok   system.echo" || { echo "BOOT-CHECK FAIL system.echo: $e" | cut -c1-200; bad=1; }
  r=$(HOME=$H node bin/vyre call records.me '{}' 2>&1 | tr -d '\n '); echo "$r" | grep -q '"person"' && echo "boot-check ok   records.me (stand-in owner)" || { echo "BOOT-CHECK FAIL records.me: $r" | cut -c1-200; bad=1; }
fi
kill -TERM -- -$(cat $H/pid) 2>/dev/null; sleep 2; kill -KILL -- -$(cat $H/pid) 2>/dev/null
[ $bad -ne 0 ] && { echo "--- last 20 daemon log lines:"; { cat $H/d.log; cat $H/.vyre/logs/*.log 2>/dev/null; } | tail -20 | cut -c1-240; }
rm -rf $H
exit $bad
REMOTE
