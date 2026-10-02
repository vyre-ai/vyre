// @ts-check
// .github/workflows/release-verify.yml: the post-publish checks of a stable release, run from main.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yml = fs.readFileSync(path.join(REPO, ".github/workflows/release-verify.yml"), "utf8");

test("release-verify: runs after the release workflow, and by hand with a tag; a stable published release only", () => {
  assert.match(yml, /workflow_run:\n\s+workflows: \[release\]\n\s+types: \[completed\]/);
  assert.match(yml, /workflow_dispatch:\n\s+inputs:\n\s+tag:/);
  assert.match(yml, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(yml, /isPrerelease,isDraft/);
});

test("release-verify: the five checks are all there, with the pinned key taken from the previous release's wrapper", () => {
  assert.match(yml, /check-release-dist\.mjs "\$d" --pulled --installer --pubkey "\$key"/);
  assert.match(yml, /git show "\$FROM:box\/vyre"/);
  assert.match(yml, /SHA256SUMS\.sig verifies against the pinned key/);
  assert.match(yml, /cosign verify-blob --bundle/);
  assert.match(yml, /cosign verify --certificate-identity-regexp/);
  assert.match(yml, /gh attestation verify/);
  assert.match(yml, /anonymous manifest read/);
  assert.match(yml, /vyre update <\/dev\/null/);
});

test("release-verify: it holds no secret, only read permissions, and every action is pinned by sha", () => {
  assert.doesNotMatch(yml, /secrets\./);
  assert.doesNotMatch(yml, /(contents|packages|id-token|attestations): write/);
  for (const m of yml.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
});
