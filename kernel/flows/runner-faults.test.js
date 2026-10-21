// @ts-check
// A port's failure becomes the step's words. The door's residency refusal carries only its code as the error message.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { portFail } from "./runner-faults.js";

const residency = (detail) => Object.assign(new Error("residency"), { code: "residency", refusal: { code: "residency", ...(detail ? { detail } : {}) } });

test("a classify step with no provider it may use says so in words, not the door's bare code", () => {
  assert.throws(() => portFail(residency("provider is not available")), (e) => {
    assert.equal(e.code, "residency");
    assert.equal(e.message, "no model may answer here: add a provider in Settings");
    return true;
  });
  assert.throws(() => portFail(residency()), (e) => e.message === "no model may answer here: add a provider in Settings");
});

test("a residency refusal that already says why keeps those words", () => {
  const why = "this Space does not allow that provider";
  assert.throws(() => portFail(residency(why)), (e) => e.code === "residency" && e.message === why);
});
