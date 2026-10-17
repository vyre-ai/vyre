// @ts-check
// The 0.6.0 limit, said plainly: when the fscrypt helper answers that removing the workspace key is "incomplete" (a process still holds a file open), one line says so. Nothing else changes.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { sayIfIncomplete } from "./workspace.js";

test("an incomplete key removal is said in one plain line; a finished one, an empty answer and a failure say nothing", () => {
  /** @type {string[]} */ const said = [];
  assert.equal(sayIfIncomplete({ out: "incomplete\n" }, m => said.push(m)), true);
  assert.deepEqual(said, ["the key is removed but a process still holds a file open: it can read until it exits"]);
  said.length = 0;
  for (const r of [{ out: "removed\n" }, { out: "" }, {}, null, undefined]) assert.equal(sayIfIncomplete(/** @type {any} */ (r), m => said.push(m)), false);
  assert.deepEqual(said, []);
});
