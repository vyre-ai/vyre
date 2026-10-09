#!/bin/sh
# queue.sh ITEM: hand the current branch to the merge queue (team/FOUNDATION.md, part 6).
# Pushes HEAD to work/q/<team>/<item>. The merge-queue workflow merges it into the integration
# branch, regenerates the generated files, runs preflight on the merged tree and pushes the result.
# Your branch stays yours; the queue ref is deleted after landing. Watch it with:
#   gh run list -R vyre-ai/vyre --workflow merge-queue.yml -L 5
set -eu
item="${1:?usage: scripts/team/queue.sh <item>   (e.g. r031-95-lease)}"
team="${VYRE_TEAM:?set VYRE_TEAM to your team name, e.g. export VYRE_TEAM=site-ops}"
case "$item$team" in *[!a-z0-9._-]*) echo "queue: use lower-case letters, digits, dot, dash and underscore only" >&2; exit 2;; esac
ref="work/q/$team/$item"
git push -q origin "HEAD:refs/heads/$ref"
echo "queued $ref at $(git rev-parse --short HEAD)"
echo "watch: gh run list -R vyre-ai/vyre --workflow merge-queue.yml -L 5"
