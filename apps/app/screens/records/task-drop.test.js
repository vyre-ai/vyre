// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { taskDrop } from "./task-drop.js";

test("a drop on a column tasks.move allows sends that move", () => {
  assert.deepEqual(taskDrop("ready", "working"), { call: { to: "working" } });
  assert.deepEqual(taskDrop("working", "stuck"), { call: { to: "stuck", reason: "Flagged from the board" } });
  assert.deepEqual(taskDrop("stuck", "ready"), { call: { to: "ready" } });
});

test("a drop where the card already is does nothing", () => {
  assert.deepEqual(taskDrop("working", "working"), { same: true });
});

test("columns the kernel owns say why a card will not go there", () => {
  for (const to of ["done", "needs_check", "waiting"]) assert.equal(typeof /** @type {any} */ (taskDrop("ready", to)).say, "string");
});
