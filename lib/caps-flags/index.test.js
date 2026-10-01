// @ts-check
// lib/caps-flags: the one flag list (PLAN.md C14b). A surface reads normalizeCaps' answer, so a
// missing or mistyped flag is off, never a control that fails; checkCaps names every gap, for
// sessions' conformance test.

import test from "node:test";
import assert from "node:assert/strict";
import { FLAGS, TOOL_KINDS, normalizeCaps, checkCaps } from "./index.js";

const full = {
  steer: true, queue: true, interrupt: true, resume: true, fork: true, rewind: { conversation: true, code: false },
  modes: ["default", "plan"], plan: true, questions: true, permissions: true, thinking: true, effort: false,
  images: true, commands: true, tasks: true, subagents: true, model_switch: true, usage: "detailed", remember: "CLAUDE.md",
};

test("the list matches C14b: no shell flag, usage tri-state, the shared tool kinds", () => {
  assert.ok(!("shell" in FLAGS));
  assert.deepEqual([...FLAGS.usage], ["none", "coarse", "detailed"]);
  assert.deepEqual([...TOOL_KINDS], ["read", "edit", "write", "run", "search", "fetch", "mcp", "task", "other"]);
  assert.deepEqual(Object.keys(full).sort(), Object.keys(FLAGS).sort(), "the test's full set names every flag");
});

test("normalizeCaps: nothing declared is all off; a wrong type is off; unknown keys drop", () => {
  const none = normalizeCaps(undefined);
  assert.equal(none.steer, false);
  assert.deepEqual(none.rewind, { conversation: false, code: false });
  assert.deepEqual(none.modes, []);
  assert.equal(none.usage, "none");
  assert.equal(none.remember, null);
  const odd = normalizeCaps({ steer: "yes", usage: "lots", remember: "NOTES.md", modes: ["plan", 3, ""], shell: true });
  assert.equal(odd.steer, false, "only a real true turns a flag on");
  assert.equal(odd.usage, "none");
  assert.equal(odd.remember, null);
  assert.deepEqual(odd.modes, ["plan"]);
  assert.ok(!("shell" in odd));
  assert.deepEqual(normalizeCaps(full), full);
});

test("checkCaps: exact caps pass; each missing, mistyped or unknown flag is named", () => {
  assert.deepEqual(checkCaps(full), []);
  const { thinking, ...less } = full;
  assert.deepEqual(checkCaps(less), ["thinking is missing"]);
  assert.deepEqual(checkCaps({ ...full, usage: "some" }), ["usage has the wrong type or value"]);
  assert.deepEqual(checkCaps({ ...full, rewind: true }), ["rewind has the wrong type or value"]);
  assert.deepEqual(checkCaps({ ...full, shell: true }), ["shell is not a capability flag"]);
  assert.deepEqual(checkCaps(null), ["caps must be an object"]);
});
