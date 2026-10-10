#!/bin/bash
# land-queue.sh: the merge queue's worker (team/FOUNDATION.md, part 7). Lands EVERY waiting
# work/q/<team>/<item> branch, oldest first, one at a time: merge into the integration branch,
# preflight the merged tree, regenerate the generated files, push. A run that GitHub cancels or
# skips loses nothing, because the next run picks up whatever is still waiting.
# Each queue branch is removed once it is decided (landed, already in, conflict, or red); the run's
# summary keeps the reason. A lost push race leaves the branch for the next run.
set -u
TARGET="${TARGET:?}"
SUM="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
sh scripts/team/setup.sh >/dev/null
git fetch -q --prune origin "+refs/heads/work/q/*:refs/remotes/origin/work/q/*" "+refs/heads/$TARGET:refs/remotes/origin/$TARGET"
mapfile -t refs < <(git for-each-ref --sort=committerdate --format='%(refname:strip=3)' refs/remotes/origin/work/q)
[ ${#refs[@]} -eq 0 ] && { echo "Nothing waiting." | tee -a "$SUM"; exit 0; }
landed=0; refused=0
drop() { git push -q origin --delete "$1" 2>/dev/null || true; }
for ref in "${refs[@]}"; do
  git fetch -q origin "+refs/heads/$TARGET:refs/remotes/origin/$TARGET"
  git checkout -q -f -B land "origin/$TARGET"
  sha=$(git rev-parse "origin/$ref")
  if git merge-base --is-ancestor "$sha" HEAD; then echo "- $ref: already in $TARGET" | tee -a "$SUM"; drop "$ref"; continue; fi
  # The queue's own commits carry the queued author's public identity (the pre-push identity check).
  git config user.name "$(git log -1 --format=%an "$sha")"; git config user.email "$(git log -1 --format=%ae "$sha")"
  if ! git merge -q --no-ff --no-edit -m "merge: $ref into $TARGET" "$sha" >/dev/null 2>&1; then
    { echo "### $ref: merge conflict, not landed"; git diff --name-only --diff-filter=U | sed 's/^/- /'; echo "Re-base on the current $TARGET and queue again."; } | tee -a "$SUM"
    git merge --abort 2>/dev/null; drop "$ref"; refused=$((refused+1)); continue
  fi
  base=$(git rev-parse "origin/$TARGET")
  if git diff --name-only "$base" HEAD | grep -qE '(^|/)package-lock\.json$'; then npm ci --no-audit --no-fund >/dev/null 2>&1; (cd apps/app && npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1); fi
  if ! node scripts/team/preflight.mjs --ci --base "$base" > preflight.log 2>&1; then
    { echo "### $ref: preflight red, not landed"; echo '```'; tail -40 preflight.log; echo '```'; } | tee -a "$SUM"
    drop "$ref"; refused=$((refused+1)); continue
  fi
  node scripts/team/regen.mjs >/dev/null 2>&1
  git add -A docs kernel/golden
  git diff --cached --quiet || git commit -q -m "chore(docs): regenerated after $ref"
  if git push -q origin "HEAD:$TARGET"; then
    echo "- $ref: landed at $(git rev-parse --short HEAD)" | tee -a "$SUM"; drop "$ref"; landed=$((landed+1))
  else
    echo "- $ref: $TARGET moved during the run; it stays queued for the next run" | tee -a "$SUM"
  fi
done
echo "Landed $landed, refused $refused." | tee -a "$SUM"
[ "$refused" -eq 0 ]
