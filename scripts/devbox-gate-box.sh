#!/bin/bash
# The whole trunk gate, run ON a test box inside a clone of the repo (no upload from the Mac).
# Usage: cd ~/vyre-ci/devbox && git fetch -q origin <branch> && git checkout -q -f FETCH_HEAD && scripts/devbox-gate-box.sh <base-sha> [skip-changed]
# Prints one line per step; the last line is GATE-DONE. A docs regeneration is left in the work tree (commit it on the Mac side from the printed patch).
base=${1:-HEAD~1}; export PATH=$HOME/node24/bin:$PATH
cd "$(git rev-parse --show-toplevel)" || exit 2
echo "head $(git rev-parse --short HEAD) base $(git rev-parse --short $base)"
echo "merge-check: $(python3 scripts/devbox-merge-check.py HEAD | tail -1)"
if [ ! -d node_modules ] || ! git diff --quiet "$base" HEAD -- package-lock.json; then npm ci --omit=dev >/dev/null 2>&1; fi
npm run docs:ref >/dev/null 2>&1; n=$(git status --short docs | wc -l | tr -d ' '); echo "docs regenerated: $n file(s) differ"; [ "$n" != 0 ] && git diff docs > /tmp/gate-docs.patch
node scripts/docs-check 2>&1 | tail -1
files=$(git diff --name-only "$base" HEAD -- '*.js' '*.mjs' | grep -v '\.test\.' | grep -v '^apps/' | grep -v '^site/' | while read -r f; do [ -f "$f" ] && echo "$f"; done)
if [ -n "$files" ]; then out=$(echo "$files" | xargs ~/lint/node_modules/.bin/eslint --no-eslintrc --parser-options=ecmaVersion:latest --parser-options=sourceType:module --env node,es2022,browser --rule "no-undef: error" 2>&1); echo "$out" | grep "no-undef" | head -10; echo "lint: $(echo "$files" | wc -l | tr -d ' ') files, no-undef hits: $(echo "$out" | grep -c no-undef)"; else echo "lint: no files"; fi
echo "load: $(uptime | sed 's/.*averages*: //')"
scripts/devbox-boot-box.sh 2>&1 | grep -E "FAIL|up ·" | cut -c1-120
RESULT=/tmp/ds.result bash scripts/devbox-smoke.sh >/tmp/ds.out 2>&1; echo "smoke rc=$?"; tail -1 /tmp/ds.result
if [ "$2" != "skip-changed" ]; then
  git diff --name-only --diff-filter=AM "$base" HEAD | grep -E '\.test\.js$' | grep -v '^apps/' > /tmp/gate-changed.txt; echo "changed tests: $(wc -l < /tmp/gate-changed.txt | tr -d ' ')"
  while read f; do r=$(timeout 300 node --test --test-timeout=250000 $f 2>&1 | grep -E "^ℹ (pass|fail)" | tr "\n" " "); echo "$r $f"; done < /tmp/gate-changed.txt | grep -v "fail 0 *[a-z/._0-9-]*$"
  echo "changed tests done"
fi
echo GATE-DONE
