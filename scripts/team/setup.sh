#!/bin/sh
# setup.sh: once per clone (the Mac worktree and every test-box checkout). Wires the JSON merge
# driver and the generated-file merge rule that .gitattributes names, so merges of the shared lists
# and generated files never conflict. Idempotent.
set -eu
git config merge.json3.name "three-way JSON merge by key (scripts/team/merge-json3.mjs)"
git config merge.json3.driver "node scripts/team/merge-json3.mjs %O %A %B"
git config merge.regen.name "generated file: keep ours, the merge queue regenerates"
git config merge.regen.driver "true"
echo "setup: merge drivers wired in $(git rev-parse --show-toplevel)"
