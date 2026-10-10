// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { newThingCall } from "./new.js";

test("a new project is made by the work hub, so it has a short name; other types are plain records", () => {
  assert.deepEqual(newThingCall("project"), { tool: "work.project.create", input: { name: "New project" } });
  assert.equal(newThingCall("contact"), null);
});
