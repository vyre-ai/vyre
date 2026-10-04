#!/bin/bash
# The whole unit suite WITHOUT --test-force-exit: one node --test process per file, so a file whose process does not exit after its tests (a leaked handle,
# which --test-force-exit hides) is reported as HUNG by name instead of stalling the run. Output: a line per file in unit-results.txt (PASS, FAIL or HUNG, tests,
# pass, fail) and the totals. Usage: scripts/int-unit.sh [per-file seconds] [parallel]
set -u
LIMIT=${1:-240}; PAR=${2:-4}
mkdir -p unit-logs
GLOBS='core/**/*.test.js kernel/**/*.test.js records/**/*.test.js stores/**/*.test.js test/**/*.test.js deck/**/*.test.js modules/**/*.test.js local/*/*.test.js relay/**/*.test.js names/**/*.test.js apps/test/*.test.js apps/app/**/*.test.js lib/**/*.test.js'
shopt -s globstar nullglob
FILES=(); for g in $GLOBS; do for f in $g; do FILES+=("$f"); done; done
printf '%s\n' "${FILES[@]}" | sort -u > unit-files.txt
echo "files: $(wc -l < unit-files.txt)"
run_one() {
  f=$1; log="unit-logs/$(echo "$f" | tr '/' '_').log"
  timeout "$LIMIT" node --test --test-reporter=spec "$f" > "$log" 2>&1; rc=$?
  t=$(grep -E '^ℹ tests ' "$log" | awk '{print $3}'); p=$(grep -E '^ℹ pass ' "$log" | awk '{print $3}'); x=$(grep -E '^ℹ fail ' "$log" | awk '{print $3}')
  if [ "$rc" = 124 ]; then s=HUNG; elif [ "$rc" = 0 ]; then s=PASS; else s=FAIL; fi
  echo "$s ${t:-0} ${p:-0} ${x:-0} $f"
}
export -f run_one; export LIMIT
VYRE_NO_DIALOGS=1 xargs -a unit-files.txt -P "$PAR" -I{} bash -c 'run_one {}' > unit-results.txt
awk '{n[$1]++; t+=$2; p+=$3; x+=$4} END {printf "TOTAL files=%d PASS=%d FAIL=%d HUNG=%d tests=%d pass=%d fail=%d\n", n["PASS"]+n["FAIL"]+n["HUNG"], n["PASS"], n["FAIL"], n["HUNG"], t, p, x}' unit-results.txt | tee unit-summary.txt
grep -E '^(FAIL|HUNG)' unit-results.txt | sort | head -150
