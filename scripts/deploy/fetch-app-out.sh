#!/usr/bin/env bash
# Fetch the signed hosted-app build for relay-deploy.yml, and refuse anything that is not the release workflow's own output for this
# commit: the run must be the `release` workflow, on the commit being deployed, not a pull request's, and successful. Then verify the
# signature of every sealed folder against the pinned release key (scripts/deploy/verify-app-out.mjs).
#   scripts/deploy/fetch-app-out.sh <run id> <sha>        (needs gh and GH_TOKEN)
set -eu
RUN=${1:?run id}; SHA=${2:?sha}
printf %s "$RUN" | grep -Eq '^[0-9]+$' || { echo "::error::app_out_run must be a run id"; exit 1; }
info=$(gh run view "$RUN" --json workflowName,headSha,event,conclusion)
echo "run $RUN: $info"
printf %s "$info" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8")), sha = process.argv[1];
  const bad = [];
  if (r.workflowName !== "release") bad.push(`workflow is "${r.workflowName}", not "release"`);
  if (r.headSha !== sha) bad.push(`it built ${r.headSha}, not ${sha}`);
  if (r.event === "pull_request" || r.event === "pull_request_target") bad.push("it is a pull request run");
  if (r.conclusion !== "success") bad.push(`it did not succeed (${r.conclusion})`);
  if (bad.length) { console.error("::error::app_out_run refused: " + bad.join("; ")); process.exit(1); }' "$SHA"
rm -rf app-out
gh run download "$RUN" --name app-out --dir app-out
node scripts/deploy/verify-app-out.mjs app-out
