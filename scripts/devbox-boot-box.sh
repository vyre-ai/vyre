#!/bin/bash
# The boot gate run ON a test box in the clone under test (cwd = the clone). Same checks as devbox-boot-check.sh, no upload from the Mac.
cd "${DIR:-$(pwd)}" || exit 2; DIR=$(pwd)
export PATH=$HOME/node24/bin:$PATH
bad=0
for f in test/daemon-smoke.test.js kernel/boot.test.js kernel/adopt.test.js kernel/rv2-hosted-takeover.test.js; do
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
# stop everything this check started: the daemon's own process group and its sealing/sandbox children (they run from ~/boot-check)
for sig in TERM KILL; do for p in $(pgrep -x node); do [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$DIR" ] && kill -$sig $p 2>/dev/null; done; sleep 2; done
rm -rf $H
exit $bad
