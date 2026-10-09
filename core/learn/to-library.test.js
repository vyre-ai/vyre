// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { libraryInput, toLibrary } from "./to-library.js";

const SK = { name: "ship-it", body: "---\nname: ship-it\ndescription: Ship a change.\n---\n1. npm test\n2. git push", scope: "all" };

test("an account-wide procedure is drafted with no project; a project's names it", () => {
  assert.deepEqual(libraryInput(SK), { name: "ship-it", body: SK.body });
  assert.deepEqual(libraryInput({ ...SK, scope: { project: "rivera" } }), { name: "ship-it", body: SK.body, project: "rivera" });
});

test("toLibrary drafts through skills.draft.learned, and a failure or an absent library never throws", async () => {
  /** @type {any[]} */ const seen = [];
  assert.equal(await toLibrary(async (t, i) => { seen.push([t, i]); return { data: { state: "draft" } }; }, SK), true);
  assert.deepEqual(seen, [["skills.draft.learned", { name: "ship-it", body: SK.body }]]);
  /** @type {string[]} */ const logs = [];
  assert.equal(await toLibrary(async () => ({ error: { message: "the kernel is not wired" } }), SK, m => logs.push(m)), false);
  assert.equal(await toLibrary(async () => { throw new Error("no such tool"); }, SK, m => logs.push(m)), false);
  assert.equal(logs.length, 2);
});
