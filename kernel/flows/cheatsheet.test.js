// @ts-check
// e6: the cheat sheet is generated from the code and cannot go stale.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cheatsheet, EXAMPLES } from "./cheatsheet.js";
import { STEP_KINDS, STEP_KEYS, POLICY_LIMITS, RETRY_CODES, checkFlow, sourceHash } from "./schema.js";
import { TRIGGER_REGISTRY } from "./triggers.js";
import { FUNCTIONS } from "./expr.js";
import { tokens } from "../../lib/tokens.js";

test("e6: every step kind, trigger, retry code and function is on the page", () => {
  const text = cheatsheet();
  for (const k of STEP_KINDS) assert.ok(text.includes(`- ${k}: ${STEP_KEYS[/** @type {keyof typeof STEP_KEYS} */ (k)].join(", ")}`), `step ${k}`);
  for (const t of Object.values(TRIGGER_REGISTRY)) assert.ok(text.includes(t.on[0]), `trigger ${t.on}`);
  for (const c of RETRY_CODES) assert.ok(text.includes(c), c);
  for (const f of Object.keys(FUNCTIONS)) assert.ok(text.includes(f), f);
  assert.ok(text.includes(`attempts 1-${POLICY_LIMITS.attempts}`));
});

test("e6: every example is a valid step, so the page never teaches a mistake", () => {
  for (const kind of STEP_KINDS) {
    const ex = structuredClone(EXAMPLES[kind]);
    assert.ok(ex, `an example for ${kind}`);
    if (kind === "fn") ex.hash = sourceHash(ex.source);
    // a lane (branch) exists only inside a parallel step, so its example is checked inside one
    const steps = kind === "branch" ? [{ id: "both_lanes", kind: "parallel", steps: [ex, { ...structuredClone(ex), id: "other", steps: [{ id: "other_make", kind: "create", type: "matter", set: { client: "B" } }] }] }] : [ex];
    const problems = checkFlow({ format: 1, name: "t", authorship: "human", trigger: { on: "manual" }, steps });
    assert.deepEqual(problems, [], `${kind}: ${JSON.stringify(problems)}`);
  }
});

test("e6: it is one page", () => {
  const n = tokens(cheatsheet());
  console.log(`# cheat sheet: ${n} tokens`);
  assert.ok(n < 2200, `${n} tokens`);
});
