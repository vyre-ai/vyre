#!/usr/bin/env bash
# Fetch the signed camera-page build for relay-deploy.yml, and refuse anything that is not the release workflow's own output for this
# commit: the run must be the `release` workflow, on the commit being deployed, not a pull request's, and successful. Then verify the
# signature of the sealed folder against the pinned release key (scripts/deploy/verify-wink-out.mjs).
#   scripts/deploy/fetch-wink-out.sh <run id> <sha>        (needs gh and GH_TOKEN)
set -eu
RUN=${1:?run id}; SHA=${2:?sha}
printf %s "$RUN" | grep -Eq '^[0-9]+$' || { echo "::error::wink_out_run must be a run id"; exit 1; }
info=$(gh run view "$RUN" --json workflowName,headSha,event,conclusion)
echo "run $RUN: $info"
printf %s "$info" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8")), sha = process.argv[1];
  const bad = [];
  if (r.workflowName !== "release") bad.push(`workflow is "${r.workflowName}", not "release"`);
  if (r.headSha !== sha) bad.push(`it built ${r.headSha}, not ${sha}`);
  if (r.event === "pull_request" || r.event === "pull_request_target") bad.push("it is a pull request run");
  if (r.conclusion !== "success") bad.push(`it did not succeed (${r.conclusion})`);
  if (bad.length) { console.error("::error::wink_out_run refused: " + bad.join("; ")); process.exit(1); }' "$SHA"
rm -rf wink-out
gh run download "$RUN" --name wink-out --dir wink-out
node scripts/deploy/verify-wink-out.mjs wink-out
