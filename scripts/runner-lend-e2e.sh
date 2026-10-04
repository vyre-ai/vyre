#!/bin/bash
# Drives scripts/runner-lend-e2e.mjs on three test boxes over the REAL Wink peer wire (ed25519 device proof) with the real kernel and sealing process at the home: a lent session on LENDER_BOX checkpoints to the home on HOME_BOX, the lender is
# SIGKILLed (node and the sandbox) at a chosen moment after it sent turn 3, and RESUME_BOX resumes the session from the home's copy.
# Rounds use kill delays (ms) from DELAYS; each round is its own session. Scratch dirs under ~/runner-lend-e2e on each box, deleted at the end.
# The boxes' firewalls (ufw) block the private network ports, so the lender and the resuming box reach the home through ssh tunnels (-L from here, -R to them).
HOME_BOX=${HOME_BOX:-testbox3}; LENDER_BOX=${LENDER_BOX:-testbox2}; RESUME_BOX=${RESUME_BOX:-testbox}; PORT=${PORT:-7788}; TPORT=${TPORT:-17801}
DELAYS=${DELAYS:-"0 300 700 1200 1800 2600"}
SRC=$(cd "$(dirname "$0")/.." && pwd); URL=$TPORT; FAIL=0
for b in $HOME_BOX $LENDER_BOX $RESUME_BOX; do rsync -a --exclude node_modules --exclude .git "$SRC/" $b:runner-lend-e2e/src/; done
ssh $HOME_BOX "cd runner-lend-e2e/src && rm -rf ../home && mkdir -p ../agent-home && cp core/runner/testing/fake-agent.js ../agent-home/agent.js && (setsid nohup node scripts/runner-lend-e2e.mjs home $PORT \$HOME/runner-lend-e2e/home \$HOME/runner-lend-e2e/agent-home/agent.js > ../home.log 2>&1 &) ; sleep 6; cat ../home.log"
ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ControlPath=none -L $TPORT:127.0.0.1:$PORT $HOME_BOX
for b in $LENDER_BOX $RESUME_BOX; do ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ControlPath=none -R $TPORT:127.0.0.1:$TPORT $b; done
for D in $DELAYS; do
  S=r$D; echo "=== round: kill $D ms after turn 3 was sent (session $S)"
  ssh $LENDER_BOX "cd runner-lend-e2e/src && (SESSION=$S KILL_AFTER_MS=$D setsid nohup node scripts/runner-lend-e2e.mjs lender $URL \$HOME/runner-lend-e2e/lender-$S dev_lender > ../lender-$S.log 2>&1 &)"
  for i in $(seq 1 120); do sleep 1; ssh $LENDER_BOX "grep -q 'turn 3 sent' runner-lend-e2e/lender-$S.log 2>/dev/null && ! pgrep -f 'e2e.mjs [l]ender .*lender-$S ' >/dev/null" && break; done
  ssh $LENDER_BOX "pkill -9 -f 'runner-lend-e2e/lender-$S[/ ]' ; sleep 1; for m in \$(mount | grep lender-$S | awk '{print \$3}'); do fusermount3 -u -z \$m; done; true"
  HELD=$(ssh $RESUME_BOX "cd runner-lend-e2e/src && SESSION=$S node scripts/runner-lend-e2e.mjs peek $URL dev_lender")
  echo "home holds after the kill: $HELD"
  OUT=$(ssh $RESUME_BOX "cd runner-lend-e2e/src && SESSION=$S timeout 120 node scripts/runner-lend-e2e.mjs resume $URL \$HOME/runner-lend-e2e/resume-$S dev_server")
  echo "$OUT" | grep -E "resume started|resumed\"|after resume" | cut -c1-200
  T=$(echo "$HELD" | sed 's/.*"turn":\([0-9]*\).*/\1/'); N=$(echo "$HELD" | sed 's/.*"transcriptLines":\([0-9]*\).*/\1/')
  RT=$(echo "$OUT" | grep -o 'resumed {"turn":[0-9]*' | grep -o '[0-9]*$'); NOTES=$(echo "$OUT" | grep '"type":"resumed"')
  AFTER=$(ssh $RESUME_BOX "cd runner-lend-e2e/src && SESSION=$S node scripts/runner-lend-e2e.mjs peek $URL dev_server" | sed 's/.*"turn":\([0-9]*\).*/\1/')
  # The session must resume from exactly the checkpoint the home held, with that checkpoint's files, and move on from it.
  if [ "$T" = 3 ]; then WANT='alpha\nbravo\ncharlie\n'; elif [ "$T" = 2 ]; then WANT='alpha\nbravo\n'; else WANT=UNEXPECTED; fi
  if [ "$RT" = "$T" ] && echo "$NOTES" | grep -qF "\"notes\":\"$WANT\"" && [ "$AFTER" = "$((T+1))" ]; then echo "PASS round $D: resumed from checkpoint $T, files match it, next checkpoint $AFTER"; else echo "FAIL round $D: held $T, resumed $RT, after $AFTER, $NOTES"; FAIL=1; fi
done
echo "== the home's files"; ssh $HOME_BOX "du -sh runner-lend-e2e/home; echo stray temp files: \$(find runner-lend-e2e/home -name '*.tmp-*' | wc -l)"
ssh $HOME_BOX "pkill -f '[r]unner-lend-e2e.mjs home'"
for b in $LENDER_BOX $RESUME_BOX; do ssh $b 'for m in $(mount | grep ckpt-e2e | awk "{print \$3}"); do fusermount3 -u -z $m; done; true'; done
for b in $HOME_BOX $LENDER_BOX $RESUME_BOX; do ssh $b "chmod -R u+rwX runner-lend-e2e 2>/dev/null; rm -rf runner-lend-e2e"; done
pkill -f "ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ControlPath=none.*$TPORT" 2>/dev/null
echo "RESULT: $([ $FAIL = 0 ] && echo ALL PASS || echo FAILURES)"
