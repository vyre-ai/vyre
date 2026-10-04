#!/bin/bash
# The short smoke set for a trunk head (about 5 minutes): one process per file, a per-file timeout, nothing wide. Run on a test box that is not loaded (check uptime first).
cd "$(dirname "$0")/.." || exit 1
export PATH=$HOME/node24/bin:$PATH
pass=0; fail=0; failed=""
files="test/daemon-smoke.test.js test/modules-boot.test.js test/signin.test.js test/one-registry.test.js kernel/gateway/gateway.test.js core/work/know-daemon.test.js $(ls core/spaces/*.test.js)"
for f in $files; do
  out=$(timeout 150 nice -n 15 node --test --test-timeout=120000 "$f" 2>&1)
  rc=$?
  p=$(echo "$out" | grep -E "^ℹ pass" | awk '{print $3}'); fl=$(echo "$out" | grep -E "^ℹ fail" | awk '{print $3}')
  if [ $rc -eq 0 ]; then pass=$((pass+${p:-0})); else fail=$((fail+${fl:-1})); failed="$failed $f(rc=$rc)"; fi
done
echo "SMOKE pass=$pass fail=$fail"; [ -n "$failed" ] && echo "FAILED FILES:$failed"
