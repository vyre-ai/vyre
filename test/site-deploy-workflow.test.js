// @ts-check
// .github/workflows/site-deploy.yml (#16): vyre.run follows a stable release, behind the deploy environment's reviewer, and is checked afterwards.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yml = fs.readFileSync(path.join(REPO, ".github/workflows/site-deploy.yml"), "utf8");

test("site-deploy: runs after the release workflow, and by hand with a tag, from main only", () => {
  assert.match(yml, /workflow_run:\n\s+workflows: \[release\]\n\s+types: \[completed\]/);
  assert.match(yml, /workflow_dispatch:\n\s+inputs:\n\s+tag:/);
  assert.equal((yml.match(/\[ "\$REF" = refs\/heads\/main \]/g) || []).length, 2, "both jobs refuse any ref but main");
});

test("site-deploy: only a published stable release is deployed, and the deploy waits for the deploy environment", () => {
  assert.match(yml, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/, "a vX.Y.Z tag, no prerelease suffix");
  assert.match(yml, /isPrerelease,isDraft/);
  assert.match(yml, /environment: deploy/);
  assert.match(yml, /needs: assemble/);
  assert.equal((yml.match(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/g) || []).length, 1, "the token is in one step, the deploy, and in the deploy environment only");
  assert.doesNotMatch(yml.split("deploy:\n    name:")[0], /secrets\./, "the assemble job has no secrets");
});

test("site-deploy: assembles from the tag, deploys with the production refusals, and checks the served copy", () => {
  assert.match(yml, /scripts\/assemble-site\.sh --out "\$RUNNER_TEMP\/site" --tag "\$TAG"/);
  assert.match(yml, /scripts\/deploy-site\.sh "\$RUNNER_TEMP\/site" --branch main/);
  assert.match(yml, /--check https:\/\/vyre\.run/);
});

test("site-deploy: every action is pinned by commit sha", () => {
  for (const m of yml.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
});
