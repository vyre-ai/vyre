#!/bin/bash
# no-undef over the non-test JS files a merge changed (node --check cannot see an undefined variable: three handlers broke that way in one day).
# Usage on the Mac: scripts/devbox-lint.sh <base-commit> ; it syncs the tree to a test box, runs eslint@8 with ONLY no-undef over the changed files there, and exits 1 on a hit.
base=${1:-HEAD~1}
cd "$(dirname "$0")/.." || exit 1
files=$(git diff --name-only "$base" HEAD -- '*.js' '*.mjs' | grep -v '\.test\.' | grep -v '^apps/' | grep -v '^site/' | while read -r f; do [ -f "$f" ] && echo "$f"; done)
[ -z "$files" ] && { echo "lint: no files"; exit 0; }
BOX=${LINTBOX:-testbox6}
rsync -a --delete --exclude node_modules --exclude .git ./ "$BOX":~/devbox-docs/ >/dev/null || exit 2
out=$(echo "$files" | ssh "$BOX" 'cd ~/devbox-docs && export PATH=$HOME/node24/bin:$PATH && xargs ~/lint/node_modules/.bin/eslint --no-eslintrc --parser-options=ecmaVersion:latest --parser-options=sourceType:module --env node,es2022,browser --rule "no-undef: error" --format unix 2>&1')
hits=$(echo "$out" | grep -c "no-undef")
echo "$out" | grep "no-undef" | head -30
echo "lint: $(echo "$files" | wc -l | tr -d ' ') files, no-undef hits: $hits"
[ "$hits" -eq 0 ]
