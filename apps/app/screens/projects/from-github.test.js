// @ts-check
// New project from a GitHub repo: the github.project input, the answer, the record lookup and the words for a refusal.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("the picked repo goes to github.project with its account only when there is one, and the short name comes back", { skip: !strip }, async () => {
  const { githubProjectSource, projectInput } = await import("./from-github.ts");
  assert.deepEqual(projectInput("acme/site", "work"), { repo: "acme/site", account: "work" });
  assert.deepEqual(projectInput("acme/site", ""), { repo: "acme/site" });
  /** @type {any[]} */ const seen = [];
  const src = githubProjectSource(async (tool, input) => { seen.push([tool, input]); return { data: { project: "site", home: "/p/site", full_name: "acme/site" } }; });
  assert.deepEqual(await src.create("acme/site", "work"), { project: "site", home: "/p/site", full_name: "acme/site" });
  assert.deepEqual(seen, [["github.project", { repo: "acme/site", account: "work" }]]);
});

test("a refusal keeps the box's code and words; a clone that failed says where it was left", { skip: !strip }, async () => {
  const { githubProjectSource, creationRefusal } = await import("./from-github.ts");
  const bad = githubProjectSource(async () => ({ error: { code: "failed", message: "That did not clone. The clone at /p/x was left in place." } }));
  await assert.rejects(() => bad.create("acme/x", ""), (e) => { assert.equal(/** @type {any} */ (e).code, "failed"); assert.match(String(/** @type {any} */ (e).message), /left in place/); return true; });
  assert.equal(creationRefusal({ code: "failed", message: "Boom" }, "acme/x"), "Could not make a project from acme/x: Boom");
  assert.equal(creationRefusal({ code: "no_such_tool" }, "acme/x"), "This server cannot make a project from GitHub yet.");
  assert.equal(creationRefusal({ code: "config" }, "acme/x"), "This server has no projects folder to clone into yet.");
  assert.equal(creationRefusal(null, "acme/x"), "Could not make a project from acme/x: it did not work");
});

test("the new project's record is found by its short name; nothing is guessed while it is not there", { skip: !strip }, async () => {
  const { findProjectId, startedLine, madeLine } = await import("./from-github.ts");
  const rows = [{ id: "r1", data: { slug: "a" } }, { id: "r2", data: { slug: "site" } }, { data: { slug: "site" } }, { id: "r4" }];
  assert.equal(findProjectId(rows, "site"), "r2");
  assert.equal(findProjectId(rows, "nope"), null);
  assert.equal(findProjectId(rows, ""), null);
  assert.equal(startedLine("acme/site"), "Cloning acme/site and making the project.");
  assert.equal(madeLine("acme/site"), "Made a project from acme/site.");
});
