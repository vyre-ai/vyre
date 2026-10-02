// @ts-check
// scripts/check-release-lineage.mjs: a release commit off main and stage must be a proper patch of the newest published stable release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineage, nextPatchTag, newestStable } from "../scripts/check-release-lineage.mjs";

const ok = { tag: "v0.2.2", prev: "v0.2.1", prevIsAncestor: true, onHotfixBranch: true };

test("lineage: the next patch of the newest published stable release, on its own hotfix branch, passes", () => {
  assert.deepEqual(lineage(ok), []);
});

test("lineage: refused when the newest published stable release is not an ancestor", () => {
  assert.match(lineage({ ...ok, prevIsAncestor: false }).join("\n"), /v0\.2\.1 is not an ancestor/);
});

test("lineage: refused when the tag is not that release's next patch (a skip, a repeat, a minor bump, a prerelease)", () => {
  for (const tag of ["v0.2.3", "v0.2.1", "v0.3.0", "v0.2.2-rc.1", "v1.0.0"]) assert.match(lineage({ ...ok, tag }).join("\n"), /is not the next patch after v0\.2\.1/, tag);
});

test("lineage: refused when the commit is not on origin/hotfix/<tag>", () => {
  assert.match(lineage({ ...ok, onHotfixBranch: false }).join("\n"), /not on origin\/hotfix\/v0\.2\.2/);
});

test("lineage: refused with no published stable release at all, and each failure is named", () => {
  assert.match(lineage({ ...ok, prev: null }).join("\n"), /no published stable release/);
  assert.equal(lineage({ tag: "v0.2.5", prev: "v0.2.1", prevIsAncestor: false, onHotfixBranch: false }).length, 3);
});

test("lineage: next patch and newest stable, numerically", () => {
  assert.equal(nextPatchTag("v0.2.9"), "v0.2.10");
  assert.equal(nextPatchTag("v0.2.1-rc.1"), null);
  assert.equal(newestStable(["v0.2.9", "v0.2.10", "v0.3.0-rc.1", "v0.2.2"]), "v0.2.10");
});
