// The work module declares the Project and Chat record types it needs in its manifest (the Space gets them from there). They are copies of the core types: this fails when they differ, so a field added to
// the core Project (tags, the template fields, personal_of) can never be missing in a real Space while the tests, which use the core type, pass.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PROJECT, CHAT } from "../records/core-types.js";

test("the work manifest's project and chat-record types are the core ones", () => {
  const m = JSON.parse(fs.readFileSync(new URL("../core/work/module.json", import.meta.url), "utf8"));
  const by = (/** @type {string} */ n) => m.needs.kernel.types.find((/** @type {any} */ t) => t.name === n);
  assert.deepEqual(by("project"), JSON.parse(JSON.stringify(PROJECT)));
  assert.deepEqual(by("chat-record"), JSON.parse(JSON.stringify(CHAT)));
});
