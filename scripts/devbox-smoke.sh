#!/bin/bash
# The short smoke set for a trunk head. BOUNDED: every file runs in its own process group with a hard timeout (the group is killed and the file reported HUNG), the whole set stops at 8 minutes
# (TOTAL, the rest reported SKIPPED), and a line per file is written to the result file as it goes, so a kill still leaves the counts. Exit code is non-zero on any fail, hang or skip.
# Run on a test box with load under 4 (check uptime). Result file: $RESULT (default /tmp/devbox-smoke.result), final line "SMOKE ...".
cd "$(dirname "$0")/.." || exit 1
export PATH=$HOME/node24/bin:$PATH
PER=${PER:-100}; TOTAL=${TOTAL:-480}; RESULT=${RESULT:-/tmp/devbox-smoke.result}; : > "$RESULT"
files="test/daemon-smoke.test.js test/modules-boot.test.js test/signin.test.js test/one-registry.test.js kernel/gateway/gateway.test.js core/work/know-daemon.test.js $(ls core/spaces/*.test.js)"
start=$(date +%s); pass=0; fail=0; hung=0; skipped=0; bad=""
for f in $files; do
  now=$(date +%s)
  if [ $((now - start)) -ge "$TOTAL" ]; then skipped=$((skipped+1)); bad="$bad $f(SKIPPED)"; echo "SKIPPED $f (total limit ${TOTAL}s)" >> "$RESULT"; continue; fi
  out=$(mktemp)
  setsid nice -n 15 node --test --test-timeout=$((PER-10))000 "$f" > "$out" 2>&1 &
  pid=$!
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ $waited -lt "$PER" ]; do sleep 1; waited=$((waited+1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- -"$pid" 2>/dev/null; sleep 2; kill -KILL -- -"$pid" 2>/dev/null
    hung=$((hung+1)); bad="$bad $f(HUNG)"; echo "HUNG $f (killed after ${PER}s)" >> "$RESULT"
  else
    wait "$pid"; rc=$?
    p=$(grep -E "^ℹ pass" "$out" | awk '{print $3}'); fl=$(grep -E "^ℹ fail" "$out" | awk '{print $3}')
    if [ $rc -eq 0 ]; then pass=$((pass+${p:-0})); echo "PASS $f ${p:-0}" >> "$RESULT"; else fail=$((fail+${fl:-1})); bad="$bad $f(FAIL)"; echo "FAIL $f rc=$rc" >> "$RESULT"; grep -E "^✖" "$out" | head -3 >> "$RESULT"; fi
  fi
  rm -f "$out"
done
echo "SMOKE pass=$pass fail=$fail hung=$hung skipped=$skipped time=$(( $(date +%s) - start ))s${bad:+ BAD:$bad}" | tee -a "$RESULT"
[ $fail -eq 0 ] && [ $hung -eq 0 ] && [ $skipped -eq 0 ]
