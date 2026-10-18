// @ts-check
// CI lanes: the 24 self-hosted runners are the release lane. Only a tag, main, integrate/**, release/**, a train (…/train) or work/lead-* runs on them; every other ref (a polish branch, a pull request, a
// dispatch from either) runs on GitHub's hosted runners, so ten teams pushing cannot queue ahead of a release. The repository is public, so hosted runners cost nothing.
import "./mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANE = "(vars.CI_SELF_HOSTED == '1' && (github.ref_type == 'tag' || github.ref_name == 'main' || startsWith(github.ref_name, 'release/') || startsWith(github.ref_name, 'integrate/') || endsWith(github.ref_name, '/train') || startsWith(github.ref_name, 'work/lead-')))";
const OLD = "github.event_name != 'pull_request_target' && github.event.pull_request.head.repo.fork != true) && fromJSON(";

for (const file of ["node.yml", "app.yml", "box-image.yml", "design-pictures.yml"]) {
  test(`${file}: the self-hosted fleet is only for release-lane refs`, () => {
    const yml = fs.readFileSync(path.join(ROOT, ".github/workflows", file), "utf8");
    assert.ok(yml.includes(LANE), "the lane expression is used");
    assert.ok(!yml.includes(OLD), "no run picks the self-hosted label for a branch or a pull request any more");
    for (const m of yml.matchAll(/runs-on: \$\{\{ ([^\n]*) \}\}/g)) if (/self-hosted/.test(m[1])) assert.ok(m[1].includes(LANE), `a self-hosted runs-on without the lane: ${m[1].slice(0, 80)}`);
  });
}

test("the release run is in the lane: release.yml calls node.yml from a tag, and a tag is a lane ref", () => {
  const release = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.match(release, /\n  node:\n    uses: \.\/\.github\/workflows\/node\.yml\n/);
  assert.ok(LANE.includes("github.ref_type == 'tag'"));
});
